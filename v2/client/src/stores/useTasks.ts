import type {
  CreateTaskInput,
  Priority,
  Task,
  TaskStatus,
  ViewConfig,
} from '@shared/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'

const ALL_STATUSES: TaskStatus[] = [
  'draft',
  'queued',
  'in_progress',
  'pending',
  'done',
  'cancelled',
]

// Sort priority — lower number = higher in list
function sortKey(task: Task): number {
  const { status, substatus } = task
  if (status === 'pending' && substatus === 'permission') return 0
  if (status === 'in_progress' && substatus === 'waiting_on_subtasks') return 1
  if (status === 'pending' && substatus === 'task_proposal') return 1
  if (status === 'pending' && substatus === 'error') return 2
  if (status === 'pending' && substatus === 'response') return 3
  if (status === 'pending' && substatus === 'review') return 4
  if (status === 'in_progress') return 5 // running, retrying
  if (status === 'queued') return 6
  if (status === 'draft') return 7
  if (status === 'done' && substatus === 'approved') return 8
  if (status === 'done' && substatus === 'rejected') return 9
  if (status === 'done') return 8
  if (status === 'cancelled') return 10
  return 99
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const sa = sortKey(a)
    const sb = sortKey(b)
    if (sa !== sb) return sa - sb
    // Queued tasks sort by queue_position
    if (a.status === 'queued' && b.status === 'queued') {
      const pa = a.queue_position ?? Infinity
      const pb = b.queue_position ?? Infinity
      return pa - pb
    }
    // Otherwise by updated_at descending
    return b.updated_at - a.updated_at
  })
}

export const useTasks = defineStore('tasks', () => {
  const allTasks = ref<Task[]>([])
  const loading = ref(false)

  // --- Computed ---

  const pendingCount = computed(
    () =>
      allTasks.value.filter(
        (t) =>
          t.status === 'pending' &&
          (t.substatus === 'review' ||
            t.substatus === 'response' ||
            t.substatus === 'permission'),
      ).length,
  )

  const hasPermissionRequests = computed(() =>
    allTasks.value.some(
      (t) => t.status === 'pending' && t.substatus === 'permission',
    ),
  )

  // --- Fetch ---

  async function fetchAll() {
    loading.value = true
    try {
      allTasks.value = await api.tasks.list([...ALL_STATUSES])
    } finally {
      loading.value = false
    }
  }

  // --- View filtering ---

  function tasksForView(viewGetter: () => ViewConfig) {
    return computed(() => {
      const view = viewGetter()
      const filtered = allTasks.value.filter((task) => {
        const f = view.filter
        if (f.statuses?.length && !f.statuses.includes(task.status))
          return false
        if (
          f.substatuses?.length &&
          !f.substatuses.includes(task.substatus)
        )
          return false
        if (
          f.priorities?.length &&
          !f.priorities.includes(task.priority as Priority)
        )
          return false
        if (f.tags?.length && !f.tags.some((t) => task.tags.includes(t)))
          return false
        if (f.project_id && task.project_id !== f.project_id) return false
        return true
      })
      return sortTasks(filtered)
    })
  }

  // --- SSE handlers ---

  function upsert(task: Task) {
    const idx = allTasks.value.findIndex((t) => t.id === task.id)
    if (idx === -1) {
      allTasks.value.push(task)
    } else {
      allTasks.value[idx] = task
    }
  }

  function onTaskCreated(task: Task) {
    upsert(task)
  }

  function onTaskUpdated(task: Task) {
    upsert(task)
  }

  function onInboxNew(task: Task) {
    upsert(task)
  }

  function onTaskRemoved(id: string) {
    allTasks.value = allTasks.value.filter((t) => t.id !== id)
  }

  // --- Task actions ---

  async function createTask(input: CreateTaskInput): Promise<Task> {
    const task = await api.tasks.create(input)
    upsert(task)
    return task
  }

  async function sendDraft(id: string): Promise<Task> {
    const task = await api.tasks.send(id)
    upsert(task)
    return task
  }

  async function deleteDraft(id: string): Promise<void> {
    await api.tasks.delete(id)
    allTasks.value = allTasks.value.filter((t) => t.id !== id)
  }

  async function updateDraft(
    id: string,
    updates: { prompt?: string; priority?: Priority; type?: string },
  ): Promise<Task> {
    const task = await api.tasks.update(id, updates)
    upsert(task)
    return task
  }

  async function cancelTask(id: string): Promise<void> {
    await api.tasks.cancel(id)
  }

  async function deleteTask(id: string): Promise<void> {
    await api.tasks.delete(id)
    allTasks.value = allTasks.value.filter((t) => t.id !== id)
  }

  async function bulkDelete(ids: string[]): Promise<void> {
    await api.tasks.bulkDelete(ids)
    const idSet = new Set(ids)
    allTasks.value = allTasks.value.filter((t) => !idSet.has(t.id))
  }

  async function clearAll(statuses: TaskStatus[]): Promise<void> {
    await api.tasks.clearAll(statuses)
    const statusSet = new Set<string>(statuses)
    allTasks.value = allTasks.value.filter((t) => !statusSet.has(t.status))
  }

  return {
    allTasks,
    loading,
    pendingCount,
    hasPermissionRequests,
    fetchAll,
    tasksForView,
    onTaskCreated,
    onTaskUpdated,
    onInboxNew,
    onTaskRemoved,
    createTask,
    sendDraft,
    deleteDraft,
    updateDraft,
    cancelTask,
    deleteTask,
    bulkDelete,
    clearAll,
  }
})
