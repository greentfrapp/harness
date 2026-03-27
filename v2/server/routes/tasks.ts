import { Hono } from 'hono'
import type { Context } from 'hono'
import type {
  CreateTaskInput,
  Priority,
  Project,
  SubtaskProposalInput,
  Task,
  TaskStatus,
  TaskSubstatus,
  UpdateTaskInput,
} from '../../shared/types'
import { getErrorMessage, isRunning, isTerminal } from '../../shared/types'
import {
  findAction,
  transition,
  type TransitionAction,
} from '../../shared/transitions'
import {
  CONFIG_PATH,
  getDefaultTaskTypes,
  readConfigRaw,
  saveConfigRaw,
} from '../config'
import type { AppContext } from '../context'
import * as git from '../git'
import { serverLog } from '../log'
import { getSessionData } from '../pool'
import { deleteSessionMessages, loadSessionMessages } from '../sessions'

export function createTaskRoutes(ctx: AppContext) {
  const app = new Hono()
  const {
    queries,
    sseManager,
    taskQueue,
    pool,
    dispatcher,
    config,
    checkoutState,
  } = ctx

  /** Look up a task by ID or return a 404 response. */
  function getTaskOr404(c: Context, id: string): Task | Response {
    const task = queries.getTaskById(id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    return task
  }

  /** Look up a task and its project, or return a 404 response. */
  function getTaskWithProjectOr404(
    c: Context,
    id: string,
  ): { task: Task; project: Project } | Response {
    const task = queries.getTaskById(id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    const project = queries.getProjectById(task.project_id)
    if (!project) return c.json({ error: 'Project not found' }, 404)
    return { task, project }
  }

  /** Validate a status transition, returning the target or a 400 response. */
  function guardTransition(
    c: Context,
    status: TaskStatus,
    substatus: TaskSubstatus,
    action: TransitionAction,
  ): { status: TaskStatus; substatus: TaskSubstatus } | Response {
    try {
      return transition(status, substatus, action)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }

  /** Clean up a task's worktree and branch. */
  function cleanupWorktree(project: Project, task: Task): void {
    if (task.worktree_path) {
      serverLog.info(`Removing worktree ${task.worktree_path}`, task.id)
      git.removeWorktree(project.repo_path, task.worktree_path)
    }
    if (task.branch_name) {
      serverLog.info(`Deleting branch ${task.branch_name}`, task.id)
      git.deleteBranch(project.repo_path, task.branch_name)
    }
  }

  /** Auto-return a checkout if the given task is currently checked out. */
  function autoReturnIfCheckedOut(taskId: string): void {
    for (const [repoPath, entry] of checkoutState) {
      if (entry.taskId === taskId) {
        const task = queries.getTaskById(taskId)
        const project = task
          ? queries.getProjectById(task.project_id)
          : undefined
        if (project) {
          try {
            git.returnCheckout(
              repoPath,
              project.target_branch,
              entry.checkoutBranch,
            )
            serverLog.info(`Auto-returned checkout before action`, taskId)
          } catch (err) {
            serverLog.warn(
              `Auto-return failed: ${getErrorMessage(err)}`,
              taskId,
            )
          }
        }
        checkoutState.delete(repoPath)
        queries.createTaskEvent(taskId, 'returned', null)
        sseManager.broadcast('task:returned', { taskId, repoPath })
        break
      }
    }
  }

  // --- Projects ---

  app.get('/projects', (c) => {
    return c.json(queries.getAllProjects())
  })

  app.get('/projects/status', (c) => {
    const projects = queries.getAllProjects()
    const statuses = projects.map((p) => {
      const { dirty, fileCount } = git.getRepoStatus(p.repo_path)
      return { projectId: p.id, projectName: p.name, dirty, fileCount }
    })
    return c.json(statuses)
  })

  // --- Config (task types for frontend) ---

  app.get('/config', (c) => {
    return c.json({ task_types: config.task_types, tags: config.tags })
  })

  /** Return built-in default task types for the "restore defaults" button. */
  app.get('/config/defaults/task-types', (c) => {
    return c.json(getDefaultTaskTypes())
  })

  /** Read raw config.jsonc content for the settings editor. */
  app.get('/config/raw', (c) => {
    return c.json({ content: readConfigRaw(), path: CONFIG_PATH })
  })

  /** Validate and save raw config.jsonc content. */
  app.put('/config/raw', async (c) => {
    const body = await c.req.json<{ content: string }>()
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400)
    }

    const result = saveConfigRaw(body.content)
    if (!result.ok) {
      return c.json({ error: result.error }, 400)
    }

    // Reload config in the running context
    Object.assign(ctx.config, result.config)

    // Re-seed projects from updated config
    queries.seedProjects(result.config)

    return c.json({ ok: true })
  })

  // --- Tasks ---

  app.get('/tasks', (c) => {
    const status = c.req.query('status')
    const projectId = c.req.query('project_id')

    if (status) {
      const statuses = status.split(',') as TaskStatus[]
      return c.json(queries.getTasksByStatus(statuses))
    }
    if (projectId) {
      return c.json(queries.getTasksByProject(projectId))
    }
    // Return all non-terminal + terminal tasks
    return c.json(
      queries.getTasksByStatus([
        'draft',
        'queued',
        'in_progress',
        'pending',
        'done',
        'cancelled',
      ]),
    )
  })

  app.get('/tasks/:id', (c) => {
    const result = getTaskOr404(c, c.req.param('id'))
    if (result instanceof Response) return result
    const events = queries.getTaskEvents(result.id)
    return c.json({ ...result, events })
  })

  app.post('/tasks', async (c) => {
    const body = await c.req.json<CreateTaskInput>()

    if (!body.project_id || !body.type || (!body.prompt && !body.title)) {
      return c.json(
        { error: 'project_id, type, and either title or prompt are required' },
        400,
      )
    }

    // Resolve agent_type from task type config if not explicitly provided
    if (!body.agent_type) {
      const taskTypeConfig = config.task_types[body.type]
      body.agent_type = taskTypeConfig?.agent ?? 'claude-code'
    }

    const task = queries.createTask(body)

    if (body.as_draft) {
      // Drafts don't enter the queue
      sseManager.broadcast('task:created', task)
      return c.json(task, 201)
    }

    taskQueue.recomputePositions(task.project_id)
    const updated = queries.getTaskById(task.id)!

    sseManager.broadcast('task:created', updated)

    // Trigger dispatch — may change status to in_progress synchronously
    dispatcher.tryDispatch()

    // Re-read after dispatch so the response reflects the current status
    const current = queries.getTaskById(task.id)!
    return c.json(current, 201)
  })

  /** Send a draft: transition from draft to queued. */
  app.post('/tasks/:id/send', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result
    const task = result
    const target = guardTransition(c, task.status, task.substatus, 'send')
    if (target instanceof Response) return target

    // Allow updating prompt/priority/depends_on/tags when sending
    const body = await c.req
      .json<{
        prompt?: string
        priority?: string
        depends_on?: string | null
        tags?: string[]
      }>()
      .catch(
        () =>
          ({}) as {
            prompt?: string
            priority?: string
            depends_on?: string | null
            tags?: string[]
          },
      )
    const updateFields: Record<string, any> = {
      status: target.status,
      substatus: target.substatus,
    }
    if (body.prompt?.trim()) updateFields.prompt = body.prompt.trim()
    if (body.priority) updateFields.priority = body.priority
    if (body.depends_on !== undefined) updateFields.depends_on = body.depends_on
    if (Array.isArray(body.tags)) updateFields.tags = body.tags

    queries.updateTask(id, updateFields)
    queries.createTaskEvent(id, 'sent', JSON.stringify({ previous: 'draft' }))
    serverLog.info(`Draft task sent to queue`, id)

    taskQueue.recomputePositions(task.project_id)
    const sent = queries.getTaskById(id)!
    sseManager.broadcast('task:updated', sent)

    // Trigger dispatch
    dispatcher.tryDispatch()

    const current = queries.getTaskById(id)!
    return c.json(current)
  })

  app.patch('/tasks/:id', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result
    const existing = result

    const body = await c.req.json<UpdateTaskInput>()

    // Validate status transitions if status is changing
    if (body.status && body.status !== existing.status) {
      const action = findAction(
        existing.status,
        existing.substatus,
        body.status,
        body.substatus ?? null,
      )
      if (!action) {
        const fromPair = existing.substatus
          ? `${existing.status}:${existing.substatus}`
          : existing.status
        const toPair = body.substatus
          ? `${body.status}:${body.substatus}`
          : body.status
        return c.json(
          {
            error: `Cannot transition from '${fromPair}' to '${toPair}'`,
          },
          400,
        )
      }
    }

    const updated = queries.updateTask(id, body)

    if (body.status && body.status !== existing.status) {
      queries.createTaskEvent(
        id,
        body.status,
        JSON.stringify({ previous: existing.status }),
      )

      if (
        body.status === 'pending' ||
        body.status === 'done' ||
        body.status === 'cancelled'
      ) {
        sseManager.broadcast('inbox:new', updated)
      } else {
        sseManager.broadcast('task:updated', updated)
      }
    } else {
      sseManager.broadcast('task:updated', updated)
    }

    return c.json(updated)
  })

  // --- Task Actions ---

  /** Approve: merge branch into target, destroy worktree, mark done:accepted. */
  app.post('/tasks/:id/approve', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(c, id)
    if (result instanceof Response) return result
    const { task, project } = result
    const target = guardTransition(c, task.status, task.substatus, 'approve')
    if (target instanceof Response) return target

    // Kill any active chat before status change
    pool.killChatAgent(id)
    // Auto-return if this task is currently checked out
    autoReturnIfCheckedOut(id)

    // Merge branch if it exists
    if (task.branch_name) {
      if (
        !git.hasCommits(
          project.repo_path,
          project.target_branch,
          task.branch_name,
        )
      ) {
        serverLog.warn(
          `Task branch has no commits ahead of ${project.target_branch}`,
          id,
        )
        return c.json(
          {
            error:
              'No changes to merge — the agent may not have committed its work',
          },
          409,
        )
      }

      try {
        serverLog.info(
          `Merging ${task.branch_name} into ${project.target_branch}`,
          id,
        )
        git.mergeBranch(
          project.repo_path,
          project.target_branch,
          task.branch_name,
          {
            push: !!project.auto_push,
          },
        )
        serverLog.info(
          `Merge successful${project.auto_push ? ' (pushed to remote)' : ''}`,
          id,
        )
      } catch (err) {
        const msg = getErrorMessage(err)
        serverLog.error(`Merge failed: ${msg}`, id)
        return c.json({ error: `Merge failed: ${msg}` }, 409)
      }

      // Clean up worktree (but keep branch for diff review)
      if (task.worktree_path) {
        git.removeWorktree(project.repo_path, task.worktree_path)
      }
    }

    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      worktree_path: null,
      completed_at: Date.now(),
    })
    queries.createTaskEvent(id, 'approved', null)
    serverLog.info(`Task approved`, id)
    sseManager.broadcast('task:updated', updated)

    // Trigger dispatch — dependencies may now be satisfied
    dispatcher.tryDispatch()

    return c.json(updated)
  })

  /** Reject: destroy worktree + branch, mark done:rejected. */
  app.post('/tasks/:id/reject', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(c, id)
    if (result instanceof Response) return result
    const { task, project } = result
    const target = guardTransition(c, task.status, task.substatus, 'reject')
    if (target instanceof Response) return target

    // Kill any active chat before status change
    pool.killChatAgent(id)
    // Auto-return if this task is currently checked out
    autoReturnIfCheckedOut(id)

    cleanupWorktree(project, task)

    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      worktree_path: null,
      branch_name: null,
      completed_at: Date.now(),
    })
    queries.createTaskEvent(id, 'rejected', null)
    serverLog.info(`Task rejected`, id)
    sseManager.broadcast('task:updated', updated)

    // Unblock children that depended on or followed up from this task
    const dependents = getDependentTasks(queries, id)
    queries.clearParentReferences(id)
    if (dependents.length > 0) {
      return c.json({
        ...updated,
        blocked_dependents: dependents.map((t) => ({
          id: t.id,
          title: t.title?.slice(0, 100),
          status: t.status,
        })),
      })
    }

    return c.json(updated)
  })

  /** Fix: re-queue a pending:review task to address an issue. */
  app.post('/tasks/:id/fix', async (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(c, id)
    if (result instanceof Response) return result
    const { task } = result
    const target = guardTransition(c, task.status, task.substatus, 'fix')
    if (target instanceof Response) return target

    // Auto-return if this task is currently checked out
    autoReturnIfCheckedOut(id)

    // Determine fix type from request body (default: merge-conflict)
    let fixType = 'merge-conflict'
    try {
      const body = await c.req.json<{ type?: string }>()
      if (
        body.type &&
        ['merge-conflict', 'checkout-failed', 'needs-commit'].includes(
          body.type,
        )
      ) {
        fixType = body.type
      }
    } catch {
      // No body or invalid JSON — use default
    }

    // Add the fix type as a tag
    const tags = task.tags.includes(fixType)
      ? task.tags
      : [...task.tags, fixType]

    // Preserve worktree, branch, and session so the agent resumes in place
    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      tags,
      result: null,
    })
    queries.createTaskEvent(id, `fix_${fixType.replace(/-/g, '_')}`, null)
    serverLog.info(`Task re-queued to fix ${fixType}`, id)

    taskQueue.recomputePositions(task.project_id)
    sseManager.broadcast('task:updated', updated)
    dispatcher.tryDispatch()

    return c.json(updated)
  })

  /** Grant permission: add the blocked tool to granted_tools, re-queue. */
  app.post('/tasks/:id/grant-permission', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(c, id)
    if (result instanceof Response) return result
    const { task } = result
    const target = guardTransition(
      c,
      task.status,
      task.substatus,
      'grant_permission',
    )
    if (target instanceof Response) return target

    // Add the blocked tool to the cumulative granted_tools list.
    const sessionData = getSessionData(task) ?? { session_id: null, pid: 0 }
    const grantedTools = new Set<string>(sessionData.granted_tools ?? [])
    if (sessionData.pending_tool) {
      let grantPattern = sessionData.pending_tool
      if (
        sessionData.pending_tool === 'Bash' &&
        sessionData.pending_tool_input?.command
      ) {
        const firstWord = sessionData.pending_tool_input.command
          .trim()
          .split(/\s+/)[0]
        if (firstWord) grantPattern = `Bash(${firstWord}:*)`
      }
      grantedTools.add(grantPattern)
      serverLog.info(`Granting tool: ${grantPattern}`, id)
    }
    const grantedTool = sessionData.pending_tool ?? 'the requested tool'
    sessionData.granted_tools = [...grantedTools]
    delete sessionData.pending_tool
    delete sessionData.pending_tool_input

    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      prompt: `Permission granted for ${grantedTool}. Continue with your task.`,
      result: null,
      agent_session_data: JSON.stringify(sessionData),
    })
    queries.createTaskEvent(
      id,
      'permission_granted',
      JSON.stringify({ tool: sessionData.granted_tools }),
    )
    serverLog.info(`Permission granted, task re-queued`, id)

    taskQueue.recomputePositions(task.project_id)
    sseManager.broadcast('task:updated', updated)
    dispatcher.tryDispatch()

    return c.json(updated)
  })

  /** Revise: return a pending:review task to the outbox with feedback. */
  app.post('/tasks/:id/revise', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result
    const task = result
    const target = guardTransition(c, task.status, task.substatus, 'revise')
    if (target instanceof Response) return target

    // Kill any active chat before status change
    pool.killChatAgent(id)
    // Auto-return if this task is currently checked out
    autoReturnIfCheckedOut(id)

    const body = await c.req.json<{ prompt: string }>()
    if (!body.prompt?.trim()) {
      return c.json({ error: 'prompt is required' }, 400)
    }

    // Replace prompt with the revise feedback — the original prompt is already
    // in the agent's session history and will be replayed via --resume.
    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      prompt: body.prompt.trim(),
      result: null,
      // Preserve: agent_session_data (for --resume), worktree_path, branch_name
    })
    queries.createTaskEvent(
      id,
      'revised',
      JSON.stringify({ feedback: body.prompt.trim() }),
    )
    serverLog.info(`Task revised and re-queued`, id)

    taskQueue.recomputePositions(task.project_id)
    sseManager.broadcast('task:updated', updated)
    dispatcher.tryDispatch()

    return c.json(updated)
  })

  /** Follow up: create a new task that resumes the conversation from a completed task. */
  app.post('/tasks/:id/follow-up', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result
    const task = result
    // Allow follow-up on inbox tasks
    const FOLLOW_UP_STATUSES: TaskStatus[] = ['pending', 'done']
    if (!FOLLOW_UP_STATUSES.includes(task.status)) {
      return c.json(
        { error: `Cannot follow up on task in status '${task.status}'` },
        400,
      )
    }

    // Guard: only one active follow-up per parent task
    const activeFollowUps = queries
      .getTasksByStatus(['queued', 'in_progress'])
      .filter((t) => t.parent_task_id === id)
    if (activeFollowUps.length > 0) {
      return c.json(
        {
          error: 'A follow-up for this task is already in progress',
          active_follow_up_id: activeFollowUps[0].id,
        },
        409,
      )
    }

    const body = await c.req.json<{ prompt: string; type?: string }>()
    if (!body.prompt?.trim()) {
      return c.json({ error: 'prompt is required' }, 400)
    }

    // Resolve follow-up type (defaults to parent type)
    const followUpType = body.type?.trim() || task.type
    if (body.type && !config.task_types[followUpType]) {
      return c.json({ error: `Unknown task type: ${followUpType}` }, 400)
    }

    // Parse parent session data to carry forward the session ID
    const parentSession = getSessionData(task)

    // Resolve agent_type from the follow-up type's config
    const taskTypeConfig = config.task_types[followUpType]
    const agentType = taskTypeConfig?.agent ?? task.agent_type ?? 'claude-code'

    // Create follow-up task with parent_task_id for lineage
    const followUpTask = queries.createTask({
      project_id: task.project_id,
      type: followUpType,
      prompt: body.prompt.trim(),
      priority: task.priority,
      agent_type: agentType,
    })

    // Set parent_task_id and pre-populate session data for --resume
    const sessionUpdate: Record<string, any> = { parent_task_id: id }
    if (parentSession?.session_id) {
      sessionUpdate.agent_session_data = JSON.stringify({
        session_id: parentSession.session_id,
        pid: 0,
      })
    }
    queries.updateTask(followUpTask.id, sessionUpdate)

    taskQueue.recomputePositions(followUpTask.project_id)
    const updated = queries.getTaskById(followUpTask.id)!

    queries.createTaskEvent(
      followUpTask.id,
      'follow_up',
      JSON.stringify({ parent_task_id: id }),
    )
    serverLog.info(`Follow-up task created from task ${id}`, followUpTask.id)
    sseManager.broadcast('task:created', updated)

    // Trigger dispatch check
    dispatcher.tryDispatch()

    return c.json(updated, 201)
  })

  /** Approve mode-escalation transition: complete source task, spawn new task of target type. */
  app.post('/tasks/:id/approve-transition', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result
    const task = result
    const target = guardTransition(
      c,
      task.status,
      task.substatus,
      'approve_transition',
    )
    if (target instanceof Response) return target

    const body = await c.req.json<{
      target_type: string
      prompt?: string
    }>()
    if (!body.target_type) {
      return c.json({ error: 'target_type is required' }, 400)
    }

    // Complete the source task
    queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      completed_at: Date.now(),
    })
    queries.createTaskEvent(id, 'transition_approved', null)
    sseManager.broadcast('task:updated', queries.getTaskById(id))

    // Spawn the new task with the same session for continuity
    const parentSession = getSessionData(task)
    const taskTypeConfig = config.task_types[body.target_type]
    const agentType = taskTypeConfig?.agent ?? task.agent_type ?? 'claude-code'

    const newTask = queries.createTask({
      project_id: task.project_id,
      type: body.target_type,
      title: task.title,
      prompt: body.prompt?.trim() || task.prompt,
      priority: task.priority,
      tags: task.tags,
      parent_task_id: id,
      agent_type: agentType,
    })

    // Pre-populate session data for --resume continuity
    if (parentSession?.session_id) {
      queries.updateTask(newTask.id, {
        agent_session_data: JSON.stringify({
          session_id: parentSession.session_id,
          pid: 0,
        }),
        session_id: parentSession.session_id,
      })
    }

    // Record the mode-escalation transition
    queries.createTaskTransition(id, newTask.id, `${task.type}_to_${body.target_type}`)

    taskQueue.recomputePositions(newTask.project_id)
    const created = queries.getTaskById(newTask.id)!
    sseManager.broadcast('task:created', created)
    dispatcher.tryDispatch()

    serverLog.info(
      `Transition approved: ${task.type} → ${body.target_type}`,
      id,
    )

    return c.json({ source: queries.getTaskById(id), target: created }, 201)
  })

  /** Cancel: kill agent, clean up, mark cancelled. */
  app.delete('/tasks/:id', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result
    const existing = result

    const forcePermanent = c.req.query('permanent') === 'true'
    const isDraft = existing.status === 'draft'
    const terminal = isTerminal(existing.status, existing.substatus)

    if (terminal || isDraft || forcePermanent) {
      // Kill running agent or chat agent if any
      pool.killAgent(id)
      pool.killChatAgent(id)

      // Clean up worktree and branch
      const project = queries.getProjectById(existing.project_id)
      if (project) cleanupWorktree(project, existing)

      // Permanently delete from database
      queries.deleteTasksByIds([id])
      deleteSessionMessages(id)
      serverLog.info(`Task permanently deleted`, id)
      sseManager.broadcast('task:removed', { id })

      if (!terminal) {
        dispatcher.tryDispatch()
      }

      return c.json({ deleted: id })
    }

    // Active task — cancel (soft delete)
    const target = guardTransition(
      c,
      existing.status,
      existing.substatus,
      'cancel',
    )
    if (target instanceof Response) return target

    pool.killAgent(id)
    pool.killChatAgent(id)

    // Clean up worktree and branch
    const cancelProject = queries.getProjectById(existing.project_id)
    if (cancelProject) cleanupWorktree(cancelProject, existing)

    // Unblock children that depended on or followed up from this task
    queries.clearParentReferences(id)

    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      worktree_path: null,
      branch_name: null,
      completed_at: Date.now(),
    })
    queries.createTaskEvent(id, 'cancelled', null)
    sseManager.broadcast('task:updated', updated)

    // Trigger dispatch — a slot just freed up
    dispatcher.tryDispatch()

    return c.json(updated)
  })

  /** Bulk delete: permanently remove tasks by IDs or by status. */
  app.delete('/tasks', async (c) => {
    const statusParam = c.req.query('status')

    let tasksToDelete: Task[]
    if (statusParam) {
      const statuses = statusParam.split(',').filter(Boolean) as TaskStatus[]
      tasksToDelete = queries.getTasksByStatus(statuses)
    } else {
      const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}))
      const ids = (body as { ids?: string[] }).ids
      if (!Array.isArray(ids) || ids.length === 0) {
        return c.json(
          { error: 'ids array or status query parameter is required' },
          400,
        )
      }
      tasksToDelete = ids
        .map((id) => queries.getTaskById(id))
        .filter((t): t is NonNullable<typeof t> => t != null)
    }

    if (tasksToDelete.length === 0) {
      return c.json({ deleted: [] })
    }

    let hadRunning = false
    for (const task of tasksToDelete) {
      if (isRunning(task.status, task.substatus)) {
        pool.killAgent(task.id)
        hadRunning = true
      }
      const project = queries.getProjectById(task.project_id)
      if (project) cleanupWorktree(project, task)
    }

    const deleted = queries.deleteTasksByIds(tasksToDelete.map((t) => t.id))
    const ids = deleted.map((t) => t.id)

    for (const deletedId of ids) {
      deleteSessionMessages(deletedId)
      sseManager.broadcast('task:removed', { id: deletedId })
    }

    if (hadRunning) {
      dispatcher.tryDispatch()
    }

    return c.json({ deleted: ids })
  })

  // --- Checkout ---

  /** List all active checkouts (for initial page load). */
  app.get('/checkouts', (c) => {
    const checkoutResult: Array<{
      taskId: string
      taskTitle: string
      repoPath: string
      projectName: string
      projectId: string
    }> = []
    for (const [repoPath, entry] of checkoutState) {
      const task = queries.getTaskById(entry.taskId)
      const project = task ? queries.getProjectById(task.project_id) : undefined
      if (task && project) {
        checkoutResult.push({
          taskId: entry.taskId,
          taskTitle: (task.title ?? task.prompt ?? '').slice(0, 100),
          repoPath,
          projectName: project.name,
          projectId: project.id,
        })
      }
    }
    return c.json(checkoutResult)
  })

  /** Checkout: merge task branch into a temp branch and check it out in the repo. */
  app.post('/tasks/:id/checkout', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(c, id)
    if (result instanceof Response) return result
    const { task, project } = result
    // Only pending:review tasks can be checked out
    if (task.status !== 'pending' || task.substatus !== 'review') {
      return c.json(
        { error: 'Only pending:review tasks can be checked out' },
        400,
      )
    }
    if (!task.branch_name) {
      return c.json({ error: 'Task has no branch to checkout' }, 400)
    }

    // Check if this repo already has a checkout active
    const existing = checkoutState.get(project.repo_path)
    if (existing) {
      const existingTask = queries.getTaskById(existing.taskId)
      return c.json(
        {
          error: `Another task is already checked out in this repo`,
          checked_out_task_id: existing.taskId,
          checked_out_task_title: existingTask?.title?.slice(0, 100) ?? '',
        },
        409,
      )
    }

    const checkoutBranch = `harness/checkout-${id.slice(0, 8)}`

    try {
      git.checkoutTask(
        project.repo_path,
        project.target_branch,
        task.branch_name,
        checkoutBranch,
      )
    } catch (err) {
      const msg = getErrorMessage(err)
      serverLog.error(`Checkout failed: ${msg}`, id)
      return c.json({ error: `Checkout failed: ${msg}` }, 500)
    }

    checkoutState.set(project.repo_path, { taskId: id, checkoutBranch })
    queries.createTaskEvent(id, 'checked_out', null)
    serverLog.info(`Task checked out to ${checkoutBranch}`, id)

    const payload = {
      taskId: id,
      taskTitle: (task.title ?? task.prompt ?? '').slice(0, 100),
      repoPath: project.repo_path,
      projectName: project.name,
      projectId: project.id,
    }
    sseManager.broadcast('task:checked_out', payload)

    return c.json({ ok: true, checkout_branch: checkoutBranch })
  })

  /** Return: switch repo back to target branch, delete checkout branch, clear state. */
  app.post('/tasks/:id/return', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(c, id)
    if (result instanceof Response) return result
    const { project } = result

    const existing = checkoutState.get(project.repo_path)
    if (!existing || existing.taskId !== id) {
      return c.json({ error: 'This task is not currently checked out' }, 400)
    }

    try {
      git.returnCheckout(
        project.repo_path,
        project.target_branch,
        existing.checkoutBranch,
      )
    } catch (err) {
      const msg = getErrorMessage(err)
      serverLog.error(`Return failed: ${msg}`, id)
      return c.json({ error: `Return failed: ${msg}` }, 500)
    }

    checkoutState.delete(project.repo_path)
    queries.createTaskEvent(id, 'returned', null)
    serverLog.info(
      `Task returned, repo restored to ${project.target_branch}`,
      id,
    )
    sseManager.broadcast('task:returned', {
      taskId: id,
      repoPath: project.repo_path,
    })

    return c.json({ ok: true })
  })

  /** Get diff for a task. */
  app.get('/tasks/:id/diff', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(c, id)
    if (result instanceof Response) return result
    const { task, project } = result

    let diff = ''
    let stats = ''
    let uncommitted = false

    // Only attempt live diff if the branch still exists
    if (
      task.branch_name &&
      git.branchExists(project.repo_path, task.branch_name)
    ) {
      diff = git.getDiff(
        project.repo_path,
        project.target_branch,
        task.branch_name,
      )
      stats = git.getDiffStats(
        project.repo_path,
        project.target_branch,
        task.branch_name,
      )
    }

    // If still no committed diff, check for uncommitted changes in the worktree
    if (!diff && task.worktree_path) {
      const uncommittedDiff = git.getUncommittedDiff(task.worktree_path)
      if (uncommittedDiff) {
        diff = uncommittedDiff
        stats = git.getUncommittedDiffStats(task.worktree_path)
        uncommitted = true
      }
    }

    return c.json({ diff, stats, uncommitted })
  })

  // --- Subtask Proposals ---

  /** Propose subtasks: agent posts proposals, parent gets paused. */
  app.post('/tasks/:id/propose-subtasks', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result
    const task = result

    // Must be in_progress:running to propose subtasks
    if (task.status !== 'in_progress' || task.substatus !== 'running') {
      return c.json(
        {
          error: `Task must be in_progress:running to propose subtasks, got '${task.status}:${task.substatus}'`,
        },
        400,
      )
    }

    const body = await c.req.json<{ subtasks: SubtaskProposalInput[] }>()
    if (!Array.isArray(body.subtasks) || body.subtasks.length === 0) {
      return c.json(
        { error: 'subtasks array is required and must not be empty' },
        400,
      )
    }

    // Validate each proposal
    for (const s of body.subtasks) {
      if (!s.title?.trim() || !s.prompt?.trim()) {
        return c.json(
          { error: 'Each subtask must have a title and prompt' },
          400,
        )
      }
    }

    // Store proposals
    const proposals = queries.createSubtaskProposals(id, body.subtasks)

    if (config.auto_approve_subtasks) {
      // Auto-approve: go straight to in_progress:waiting_on_subtasks
      const target = guardTransition(
        c,
        task.status,
        task.substatus,
        'auto_approve_subtasks',
      )
      if (target instanceof Response) return target
      // Transition BEFORE killing so exit handler early-returns
      queries.updateTask(id, {
        status: target.status,
        substatus: target.substatus,
      })
      pool.killAgent(id)
      // Create tasks immediately
      for (const proposal of proposals) {
        const newTask = queries.createTask({
          project_id: task.project_id,
          type: task.type,
          title: proposal.title,
          prompt: proposal.prompt,
          priority: proposal.priority as Priority,
        })
        queries.updateTask(newTask.id, { parent_task_id: id })
        queries.updateSubtaskProposal(proposal.id, {
          status: 'approved',
          spawned_task_id: newTask.id,
        })
        sseManager.broadcast('task:created', queries.getTaskById(newTask.id))
      }
      queries.createTaskEvent(id, 'subtasks_auto_approved', null)
      const updated = queries.getTaskById(id)
      sseManager.broadcast('task:updated', updated)
      dispatcher.tryDispatch()
    } else {
      // Manual review: move to pending:subtask_approval for user review
      const target = guardTransition(
        c,
        task.status,
        task.substatus,
        'propose_subtasks',
      )
      if (target instanceof Response) return target
      // Transition BEFORE killing so exit handler early-returns
      queries.updateTask(id, {
        status: target.status,
        substatus: target.substatus,
      })
      pool.killAgent(id)
      queries.createTaskEvent(id, 'subtasks_proposed', null)
      const updated = queries.getTaskById(id)
      sseManager.broadcast('task:updated', updated)
    }

    return c.json({ ok: true, proposal_count: proposals.length })
  })

  /** Get proposals for a task. */
  app.get('/tasks/:id/proposals', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result

    return c.json(queries.getSubtaskProposals(id))
  })

  /** Resolve proposals: approve some, dismiss others. */
  app.post('/tasks/:id/resolve-proposals', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result
    const task = result

    if (task.status !== 'pending' || task.substatus !== 'subtask_approval') {
      return c.json(
        {
          error: `Task must be pending:subtask_approval, got '${task.status}:${task.substatus}'`,
        },
        400,
      )
    }

    const body = await c.req.json<{
      approved: Array<{ id: number; prompt?: string; priority?: Priority }>
      dismissed: Array<{ id: number; feedback?: string }>
    }>()

    // Process dismissed proposals
    for (const d of body.dismissed ?? []) {
      queries.updateSubtaskProposal(d.id, {
        status: 'dismissed',
        feedback: d.feedback ?? null,
      })
    }

    // Process approved proposals
    for (const a of body.approved ?? []) {
      const proposals = queries.getSubtaskProposals(id)
      const proposal = proposals.find((p) => p.id === a.id)
      if (!proposal) continue

      const newTask = queries.createTask({
        project_id: task.project_id,
        type: task.type,
        title: proposal.title,
        prompt: a.prompt ?? proposal.prompt,
        priority: a.priority ?? (proposal.priority as Priority),
      })
      queries.updateTask(newTask.id, { parent_task_id: id })
      queries.updateSubtaskProposal(a.id, {
        status: 'approved',
        spawned_task_id: newTask.id,
      })
      sseManager.broadcast('task:created', queries.getTaskById(newTask.id))
    }

    const approvedCount = (body.approved ?? []).length

    if (approvedCount === 0) {
      // No subtasks approved — resume parent immediately with dismissal feedback
      const proposals = queries.getSubtaskProposals(id)
      const dismissed = proposals.filter((p) => p.status === 'dismissed')
      let resumePrompt =
        'All proposed subtasks were dismissed by the user.\n\n'
      if (dismissed.length > 0) {
        resumePrompt += '## Dismissed Proposals\n'
        for (const d of dismissed) {
          const fb = d.feedback
            ? `User feedback: "${d.feedback}"`
            : '(no feedback)'
          resumePrompt += `- "${d.title}": ${fb}\n`
        }
        resumePrompt += '\n'
      }
      resumePrompt += `Continue with your original task.\n\nOriginal task:\n${task.prompt}`

      const dismissTarget = transition(
        task.status,
        task.substatus,
        'dismiss_all_subtasks',
      )
      queries.updateTask(id, {
        status: dismissTarget.status,
        substatus: dismissTarget.substatus,
        prompt: resumePrompt,
        result: null,
      })
      queries.createTaskEvent(id, 'subtasks_all_dismissed', null)
      serverLog.info(`All proposals dismissed, parent re-queued`, id)

      taskQueue.recomputePositions(task.project_id)
      const updated = queries.getTaskById(id)
      sseManager.broadcast('task:updated', updated)
      dispatcher.tryDispatch()
    } else {
      // Transition to in_progress:waiting_on_subtasks
      const approveTarget = transition(
        task.status,
        task.substatus,
        'approve_subtasks',
      )
      queries.updateTask(id, {
        status: approveTarget.status,
        substatus: approveTarget.substatus,
      })
      const updated = queries.getTaskById(id)
      sseManager.broadcast('task:updated', updated)
      taskQueue.recomputePositions(task.project_id)
      dispatcher.tryDispatch()
    }

    return c.json({
      ok: true,
      approved: approvedCount,
      dismissed: (body.dismissed ?? []).length,
    })
  })

  app.get('/tasks/:id/events', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result

    return c.json(queries.getTaskEvents(id))
  })

  /** Get buffered progress messages for a task (live buffer or persisted history). */
  app.get('/tasks/:id/progress', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result

    const messages = pool.getProgressBuffer(id)
    if (messages.length > 0) return c.json({ messages })
    // Fall back to persisted session history
    const persisted = loadSessionMessages(id)
    return c.json({ messages: persisted })
  })

  // --- Task Transitions (Mode Escalation) ---

  /** Get the transition chain for a task. */
  app.get('/tasks/:id/transitions', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result

    return c.json(queries.getTransitionChain(id))
  })

  // ── Chat ──────────────────────────────────────────────────────────

  const CHAT_STATUSES: TaskStatus[] = ['draft', 'pending', 'done']

  /** Send a chat message on a task. Spawns an inline agent with read-only tools. */
  app.post('/tasks/:id/chat', async (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(c, id)
    if (result instanceof Response) return result
    const { task, project } = result

    if (!CHAT_STATUSES.includes(task.status)) {
      return c.json(
        { error: `Cannot chat on task in status '${task.status}'` },
        400,
      )
    }

    if (pool.hasChatAgent(id)) {
      return c.json({ error: 'Chat already in progress' }, 409)
    }

    if (pool.activeConversationCount >= config.conversation_limit) {
      return c.json({ error: 'No conversation slots available' }, 503)
    }

    const body = await c.req.json<{ message: string }>()
    if (!body.message?.trim()) {
      return c.json({ error: 'message is required' }, 400)
    }

    const sessionData = getSessionData(task)
    pool.spawnChatAgent(task, project, {
      message: body.message.trim(),
      sessionId: sessionData?.session_id ?? null,
    })

    queries.createTaskEvent(
      id,
      'chat',
      JSON.stringify({ message: body.message.trim() }),
    )

    return c.json({ ok: true })
  })

  /** Stop an active chat on a task. */
  app.delete('/tasks/:id/chat', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(c, id)
    if (result instanceof Response) return result

    if (!pool.hasChatAgent(id)) {
      return c.json({ error: 'No active chat' }, 404)
    }

    pool.killChatAgent(id)
    return c.json({ ok: true })
  })

  return app
}

/** Find tasks that depend on the given task. */
function getDependentTasks(
  queries: { getTasksByStatus: (s: TaskStatus[]) => Task[] },
  taskId: string,
): Task[] {
  const activeTasks = queries.getTasksByStatus(['queued', 'in_progress'])
  return activeTasks.filter((t) => t.depends_on === taskId)
}
