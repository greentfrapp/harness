import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../shared/types'
import { TaskQueue } from './queue'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    type: 'do',
    status: 'queued',
    prompt: 'test',
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
    queue_position: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  }
}

function makeDeps() {
  return {
    getTaskById: vi.fn<(id: string) => Task | undefined>(),
    getQueuedTasks: vi.fn<(projectId?: string) => Task[]>().mockReturnValue([]),
    updateTask:
      vi.fn<
        (id: string, updates: Record<string, unknown>) => Task | undefined
      >(),
    createTaskEvent: vi.fn(),
    broadcast: vi.fn(),
  }
}

describe('TaskQueue', () => {
  let deps: ReturnType<typeof makeDeps>
  let queue: TaskQueue

  beforeEach(() => {
    deps = makeDeps()
    queue = new TaskQueue(deps)
  })

  describe('isDependencySatisfied', () => {
    it('returns true when task has no dependency', () => {
      const task = makeTask({ depends_on: null })
      expect(queue.isDependencySatisfied(task)).toBe(true)
    })

    it('returns true when dependency is approved', () => {
      const task = makeTask({ depends_on: 'dep-1' })
      deps.getTaskById.mockReturnValue(
        makeTask({ id: 'dep-1', status: 'approved' }),
      )
      expect(queue.isDependencySatisfied(task)).toBe(true)
    })

    it('returns false when dependency is queued', () => {
      const task = makeTask({ depends_on: 'dep-1' })
      deps.getTaskById.mockReturnValue(
        makeTask({ id: 'dep-1', status: 'queued' }),
      )
      expect(queue.isDependencySatisfied(task)).toBe(false)
    })

    it('returns false when dependency is in_progress', () => {
      const task = makeTask({ depends_on: 'dep-1' })
      deps.getTaskById.mockReturnValue(
        makeTask({ id: 'dep-1', status: 'in_progress' }),
      )
      expect(queue.isDependencySatisfied(task)).toBe(false)
    })

    it('returns false when dependency is rejected', () => {
      const task = makeTask({ depends_on: 'dep-1' })
      deps.getTaskById.mockReturnValue(
        makeTask({ id: 'dep-1', status: 'rejected' }),
      )
      expect(queue.isDependencySatisfied(task)).toBe(false)
    })

    it('returns false when dependency does not exist', () => {
      const task = makeTask({ depends_on: 'dep-1' })
      deps.getTaskById.mockReturnValue(undefined)
      expect(queue.isDependencySatisfied(task)).toBe(false)
    })
  })

  describe('getNextReady', () => {
    it('returns null when no queued tasks', () => {
      deps.getQueuedTasks.mockReturnValue([])
      expect(queue.getNextReady()).toBeNull()
    })

    it('returns the only queued task', () => {
      const task = makeTask()
      deps.getQueuedTasks.mockReturnValue([task])
      expect(queue.getNextReady()).toBe(task)
    })

    it('returns P0 over P2 over P3', () => {
      const low = makeTask({ id: 'low', priority: 'P3' })
      const normal = makeTask({ id: 'normal', priority: 'P2' })
      const urgent = makeTask({ id: 'urgent', priority: 'P0' })
      deps.getQueuedTasks.mockReturnValue([low, normal, urgent])
      expect(queue.getNextReady()?.id).toBe('urgent')
    })

    it('breaks priority ties by created_at (oldest first)', () => {
      const newer = makeTask({ id: 'newer', priority: 'P2', created_at: 2000 })
      const older = makeTask({ id: 'older', priority: 'P2', created_at: 1000 })
      deps.getQueuedTasks.mockReturnValue([newer, older])
      expect(queue.getNextReady()?.id).toBe('older')
    })

    it('skips tasks with unsatisfied dependencies', () => {
      const blocked = makeTask({
        id: 'blocked',
        depends_on: 'dep-1',
        priority: 'P0',
      })
      const ready = makeTask({ id: 'ready', priority: 'P2' })
      deps.getQueuedTasks.mockReturnValue([blocked, ready])
      deps.getTaskById.mockReturnValue(
        makeTask({ id: 'dep-1', status: 'queued' }),
      )
      expect(queue.getNextReady()?.id).toBe('ready')
    })

    it('passes projectId to getQueuedTasks', () => {
      deps.getQueuedTasks.mockReturnValue([])
      queue.getNextReady('proj-1')
      expect(deps.getQueuedTasks).toHaveBeenCalledWith('proj-1')
    })
  })

  describe('recomputePositions', () => {
    it('assigns sequential positions to ready tasks', () => {
      const t1 = makeTask({ id: 't1', priority: 'P0' })
      const t2 = makeTask({ id: 't2', priority: 'P2' })
      deps.getQueuedTasks.mockReturnValue([t2, t1])

      queue.recomputePositions('proj-1')

      expect(deps.updateTask).toHaveBeenCalledWith('t1', { queue_position: 1 })
      expect(deps.updateTask).toHaveBeenCalledWith('t2', { queue_position: 2 })
    })

    it('puts blocked tasks after ready ones', () => {
      const ready = makeTask({ id: 'ready', priority: 'P2' })
      const blocked = makeTask({
        id: 'blocked',
        priority: 'P0',
        depends_on: 'dep-1',
      })
      deps.getQueuedTasks.mockReturnValue([blocked, ready])
      deps.getTaskById.mockReturnValue(
        makeTask({ id: 'dep-1', status: 'queued' }),
      )

      queue.recomputePositions('proj-1')

      // Ready first (position 1), blocked second (position 2) despite higher priority
      expect(deps.updateTask).toHaveBeenCalledWith('ready', {
        queue_position: 1,
      })
      expect(deps.updateTask).toHaveBeenCalledWith('blocked', {
        queue_position: 2,
      })
    })
  })

  describe('dispatch', () => {
    it('transitions queued task to in_progress', () => {
      const task = makeTask({ id: 't1', status: 'queued' })
      const updated = makeTask({ id: 't1', status: 'in_progress' })
      deps.getTaskById.mockReturnValue(task)
      deps.updateTask.mockReturnValue(updated)

      const result = queue.dispatch('t1')

      expect(deps.updateTask).toHaveBeenCalledWith('t1', {
        status: 'in_progress',
      })
      expect(deps.createTaskEvent).toHaveBeenCalledWith(
        't1',
        'dispatched',
        null,
      )
      expect(deps.broadcast).toHaveBeenCalledWith('task:updated', updated)
      expect(result).toBe(updated)
    })

    it('returns undefined for non-existent task', () => {
      deps.getTaskById.mockReturnValue(undefined)
      expect(queue.dispatch('nope')).toBeUndefined()
      expect(deps.updateTask).not.toHaveBeenCalled()
    })

    it('returns undefined for non-queued task', () => {
      deps.getTaskById.mockReturnValue(makeTask({ status: 'in_progress' }))
      expect(queue.dispatch('t1')).toBeUndefined()
      expect(deps.updateTask).not.toHaveBeenCalled()
    })
  })
})
