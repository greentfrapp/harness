import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import type { CreateTaskInput, UpdateTaskInput } from '../../shared/types.ts';
import { OUTBOX_STATUSES, INBOX_STATUSES } from '../../shared/types.ts';

export function createTaskRoutes(ctx: AppContext) {
  const app = new Hono();
  const { queries, sseManager, taskQueue, config } = ctx;

  // --- Projects ---

  app.get('/projects', (c) => {
    return c.json(queries.getAllProjects());
  });

  // --- Config (task types for frontend) ---

  app.get('/config', (c) => {
    return c.json({ task_types: config.task_types });
  });

  // --- Tasks ---

  app.get('/tasks', (c) => {
    const status = c.req.query('status');
    const projectId = c.req.query('project_id');

    if (status) {
      return c.json(queries.getTasksByStatus(status.split(',')));
    }
    if (projectId) {
      return c.json(queries.getTasksByProject(projectId));
    }
    return c.json(
      queries.getTasksByStatus([...OUTBOX_STATUSES, ...INBOX_STATUSES]),
    );
  });

  app.get('/tasks/:id', (c) => {
    const task = queries.getTaskById(c.req.param('id'));
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const events = queries.getTaskEvents(task.id);
    return c.json({ ...task, events });
  });

  app.post('/tasks', async (c) => {
    const body = await c.req.json<CreateTaskInput>();

    if (!body.project_id || !body.type || !body.prompt) {
      return c.json(
        { error: 'project_id, type, and prompt are required' },
        400,
      );
    }

    const task = queries.createTask(body);
    taskQueue.recomputePositions(task.project_id);
    const updated = queries.getTaskById(task.id)!;

    sseManager.broadcast('task:created', updated);
    return c.json(updated, 201);
  });

  app.patch('/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const existing = queries.getTaskById(id);
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    const body = await c.req.json<UpdateTaskInput>();
    const updated = queries.updateTask(id, body);

    if (body.status && body.status !== existing.status) {
      queries.createTaskEvent(
        id,
        body.status,
        JSON.stringify({ previous: existing.status }),
      );

      if (INBOX_STATUSES.includes(body.status as any)) {
        sseManager.broadcast('inbox:new', updated);
      } else {
        sseManager.broadcast('task:updated', updated);
      }
    } else {
      sseManager.broadcast('task:updated', updated);
    }

    return c.json(updated);
  });

  app.delete('/tasks/:id', (c) => {
    const id = c.req.param('id');
    const existing = queries.getTaskById(id);
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    const updated = queries.updateTask(id, { status: 'cancelled' });
    queries.createTaskEvent(id, 'cancelled', null);
    sseManager.broadcast('task:updated', updated);

    return c.json(updated);
  });

  app.get('/tasks/:id/events', (c) => {
    const id = c.req.param('id');
    const existing = queries.getTaskById(id);
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    return c.json(queries.getTaskEvents(id));
  });

  return app;
}
