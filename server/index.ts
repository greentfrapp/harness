import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { ensureHarnessDir, loadConfig, validateConfig } from './config.ts';
import { initDatabase } from './db/index.ts';
import * as queries from './db/queries.ts';
import { SSEManager } from './sse.ts';
import { TaskQueue } from './queue.ts';
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

// --- Dependency wiring ---

const sseManager = new SSEManager();

const taskQueue = new TaskQueue({
  getTaskById: queries.getTaskById,
  getQueuedTasks: queries.getQueuedTasks,
  updateTask: queries.updateTask,
  createTaskEvent: queries.createTaskEvent,
  broadcast: (event, data) => sseManager.broadcast(event, data),
});

const appContext: AppContext = {
  config,
  sseManager,
  taskQueue,
  queries,
};

// --- App ---

const app = new Hono();

// SSE endpoint
app.get('/events', (c) => {
  const clientId = crypto.randomUUID();

  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const client = {
          id: clientId,
          write: (data: string) => {
            try {
              controller.enqueue(encoder.encode(data));
            } catch {
              sseManager.removeClient(clientId);
            }
          },
          close: () => controller.close(),
        };

        sseManager.addClient(client);

        // Send initial connection event
        client.write(
          `event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`,
        );

        // Keep-alive every 30s
        const keepAlive = setInterval(() => {
          try {
            client.write(': keepalive\n\n');
          } catch {
            clearInterval(keepAlive);
            sseManager.removeClient(clientId);
          }
        }, 30_000);

        // Cleanup on abort
        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(keepAlive);
          sseManager.removeClient(clientId);
        });
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
  );
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
});
