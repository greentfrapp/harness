import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Task } from '../../shared/types'
import type { AppContext } from '../context'
import { createTaskRoutes } from './tasks'

vi.mock('../sessions.ts', () => ({
  loadSessionMessages: vi.fn().mockReturnValue([]),
  deleteSessionMessages: vi.fn(),
  saveSessionMessages: vi.fn(),
}))

vi.mock('../git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git.ts')>()
  return {
    ...actual,
    checkoutTask: vi.fn(),
    returnCheckout: vi.fn(),
    cleanupCheckoutBranches: vi.fn(),
    removeWorktree: vi.fn(),
    deleteBranch: vi.fn(),
    mergeBranch: vi.fn(),
    hasCommits: vi.fn().mockReturnValue(false),
    createBranch: vi.fn(),
    makeBranchName: vi.fn().mockReturnValue('branch-test'),
    branchExists: vi.fn().mockReturnValue(false),
  }
})

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    type: 'do',
    status: 'queued',
    substatus: null,
    title: null,
    prompt: 'test task',
    result: null,
    priority: 'P2',
    tags: [],
    depends_on: null,
    parent_task_id: null,
    references: [],
    agent_type: 'claude-code',
    agent_session_data: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    retry_count: 0,
    queue_position: 1,
    created_at: 1000,
    updated_at: 1000,
    started_at: null,
    completed_at: null,
    ...overrides,
  }
}

function makeProject(): Project {
  return {
    id: 'proj-1',
    name: 'test',
    repo_path: '/tmp/test',
    target_branch: 'main',
    worktree_limit: 3,
    conversation_limit: 5,
    auto_push: false,
    created_at: 1000,
  }
}

function makeContext(): AppContext {
  return {
    config: {
      worktree_limit: 3,
      conversation_limit: 5,
      task_types: {
        do: {
          prompt_template: '...',
          needs_worktree: true,
          default_priority: 'P2',
        },
        discuss: {
          prompt_template: '...',
          needs_worktree: false,
          default_priority: 'P2',
        },
        plan: {
          prompt_template: '...',
          needs_worktree: false,
          default_priority: 'P2',
        },
      },
      tags: {},
      projects: [],
    },
    sseManager: {
      addClient: vi.fn(),
      removeClient: vi.fn(),
      broadcast: vi.fn(),
      clientCount: 0,
    } as any,
    taskQueue: {
      recomputePositions: vi.fn(),
      getNextReady: vi.fn(),
      dispatch: vi.fn(),
      isDependencySatisfied: vi.fn(),
    } as any,
    pool: {
      killAgent: vi.fn().mockReturnValue(false),
      killChatAgent: vi.fn().mockReturnValue(false),
      hasAgent: vi.fn().mockReturnValue(false),
      hasChatAgent: vi.fn().mockReturnValue(false),
      spawnChatAgent: vi.fn(),
      activeConversationCount: 0,
      getProgressBuffer: vi.fn().mockReturnValue([]),
    } as any,
    dispatcher: { tryDispatch: vi.fn() } as any,
    queries: {
      getAllProjects: vi.fn().mockReturnValue([makeProject()]),
      getProjectById: vi.fn().mockReturnValue(makeProject()),
      seedProjects: vi.fn(),
      createTask: vi
        .fn()
        .mockImplementation((input) => makeTask({ ...input, id: 'new-1' })),
      getTaskById: vi.fn(),
      getTasksByStatus: vi.fn().mockReturnValue([]),
      getTasksByProject: vi.fn().mockReturnValue([]),
      getQueuedTasks: vi.fn().mockReturnValue([]),
      updateTask: vi
        .fn()
        .mockImplementation((id, updates) => makeTask({ id, ...updates })),
      createTaskEvent: vi.fn(),
      getTaskEvents: vi.fn().mockReturnValue([]),
      clearParentReferences: vi.fn(),
      deleteTasksByIds: vi
        .fn()
        .mockImplementation((ids: string[]) =>
          ids.map((id) => makeTask({ id })),
        ),
      createTaskProposals: vi.fn().mockReturnValue([]),
      getTaskProposals: vi.fn().mockReturnValue([]),
      updateTaskProposal: vi.fn(),
      getChildTasks: vi.fn().mockReturnValue([]),
      createTaskTransition: vi.fn(),
      getTaskTransitions: vi.fn().mockReturnValue([]),
      getTransitionChain: vi.fn().mockReturnValue([]),
    } as any,
    checkoutState: new Map(),
  }
}

