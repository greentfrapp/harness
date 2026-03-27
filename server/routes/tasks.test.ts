import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Task, TaskEvent } from '../../shared/types'
import { readConfigRaw, saveConfigRaw } from '../config'
import type { AppContext } from '../context'
import {
  checkoutTask,
  deleteBranch,
  removeWorktree,
  returnCheckout,
} from '../git'
import { loadSessionMessages } from '../sessions'
import { createTaskRoutes } from './tasks'

vi.mock('../config.ts', () => ({
  readConfigRaw: vi.fn(),
  saveConfigRaw: vi.fn(),
  getDefaultTaskTypes: vi.fn().mockReturnValue({
    do: { prompt_template: '...', needs_worktree: true, default_priority: 'P2' },
    discuss: { prompt_template: '...', needs_worktree: false, default_priority: 'P2' },
    plan: { prompt_template: '...', needs_worktree: false, default_priority: 'P2' },
  }),
  CONFIG_PATH: '/mock/.harness/config.jsonc',
}))

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
  }
})

const mockReadConfigRaw = readConfigRaw as ReturnType<typeof vi.fn>
const mockSaveConfigRaw = saveConfigRaw as ReturnType<typeof vi.fn>
const mockCheckoutTask = checkoutTask as ReturnType<typeof vi.fn>
const mockReturnCheckout = returnCheckout as ReturnType<typeof vi.fn>
const mockRemoveWorktree = removeWorktree as ReturnType<typeof vi.fn>
const mockDeleteBranch = deleteBranch as ReturnType<typeof vi.fn>

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    type: 'do',
    status: 'queued',
    title: null,
    prompt: 'test task',
    original_prompt: null,
    priority: 'P2',
    tags: [],
    depends_on: null,
    parent_task_id: null,
    agent_type: 'claude-code',
    agent_session_data: null,
    worktree_path: null,
    branch_name: null,
    diff_summary: null,
    diff_full: null,
    agent_summary: null,
    error_message: null,
    retry_count: 0,
    queue_position: 1,
    created_at: 1000,
    updated_at: 1000,
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
      hasAgent: vi.fn().mockReturnValue(false),
      getProgressBuffer: vi.fn().mockReturnValue([]),
    } as any,
    dispatcher: { tryDispatch: vi.fn() } as any,
    queries: {
      getAllProjects: vi.fn().mockReturnValue([{ id: 'proj-1', name: 'test' }]),
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
      deleteTasksByIds: vi.fn().mockReturnValue([]),
      createSubtaskProposals: vi.fn().mockReturnValue([]),
      getSubtaskProposals: vi.fn().mockReturnValue([]),
      updateSubtaskProposal: vi.fn(),
      getChildTasks: vi.fn().mockReturnValue([]),
    } as any,
    checkoutState: new Map(),
  }
}

