import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Task, CreateTaskInput } from '@shared/types';
import { OUTBOX_STATUSES } from '@shared/types';
import { api } from '../api';
import { upsertOrRemove } from './taskArrayUtils';

export const useOutbox = defineStore('outbox', () => {
  const tasks = ref<Task[]>([]);
  const loading = ref(false);

  const sortedTasks = computed(() =>
    [...tasks.value].sort((a, b) => {
      if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
      if (b.status === 'in_progress' && a.status !== 'in_progress') return 1;
      const pa = a.queue_position ?? Infinity;
      const pb = b.queue_position ?? Infinity;
      return pa - pb;
    }),
  );

  async function fetchTasks() {
    loading.value = true;
    try {
      tasks.value = await api.tasks.list([...OUTBOX_STATUSES]);
    } finally {
      loading.value = false;
    }
  }

  async function createTask(input: CreateTaskInput): Promise<Task> {
    const task = await api.tasks.create(input);
    // Only add if SSE hasn't already delivered this task (possibly with a newer status).
    // The server broadcasts SSE events (task:created, task:updated) before sending
    // the HTTP response, so on warm connections the SSE events may arrive first.
    // Without this guard, the stale 'queued' status from the HTTP response would
    // overwrite the newer 'in_progress' status delivered via SSE.
    const existing = tasks.value.find((t) => t.id === task.id);
    if (!existing) {
      onTaskCreated(task);
    }
    return task;
  }

  async function cancelTask(id: string): Promise<void> {
    await api.tasks.cancel(id);
  }

  async function deleteTask(id: string): Promise<void> {
    await api.tasks.delete(id);
    tasks.value = tasks.value.filter((t) => t.id !== id);
  }

  async function bulkDelete(ids: string[]): Promise<void> {
    await api.tasks.bulkDelete(ids);
    const idSet = new Set(ids);
    tasks.value = tasks.value.filter((t) => !idSet.has(t.id));
  }

  // SSE handlers
  function onTaskCreated(task: Task) {
    upsertOrRemove(tasks, task, OUTBOX_STATUSES);
  }

  function onTaskUpdated(task: Task) {
    upsertOrRemove(tasks, task, OUTBOX_STATUSES);
  }

  function onTaskRemoved(id: string) {
    tasks.value = tasks.value.filter((t) => t.id !== id);
  }

  async function clearAll() {
    await api.tasks.clearAll([...OUTBOX_STATUSES]);
    tasks.value = [];
  }

  return {
    tasks,
    sortedTasks,
    loading,
    fetchTasks,
    createTask,
    cancelTask,
    deleteTask,
    bulkDelete,
    onTaskCreated,
    onTaskUpdated,
    onTaskRemoved,
    clearAll,
  };
});
