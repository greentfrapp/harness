import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Task, ViewConfig } from '@shared/types'
import { useTasks } from '../src/stores/useTasks'

// Mock the api module
vi.mock('../src/api', () => ({
  api: {
    tasks: {
      list: vi.fn().mockResolvedValue([]),
    },
  },
}))

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    project_id: 'proj-1',
    type: 'do',
    status: 'queued',
    substatus: null,
    title: null,
    prompt: 'test',
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
    queue_position: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    started_at: null,
    completed_at: null,
    ...overrides,
  }
}

describe('useTasks.tasksForView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('filters tasks by view statuses', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'queued', substatus: null }),
      makeTask({ status: 'pending', substatus: 'review' }),
      makeTask({ status: 'pending', substatus: 'error' }),
    ]

    const view: ViewConfig = {
      id: 'test',
      name: 'Test',
      filter: { statuses: ['queued'] },
    }
    const result = store.tasksForView(() => view)
    expect(result.value).toHaveLength(1)
    expect(result.value[0].status).toBe('queued')
  })

  it('filters tasks by view substatuses', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'pending', substatus: 'review' }),
      makeTask({ status: 'pending', substatus: 'error' }),
      makeTask({ status: 'pending', substatus: 'permission' }),
    ]

    const view: ViewConfig = {
      id: 'test',
      name: 'Test',
      filter: { statuses: ['pending'], substatuses: ['review', 'error'] },
    }
    const result = store.tasksForView(() => view)
    expect(result.value).toHaveLength(2)
    expect(result.value.map((t) => t.substatus).sort()).toEqual([
      'error',
      'review',
    ])
  })

  it('reacts to view filter changes via getter', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'queued', substatus: null }),
      makeTask({ status: 'pending', substatus: 'review' }),
      makeTask({ status: 'pending', substatus: 'error' }),
    ]

    const view = ref<ViewConfig>({
      id: 'test',
      name: 'Test',
      filter: { statuses: ['queued'] },
    })

    const result = store.tasksForView(() => view.value)

    expect(result.value).toHaveLength(1)
    expect(result.value[0].status).toBe('queued')

    // Change the view filter — the computed should react
    view.value = {
      id: 'test',
      name: 'Test',
      filter: { statuses: ['pending'] },
    }

    expect(result.value).toHaveLength(2)
    expect(result.value.map((t) => t.status)).toEqual(['pending', 'pending'])
  })

  it('reacts when view object is replaced (simulating store update)', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'queued', substatus: null }),
      makeTask({ status: 'in_progress', substatus: 'running' }),
      makeTask({ status: 'pending', substatus: 'review' }),
    ]

    const views = ref<ViewConfig[]>([
      { id: 'outbox', name: 'Outbox', filter: { statuses: ['queued'] } },
    ])

    const result = store.tasksForView(() => views.value[0])

    expect(result.value).toHaveLength(1)

    views.value = [
      {
        id: 'outbox',
        name: 'Outbox',
        filter: { statuses: ['queued', 'in_progress'] },
      },
    ]

    expect(result.value).toHaveLength(2)
  })
})

describe('useTasks.pendingCount', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('counts pending:review, pending:response, and pending:permission tasks', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'pending', substatus: 'review' }),
      makeTask({ status: 'pending', substatus: 'response' }),
      makeTask({ status: 'pending', substatus: 'permission' }),
      makeTask({ status: 'pending', substatus: 'error' }),
      makeTask({ status: 'pending', substatus: 'task_proposal' }),
      makeTask({ status: 'queued', substatus: null }),
    ]
    expect(store.pendingCount).toBe(3)
  })
})

describe('useTasks.hasPermissionRequests', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('returns true when pending:permission tasks exist', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'pending', substatus: 'permission' }),
    ]
    expect(store.hasPermissionRequests).toBe(true)
  })

  it('returns false when no pending:permission tasks', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'pending', substatus: 'review' }),
    ]
    expect(store.hasPermissionRequests).toBe(false)
  })
})

describe('useTasks sort order', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('sorts permission before error before review before running', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'in_progress', substatus: 'running', updated_at: 1 }),
      makeTask({ status: 'pending', substatus: 'review', updated_at: 1 }),
      makeTask({ status: 'pending', substatus: 'permission', updated_at: 1 }),
      makeTask({ status: 'pending', substatus: 'error', updated_at: 1 }),
    ]

    const view: ViewConfig = {
      id: 'all',
      name: 'All',
      filter: {},
    }
    const result = store.tasksForView(() => view)
    const substatuses = result.value.map((t) => t.substatus)
    expect(substatuses).toEqual(['permission', 'error', 'review', 'running'])
  })

  it('sorts queued tasks by queue_position', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'queued', substatus: null, queue_position: 3 }),
      makeTask({ status: 'queued', substatus: null, queue_position: 1 }),
      makeTask({ status: 'queued', substatus: null, queue_position: 2 }),
    ]

    const view: ViewConfig = {
      id: 'all',
      name: 'All',
      filter: { statuses: ['queued'] },
    }
    const result = store.tasksForView(() => view)
    expect(result.value.map((t) => t.queue_position)).toEqual([1, 2, 3])
  })
})
