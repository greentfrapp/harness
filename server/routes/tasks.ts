import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import type { CreateTaskInput, UpdateTaskInput } from '../../shared/types.ts';
import { OUTBOX_STATUSES, INBOX_STATUSES, DRAFT_STATUSES } from '../../shared/types.ts';
import * as git from '../git.ts';
import { readConfigRaw, saveConfigRaw, CONFIG_PATH } from '../config.ts';
import { serverLog } from '../log.ts';

export function createTaskRoutes(ctx: AppContext) {
  const app = new Hono();
  const { queries, sseManager, taskQueue, pool, dispatcher, config, checkoutState } = ctx;

  /** Auto-return a checkout if the given task is currently checked out. */
  function autoReturnIfCheckedOut(taskId: string): void {
    for (const [repoPath, entry] of checkoutState) {
      if (entry.taskId === taskId) {
        const task = queries.getTaskById(taskId);
        const project = task ? queries.getProjectById(task.project_id) : undefined;
        if (project) {
          try {
            git.returnCheckout(repoPath, project.target_branch, entry.checkoutBranch);
            serverLog.info(`Auto-returned checkout before action`, taskId);
          } catch (err) {
            serverLog.warn(`Auto-return failed: ${err instanceof Error ? err.message : String(err)}`, taskId);
          }
        }
        checkoutState.delete(repoPath);
        queries.createTaskEvent(taskId, 'returned', null);
        sseManager.broadcast('task:returned', { taskId, repoPath });
        break;
      }
    }
  }

  // --- Projects ---

  app.get('/projects', (c) => {
    return c.json(queries.getAllProjects());
  });

  app.get('/projects/status', (c) => {
    const projects = queries.getAllProjects();
    const statuses = projects.map((p) => {
      const { dirty, fileCount } = git.getRepoStatus(p.repo_path);
      return { projectId: p.id, projectName: p.name, dirty, fileCount };
    });
    return c.json(statuses);
  });

  // --- Config (task types for frontend) ---

  app.get('/config', (c) => {
    return c.json({ task_types: config.task_types, tags: config.tags });
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
      queries.getTasksByStatus([...DRAFT_STATUSES, ...OUTBOX_STATUSES, ...INBOX_STATUSES]),
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

    if (body.as_draft) {
      // Drafts don't enter the queue
      sseManager.broadcast('task:created', task);
      return c.json(task, 201);
    }

    taskQueue.recomputePositions(task.project_id);
    const updated = queries.getTaskById(task.id)!;

    sseManager.broadcast('task:created', updated);

    // Trigger dispatch check
    dispatcher.tryDispatch();

    return c.json(updated, 201);
  });

  /** Send a draft: transition from draft to queued. */
  app.post('/tasks/:id/send', async (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'draft') {
      return c.json({ error: 'Only draft tasks can be sent' }, 400);
    }

    // Allow updating prompt/priority/depends_on/tags when sending
    const body = await c.req.json<{ prompt?: string; priority?: string; depends_on?: string | null; tags?: string[] }>().catch(() => ({} as { prompt?: string; priority?: string; depends_on?: string | null; tags?: string[] }));
    const updateFields: Record<string, any> = { status: 'queued' };
    if (body.prompt?.trim()) updateFields.prompt = body.prompt.trim();
    if (body.priority) updateFields.priority = body.priority;
    if (body.depends_on !== undefined) updateFields.depends_on = body.depends_on;
    if (Array.isArray(body.tags)) updateFields.tags = body.tags;

    const updated = queries.updateTask(id, updateFields);
    queries.createTaskEvent(id, 'sent', JSON.stringify({ previous: 'draft' }));
    serverLog.info(`Draft task sent to queue`, id);

    taskQueue.recomputePositions(task.project_id);
    const final = queries.getTaskById(id)!;
    sseManager.broadcast('task:updated', final);
    dispatcher.tryDispatch();

    return c.json(final);
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

    // Auto-return if this task is currently checked out
    autoReturnIfCheckedOut(id);

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
      branch_name: null,
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
    if (task.status !== 'ready' && task.status !== 'error' && task.status !== 'held') {
      return c.json({ error: 'Task cannot be rejected in current status' }, 400);
    }

    // Auto-return if this task is currently checked out
    autoReturnIfCheckedOut(id);

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
      branch_name: null,
    });
    queries.createTaskEvent(id, 'rejected', null);
    serverLog.info(`Task rejected`, id);
    sseManager.broadcast('task:updated', updated);

    // Unblock children that depended on or followed up from this task
    const dependents = getDependentTasks(queries, id);
    queries.clearParentReferences(id);
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

  /** Fix: re-queue a ready task whose merge failed so the agent can resolve conflicts in its existing worktree. */
  app.post('/tasks/:id/fix', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'ready' && task.status !== 'error') {
      return c.json({ error: 'Only ready or error tasks can be fixed' }, 400);
    }

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Auto-return if this task is currently checked out
    autoReturnIfCheckedOut(id);

    // Augment prompt so the agent knows to resolve merge conflicts
    const fixPrefix = `[MERGE CONFLICT] Your branch failed to merge into ${project.target_branch} due to conflicts. Merge ${project.target_branch} into your branch and resolve all conflicts, then verify the code still works.\n\nOriginal task:\n`;
    const augmentedPrompt = task.prompt.startsWith('[MERGE CONFLICT]')
      ? task.prompt
      : fixPrefix + task.prompt;

    // Preserve worktree, branch, and session so the agent resumes in place
    const updated = queries.updateTask(id, {
      status: 'queued',
      prompt: augmentedPrompt,
      error_message: null,
      agent_summary: null,
      diff_summary: null,
    });
    queries.createTaskEvent(id, 'fix_merge_conflict', null);
    serverLog.info(`Task re-queued to fix merge conflict`, id);

    taskQueue.recomputePositions(task.project_id);
    sseManager.broadcast('task:updated', updated);
    dispatcher.tryDispatch();

    return c.json(updated);
  });

  /** Approve plan: re-queue a held plan-mode task for execution with full permissions. */
  app.post('/tasks/:id/approve-plan', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'held') {
      return c.json({ error: 'Only held tasks can have plans approved' }, 400);
    }

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Mark plan as approved in session data
    const sessionData = task.agent_session_data
      ? JSON.parse(task.agent_session_data)
      : { session_id: null, pid: 0 };
    sessionData.plan_approved = true;

    const updated = queries.updateTask(id, {
      status: 'queued',
      prompt: 'Your plan has been approved. Execute it now — you have full permissions to make changes.',
      error_message: null,
      agent_summary: null,
      diff_summary: null,
      agent_session_data: JSON.stringify(sessionData),
    });
    queries.createTaskEvent(id, 'plan_approved', null);
    serverLog.info(`Plan approved, task re-queued for execution`, id);

    taskQueue.recomputePositions(task.project_id);
    sseManager.broadcast('task:updated', updated);
    dispatcher.tryDispatch();

    return c.json(updated);
  });

  /** Grant permission: add the blocked tool to granted_tools, re-queue for --resume. */
  app.post('/tasks/:id/grant-permission', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'permission') {
      return c.json({ error: 'Only permission tasks can be granted' }, 400);
    }

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Add the blocked tool to the cumulative granted_tools list.
    // For Bash, use command-level patterns like Bash(curl:*) instead of blanket Bash.
    const sessionData = task.agent_session_data ? JSON.parse(task.agent_session_data) : {};
    const grantedTools = new Set<string>(sessionData.granted_tools ?? []);
    if (sessionData.pending_tool) {
      let grantPattern = sessionData.pending_tool;
      if (sessionData.pending_tool === 'Bash' && sessionData.pending_tool_input?.command) {
        const firstWord = sessionData.pending_tool_input.command.trim().split(/\s+/)[0];
        if (firstWord) grantPattern = `Bash(${firstWord}:*)`;
      }
      grantedTools.add(grantPattern);
      serverLog.info(`Granting tool: ${grantPattern}`, id);
    }
    const grantedTool = sessionData.pending_tool ?? 'the requested tool';
    sessionData.granted_tools = [...grantedTools];
    delete sessionData.pending_tool;
    delete sessionData.pending_tool_input;

    const updated = queries.updateTask(id, {
      status: 'queued',
      prompt: `Permission granted for ${grantedTool}. Continue with your task.`,
      error_message: null,
      agent_session_data: JSON.stringify(sessionData),
    });
    queries.createTaskEvent(id, 'permission_granted', JSON.stringify({ tool: sessionData.granted_tools }));
    serverLog.info(`Permission granted, task re-queued`, id);

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
    const isDraft = existing.status === 'draft';
    const isTerminal = terminalStatuses.includes(existing.status);

    if (isTerminal || isDraft || forcePermanent) {
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

    // Unblock children that depended on or followed up from this task
    queries.clearParentReferences(id);

    const updated = queries.updateTask(id, {
      status: 'cancelled',
      worktree_path: null,
      branch_name: null,
    });
    queries.createTaskEvent(id, 'cancelled', null);
    sseManager.broadcast('task:updated', updated);

    // Trigger dispatch — a slot just freed up
    dispatcher.tryDispatch();

    return c.json(updated);
  });

  /** Revise: return a ready/error task to the outbox with feedback, preserving worktree and session. */
  app.post('/tasks/:id/revise', async (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'ready' && task.status !== 'error' && task.status !== 'held') {
      return c.json({ error: 'Only ready, error, or held tasks can be revised' }, 400);
    }

    // Auto-return if this task is currently checked out
    autoReturnIfCheckedOut(id);

    const body = await c.req.json<{ prompt: string }>();
    if (!body.prompt?.trim()) {
      return c.json({ error: 'prompt is required' }, 400);
    }

    // Replace prompt with the revise feedback — the original prompt is already
    // in the agent's session history and will be replayed via --resume
    const updated = queries.updateTask(id, {
      status: 'queued',
      prompt: body.prompt.trim(),
      error_message: null,
      agent_summary: null,
      diff_summary: null,
      // Preserve: agent_session_data (for --resume), worktree_path, branch_name
    });
    queries.createTaskEvent(id, 'revised', JSON.stringify({ feedback: body.prompt.trim() }));
    serverLog.info(`Task revised and re-queued`, id);

    taskQueue.recomputePositions(task.project_id);
    sseManager.broadcast('task:updated', updated);
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

    // Guard: only one active follow-up per parent task
    const activeFollowUps = queries.getTasksByStatus([
      'queued', 'in_progress', 'retrying', 'ready', 'error',
    ]).filter((t) => t.parent_task_id === id);
    if (activeFollowUps.length > 0) {
      return c.json({
        error: 'A follow-up for this task is already in progress',
        active_follow_up_id: activeFollowUps[0].id,
      }, 409);
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

    // Create follow-up task with parent_task_id for lineage (not depends_on)
    const followUpTask = queries.createTask({
      project_id: task.project_id,
      type: task.type,
      prompt: body.prompt.trim(),
      priority: task.priority,
      agent_type: agentType,
    });

    // Set parent_task_id and pre-populate session data for --resume
    const sessionUpdate: Record<string, any> = { parent_task_id: id };
    if (parentSession?.session_id) {
      sessionUpdate.agent_session_data = JSON.stringify({
        session_id: parentSession.session_id,
        pid: 0,
      });
    }
    queries.updateTask(followUpTask.id, sessionUpdate);

    taskQueue.recomputePositions(followUpTask.project_id);
    const updated = queries.getTaskById(followUpTask.id)!;

    queries.createTaskEvent(followUpTask.id, 'follow_up', JSON.stringify({ parent_task_id: id }));
    serverLog.info(`Follow-up task created from task ${id}`, followUpTask.id);
    sseManager.broadcast('task:created', updated);

    // Trigger dispatch check
    dispatcher.tryDispatch();

    return c.json(updated, 201);
  });

  // --- Checkout ---

  /** List all active checkouts (for initial page load). */
  app.get('/checkouts', (c) => {
    const result: Array<{ taskId: string; taskPrompt: string; repoPath: string; projectName: string; projectId: string }> = [];
    for (const [repoPath, entry] of checkoutState) {
      const task = queries.getTaskById(entry.taskId);
      const project = task ? queries.getProjectById(task.project_id) : undefined;
      if (task && project) {
        result.push({
          taskId: entry.taskId,
          taskPrompt: task.prompt.slice(0, 100),
          repoPath,
          projectName: project.name,
          projectId: project.id,
        });
      }
    }
    return c.json(result);
  });

  /** Checkout: merge task branch into a temp branch and check it out in the repo for manual testing. */
  app.post('/tasks/:id/checkout', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'ready' && task.status !== 'error') {
      return c.json({ error: 'Only ready or error tasks can be checked out' }, 400);
    }
    if (!task.branch_name) {
      return c.json({ error: 'Task has no branch to checkout' }, 400);
    }

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Check if this repo already has a checkout active
    const existing = checkoutState.get(project.repo_path);
    if (existing) {
      const existingTask = queries.getTaskById(existing.taskId);
      return c.json({
        error: `Another task is already checked out in this repo`,
        checked_out_task_id: existing.taskId,
        checked_out_task_prompt: existingTask?.prompt.slice(0, 100) ?? '',
      }, 409);
    }

    const checkoutBranch = `harness/checkout-${id.slice(0, 8)}`;

    try {
      git.checkoutTask(project.repo_path, project.target_branch, task.branch_name, checkoutBranch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      serverLog.error(`Checkout failed: ${msg}`, id);
      return c.json({ error: `Checkout failed: ${msg}` }, 500);
    }

    checkoutState.set(project.repo_path, { taskId: id, checkoutBranch });
    queries.createTaskEvent(id, 'checked_out', null);
    serverLog.info(`Task checked out to ${checkoutBranch}`, id);

    const payload = {
      taskId: id,
      taskPrompt: task.prompt.slice(0, 100),
      repoPath: project.repo_path,
      projectName: project.name,
      projectId: project.id,
    };
    sseManager.broadcast('task:checked_out', payload);

    return c.json({ ok: true, checkout_branch: checkoutBranch });
  });

  /** Return: switch repo back to target branch, delete checkout branch, clear state. */
  app.post('/tasks/:id/return', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const existing = checkoutState.get(project.repo_path);
    if (!existing || existing.taskId !== id) {
      return c.json({ error: 'This task is not currently checked out' }, 400);
    }

    try {
      git.returnCheckout(project.repo_path, project.target_branch, existing.checkoutBranch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      serverLog.error(`Return failed: ${msg}`, id);
      return c.json({ error: `Return failed: ${msg}` }, 500);
    }

    checkoutState.delete(project.repo_path);
    queries.createTaskEvent(id, 'returned', null);
    serverLog.info(`Task returned, repo restored to ${project.target_branch}`, id);
    sseManager.broadcast('task:returned', { taskId: id, repoPath: project.repo_path });

    return c.json({ ok: true });
  });

  /** Get diff for a completed task. */
  app.get('/tasks/:id/diff', (c) => {
    const id = c.req.param('id');
    const task = queries.getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const project = queries.getProjectById(task.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    let diff = '';
    let stats = '';
    let uncommitted = false;

    // Only attempt live diff if the branch still exists
    if (task.branch_name && git.branchExists(project.repo_path, task.branch_name)) {
      diff = git.getDiff(
        project.repo_path,
        project.target_branch,
        task.branch_name,
      );
      stats = git.getDiffStats(
        project.repo_path,
        project.target_branch,
        task.branch_name,
      );

      // Backfill cache on first successful live diff
      if (diff && !task.diff_full) {
        queries.updateTask(id, { diff_full: diff });
      }
    }

    // Fall back to cached values for whichever field is empty
    if (!diff && task.diff_full) diff = task.diff_full;
    if (!stats && task.diff_summary) stats = task.diff_summary;

    // If still no committed diff, check for uncommitted changes in the worktree
    if (!diff && task.worktree_path) {
      const uncommittedDiff = git.getUncommittedDiff(task.worktree_path);
      if (uncommittedDiff) {
        diff = uncommittedDiff;
        stats = git.getUncommittedDiffStats(task.worktree_path);
        uncommitted = true;
      }
    }

    return c.json({ diff, stats, uncommitted });
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
