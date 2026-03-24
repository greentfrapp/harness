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
    return api.tasks.create(input);
  }

  async function cancelTask(id: string): Promise<void> {
    await api.tasks.cancel(id);
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
    onTaskCreated,
    onTaskUpdated,
    onTaskRemoved,
    clearAll,
  };
});
