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
    title: null,
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
    created_at: Date.now(),
    updated_at: Date.now(),
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
      makeTask({ status: 'queued' }),
      makeTask({ status: 'ready' }),
      makeTask({ status: 'error' }),
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

  it('reacts to view filter changes via getter', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'queued' }),
      makeTask({ status: 'ready' }),
      makeTask({ status: 'error' }),
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
      filter: { statuses: ['ready', 'error'] },
    }

    expect(result.value).toHaveLength(2)
    expect(result.value.map((t) => t.status).sort()).toEqual(['error', 'ready'])
  })

  it('reacts when view object is replaced (simulating store update)', () => {
    const store = useTasks()
    store.allTasks = [
      makeTask({ status: 'queued' }),
      makeTask({ status: 'in_progress' }),
      makeTask({ status: 'ready' }),
    ]

    // Simulate how ViewPanel receives views from the store:
    // views is a ref array, and the component accesses a specific index
    const views = ref<ViewConfig[]>([
      { id: 'outbox', name: 'Outbox', filter: { statuses: ['queued'] } },
    ])

    const result = store.tasksForView(() => views.value[0])

    expect(result.value).toHaveLength(1)

    // Simulate what happens when useViews.updateView replaces the array
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