describe('Task Routes', () => {
  let ctx: AppContext
  let app: ReturnType<typeof createTaskRoutes>

  beforeEach(() => {
    ctx = makeContext()
    app = createTaskRoutes(ctx)
    mockCheckoutTask.mockReset()
    mockReturnCheckout.mockReset()
    mockRemoveWorktree.mockReset()
    mockDeleteBranch.mockReset()
  })

  describe('GET /projects', () => {
    it('returns projects', async () => {
      const res = await app.request('/projects')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([{ id: 'proj-1', name: 'test' }])
    })
  })

  describe('GET /config', () => {
    it('returns task types', async () => {
      const res = await app.request('/config')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.task_types).toHaveProperty('do')
      expect(body.task_types).toHaveProperty('discuss')
    })
  })

  describe('GET /config/raw', () => {
    it('returns raw config content and path', async () => {
      mockReadConfigRaw.mockReturnValue('{ "worktree_limit": 3 }')

      const res = await app.request('/config/raw')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content).toBe('{ "worktree_limit": 3 }')
      expect(body.path).toBe('/mock/.harness/config.jsonc')
    })
  })

  describe('PUT /config/raw', () => {
    it('saves valid config and re-seeds projects', async () => {
      const newConfig = {
        worktree_limit: 5,
        conversation_limit: 5,
        task_types: {},
        projects: [],
      }
      mockSaveConfigRaw.mockReturnValue({ ok: true, config: newConfig })

      const res = await app.request('/config/raw', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '{ "worktree_limit": 5 }' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(mockSaveConfigRaw).toHaveBeenCalledWith('{ "worktree_limit": 5 }')
      expect(ctx.queries.seedProjects).toHaveBeenCalled()
    })

    it('returns 400 when content is missing', async () => {
      const res = await app.request('/config/raw', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/content/i)
    })

    it('returns 400 for invalid JSONC syntax', async () => {
      mockSaveConfigRaw.mockReturnValue({
        ok: false,
        error: 'Invalid JSONC syntax at offset 5',
      })

      const res = await app.request('/config/raw', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '{ bad' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/JSONC syntax/)
    })

    it('returns 400 for invalid project config', async () => {
      mockSaveConfigRaw.mockReturnValue({
        ok: false,
        error: 'Project "foo": repo_path does not exist',
      })

      const res = await app.request('/config/raw', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '{ "projects": [{"name":"foo"}] }' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/repo_path/)
    })
  })

  describe('GET /config/defaults/task-types', () => {
    it('returns default task types including plan', async () => {
      const res = await app.request('/config/defaults/task-types')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty('do')
      expect(body).toHaveProperty('discuss')
      expect(body).toHaveProperty('plan')
      expect(body.plan.needs_worktree).toBe(false)
    })
  })

  describe('GET /tasks/:id', () => {
    it('returns task with events', async () => {
      const task = makeTask()
      const events: TaskEvent[] = [
        {
          id: 1,
          task_id: 'task-1',
          event_type: 'created',
          data: null,
          created_at: 1000,
        },
      ]
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getTaskEvents as any).mockReturnValue(events)

      const res = await app.request('/tasks/task-1')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe('task-1')
      expect(body.events).toHaveLength(1)
    })

    it('returns 404 for unknown task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(undefined)
      const res = await app.request('/tasks/nope')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /tasks', () => {
    it('creates a task, broadcasts, and triggers dispatch', async () => {
      const created = makeTask({ id: 'new-1' })
      ;(ctx.queries.createTask as any).mockReturnValue(created)
      ;(ctx.queries.getTaskById as any).mockReturnValue(created)

      const res = await app.request('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 'proj-1',
          type: 'do',
          prompt: 'do something',
        }),
      })

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.id).toBe('new-1')
      expect(ctx.taskQueue.recomputePositions).toHaveBeenCalledWith('proj-1')
      expect(ctx.sseManager.broadcast).toHaveBeenCalledWith(
        'task:created',
        created,
      )
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })

    it('returns 400 when both title and prompt are missing', async () => {
      const res = await app.request('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'proj-1', type: 'do' }),
      })
      expect(res.status).toBe(400)
    })

    it('creates a task with title only (no prompt)', async () => {
      const created = makeTask({ id: 'new-1', title: 'Fix auth', prompt: null })
      ;(ctx.queries.createTask as any).mockReturnValue(created)
      ;(ctx.queries.getTaskById as any).mockReturnValue(created)

      const res = await app.request('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 'proj-1',
          type: 'do',
          title: 'Fix auth',
        }),
      })

      expect(res.status).toBe(201)
      expect(ctx.queries.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Fix auth' }),
      )
    })
  })

  describe('PATCH /tasks/:id', () => {
    it('updates task and broadcasts', async () => {
      const existing = makeTask({ status: 'queued' })
      const updated = makeTask({ status: 'in_progress' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(existing)
      ;(ctx.queries.updateTask as any).mockReturnValue(updated)

      const res = await app.request('/tasks/task-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      })

      expect(res.status).toBe(200)
      expect(ctx.sseManager.broadcast).toHaveBeenCalledWith(
        'task:updated',
        updated,
      )
    })

    it('broadcasts inbox:new when status transitions to inbox', async () => {
      const existing = makeTask({ status: 'in_progress' })
      const updated = makeTask({ status: 'ready' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(existing)
      ;(ctx.queries.updateTask as any).mockReturnValue(updated)

      await app.request('/tasks/task-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready' }),
      })

      expect(ctx.sseManager.broadcast).toHaveBeenCalledWith(
        'inbox:new',
        updated,
      )
    })
  })

  describe('DELETE /tasks/:id (cancel)', () => {
    it('kills agent, cancels task, broadcasts, and triggers dispatch', async () => {
      const existing = makeTask({ status: 'in_progress' })
      const cancelled = makeTask({ status: 'cancelled', worktree_path: null })
      ;(ctx.queries.getTaskById as any).mockReturnValue(existing)
      ;(ctx.queries.updateTask as any).mockReturnValue(cancelled)

      const res = await app.request('/tasks/task-1', { method: 'DELETE' })

      expect(res.status).toBe(200)
      expect(ctx.pool.killAgent).toHaveBeenCalledWith('task-1')
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'cancelled',
        null,
      )
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })

    it('deletes worktree and branch when cancelling a task with a branch', async () => {
      const existing = makeTask({
        status: 'in_progress',
        worktree_path: '/tmp/test/.harness-worktrees/harness-abc-test',
        branch_name: 'harness/abc-test',
      })
      const cancelled = makeTask({
        status: 'cancelled',
        worktree_path: null,
        branch_name: null,
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(existing)
      ;(ctx.queries.updateTask as any).mockReturnValue(cancelled)

      const res = await app.request('/tasks/task-1', { method: 'DELETE' })

      expect(res.status).toBe(200)
      expect(mockRemoveWorktree).toHaveBeenCalledWith(
        '/tmp/test',
        '/tmp/test/.harness-worktrees/harness-abc-test',
      )
      expect(mockDeleteBranch).toHaveBeenCalledWith(
        '/tmp/test',
        'harness/abc-test',
      )
      // branch_name should be nulled in the DB update
      expect(ctx.queries.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: 'cancelled',
          worktree_path: null,
          branch_name: null,
        }),
      )
    })

    it('deletes branch when permanently deleting a terminal task', async () => {
      const existing = makeTask({
        status: 'cancelled',
        worktree_path: null,
        branch_name: 'harness/abc-test',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(existing)

      const res = await app.request('/tasks/task-1?permanent=true', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      expect(mockDeleteBranch).toHaveBeenCalledWith(
        '/tmp/test',
        'harness/abc-test',
      )
    })

    it('returns 404 for unknown task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(undefined)
      const res = await app.request('/tasks/nope', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /tasks/:id/approve', () => {
    it('returns 404 for unknown task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(undefined)
      const res = await app.request('/tasks/nope/approve', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('returns 400 for task not in approvable status', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(
        makeTask({ status: 'queued' }),
      )
      const res = await app.request('/tasks/task-1/approve', { method: 'POST' })
      expect(res.status).toBe(400)
    })

    it('approves a ready task without branch (discuss task)', async () => {
      const task = makeTask({ status: 'ready', branch_name: null })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockReturnValue(
        makeTask({ status: 'approved' }),
      )

      const res = await app.request('/tasks/task-1/approve', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(ctx.queries.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'approved' }),
      )
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })
  })

  describe('POST /tasks/:id/reject', () => {
    it('rejects a ready task and reports blocked dependents', async () => {
      const task = makeTask({ status: 'ready' })
      const dependent = makeTask({
        id: 'dep-1',
        depends_on: 'task-1',
        status: 'queued',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockReturnValue(
        makeTask({ status: 'rejected' }),
      )
      ;(ctx.queries.getTasksByStatus as any).mockReturnValue([dependent])

      const res = await app.request('/tasks/task-1/reject', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.blocked_dependents).toHaveLength(1)
      expect(body.blocked_dependents[0].id).toBe('dep-1')
    })
  })

  describe('GET /tasks/:id/diff', () => {
    it('returns empty diff for task without branch', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(
        makeTask({ branch_name: null }),
      )

      const res = await app.request('/tasks/task-1/diff')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.diff).toBe('')
    })
  })

  describe('POST /tasks/:id/revise', () => {
    it('revises a ready task preserving session data and worktree', async () => {
      const task = makeTask({
        status: 'ready',
        agent_session_data: '{"session_id":"sess-1","pid":123}',
        worktree_path: '/tmp/wt',
        branch_name: 'harness/abc-test',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockImplementation(
        (id: string, updates: any) => makeTask({ id, ...updates }),
      )

      const res = await app.request('/tasks/task-1/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Fix the tests please' }),
      })
      expect(res.status).toBe(200)

      // Should update with new prompt and queued status, but NOT clear session data/worktree
      expect(ctx.queries.updateTask).toHaveBeenCalledWith('task-1', {
        status: 'queued',
        prompt: 'Fix the tests please',
        error_message: null,
        agent_summary: null,
        diff_summary: null,
        original_prompt: 'test task',
      })
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'revised',
        expect.stringContaining('Fix the tests please'),
      )
      expect(ctx.sseManager.broadcast).toHaveBeenCalledWith(
        'task:updated',
        expect.anything(),
      )
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })

    it('rejects revise on non-ready/error task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(
        makeTask({ status: 'approved' }),
      )

      const res = await app.request('/tasks/task-1/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'test' }),
      })
      expect(res.status).toBe(400)
    })

    it('does not overwrite original_prompt on second revise', async () => {
      const task = makeTask({
        status: 'ready',
        prompt: 'second feedback',
        original_prompt: 'the very first prompt',
        agent_session_data: '{"session_id":"sess-1","pid":123}',
        worktree_path: '/tmp/wt',
        branch_name: 'harness/abc-test',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockImplementation(
        (id: string, updates: any) => makeTask({ id, ...updates }),
      )

      const res = await app.request('/tasks/task-1/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'third feedback' }),
      })
      expect(res.status).toBe(200)

      // original_prompt should NOT be in the update since it's already set
      expect(ctx.queries.updateTask).toHaveBeenCalledWith('task-1', {
        status: 'queued',
        prompt: 'third feedback',
        error_message: null,
        agent_summary: null,
        diff_summary: null,
      })
    })

    it('revises an error task', async () => {
      const task = makeTask({
        status: 'error',
        agent_session_data: '{"session_id":"sess-1","pid":0}',
        worktree_path: '/tmp/wt',
        branch_name: 'harness/abc-test',
        error_message: 'agent crashed',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockImplementation(
        (id: string, updates: any) => makeTask({ id, ...updates }),
      )

      const res = await app.request('/tasks/task-1/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Use pnpm not npm' }),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('POST /tasks/:id/fix', () => {
    it('fixes a ready task by adding tag and preserving original prompt', async () => {
      const task = makeTask({
        status: 'ready',
        agent_session_data: '{"session_id":"sess-1","pid":123}',
        worktree_path: '/tmp/wt',
        branch_name: 'harness/abc-test',
        prompt: 'Add login form',
        tags: [],
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockImplementation(
        (id: string, updates: any) => makeTask({ id, ...updates }),
      )

      const res = await app.request('/tasks/task-1/fix', { method: 'POST' })
      expect(res.status).toBe(200)

      // Should add merge-conflict tag and preserve original prompt
      expect(ctx.queries.updateTask).toHaveBeenCalledWith('task-1', {
        status: 'queued',
        tags: ['merge-conflict'],
        error_message: null,
        agent_summary: null,
        diff_summary: null,
      })

      // Prompt should NOT be modified
      const updateCall = (ctx.queries.updateTask as any).mock.calls[0][1]
      expect(updateCall).not.toHaveProperty('prompt')

      // Should NOT clear session data, worktree, or branch
      expect(updateCall).not.toHaveProperty('agent_session_data')
      expect(updateCall).not.toHaveProperty('worktree_path')
      expect(updateCall).not.toHaveProperty('branch_name')

      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'fix_merge_conflict',
        null,
      )
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })

    it('accepts a fix type parameter', async () => {
      const task = makeTask({
        status: 'ready',
        prompt: 'Add login form',
        tags: [],
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockImplementation(
        (id: string, updates: any) => makeTask({ id, ...updates }),
      )

      const res = await app.request('/tasks/task-1/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'needs-commit' }),
      })
      expect(res.status).toBe(200)

      const updateCall = (ctx.queries.updateTask as any).mock.calls[0][1]
      expect(updateCall.tags).toEqual(['needs-commit'])
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'fix_needs_commit',
        null,
      )
    })

    it('rejects fix on non-ready task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(
        makeTask({ status: 'queued' }),
      )

      const res = await app.request('/tasks/task-1/fix', { method: 'POST' })
      expect(res.status).toBe(400)
    })

    it('does not duplicate tag on repeated fix', async () => {
      const task = makeTask({
        status: 'ready',
        prompt: 'Add login form',
        tags: ['merge-conflict'],
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockImplementation(
        (id: string, updates: any) => makeTask({ id, ...updates }),
      )

      const res = await app.request('/tasks/task-1/fix', { method: 'POST' })
      expect(res.status).toBe(200)

      const updateCall = (ctx.queries.updateTask as any).mock.calls[0][1]
      // Should not have duplicate tags
      expect(
        updateCall.tags.filter((t: string) => t === 'merge-conflict'),
      ).toHaveLength(1)
    })
  })

  describe('POST /tasks/:id/grant-permission', () => {
    it('rejects non-permission tasks', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(
        makeTask({ status: 'ready' }),
      )
      const res = await app.request('/tasks/task-1/grant-permission', {
        method: 'POST',
      })
      expect(res.status).toBe(400)
    })

    it('adds tool to granted_tools and re-queues', async () => {
      const task = makeTask({
        status: 'permission',
        error_message: 'Tool requiring permission: WebSearch',
        agent_session_data: JSON.stringify({
          session_id: 'sess-1',
          pid: 123,
          pending_tool: 'WebSearch',
          pending_tool_input: null,
        }),
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/grant-permission', {
        method: 'POST',
      })
      expect(res.status).toBe(200)

      const updateCall = (ctx.queries.updateTask as any).mock.calls[0]
      expect(updateCall[1].status).toBe('queued')
      expect(updateCall[1].error_message).toBeNull()
      const sessionData = JSON.parse(updateCall[1].agent_session_data)
      expect(sessionData.granted_tools).toContain('WebSearch')
      expect(sessionData.pending_tool).toBeUndefined()
    })

    it('uses command-level pattern for Bash grants', async () => {
      const task = makeTask({
        status: 'permission',
        agent_session_data: JSON.stringify({
          session_id: 'sess-1',
          pid: 123,
          pending_tool: 'Bash',
          pending_tool_input: {
            command: 'curl example.com',
            description: 'Fetch example.com',
          },
        }),
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/grant-permission', {
        method: 'POST',
      })
      expect(res.status).toBe(200)

      const updateCall = (ctx.queries.updateTask as any).mock.calls[0]
      const sessionData = JSON.parse(updateCall[1].agent_session_data)
      expect(sessionData.granted_tools).toContain('Bash(curl:*)')
      expect(sessionData.granted_tools).not.toContain('Bash')
    })

    it('accumulates grants across multiple permission cycles', async () => {
      const task = makeTask({
        status: 'permission',
        agent_session_data: JSON.stringify({
          session_id: 'sess-1',
          pid: 123,
          granted_tools: ['Bash(curl:*)'],
          pending_tool: 'WebSearch',
          pending_tool_input: null,
        }),
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/grant-permission', {
        method: 'POST',
      })
      expect(res.status).toBe(200)

      const updateCall = (ctx.queries.updateTask as any).mock.calls[0]
      const sessionData = JSON.parse(updateCall[1].agent_session_data)
      expect(sessionData.granted_tools).toEqual(['Bash(curl:*)', 'WebSearch'])
    })
  })

  describe('POST /tasks/:id/follow-up', () => {
    it('blocks concurrent follow-ups on the same parent', async () => {
      const parent = makeTask({
        id: 'parent-1',
        status: 'approved',
        agent_session_data: '{"session_id":"sess-1","pid":0}',
      })
      const existingFollowUp = makeTask({
        id: 'followup-1',
        parent_task_id: 'parent-1',
        status: 'in_progress',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(parent)
      ;(ctx.queries.getTasksByStatus as any).mockReturnValue([existingFollowUp])

      const res = await app.request('/tasks/parent-1/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'do more' }),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.active_follow_up_id).toBe('followup-1')
    })

    it('creates follow-up with parent_task_id instead of depends_on', async () => {
      const parent = makeTask({
        id: 'parent-1',
        status: 'approved',
        agent_session_data: '{"session_id":"sess-1","pid":0}',
      })
      ;(ctx.queries.getTaskById as any)
        .mockReturnValueOnce(parent) // initial lookup
        .mockReturnValue(makeTask({ id: 'new-1', parent_task_id: 'parent-1' })) // after update
      ;(ctx.queries.getTasksByStatus as any).mockReturnValue([]) // no active follow-ups
      ;(ctx.queries.createTask as any).mockReturnValue(
        makeTask({ id: 'new-1' }),
      )

      const res = await app.request('/tasks/parent-1/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'add logging' }),
      })
      expect(res.status).toBe(201)

      // Should NOT set depends_on
      expect(ctx.queries.createTask).toHaveBeenCalledWith(
        expect.not.objectContaining({ depends_on: 'parent-1' }),
      )
      // Should set parent_task_id via updateTask
      expect(ctx.queries.updateTask).toHaveBeenCalledWith(
        'new-1',
        expect.objectContaining({ parent_task_id: 'parent-1' }),
      )
    })

    it('creates follow-up with overridden task type', async () => {
      const parent = makeTask({
        id: 'parent-1',
        type: 'discuss',
        status: 'approved',
        agent_session_data: '{"session_id":"sess-1","pid":0}',
      })
      ;(ctx.queries.getTaskById as any)
        .mockReturnValueOnce(parent)
        .mockReturnValue(makeTask({ id: 'new-1', type: 'do', parent_task_id: 'parent-1' }))
      ;(ctx.queries.getTasksByStatus as any).mockReturnValue([])
      ;(ctx.queries.createTask as any).mockReturnValue(
        makeTask({ id: 'new-1', type: 'do' }),
      )

      const res = await app.request('/tasks/parent-1/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'implement this', type: 'do' }),
      })
      expect(res.status).toBe(201)

      expect(ctx.queries.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'do' }),
      )
    })

    it('rejects follow-up with unknown task type', async () => {
      const parent = makeTask({
        id: 'parent-1',
        status: 'approved',
        agent_session_data: '{"session_id":"sess-1","pid":0}',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(parent)
      ;(ctx.queries.getTasksByStatus as any).mockReturnValue([])

      const res = await app.request('/tasks/parent-1/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'do stuff', type: 'nonexistent' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Unknown task type')
    })
  })

  describe('reject clears parent references', () => {
    it('calls clearParentReferences on reject', async () => {
      const task = makeTask({ status: 'ready' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockReturnValue(
        makeTask({ status: 'rejected' }),
      )
      ;(ctx.queries.getTasksByStatus as any).mockReturnValue([])

      await app.request('/tasks/task-1/reject', { method: 'POST' })
      expect(ctx.queries.clearParentReferences).toHaveBeenCalledWith('task-1')
    })
  })

  describe('cancel clears parent references', () => {
    it('calls clearParentReferences on cancel', async () => {
      const task = makeTask({ status: 'in_progress' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockReturnValue(
        makeTask({ status: 'cancelled' }),
      )

      await app.request('/tasks/task-1', { method: 'DELETE' })
      expect(ctx.queries.clearParentReferences).toHaveBeenCalledWith('task-1')
    })
  })

  describe('POST /tasks/:id/checkout', () => {
    it('checks out a ready task with a branch', async () => {
      const task = makeTask({
        status: 'ready',
        branch_name: 'harness/abc-test',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/checkout', {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.checkout_branch).toMatch(/^harness\/checkout-/)

      expect(mockCheckoutTask).toHaveBeenCalledWith(
        '/tmp/test',
        'main',
        'harness/abc-test',
        expect.stringContaining('harness/checkout-'),
      )
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'checked_out',
        null,
      )
      expect(ctx.sseManager.broadcast).toHaveBeenCalledWith(
        'task:checked_out',
        expect.objectContaining({
          taskId: 'task-1',
          projectName: 'test',
        }),
      )
      expect(ctx.checkoutState.has('/tmp/test')).toBe(true)
    })

    it('returns 404 for unknown task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(undefined)
      const res = await app.request('/tasks/nope/checkout', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('returns 400 for non-ready task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(
        makeTask({ status: 'approved' }),
      )
      const res = await app.request('/tasks/task-1/checkout', {
        method: 'POST',
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 for task without branch', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(
        makeTask({ status: 'ready', branch_name: null }),
      )
      const res = await app.request('/tasks/task-1/checkout', {
        method: 'POST',
      })
      expect(res.status).toBe(400)
    })

    it('returns 409 when repo already has a checkout active', async () => {
      const task = makeTask({
        status: 'ready',
        branch_name: 'harness/abc-test',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      // Pre-populate checkout state
      ctx.checkoutState.set('/tmp/test', {
        taskId: 'other-task',
        checkoutBranch: 'harness/checkout-other',
      })

      const res = await app.request('/tasks/task-1/checkout', {
        method: 'POST',
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.checked_out_task_id).toBe('other-task')
    })

    it('allows checkout of error tasks', async () => {
      const task = makeTask({
        status: 'error',
        branch_name: 'harness/abc-test',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/checkout', {
        method: 'POST',
      })
      expect(res.status).toBe(200)
    })

    it('returns 500 when git checkout fails', async () => {
      const task = makeTask({
        status: 'ready',
        branch_name: 'harness/abc-test',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      mockCheckoutTask.mockImplementationOnce(() => {
        throw new Error('merge conflict')
      })

      const res = await app.request('/tasks/task-1/checkout', {
        method: 'POST',
      })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toMatch(/merge conflict/)
      expect(ctx.checkoutState.has('/tmp/test')).toBe(false)
    })
  })

  describe('POST /tasks/:id/return', () => {
    it('returns a checked-out task', async () => {
      const task = makeTask({
        status: 'ready',
        branch_name: 'harness/abc-test',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      ctx.checkoutState.set('/tmp/test', {
        taskId: 'task-1',
        checkoutBranch: 'harness/checkout-task-1',
      })

      const res = await app.request('/tasks/task-1/return', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)

      expect(mockReturnCheckout).toHaveBeenCalledWith(
        '/tmp/test',
        'main',
        'harness/checkout-task-1',
      )
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'returned',
        null,
      )
      expect(ctx.sseManager.broadcast).toHaveBeenCalledWith(
        'task:returned',
        expect.objectContaining({
          taskId: 'task-1',
        }),
      )
      expect(ctx.checkoutState.has('/tmp/test')).toBe(false)
    })

    it('returns 400 when task is not checked out', async () => {
      const task = makeTask({ status: 'ready' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/return', { method: 'POST' })
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(undefined)
      const res = await app.request('/tasks/nope/return', { method: 'POST' })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /checkouts', () => {
    it('returns empty list when no checkouts active', async () => {
      const res = await app.request('/checkouts')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    })

    it('returns active checkouts', async () => {
      const task = makeTask({ status: 'ready', prompt: 'implement feature X' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      ctx.checkoutState.set('/tmp/test', {
        taskId: 'task-1',
        checkoutBranch: 'harness/checkout-task-1',
      })

      const res = await app.request('/checkouts')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveLength(1)
      expect(body[0]).toEqual({
        taskId: 'task-1',
        taskPrompt: 'implement feature X',
        repoPath: '/tmp/test',
        projectName: 'test',
        projectId: 'proj-1',
      })
    })
  })

  describe('auto-return on approve/reject', () => {
    it('auto-returns checkout when approving checked-out task', async () => {
      const task = makeTask({ status: 'ready', branch_name: null })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockReturnValue(
        makeTask({ status: 'approved' }),
      )

      ctx.checkoutState.set('/tmp/test', {
        taskId: 'task-1',
        checkoutBranch: 'harness/checkout-task-1',
      })

      const res = await app.request('/tasks/task-1/approve', { method: 'POST' })
      expect(res.status).toBe(200)

      // Should have auto-returned
      expect(mockReturnCheckout).toHaveBeenCalledWith(
        '/tmp/test',
        'main',
        'harness/checkout-task-1',
      )
      expect(ctx.checkoutState.has('/tmp/test')).toBe(false)
      expect(ctx.sseManager.broadcast).toHaveBeenCalledWith(
        'task:returned',
        expect.objectContaining({
          taskId: 'task-1',
        }),
      )
    })

    it('auto-returns checkout when rejecting checked-out task', async () => {
      const task = makeTask({ status: 'ready' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockReturnValue(
        makeTask({ status: 'rejected' }),
      )
      ;(ctx.queries.getTasksByStatus as any).mockReturnValue([])

      ctx.checkoutState.set('/tmp/test', {
        taskId: 'task-1',
        checkoutBranch: 'harness/checkout-task-1',
      })

      const res = await app.request('/tasks/task-1/reject', { method: 'POST' })
      expect(res.status).toBe(200)

      expect(mockReturnCheckout).toHaveBeenCalledWith(
        '/tmp/test',
        'main',
        'harness/checkout-task-1',
      )
      expect(ctx.checkoutState.has('/tmp/test')).toBe(false)
    })

    it('does not auto-return for a different task', async () => {
      const task = makeTask({ status: 'ready', branch_name: null })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockReturnValue(
        makeTask({ status: 'approved' }),
      )

      // Different task is checked out
      ctx.checkoutState.set('/tmp/test', {
        taskId: 'other-task',
        checkoutBranch: 'harness/checkout-other',
      })

      await app.request('/tasks/task-1/approve', { method: 'POST' })

      // Should NOT have returned
      expect(mockReturnCheckout).not.toHaveBeenCalled()
      expect(ctx.checkoutState.has('/tmp/test')).toBe(true)
    })

    it('auto-returns checkout when revising checked-out task', async () => {
      const task = makeTask({
        status: 'ready',
        agent_session_data: '{"session_id":"sess-1","pid":123}',
        worktree_path: '/tmp/wt',
        branch_name: 'harness/abc-test',
      })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.updateTask as any).mockImplementation(
        (id: string, updates: any) => makeTask({ id, ...updates }),
      )

      ctx.checkoutState.set('/tmp/test', {
        taskId: 'task-1',
        checkoutBranch: 'harness/checkout-task-1',
      })

      const res = await app.request('/tasks/task-1/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Fix the tests please' }),
      })
      expect(res.status).toBe(200)

      // Should have auto-returned
      expect(mockReturnCheckout).toHaveBeenCalledWith(
        '/tmp/test',
        'main',
        'harness/checkout-task-1',
      )
      expect(ctx.checkoutState.has('/tmp/test')).toBe(false)
      expect(ctx.sseManager.broadcast).toHaveBeenCalledWith(
        'task:returned',
        expect.objectContaining({
          taskId: 'task-1',
        }),
      )
    })
  })

  describe('POST /tasks/:id/propose-subtasks', () => {
    it('stores proposals and transitions to subtasks_proposed', async () => {
      const task = makeTask({ status: 'in_progress' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.createSubtaskProposals as any).mockReturnValue([
        { id: 1, title: 'Fix auth', prompt: 'Fix the auth bug', priority: 'P2', status: 'pending' },
        { id: 2, title: 'Add tests', prompt: 'Add unit tests', priority: 'P2', status: 'pending' },
      ])

      const res = await app.request('/tasks/task-1/propose-subtasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtasks: [
            { title: 'Fix auth', prompt: 'Fix the auth bug' },
            { title: 'Add tests', prompt: 'Add unit tests' },
          ],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.proposal_count).toBe(2)

      expect(ctx.queries.createSubtaskProposals).toHaveBeenCalledWith('task-1', [
        { title: 'Fix auth', prompt: 'Fix the auth bug' },
        { title: 'Add tests', prompt: 'Add unit tests' },
      ])
      expect(ctx.queries.updateTask).toHaveBeenCalledWith('task-1', { status: 'subtasks_proposed' })
      expect(ctx.pool.killAgent).toHaveBeenCalledWith('task-1')
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith('task-1', 'subtasks_proposed', null)
    })

    it('rejects if task is not in_progress', async () => {
      const task = makeTask({ status: 'queued' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/propose-subtasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtasks: [{ title: 'X', prompt: 'Y' }] }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty subtasks array', async () => {
      const task = makeTask({ status: 'in_progress' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/propose-subtasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtasks: [] }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects subtasks missing title or prompt', async () => {
      const task = makeTask({ status: 'in_progress' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/propose-subtasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtasks: [{ title: '', prompt: 'Y' }] }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(undefined)

      const res = await app.request('/tasks/nope/propose-subtasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtasks: [{ title: 'X', prompt: 'Y' }] }),
      })
      expect(res.status).toBe(404)
    })

    it('auto-approves when config.auto_approve_subtasks is true', async () => {
      ctx.config.auto_approve_subtasks = true
      const task = makeTask({ status: 'in_progress' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.createSubtaskProposals as any).mockReturnValue([
        { id: 1, title: 'Fix auth', prompt: 'Fix it', priority: 'P2', status: 'pending' },
      ])
      ;(ctx.queries.createTask as any).mockReturnValue(
        makeTask({ id: 'child-1', prompt: 'Fix it' }),
      )

      const res = await app.request('/tasks/task-1/propose-subtasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtasks: [{ title: 'Fix auth', prompt: 'Fix it' }] }),
      })
      expect(res.status).toBe(200)

      // Should create child task immediately
      expect(ctx.queries.createTask).toHaveBeenCalled()
      // Should set parent_task_id on child
      expect(ctx.queries.updateTask).toHaveBeenCalledWith(
        'child-1',
        expect.objectContaining({ parent_task_id: 'task-1' }),
      )
      // Should mark proposal as approved
      expect(ctx.queries.updateSubtaskProposal).toHaveBeenCalledWith(1, {
        status: 'approved',
        spawned_task_id: 'child-1',
      })
      // Should create auto-approved event (not subtasks_proposed)
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'subtasks_auto_approved',
        null,
      )
      // Should trigger dispatch
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })
  })

  describe('GET /tasks/:id/proposals', () => {
    it('returns proposals for a task', async () => {
      const task = makeTask({ status: 'subtasks_proposed' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      const proposals = [
        { id: 1, task_id: 'task-1', title: 'Fix auth', prompt: 'Fix it', priority: 'P2', status: 'pending' },
      ]
      ;(ctx.queries.getSubtaskProposals as any).mockReturnValue(proposals)

      const res = await app.request('/tasks/task-1/proposals')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(proposals)
    })

    it('returns 404 for unknown task', async () => {
      ;(ctx.queries.getTaskById as any).mockReturnValue(undefined)

      const res = await app.request('/tasks/nope/proposals')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /tasks/:id/resolve-proposals', () => {
    it('creates tasks for approved proposals and dispatches', async () => {
      const task = makeTask({ status: 'subtasks_proposed' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getSubtaskProposals as any).mockReturnValue([
        { id: 1, task_id: 'task-1', title: 'Fix auth', prompt: 'Fix it', priority: 'P2', status: 'pending' },
      ])
      ;(ctx.queries.createTask as any).mockReturnValue(
        makeTask({ id: 'child-1', prompt: 'Fix it' }),
      )

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
      expect(body.dismissed).toBe(0)

      expect(ctx.queries.createTask).toHaveBeenCalled()
      expect(ctx.queries.updateSubtaskProposal).toHaveBeenCalledWith(1, {
        status: 'approved',
        spawned_task_id: 'child-1',
      })
      expect(ctx.dispatcher.tryDispatch).toHaveBeenCalled()
    })

    it('resumes parent immediately when all proposals dismissed', async () => {
      const task = makeTask({ status: 'subtasks_proposed', prompt: 'original prompt' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getSubtaskProposals as any).mockReturnValue([
        { id: 1, task_id: 'task-1', title: 'Fix auth', prompt: 'Fix it', priority: 'P2', status: 'dismissed', feedback: 'Not needed' },
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

      // Parent should have been re-queued
      expect(ctx.queries.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'queued' }),
      )
      expect(ctx.queries.createTaskEvent).toHaveBeenCalledWith(
        'task-1',
        'subtasks_all_dismissed',
        null,
      )
    })

    it('rejects if task is not subtasks_proposed', async () => {
      const task = makeTask({ status: 'in_progress' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: [], dismissed: [] }),
      })
      expect(res.status).toBe(400)
    })

    it('handles mixed approval and dismissal in a single request', async () => {
      const task = makeTask({ status: 'subtasks_proposed' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getSubtaskProposals as any).mockReturnValue([
        { id: 1, task_id: 'task-1', title: 'Fix auth', prompt: 'Fix it', priority: 'P2', status: 'pending' },
        { id: 2, task_id: 'task-1', title: 'Refactor', prompt: 'Clean up', priority: 'P3', status: 'pending' },
      ])
      ;(ctx.queries.createTask as any).mockReturnValue(
        makeTask({ id: 'child-1', prompt: 'Fix it' }),
      )

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: [{ id: 1 }],
          dismissed: [{ id: 2, feedback: 'Not worth it' }],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.approved).toBe(1)
      expect(body.dismissed).toBe(1)

      // Dismissed should store feedback
      expect(ctx.queries.updateSubtaskProposal).toHaveBeenCalledWith(2, {
        status: 'dismissed',
        feedback: 'Not worth it',
      })
      // Approved should create task
      expect(ctx.queries.createTask).toHaveBeenCalled()
      // Parent transitions to waiting_on_subtasks (some approved)
      expect(ctx.queries.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'waiting_on_subtasks' }),
      )
    })

    it('applies user prompt and priority overrides on approved proposals', async () => {
      const task = makeTask({ status: 'subtasks_proposed' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getSubtaskProposals as any).mockReturnValue([
        { id: 1, task_id: 'task-1', title: 'Fix auth', prompt: 'Original prompt', priority: 'P2', status: 'pending' },
      ])
      ;(ctx.queries.createTask as any).mockReturnValue(
        makeTask({ id: 'child-1', prompt: 'Revised prompt' }),
      )

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: [{ id: 1, prompt: 'Revised prompt', priority: 'P0' }],
          dismissed: [],
        }),
      })
      expect(res.status).toBe(200)

      // Should use overridden prompt and priority
      expect(ctx.queries.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Revised prompt',
          priority: 'P0',
        }),
      )
    })

    it('stores feedback on dismissed proposals', async () => {
      const task = makeTask({ status: 'subtasks_proposed', prompt: 'original' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.queries.getSubtaskProposals as any).mockReturnValue([
        { id: 1, task_id: 'task-1', title: 'Fix auth', prompt: 'Fix it', priority: 'P2', status: 'dismissed', feedback: 'Already fixed' },
      ])

      const res = await app.request('/tasks/task-1/resolve-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: [],
          dismissed: [{ id: 1, feedback: 'Already fixed' }],
        }),
      })
      expect(res.status).toBe(200)

      expect(ctx.queries.updateSubtaskProposal).toHaveBeenCalledWith(1, {
        status: 'dismissed',
        feedback: 'Already fixed',
      })
    })
  })

  describe('GET /tasks/:id/progress', () => {
    it('returns live buffer when available', async () => {
      const task = makeTask({ status: 'in_progress' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      const liveMessages = [{ type: 'assistant', message: 'Working...' }]
      ;(ctx.pool.getProgressBuffer as any).mockReturnValue(liveMessages)

      const res = await app.request('/tasks/task-1/progress')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.messages).toEqual(liveMessages)
    })

    it('falls back to persisted session when live buffer is empty', async () => {
      const task = makeTask({ status: 'approved' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.pool.getProgressBuffer as any).mockReturnValue([])
      const persisted = [{ type: 'assistant', message: 'Done' }]
      ;(loadSessionMessages as any).mockReturnValue(persisted)

      const res = await app.request('/tasks/task-1/progress')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.messages).toEqual(persisted)
      expect(loadSessionMessages).toHaveBeenCalledWith('task-1')
    })

    it('returns empty array when no live buffer or persisted session', async () => {
      const task = makeTask({ status: 'approved' })
      ;(ctx.queries.getTaskById as any).mockReturnValue(task)
      ;(ctx.pool.getProgressBuffer as any).mockReturnValue([])
      ;(loadSessionMessages as any).mockReturnValue([])

      const res = await app.request('/tasks/task-1/progress')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.messages).toEqual([])
    })
  })
})
