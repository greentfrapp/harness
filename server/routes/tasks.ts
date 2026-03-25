import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import type { CreateTaskInput, UpdateTaskInput } from '../../shared/types.ts';
import { OUTBOX_STATUSES, INBOX_STATUSES } from '../../shared/types.ts';
import * as git from '../git.ts';
import { readConfigRaw, saveConfigRaw, CONFIG_PATH } from '../config.ts';
import { serverLog } from '../log.ts';

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

    // Resolve agent_type from task type config if not explicitly provided
    if (!body.agent_type) {
      const taskTypeConfig = config.task_types[body.type];
      body.agent_type = taskTypeConfig?.agent ?? 'claude-code';
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
      if (!git.hasCommits(project.repo_path, project.target_branch, task.branch_name)) {
        serverLog.warn(`Task branch has no commits ahead of ${project.target_branch}`, id);
        return c.json({ error: 'No changes to merge — the agent may not have committed its work' }, 409);
      }

      try {
        serverLog.info(`Merging ${task.branch_name} into ${project.target_branch}`, id);
        git.mergeBranch(project.repo_path, project.target_branch, task.branch_name, {
          push: !!project.auto_push,
        });
        serverLog.info(`Merge successful${project.auto_push ? ' (pushed to remote)' : ''}`, id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        serverLog.error(`Merge failed: ${msg}`, id);
        return c.json({ error: `Merge failed: ${msg}` }, 409);
      }

      // Clean up worktree and branch
      if (task.worktree_path) {
        serverLog.info(`Removing worktree ${task.worktree_path}`, id);
        git.removeWorktree(project.repo_path, task.worktree_path);
      }
      serverLog.info(`Deleting branch ${task.branch_name}`, id);
      git.deleteBranch(project.repo_path, task.branch_name);
    }

    const updated = queries.updateTask(id, {
      status: 'approved',
      worktree_path: null,
    });
    queries.createTaskEvent(id, 'approved', null);
    serverLog.info(`Task approved`, id);
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
      serverLog.info(`Removing worktree ${task.worktree_path}`, id);
      git.removeWorktree(project.repo_path, task.worktree_path);
    }
    if (task.branch_name) {
      serverLog.info(`Deleting branch ${task.branch_name}`, id);
      git.deleteBranch(project.repo_path, task.branch_name);
    }

    const updated = queries.updateTask(id, {
      status: 'rejected',
      worktree_path: null,
    });
    queries.createTaskEvent(id, 'rejected', null);
    serverLog.info(`Task rejected`, id);
    sseManager.broadcast('task:removed', { id });

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

  /** Fix: re-queue a ready task whose merge failed so the agent can resolve conflicts on a fresh worktree. */
  app.post('/tasks/:id/fix', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'ready') {
      return c.json({ error: 'Only ready tasks can be fixed' }, 400);
    }

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Clean up old worktree and branch
    if (task.worktree_path) {
      serverLog.info(`Removing worktree ${task.worktree_path}`, id);
      git.removeWorktree(project.repo_path, task.worktree_path);
    }
    if (task.branch_name) {
      serverLog.info(`Deleting branch ${task.branch_name}`, id);
      git.deleteBranch(project.repo_path, task.branch_name);
    }

    // Augment prompt so the agent knows to resolve merge conflicts
    const fixPrefix = `[MERGE CONFLICT FIX] The previous attempt completed successfully but failed to merge into ${project.target_branch} due to merge conflicts. Please redo the work on a fresh worktree, ensuring compatibility with the latest ${project.target_branch}.\n\nOriginal task:\n`;
    const augmentedPrompt = task.prompt.startsWith('[MERGE CONFLICT FIX]')
      ? task.prompt
      : fixPrefix + task.prompt;

    const updated = queries.updateTask(id, {
      status: 'queued',
      prompt: augmentedPrompt,
      error_message: null,
      agent_session_data: null,
      agent_summary: null,
      diff_summary: null,
      worktree_path: null,
      branch_name: null,
    });
    queries.createTaskEvent(id, 'fix_merge_conflict', null);
    serverLog.info(`Task re-queued to fix merge conflict`, id);

    taskQueue.recomputePositions(task.project_id);
    sseManager.broadcast('task:updated', updated);
    dispatcher.tryDispatch();

    return c.json(updated);
  });

  /** Retry: clean up old worktree/branch, re-queue for a fresh run. */
  app.post('/tasks/:id/retry', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'error') {
      return c.json({ error: 'Only error tasks can be retried' }, 400);
    }

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Clean up old worktree and branch
    if (task.worktree_path) {
      serverLog.info(`Removing worktree ${task.worktree_path}`, id);
      git.removeWorktree(project.repo_path, task.worktree_path);
    }
    if (task.branch_name) {
      serverLog.info(`Deleting branch ${task.branch_name}`, id);
      git.deleteBranch(project.repo_path, task.branch_name);
    }

    const updated = queries.updateTask(id, {
      status: 'queued',
      retry_count: 0,
      error_message: null,
      agent_session_data: null,
      agent_summary: null,
      diff_summary: null,
      worktree_path: null,
      branch_name: null,
    });
    queries.createTaskEvent(id, 'retried_manual', null);
    serverLog.info(`Task manually retried — re-queued`, id);

    taskQueue.recomputePositions(task.project_id);
    sseManager.broadcast('task:updated', updated);
    dispatcher.tryDispatch();

    return c.json(updated);
  });

  /** Bulk delete by IDs: permanently remove specific tasks. */
  app.post('/tasks/bulk-delete', async (c) => {
    const body = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: 'ids array is required' }, 400);
    }

    const tasksToDelete = body.ids
      .map((id) => queries.getTaskById(id))
      .filter((t): t is NonNullable<typeof t> => t != null);

    if (tasksToDelete.length === 0) {
      return c.json({ deleted: [] });
    }

    // Kill running agents and clean up worktrees/branches
    let hadRunning = false;
    for (const task of tasksToDelete) {
      if (task.status === 'in_progress' || task.status === 'retrying') {
        pool.killAgent(task.id);
        hadRunning = true;
      }
      const project = queries.getProjectById(task.project_id);
      if (project) {
        if (task.worktree_path) {
          git.removeWorktree(project.repo_path, task.worktree_path);
        }
        if (task.branch_name) {
          git.deleteBranch(project.repo_path, task.branch_name);
        }
      }
    }

    const deleted = queries.deleteTasksByIds(tasksToDelete.map((t) => t.id));
    const ids = deleted.map((t) => t.id);

    for (const id of ids) {
      sseManager.broadcast('task:removed', { id });
    }

    if (hadRunning) {
      dispatcher.tryDispatch();
    }

    return c.json({ deleted: ids });
  });

  /** Bulk delete: permanently remove tasks by status. */
  app.delete('/tasks', (c) => {
    const statusParam = c.req.query('status');
    if (!statusParam) {
      return c.json({ error: 'status query parameter is required' }, 400);
    }
    const statuses = statusParam.split(',').filter(Boolean);

    // Get tasks before deletion for cleanup
    const tasksToDelete = queries.getTasksByStatus(statuses);

    // Kill running agents and clean up worktrees/branches
    let hadRunning = false;
    for (const task of tasksToDelete) {
      if (task.status === 'in_progress' || task.status === 'retrying') {
        pool.killAgent(task.id);
        hadRunning = true;
      }
      const project = queries.getProjectById(task.project_id);
      if (project) {
        if (task.worktree_path) {
          git.removeWorktree(project.repo_path, task.worktree_path);
        }
        if (task.branch_name) {
          git.deleteBranch(project.repo_path, task.branch_name);
        }
      }
    }

    const deleted = queries.deleteTasksByStatus(statuses);
    const ids = deleted.map((t) => t.id);

    for (const id of ids) {
      sseManager.broadcast('task:removed', { id });
    }

    if (hadRunning) {
      dispatcher.tryDispatch();
    }

    return c.json({ deleted: ids });
  });

  /** Cancel or permanently delete a task.
   *  - Terminal states (approved, rejected, cancelled): permanently deletes from DB.
   *  - Active states: cancels the task (kills agent, cleans up, marks cancelled).
   *  - Use ?permanent=true to force permanent deletion regardless of state.
   */
  app.delete('/tasks/:id', (c) => {
    const id = c.req.param('id');
    const existing = queries.getTaskById(id);
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    const terminalStatuses = ['approved', 'rejected', 'cancelled'];
    const forcePermanent = c.req.query('permanent') === 'true';
    const isTerminal = terminalStatuses.includes(existing.status);

    if (isTerminal || forcePermanent) {
      // Kill running agent if any (relevant when force-deleting active tasks)
      pool.killAgent(id);

      // Clean up worktree and branch
      const project = queries.getProjectById(existing.project_id);
      if (project) {
        if (existing.worktree_path) {
          git.removeWorktree(project.repo_path, existing.worktree_path);
        }
        if (existing.branch_name) {
          git.deleteBranch(project.repo_path, existing.branch_name);
        }
      }

      // Permanently delete from database
      queries.deleteTaskById(id);
      serverLog.info(`Task permanently deleted`, id);
      sseManager.broadcast('task:removed', { id });

      if (!isTerminal) {
        dispatcher.tryDispatch();
      }

      return c.json({ deleted: id });
    }

    // Active task — cancel (soft delete)
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

  /** Follow up: create a new task that resumes the conversation from an approved task. */
  app.post('/tasks/:id/follow-up', async (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'approved') {
      return c.json({ error: 'Only approved tasks can have follow-ups' }, 400);
    }

    const body = await c.req.json<{ prompt: string }>();
    if (!body.prompt?.trim()) {
      return c.json({ error: 'prompt is required' }, 400);
    }

    // Parse parent session data to carry forward the session ID
    const parentSession = task.agent_session_data
      ? JSON.parse(task.agent_session_data)
      : null;

    // Resolve agent_type from task type config
    const taskTypeConfig = config.task_types[task.type];
    const agentType = taskTypeConfig?.agent ?? task.agent_type ?? 'claude-code';

    // Create follow-up task with parent's session ID pre-populated
    const followUpTask = queries.createTask({
      project_id: task.project_id,
      type: task.type,
      prompt: body.prompt.trim(),
      priority: task.priority,
      depends_on: task.id,
      agent_type: agentType,
    });

    // Pre-populate session data so the dispatcher uses --resume
    if (parentSession?.session_id) {
      queries.updateTask(followUpTask.id, {
        agent_session_data: JSON.stringify({
          session_id: parentSession.session_id,
          pid: 0,
        }),
      });
    }

    taskQueue.recomputePositions(followUpTask.project_id);
    const updated = queries.getTaskById(followUpTask.id)!;

    queries.createTaskEvent(followUpTask.id, 'follow_up', JSON.stringify({ parent_task_id: id }));
    serverLog.info(`Follow-up task created from task ${id}`, followUpTask.id);
    sseManager.broadcast('task:created', updated);

    // Trigger dispatch check
    dispatcher.tryDispatch();

    return c.json(updated, 201);
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

  /** Get buffered progress messages for an in-progress task (for late-joining clients). */
  app.get('/tasks/:id/progress', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const messages = pool.getProgressBuffer(id);
    return c.json({ messages });
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
