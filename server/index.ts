import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { ensureHarnessDir, loadConfig, validateConfig } from './config.ts';
import { initDatabase } from './db/index.ts';
import * as queries from './db/queries.ts';
import { SSEManager } from './sse.ts';
import { TaskQueue } from './queue.ts';
import { AgentPool } from './pool.ts';
import { AgentRegistry } from './agents/index.ts';
import { Dispatcher } from './dispatcher.ts';
import { recoverStaleTasks } from './recovery.ts';
import { createTaskRoutes } from './routes/tasks.ts';
import type { AppContext, CheckoutEntry } from './context.ts';
import { serverLog } from './log.ts';
import { cleanupCheckoutBranches, getCurrentBranch, returnCheckout } from './git.ts';

// --- Startup ---

console.log('Harness starting...');

ensureHarnessDir();
const config = loadConfig();
validateConfig(config);
initDatabase();
queries.seedProjects(config);

console.log(
  `Loaded ${config.projects.length} project(s), ${Object.keys(config.task_types).length} task type(s)`,
);

// --- Crash Recovery (before accepting connections) ---

const recovered = recoverStaleTasks({
  getTasksByStatus: queries.getTasksByStatus,
  getProjectById: queries.getProjectById,
  updateTask: queries.updateTask,
  createTaskEvent: queries.createTaskEvent,
  getAllProjects: queries.getAllProjects,
});
if (recovered > 0) {
  console.log(`Recovery complete: ${recovered} task(s) recovered`);
}

// --- Dependency wiring ---

const sseManager = new SSEManager();

// Stream server log entries to connected clients
serverLog.onEntry((entry) => {
  sseManager.broadcast('log:entry', entry);
});

const taskQueue = new TaskQueue({
  getTaskById: queries.getTaskById,
  getQueuedTasks: queries.getQueuedTasks,
  updateTask: queries.updateTask,
  createTaskEvent: queries.createTaskEvent,
  broadcast: (event, data) => sseManager.broadcast(event, data),
});

// Pool and dispatcher have a circular dependency (pool calls onTaskCompleted
// which triggers dispatcher). We create pool first with a placeholder, then
// set the real dispatcher.

let dispatcher: Dispatcher;

const agentRegistry = new AgentRegistry();

const pool = new AgentPool({
  config,
  agentRegistry,
  getProjectById: queries.getProjectById,
  updateTask: queries.updateTask,
  createTaskEvent: queries.createTaskEvent,
  broadcast: (event, data) => sseManager.broadcast(event, data),
  getTaskById: queries.getTaskById,
  onTaskCompleted: () => {
    // Re-check queue when an agent finishes (slot freed)
    dispatcher?.tryDispatch();
  },
});

dispatcher = new Dispatcher({
  config,
  pool,
  getProjectById: queries.getProjectById,
  getTaskById: queries.getTaskById,
  getQueuedTasks: queries.getQueuedTasks,
  getTasksByStatus: queries.getTasksByStatus,
  updateTask: queries.updateTask,
  createTaskEvent: queries.createTaskEvent,
  broadcast: (event, data) => sseManager.broadcast(event, data),
  isDependencySatisfied: (task) => taskQueue.isDependencySatisfied(task),
});

// --- Checkout state (in-memory, recover from git on restart) ---

const checkoutState = new Map<string, CheckoutEntry>();

// Recover active checkouts or clean up stale checkout branches from a previous crash
for (const project of queries.getAllProjects()) {
  const currentBranch = getCurrentBranch(project.repo_path);
  if (currentBranch && currentBranch.startsWith('harness/checkout-')) {
    // Repo is currently on a checkout branch — recover the checkout state
    const idPrefix = currentBranch.replace('harness/checkout-', '');
    // Find the task whose ID starts with this prefix
    const projectTasks = queries.getTasksByProject(project.id);
    const matchedTask = projectTasks.find((t) => t.id.startsWith(idPrefix));
    if (matchedTask) {
      checkoutState.set(project.repo_path, {
        taskId: matchedTask.id,
        checkoutBranch: currentBranch,
      });
      console.log(`Recovered checkout: ${currentBranch} → task ${matchedTask.id}`);
    } else {
      // No matching task found — return to target branch, then clean up
      try {
        returnCheckout(project.repo_path, project.target_branch, currentBranch);
      } catch { /* best effort */ }
      cleanupCheckoutBranches(project.repo_path);
    }
  } else {
    // Not on a checkout branch — clean up any stale checkout branches
    cleanupCheckoutBranches(project.repo_path);
  }
}

const appContext: AppContext = {
  config,
  sseManager,
  taskQueue,
  pool,
  dispatcher,
  queries,
  checkoutState,
};

// --- App ---

const app = new Hono();

// SSE endpoint
app.get('/events', (c) => {
  const clientId = crypto.randomUUID();

  return streamSSE(c, async (stream) => {
    sseManager.addClient({ id: clientId, stream });

    // Send initial connection event
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ clientId }),
    });

    // Keep-alive every 30s
    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: '' }).catch(() => {
        clearInterval(keepAlive);
        sseManager.removeClient(clientId);
      });
    }, 30_000);

    // Keep stream open until client disconnects
    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        sseManager.removeClient(clientId);
        resolve();
      });
    });
  });
});

// Log endpoint
app.get('/api/log', (c) => {
  return c.json(serverLog.getRecent());
});

// API routes
app.route('/api', createTaskRoutes(appContext));

// Serve static files in production
app.use('/*', serveStatic({ root: './client/dist' }));
app.get('/*', serveStatic({ root: './client/dist', path: 'index.html' }));

// --- Start Server ---

const PORT = parseInt(process.env.PORT ?? '3001', 10);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Harness server listening on http://localhost:${info.port}`);

  // Initial dispatch check — pick up any queued tasks
  dispatcher.tryDispatch();
});
