import type {
  CreateTaskInput,
  Priority,
  Task,
  TaskStatus,
  ViewConfig,
} from '@shared/types'
import {
  DRAFT_STATUSES,
  INBOX_STATUSES,
  OUTBOX_STATUSES,
} from '@shared/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'

const ALL_STATUSES: TaskStatus[] = [
  ...DRAFT_STATUSES,
  ...OUTBOX_STATUSES,
  ...INBOX_STATUSES,
]

// Unified sort priority — lower number = higher in list
const STATUS_SORT_ORDER: Record<string, number> = {
  permission: 0,
  held: 1,
  error: 2,
  ready: 3,
  in_progress: 4,
  retrying: 5,
  queued: 6,
  draft: 7,
  approved: 8,
  rejected: 9,
  cancelled: 10,
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const sa = STATUS_SORT_ORDER[a.status] ?? 99
    const sb = STATUS_SORT_ORDER[b.status] ?? 99
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
        (t) => t.status === 'ready' || t.status === 'permission',
      ).length,
  )

  const hasPermissionRequests = computed(() =>
    allTasks.value.some((t) => t.status === 'permission'),
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

  function tasksForView(view: ViewConfig) {
    return computed(() => {
      const filtered = allTasks.value.filter((task) => {
        const f = view.filter
        if (f.statuses?.length && !f.statuses.includes(task.status))
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

  // --- Task actions (merged from useOutbox + useInbox) ---

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
    updates: { prompt?: string; priority?: string; type?: string },
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