describe('Task Routes — Cancel & Delete', () => {
  let ctx: AppContext
  let app: ReturnType<typeof createTaskRoutes>

  beforeEach(() => {
    ctx = makeContext()
    app = createTaskRoutes(ctx)
  })

  // --- POST /tasks/:id/cancel ---

  describe('POST /tasks/:id/cancel', () => {
    it('cancels a queued task', async () => {
      const task = makeTask({ status: 'queued', substatus: null })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('cancelled')
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'cancelled',
        null,
      )
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })

    it('cancels an in_progress:running task and kills agent', async () => {
      const task = makeTask({ status: 'in_progress', substatus: 'running' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(ctx.pool.killAgent).toHaveBeenCalledWith('task-1')
    })

    it('preserves branch on cancel', async () => {
      const task = makeTask({
        status: 'queued',
        substatus: null,
        worktree_path: '/tmp/wt',
        branch_name: 'task-branch',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)

      const updateCall = (ctx.queries.updateTask as any).mock.calls[0]
      expect(updateCall[1].worktree_path).toBeNull()
      // branch_name should NOT be set to null
      expect(updateCall[1].branch_name).toBeUndefined()
    })

    it('returns 404 for unknown task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(null)

      const res = await app.request('/tasks/unknown/cancel', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('returns 400 for non-cancellable task (draft)', async () => {
      const task = makeTask({ status: 'draft', substatus: null })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/cancel', { method: 'POST' })
      expect(res.status).toBe(400)
    })

    it('returns 400 for non-cancellable task (done:approved)', async () => {
      const task = makeTask({ status: 'done', substatus: 'approved' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/cancel', { method: 'POST' })
      expect(res.status).toBe(400)
    })

    it('checks waiting parent after cancel', async () => {
      const parent = makeTask({
        id: 'parent-1',
        status: 'in_progress',
        substatus: 'waiting_on_subtasks',
      })
      const task = makeTask({
        status: 'queued',
        substatus: null,
        parent_task_id: 'parent-1',
      })
      ;(ctx.queries.getTaskById as any).mockImplementation((id: string) => {
        if (id === 'task-1') return task
        if (id === 'parent-1') return parent
        return null
      })
      ;(ctx.queries.getChildTasks as any).mockReturnValue([
        makeTask({ status: 'cancelled', substatus: null }),
      ])

      const res = await app.request('/tasks/task-1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
    })
  })

  // --- POST /tasks/cancel (bulk) ---

  describe('POST /tasks/cancel (bulk)', () => {
    it('cancels multiple tasks', async () => {
      const task1 = makeTask({ id: 't1', status: 'queued', substatus: null })
      const task2 = makeTask({
        id: 't2',
        status: 'in_progress',
        substatus: 'running',
      })
      ;(ctx.queries.getTaskById as any).mockImplementation((id: string) => {
        if (id === 't1') return task1
        if (id === 't2') return task2
        return null
      })

      const res = await app.request('/tasks/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['t1', 't2'] }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.cancelled).toEqual(['t1', 't2'])
      expect(body.skipped).toEqual([])
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })

    it('skips non-cancellable tasks', async () => {
      const task1 = makeTask({ id: 't1', status: 'queued', substatus: null })
      const task2 = makeTask({ id: 't2', status: 'done', substatus: 'approved' })
      ;(ctx.queries.getTaskById as any).mockImplementation((id: string) => {
        if (id === 't1') return task1
        if (id === 't2') return task2
        return null
      })

      const res = await app.request('/tasks/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['t1', 't2'] }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.cancelled).toEqual(['t1'])
      expect(body.skipped).toEqual(['t2'])
    })

    it('skips unknown task IDs', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(null)

      const res = await app.request('/tasks/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['nonexistent'] }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.cancelled).toEqual([])
    })

    it('returns 400 without ids', async () => {
      const res = await app.request('/tasks/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })
  })

  // --- DELETE /tasks/:id ---

  describe('DELETE /tasks/:id', () => {
    it('permanently deletes a task', async () => {
      const task = makeTask({ status: 'done', substatus: 'approved' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.deleted).toBe('task-1')
      expect(ctx.queries.deleteTasksByIds).toHaveBeenCalledWith(['task-1'])
    })

    it('deletes worktree and branch', async () => {
      const { removeWorktree, deleteBranch } = await import('../git')
      const task = makeTask({
        status: 'done',
        substatus: 'approved',
        worktree_path: '/tmp/wt',
        branch_name: 'task-branch',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      await app.request('/tasks/task-1', { method: 'DELETE' })
      expect(removeWorktree).toHaveBeenCalled()
      expect(deleteBranch).toHaveBeenCalled()
    })

    it('kills running agent and triggers dispatch', async () => {
      const task = makeTask({ status: 'in_progress', substatus: 'running' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      await app.request('/tasks/task-1', { method: 'DELETE' })
      expect(ctx.pool.killAgent).toHaveBeenCalledWith('task-1')
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })

    it('returns 404 for unknown task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(null)

      const res = await app.request('/tasks/unknown', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  // --- DELETE /tasks (bulk) ---

  describe('DELETE /tasks (bulk)', () => {
    it('deletes tasks by IDs', async () => {
      const task1 = makeTask({ id: 't1', status: 'done', substatus: 'approved' })
      const task2 = makeTask({ id: 't2', status: 'cancelled', substatus: null })
      ;(ctx.queries.getTaskById as any).mockImplementation((id: string) => {
        if (id === 't1') return task1
        if (id === 't2') return task2
        return null
      })

      const res = await app.request('/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['t1', 't2'] }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.deleted).toEqual(['t1', 't2'])
    })

    it('deletes tasks by status query param', async () => {
      const tasks = [
        makeTask({ id: 't1', status: 'done', substatus: 'approved' }),
        makeTask({ id: 't2', status: 'done', substatus: 'rejected' }),
      ]
      ;(ctx.queries.getTasksByStatus as any).mockReturnValue(tasks)

      const res = await app.request('/tasks?status=done', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.deleted).toEqual(['t1', 't2'])
    })

    it('returns empty array when no tasks match', async () => {
      ;(ctx.queries.getTasksByStatus as any).mockReturnValue([])

      const res = await app.request('/tasks?status=done', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.deleted).toEqual([])
    })

    it('returns 400 without ids or status', async () => {
      const res = await app.request('/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('triggers dispatch if running tasks were deleted', async () => {
      const task = makeTask({ id: 't1', status: 'in_progress', substatus: 'running' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      await app.request('/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['t1'] }),
      })
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })
  })
})

describe('Task Routes — Proposals', () => {
  let ctx: AppContext
  let app: ReturnType<typeof createTaskRoutes>

  beforeEach(() => {
    ctx = makeContext()
    app = createTaskRoutes(ctx)
  })

  // --- POST /tasks/:id/propose-tasks ---

  describe('POST /tasks/:id/propose-tasks', () => {
    it('creates proposals and moves task to pending:task_proposal', async () => {
      const task = makeTask({ status: 'in_progress', substatus: 'running' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.createTaskProposals as any).mockReturnValue([
        { id: 1, title: 'Sub 1', parent_task_id: 'task-1', inherit_session: false },
      ])

      const res = await app.request('/tasks/task-1/propose-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: [{ title: 'Sub 1', prompt: 'Do sub 1' }],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.proposal_count).toBe(1)
      expect(ctx.queries.createTaskProposals).toHaveBeenCalled()
      expect(ctx.pool.killAgent).toHaveBeenCalledWith('task-1')
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'tasks_proposed',
        null,
      )
    })

    it('returns 400 if task not in_progress:running', async () => {
      const task = makeTask({ status: 'pending', substatus: 'review' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/propose-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: [{ title: 'X', prompt: 'Y' }] }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 with empty tasks array', async () => {
      const task = makeTask({ status: 'in_progress', substatus: 'running' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/propose-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: [] }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 when proposal missing title', async () => {
      const task = makeTask({ status: 'in_progress', substatus: 'running' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/propose-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: [{ prompt: 'Y' }] }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 for nonexistent parent_task_id', async () => {
      const task = makeTask({ status: 'in_progress', substatus: 'running' })
      ;(ctx.queries.getTaskById as any).mockImplementation((id: string) => {
        if (id === 'task-1') return task
        return undefined // nonexistent
      })

      const res = await app.request('/tasks/task-1/propose-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: [{ title: 'Sub', prompt: 'Do it', parent_task_id: 'nonexistent' }],
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('parent_task_id')
      expect(body.error).toContain('nonexistent')
    })

    it('returns 400 for nonexistent depends_on', async () => {
      const task = makeTask({ status: 'in_progress', substatus: 'running' })
      ;(ctx.queries.getTaskById as any).mockImplementation((id: string) => {
        if (id === 'task-1') return task
        return undefined
      })

      const res = await app.request('/tasks/task-1/propose-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: [{ title: 'Dep', prompt: 'After', depends_on: 'nonexistent' }],
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('depends_on')
    })
  })

  // --- POST /tasks/:id/resolve-proposals ---

  describe('POST /tasks/:id/resolve-proposals', () => {
    it('returns 400 if task not pending:task_proposal', async () => {
      const task = makeTask({ status: 'pending', substatus: 'review' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: [], dismissed: [] }),
      })
      expect(res.status).toBe(400)
    })

    it('dismisses all → re-queues parent', async () => {
      const task = makeTask({
        status: 'pending',
        substatus: 'task_proposal',
        prompt: 'Original prompt',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getTaskProposals as any).mockReturnValue([
        {
          id: 1,
          title: 'Dismissed task',
          status: 'dismissed',
          feedback: 'Not needed',
          parent_task_id: 'task-1',
        },
      ])

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: [],
          dismissed: [{ id: 1, feedback: 'Not needed' }],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.approved).toBe(0)
      expect(body.dismissed).toBe(1)
      expect(ctx.queries.updateTaskProposal).toHaveBeenCalledWith(1, {
        status: 'dismissed',
        feedback: 'Not needed',
      })
      // Parent should be re-queued
      const updateCall = (ctx.queries.updateTask as any).mock.calls[0]
      expect(updateCall[1].status).toBe('queued')
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'proposals_all_dismissed',
        null,
      )
    })

    it('approves subtask proposals → parent waits', async () => {
      const task = makeTask({
        status: 'pending',
        substatus: 'task_proposal',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getTaskProposals as any).mockReturnValue([
        {
          id: 1,
          title: 'Subtask A',
          prompt: 'Do A',
          type: null,
          priority: 'P2',
          tags: [],
          parent_task_id: 'task-1',
          depends_on: null,
          references: [],
          inherit_session: false,
        },
      ])

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: [{ id: 1 }],
          dismissed: [],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.approved).toBe(1)

      // Should create task with parent_task_id
      const createCall = (ctx.queries.createTask as any).mock.calls[0][0]
      expect(createCall.parent_task_id).toBe('task-1')

      // Parent should move to waiting_on_subtasks
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'tasks_approved',
        null,
      )
    })

    it('approves non-subtask proposal → parent completes', async () => {
      const task = makeTask({
        status: 'pending',
        substatus: 'task_proposal',
        agent_session_data: JSON.stringify({ session_id: 'sess-1', pid: 0 }),
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getTaskProposals as any).mockReturnValue([
        {
          id: 1,
          title: 'Transition to plan',
          prompt: 'Plan the work',
          type: 'plan',
          priority: 'P2',
          tags: [],
          parent_task_id: null,
          depends_on: null,
          references: [],
          inherit_session: true,
        },
      ])

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: [{ id: 1 }],
          dismissed: [],
        }),
      })
      expect(res.status).toBe(200)

      // Should create task without parent_task_id (not a subtask)
      const createCall = (ctx.queries.createTask as any).mock.calls[0][0]
      expect(createCall.parent_task_id).toBeUndefined()
      expect(createCall.type).toBe('plan')

      // Should copy session (inherit_session: true)
      const updateCalls = (ctx.queries.updateTask as any).mock.calls
      const sessionUpdate = updateCalls.find(
        (c: any[]) => c[1].session_id === 'sess-1',
      )
      expect(sessionUpdate).toBeDefined()

      // Should record transition
      expect(ctx.queries.createTaskTransition).toHaveBeenCalledWith(
        'task-1',
        'new-1',
        'do_to_plan',
      )

      // Parent should complete (done:approved)
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'transition_approved',
        null,
      )
    })

    it('mixed proposals: subtask + non-subtask → parent waits (subtask takes priority)', async () => {
      const task = makeTask({
        status: 'pending',
        substatus: 'task_proposal',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getTaskProposals as any).mockReturnValue([
        {
          id: 1,
          title: 'Subtask',
          prompt: 'Do it',
          type: null,
          priority: 'P2',
          tags: [],
          parent_task_id: 'task-1',
          depends_on: null,
          references: [],
          inherit_session: false,
        },
        {
          id: 2,
          title: 'Handoff',
          prompt: 'Continue',
          type: 'plan',
          priority: 'P2',
          tags: [],
          parent_task_id: null,
          depends_on: null,
          references: [],
          inherit_session: true,
        },
      ])

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: [{ id: 1 }, { id: 2 }],
          dismissed: [],
        }),
      })
      expect(res.status).toBe(200)

      // Parent should wait (has subtasks)
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'tasks_approved',
        null,
      )
    })

    it('passes tags, depends_on, and references through to created task', async () => {
      const task = makeTask({
        status: 'pending',
        substatus: 'task_proposal',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getTaskProposals as any).mockReturnValue([
        {
          id: 1,
          title: 'Tagged subtask',
          prompt: 'Do it',
          type: null,
          priority: 'P1',
          tags: ['bug', 'urgent'],
          parent_task_id: 'task-1',
          depends_on: 'dep-task-1',
          references: ['ref-1', 'ref-2'],
          inherit_session: false,
        },
      ])

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: [{ id: 1 }],
          dismissed: [],
        }),
      })
      expect(res.status).toBe(200)

      const createCall = (ctx.queries.createTask as any).mock.calls[0][0]
      expect(createCall.tags).toEqual(['bug', 'urgent'])
      expect(createCall.depends_on).toBe('dep-task-1')
      expect(createCall.references).toEqual(['ref-1', 'ref-2'])
      expect(createCall.parent_task_id).toBe('task-1')
      expect(createCall.priority).toBe('P1')
    })
  })
})
