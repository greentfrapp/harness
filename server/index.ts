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
import type { AppContext } from './context.ts';

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

const appContext: AppContext = {
  config,
  sseManager,
  taskQueue,
  pool,
  dispatcher,
  queries,
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
