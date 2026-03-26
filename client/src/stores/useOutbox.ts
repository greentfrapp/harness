import type { CreateTaskInput, Task } from '@shared/types'
import { DRAFT_STATUSES, OUTBOX_STATUSES } from '@shared/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'
import { upsertOrRemove } from './taskArrayUtils'

export const useOutbox = defineStore('outbox', () => {
  const tasks = ref<Task[]>([])
  const drafts = ref<Task[]>([])
  const loading = ref(false)

  const sortedTasks = computed(() =>
    [...tasks.value].sort((a, b) => {
      if (a.status === 'in_progress' && b.status !== 'in_progress') return -1
      if (b.status === 'in_progress' && a.status !== 'in_progress') return 1
      const pa = a.queue_position ?? Infinity
      const pb = b.queue_position ?? Infinity
      return pa - pb
    }),
  )

  const sortedDrafts = computed(() =>
    [...drafts.value].sort((a, b) => b.updated_at - a.updated_at),
  )

  async function fetchTasks() {
    loading.value = true
    try {
      const [outboxTasks, draftTasks] = await Promise.all([
        api.tasks.list([...OUTBOX_STATUSES]),
        api.tasks.list([...DRAFT_STATUSES]),
      ])
      tasks.value = outboxTasks
      drafts.value = draftTasks
    } finally {
      loading.value = false
    }
  }

  async function createTask(input: CreateTaskInput): Promise<Task> {
    const task = await api.tasks.create(input)
    if (input.as_draft) {
      const existing = drafts.value.find((t) => t.id === task.id)
      if (!existing) {
        drafts.value.push(task)
      }
    } else {
      const existing = tasks.value.find((t) => t.id === task.id)
      if (!existing) {
        onTaskCreated(task)
      }
    }
    return task
  }

  async function sendDraft(id: string): Promise<Task> {
    const task = await api.tasks.send(id)
    // Remove from drafts
    drafts.value = drafts.value.filter((t) => t.id !== id)
    // Add to outbox
    const existing = tasks.value.find((t) => t.id === task.id)
    if (!existing) {
      onTaskCreated(task)
    }
    return task
  }

  async function deleteDraft(id: string): Promise<void> {
    await api.tasks.delete(id)
    drafts.value = drafts.value.filter((t) => t.id !== id)
  }

  async function updateDraft(
    id: string,
    updates: { prompt?: string; priority?: string; type?: string },
  ): Promise<Task> {
    const task = await api.tasks.update(id, updates)
    const idx = drafts.value.findIndex((t) => t.id === id)
    if (idx !== -1) {
      drafts.value[idx] = task
    }
    return task
  }

  async function cancelTask(id: string): Promise<void> {
    await api.tasks.cancel(id)
  }

  async function deleteTask(id: string): Promise<void> {
    await api.tasks.delete(id)
    tasks.value = tasks.value.filter((t) => t.id !== id)
  }

  async function bulkDelete(ids: string[]): Promise<void> {
    await api.tasks.bulkDelete(ids)
    const idSet = new Set(ids)
    tasks.value = tasks.value.filter((t) => !idSet.has(t.id))
  }

  // SSE handlers
  function onTaskCreated(task: Task) {
    if (task.status === 'draft') {
      upsertOrRemove(drafts, task, DRAFT_STATUSES)
    } else {
      upsertOrRemove(tasks, task, OUTBOX_STATUSES)
    }
  }

  function onTaskUpdated(task: Task) {
    if (task.status === 'draft') {
      upsertOrRemove(drafts, task, DRAFT_STATUSES)
    } else {
      // Remove from drafts if it was promoted
      drafts.value = drafts.value.filter((t) => t.id !== task.id)
      upsertOrRemove(tasks, task, OUTBOX_STATUSES)
    }
  }

  function onTaskRemoved(id: string) {
    tasks.value = tasks.value.filter((t) => t.id !== id)
    drafts.value = drafts.value.filter((t) => t.id !== id)
  }

  async function clearAll() {
    await api.tasks.clearAll([...OUTBOX_STATUSES])
    tasks.value = []
  }

  return {
    tasks,
    drafts,
    sortedTasks,
    sortedDrafts,
    loading,
    fetchTasks,
    createTask,
    sendDraft,
    deleteDraft,
    updateDraft,
    cancelTask,
    deleteTask,
    bulkDelete,
    onTaskCreated,
    onTaskUpdated,
    onTaskRemoved,
    clearAll,
  }
})
