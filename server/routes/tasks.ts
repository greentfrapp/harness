import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import type { CreateTaskInput, UpdateTaskInput } from '../../shared/types.ts';
import { OUTBOX_STATUSES, INBOX_STATUSES } from '../../shared/types.ts';
import * as git from '../git.ts';
import { readConfigRaw, saveConfigRaw, CONFIG_PATH } from '../config.ts';

export function createTaskRoutes(ctx: AppContext) {
  const app = new Hono();
  const { queries, sseManager, taskQueue, pool, dispatcher, config } = ctx;

  // --- Projects ---

  app.get('/projects', (c) => {
    return c.json(queries.getAllProjects());
  });

  // --- Config (task types for frontend) ---

  app.get('/config', (c) => {
    return c.json({ task_types: config.task_types });
  });

  /** Read raw config.jsonc content for the settings editor. */
  app.get('/config/raw', (c) => {
    return c.json({ content: readConfigRaw(), path: CONFIG_PATH });
  });

  /** Validate and save raw config.jsonc content. */
  app.put('/config/raw', async (c) => {
    const body = await c.req.json<{ content: string }>();
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400);
    }

    const result = saveConfigRaw(body.content);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    // Reload config in the running context
    Object.assign(ctx.config, result.config);

    // Re-seed projects from updated config
    queries.seedProjects(result.config);

    return c.json({ ok: true });
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

    // Trigger dispatch check
    dispatcher.tryDispatch();

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

  // --- Task Actions ---

  /** Approve: merge branch into target, destroy worktree, mark approved. */
  app.post('/tasks/:id/approve', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'ready' && task.status !== 'error') {
      return c.json({ error: 'Task cannot be approved in current status' }, 400);
    }

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Merge branch if it exists
    if (task.branch_name) {
      try {
        git.mergeBranch(project.repo_path, project.target_branch, task.branch_name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Merge failed: ${msg}` }, 409);
      }

      // Clean up worktree and branch
      if (task.worktree_path) {
        git.removeWorktree(project.repo_path, task.worktree_path);
      }
      git.deleteBranch(project.repo_path, task.branch_name);
    }

    const updated = queries.updateTask(id, {
      status: 'approved',
      worktree_path: null,
    });
    queries.createTaskEvent(id, 'approved', null);
    sseManager.broadcast('task:updated', updated);

    // Trigger dispatch — dependencies may now be satisfied
    dispatcher.tryDispatch();

    return c.json(updated);
  });

  /** Reject: destroy worktree + branch, mark rejected. */
  app.post('/tasks/:id/reject', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'ready' && task.status !== 'error') {
      return c.json({ error: 'Task cannot be rejected in current status' }, 400);
    }

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Clean up worktree and branch
    if (task.worktree_path) {
      git.removeWorktree(project.repo_path, task.worktree_path);
    }
    if (task.branch_name) {
      git.deleteBranch(project.repo_path, task.branch_name);
    }

    const updated = queries.updateTask(id, {
      status: 'rejected',
      worktree_path: null,
    });
    queries.createTaskEvent(id, 'rejected', null);
    sseManager.broadcast('task:updated', updated);

    // Check for dependent tasks
    const dependents = getDependentTasks(queries, id);
    if (dependents.length > 0) {
      // Return info about blocked dependents so frontend can warn the user
      return c.json({
        ...updated,
        blocked_dependents: dependents.map((t) => ({
          id: t.id,
          prompt: t.prompt.slice(0, 100),
          status: t.status,
        })),
      });
    }

    return c.json(updated);
  });

  /** Cancel: kill agent, destroy worktree + branch, mark cancelled. */
  app.delete('/tasks/:id', (c) => {
    const id = c.req.param('id');
    const existing = queries.getTaskById(id);
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    // Kill running agent if any
    pool.killAgent(id);

    // Clean up worktree and branch
    if (existing.worktree_path) {
      const project = queries.getProjectById(existing.project_id);
      if (project) {
        git.removeWorktree(project.repo_path, existing.worktree_path);
      }
    }
    if (existing.branch_name) {
      const project = queries.getProjectById(existing.project_id);
      if (project) {
        git.deleteBranch(project.repo_path, existing.branch_name);
      }
    }

    const updated = queries.updateTask(id, {
      status: 'cancelled',
      worktree_path: null,
    });
    queries.createTaskEvent(id, 'cancelled', null);
    sseManager.broadcast('task:updated', updated);

    // Trigger dispatch — a slot just freed up
    dispatcher.tryDispatch();

    return c.json(updated);
  });

  /** Get diff for a completed task. */
  app.get('/tasks/:id/diff', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    if (!task.branch_name) {
      return c.json({ diff: '', stats: '' });
    }

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const diff = git.getDiff(
      project.repo_path,
      project.target_branch,
      task.branch_name,
    );
    const stats = git.getDiffStats(
      project.repo_path,
      project.target_branch,
      task.branch_name,
    );

    return c.json({ diff, stats });
  });

  app.get('/tasks/:id/events', (c) => {
    const id = c.req.param('id');
    const existing = queries.getTaskById(id);
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    return c.json(queries.getTaskEvents(id));
  });

  return app;
}

/** Find tasks that depend on the given task. */
function getDependentTasks(
  queries: { getTasksByStatus: (s: string[]) => any[] },
  taskId: string,
): any[] {
  const activeTasks = queries.getTasksByStatus([
    'queued',
    'in_progress',
    'retrying',
    'ready',
    'held',
  ]);
  return activeTasks.filter((t: any) => t.depends_on === taskId);
}
