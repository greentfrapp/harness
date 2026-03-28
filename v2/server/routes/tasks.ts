import { Hono } from 'hono'
import type {
  CreateTaskInput,
  Priority,
  Project,
  SubtaskProposalInput,
  Task,
  TaskStatus,
  UpdateTaskInput,
} from '../../shared/types'
import { getErrorMessage, isRunning, isTerminal } from '../../shared/types'
import { findAction, transition } from '../../shared/transitions'
import type { AppContext } from '../context'
import * as git from '../git'
import { serverLog } from '../log'
import { getSessionData, updateSessionData } from '../pool'
import { deleteSessionMessages, loadSessionMessages } from '../sessions'
import { autoReturnIfCheckedOut } from './checkout'
import {
  getTaskOr404,
  getTaskWithProjectOr404,
  guardTransition,
} from './helpers'

export function createTaskRoutes(ctx: AppContext) {
  const app = new Hono()
  const {
    queries,
    sseManager,
    taskQueue,
    pool,
    dispatcher,
    config,
  } = ctx

  /** Remove a task's worktree. Branch is preserved for diff review. */
  function removeWorktree(project: Project, task: Task): void {
    if (task.worktree_path) {
      serverLog.info(`Removing worktree ${task.worktree_path}`, task.id)
      git.removeWorktree(project.repo_path, task.worktree_path)
    }
  }

  /** Remove a task's worktree and delete its branch. Only for permanent deletion. */
  function cleanupWorktreeAndBranch(project: Project, task: Task): void {
    removeWorktree(project, task)
    if (task.branch_name) {
      serverLog.info(`Deleting branch ${task.branch_name}`, task.id)
      git.deleteBranch(project.repo_path, task.branch_name)
    }
  }

  // --- Tasks CRUD ---

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
    const result = getTaskOr404(queries, c, c.req.param('id'))
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
      sseManager.broadcast('task:created', task)
      return c.json(task, 201)
    }

    taskQueue.recomputePositions(task.project_id)
    const updated = queries.getTaskById(task.id)!

    sseManager.broadcast('task:created', updated)
    dispatcher.tryDispatch()

    const current = queries.getTaskById(task.id)!
    return c.json(current, 201)
  })

  /** Send a draft: transition from draft to queued. */
  app.post('/tasks/:id/send', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    const task = result
    const target = guardTransition(c, task.status, task.substatus, 'send')
    if (target instanceof Response) return target

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

    dispatcher.tryDispatch()

    const current = queries.getTaskById(id)!
    return c.json(current)
  })

  app.patch('/tasks/:id', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    const existing = result

    const body = await c.req.json<UpdateTaskInput>()

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
          { error: `Cannot transition from '${fromPair}' to '${toPair}'` },
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

  // --- Task Lifecycle Actions ---

  /** Approve: merge branch into target, destroy worktree, mark done:approved. */
  app.post('/tasks/:id/approve', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(queries, c, id)
    if (result instanceof Response) return result
    const { task, project } = result
    const target = guardTransition(c, task.status, task.substatus, 'approve')
    if (target instanceof Response) return target

    pool.killChatAgent(id)
    autoReturnIfCheckedOut(ctx, id)

    if (task.branch_name) {
      // Resolve merge target: subtasks of plan tasks merge to the feature branch
      let mergeTarget = project.target_branch
      let shouldPush = !!project.auto_push
      if (task.parent_task_id) {
        const parent = queries.getTaskById(task.parent_task_id)
        if (parent?.type === 'plan' && parent.branch_name) {
          mergeTarget = parent.branch_name
          shouldPush = false // don't push feature branches
        }
      }

      if (
        !git.hasCommits(
          project.repo_path,
          mergeTarget,
          task.branch_name,
        )
      ) {
        serverLog.warn(
          `Task branch has no commits ahead of ${mergeTarget}`,
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
          `Merging ${task.branch_name} into ${mergeTarget}`,
          id,
        )
        git.mergeBranch(
          project.repo_path,
          mergeTarget,
          task.branch_name,
          { push: shouldPush },
        )
        serverLog.info(
          `Merge successful${shouldPush ? ' (pushed to remote)' : ''}`,
          id,
        )
      } catch (err) {
        const msg = getErrorMessage(err)
        serverLog.error(`Merge failed: ${msg}`, id)
        return c.json({ error: `Merge failed: ${msg}` }, 409)
      }

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

    // Check if this was a subtask and its parent plan is waiting
    checkWaitingParent(ctx, task)

    dispatcher.tryDispatch()

    return c.json(updated)
  })

  /** Reject: destroy worktree + branch, mark done:rejected. */
  app.post('/tasks/:id/reject', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(queries, c, id)
    if (result instanceof Response) return result
    const { task, project } = result
    const target = guardTransition(c, task.status, task.substatus, 'reject')
    if (target instanceof Response) return target

    pool.killChatAgent(id)
    autoReturnIfCheckedOut(ctx, id)

    removeWorktree(project, task)

    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      worktree_path: null,
      completed_at: Date.now(),
    })
    queries.createTaskEvent(id, 'rejected', null)
    serverLog.info(`Task rejected`, id)
    sseManager.broadcast('task:updated', updated)

    // Check if this was a subtask and its parent plan is waiting
    checkWaitingParent(ctx, task)

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

  /** Dismiss: mark a pending:response (discuss) task as read. */
  app.post('/tasks/:id/dismiss', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    const task = result
    const target = guardTransition(c, task.status, task.substatus, 'dismiss')
    if (target instanceof Response) return target

    pool.killChatAgent(id)

    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      completed_at: Date.now(),
    })
    queries.createTaskEvent(id, 'dismissed', null)
    serverLog.info(`Task dismissed`, id)
    sseManager.broadcast('task:updated', updated)

    return c.json(updated)
  })

  /** Fix: re-queue a pending:review or pending:error task to address an issue. */
  app.post('/tasks/:id/fix', async (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(queries, c, id)
    if (result instanceof Response) return result
    const { task } = result
    const target = guardTransition(c, task.status, task.substatus, 'fix')
    if (target instanceof Response) return target

    autoReturnIfCheckedOut(ctx, id)

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

    const tags = task.tags.includes(fixType)
      ? task.tags
      : [...task.tags, fixType]

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
    const result = getTaskWithProjectOr404(queries, c, id)
    if (result instanceof Response) return result
    const { task } = result
    const target = guardTransition(
      c,
      task.status,
      task.substatus,
      'grant_permission',
    )
    if (target instanceof Response) return target

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
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    const task = result
    const target = guardTransition(c, task.status, task.substatus, 'revise')
    if (target instanceof Response) return target

    pool.killChatAgent(id)
    autoReturnIfCheckedOut(ctx, id)

    const body = await c.req.json<{ prompt: string }>()
    if (!body.prompt?.trim()) {
      return c.json({ error: 'prompt is required' }, 400)
    }

    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      prompt: body.prompt.trim(),
      result: null,
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
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    const task = result
    const FOLLOW_UP_STATUSES: TaskStatus[] = ['pending', 'done']
    if (!FOLLOW_UP_STATUSES.includes(task.status)) {
      return c.json(
        { error: `Cannot follow up on task in status '${task.status}'` },
        400,
      )
    }

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

    const followUpType = body.type?.trim() || task.type
    if (body.type && !config.task_types[followUpType]) {
      return c.json({ error: `Unknown task type: ${followUpType}` }, 400)
    }

    const parentSession = getSessionData(task)
    const taskTypeConfig = config.task_types[followUpType]
    const agentType = taskTypeConfig?.agent ?? task.agent_type ?? 'claude-code'

    const followUpTask = queries.createTask({
      project_id: task.project_id,
      type: followUpType,
      prompt: body.prompt.trim(),
      priority: task.priority,
      agent_type: agentType,
    })

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

    dispatcher.tryDispatch()

    return c.json(updated, 201)
  })

  /** Approve mode-escalation transition: complete source task, spawn new task of target type. */
  app.post('/tasks/:id/approve-transition', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
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

    queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      completed_at: Date.now(),
    })
    queries.createTaskEvent(id, 'transition_approved', null)
    sseManager.broadcast('task:updated', queries.getTaskById(id))

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

    if (parentSession?.session_id) {
      queries.updateTask(newTask.id, {
        agent_session_data: JSON.stringify({
          session_id: parentSession.session_id,
          pid: 0,
        }),
        session_id: parentSession.session_id,
      })
    }

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

  // --- Delete / Cancel ---

  /** Cancel or permanently delete a task. */
  app.delete('/tasks/:id', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    const existing = result

    const forcePermanent = c.req.query('permanent') === 'true'
    const isDraft = existing.status === 'draft'
    const terminal = isTerminal(existing.status, existing.substatus)

    if (terminal || isDraft || forcePermanent) {
      pool.killAgent(id)
      pool.killChatAgent(id)

      const project = queries.getProjectById(existing.project_id)
      if (project) cleanupWorktreeAndBranch(project, existing)

      queries.deleteTasksByIds([id])
      deleteSessionMessages(id)
      serverLog.info(`Task permanently deleted`, id)
      sseManager.broadcast('task:removed', { id })

      if (!terminal) {
        dispatcher.tryDispatch()
      }

      return c.json({ deleted: id })
    }

    const target = guardTransition(
      c,
      existing.status,
      existing.substatus,
      'cancel',
    )
    if (target instanceof Response) return target

    pool.killAgent(id)
    pool.killChatAgent(id)

    const cancelProject = queries.getProjectById(existing.project_id)
    if (cancelProject) removeWorktree(cancelProject, existing)

    queries.clearParentReferences(id)

    const updated = queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      worktree_path: null,
      completed_at: Date.now(),
    })
    queries.createTaskEvent(id, 'cancelled', null)
    sseManager.broadcast('task:updated', updated)

    // Check if this was a subtask and its parent plan is waiting
    checkWaitingParent(ctx, existing)

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
      if (project) cleanupWorktreeAndBranch(project, task)
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

  // --- Subtask Proposals ---

  /** Propose subtasks: agent posts proposals, parent gets paused. */
  app.post('/tasks/:id/propose-subtasks', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    const task = result

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

    for (const s of body.subtasks) {
      if (!s.title?.trim() || !s.prompt?.trim()) {
        return c.json(
          { error: 'Each subtask must have a title and prompt' },
          400,
        )
      }
    }

    const proposals = queries.createSubtaskProposals(id, body.subtasks)

    if (config.auto_approve_subtasks) {
      const autoTarget = guardTransition(
        c,
        task.status,
        task.substatus,
        'auto_approve_subtasks',
      )
      if (autoTarget instanceof Response) return autoTarget
      queries.updateTask(id, {
        status: autoTarget.status,
        substatus: autoTarget.substatus,
      })
      pool.killAgent(id)
      // Create feature branch for plan tasks
      ensurePlanFeatureBranch(ctx, task)
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
      const proposeTarget = guardTransition(
        c,
        task.status,
        task.substatus,
        'propose_subtasks',
      )
      if (proposeTarget instanceof Response) return proposeTarget
      queries.updateTask(id, {
        status: proposeTarget.status,
        substatus: proposeTarget.substatus,
      })
      pool.killAgent(id)
      queries.createTaskEvent(id, 'subtasks_proposed', null)
      const updated = queries.getTaskById(id)
      sseManager.broadcast('task:updated', updated)
    }

    return c.json({ ok: true, proposal_count: proposals.length })
  })

  /** Agent requests permission for a tool via CLI. */
  app.post('/tasks/:id/request-permission', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    const task = result

    if (task.status !== 'in_progress' || task.substatus !== 'running') {
      return c.json(
        {
          error: `Task must be in_progress:running to request permission, got '${task.status}:${task.substatus}'`,
        },
        400,
      )
    }

    const body = await c.req.json<{
      tool: string
      tool_input?: Record<string, unknown>
    }>()
    if (!body.tool?.trim()) {
      return c.json({ error: 'tool is required' }, 400)
    }

    const target = guardTransition(
      c,
      task.status,
      task.substatus,
      'request_permission',
    )
    if (target instanceof Response) return target

    const toolInfo = `Tool requiring permission: ${body.tool}`

    queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      result: toolInfo,
      agent_session_data: updateSessionData(task.agent_session_data, {
        pending_tool: body.tool,
        pending_tool_input: body.tool_input ?? null,
      }),
    })

    pool.killAgent(id)

    queries.createTaskEvent(
      id,
      'permission_requested',
      JSON.stringify({ tool: body.tool }),
    )
    serverLog.info(`Permission requested for tool: ${body.tool} (via CLI)`, id)

    const updated = queries.getTaskById(id)
    sseManager.broadcast('inbox:new', updated)

    return c.json({ ok: true, tool: body.tool })
  })

  /** Agent requests mode escalation via CLI. */
  app.post('/tasks/:id/request-transition', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    const task = result

    if (task.status !== 'in_progress' || task.substatus !== 'running') {
      return c.json(
        {
          error: `Task must be in_progress:running to request transition, got '${task.status}:${task.substatus}'`,
        },
        400,
      )
    }

    const body = await c.req.json<{ target_type: string }>()
    if (!body.target_type?.trim()) {
      return c.json({ error: 'target_type is required' }, 400)
    }

    if (!config.task_types[body.target_type]) {
      return c.json(
        { error: `Unknown task type: ${body.target_type}` },
        400,
      )
    }

    const target = guardTransition(
      c,
      task.status,
      task.substatus,
      'request_transition',
    )
    if (target instanceof Response) return target

    queries.updateTask(id, {
      status: target.status,
      substatus: target.substatus,
      result: `Transition requested: ${task.type} → ${body.target_type}`,
    })

    pool.killAgent(id)

    queries.createTaskEvent(
      id,
      'transition_requested',
      JSON.stringify({ target_type: body.target_type }),
    )
    serverLog.info(
      `Transition requested: ${task.type} → ${body.target_type} (via CLI)`,
      id,
    )

    const updated = queries.getTaskById(id)
    sseManager.broadcast('inbox:new', updated)

    return c.json({ ok: true, target_type: body.target_type })
  })

  /** Get proposals for a task. */
  app.get('/tasks/:id/proposals', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result

    return c.json(queries.getSubtaskProposals(id))
  })

  /** Resolve proposals: approve some, dismiss others. */
  app.post('/tasks/:id/resolve-proposals', async (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
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

    for (const d of body.dismissed ?? []) {
      queries.updateSubtaskProposal(d.id, {
        status: 'dismissed',
        feedback: d.feedback ?? null,
      })
    }

    // Create feature branch for plan tasks when first subtask is approved
    if ((body.approved ?? []).length > 0) {
      ensurePlanFeatureBranch(ctx, task)
    }

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

  // --- Read helpers ---

  app.get('/tasks/:id/events', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    return c.json(queries.getTaskEvents(id))
  })

  /** Get buffered progress messages for a task (live buffer or persisted history). */
  app.get('/tasks/:id/progress', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result

    const messages = pool.getProgressBuffer(id)
    if (messages.length > 0) return c.json({ messages })
    const persisted = loadSessionMessages(id)
    return c.json({ messages: persisted })
  })

  /** Get diff for a task. */
  app.get('/tasks/:id/diff', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(queries, c, id)
    if (result instanceof Response) return result
    const { task, project } = result

    let diff = ''
    let stats = ''
    let uncommitted = false

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

  /** Get the transition chain for a task. */
  app.get('/tasks/:id/transitions', (c) => {
    const id = c.req.param('id')
    const result = getTaskOr404(queries, c, id)
    if (result instanceof Response) return result
    return c.json(queries.getTransitionChain(id))
  })

  // --- Chat ---

  const CHAT_STATUSES: TaskStatus[] = ['draft', 'pending', 'done']

  /** Send a chat message on a task. Spawns an inline agent with read-only tools. */
  app.post('/tasks/:id/chat', async (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(queries, c, id)
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
    const result = getTaskOr404(queries, c, id)
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

/**
 * Ensure a plan task has a feature branch for its subtasks.
 * Creates the branch on first call (when first subtask is approved).
 */
function ensurePlanFeatureBranch(
  ctx: AppContext,
  planTask: Task,
): void {
  if (planTask.type !== 'plan' || planTask.branch_name) return

  const project = ctx.queries.getProjectById(planTask.project_id)
  if (!project) return

  const branchName = git.makeBranchName(planTask.id, planTask.title ?? planTask.prompt ?? '')
  git.createBranch(project.repo_path, project.target_branch, branchName)
  ctx.queries.updateTask(planTask.id, { branch_name: branchName })
  serverLog.info(`Created feature branch ${branchName} for plan task`, planTask.id)
}

/**
 * Check if a completed/cancelled subtask's parent plan is waiting on subtasks.
 * If all children are terminal, transition the parent back to queued so the
 * plan agent can resume and set its result.
 */
function checkWaitingParent(ctx: AppContext, task: Task): void {
  if (!task.parent_task_id) return

  const parent = ctx.queries.getTaskById(task.parent_task_id)
  if (
    !parent ||
    parent.status !== 'in_progress' ||
    parent.substatus !== 'waiting_on_subtasks'
  )
    return

  const children = ctx.queries.getChildTasks(parent.id)
  const allTerminal = children.every((c) => isTerminal(c.status, c.substatus))
  if (!allTerminal) return

  // Build resume prompt with subtask results
  let resumePrompt = 'All subtasks have completed. Here are the results:\n\n'
  for (const child of children) {
    const status = child.substatus
      ? `${child.status}:${child.substatus}`
      : child.status
    resumePrompt += `## ${child.title ?? child.prompt?.slice(0, 80) ?? child.id}\n`
    resumePrompt += `Status: ${status}\n`
    if (child.result) {
      resumePrompt += `Result: ${child.result}\n`
    }
    resumePrompt += '\n'
  }
  resumePrompt +=
    'Set your result with a summary of the plan and what was accomplished, then finish.'

  const target = transition(parent.status, parent.substatus, 'subtasks_completed')
  ctx.queries.updateTask(parent.id, {
    status: target.status,
    substatus: target.substatus,
    prompt: resumePrompt,
  })
  ctx.queries.createTaskEvent(parent.id, 'subtasks_completed', null)
  serverLog.info(`All subtasks complete, parent re-queued`, parent.id)

  ctx.sseManager.broadcast('task:updated', ctx.queries.getTaskById(parent.id))
}
