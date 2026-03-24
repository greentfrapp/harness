import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Task } from '@shared/types';
import { INBOX_STATUSES } from '@shared/types';
import { api } from '../api';
import { upsertOrRemove } from './taskArrayUtils';

export const useInbox = defineStore('inbox', () => {
  const items = ref<Task[]>([]);
  const loading = ref(false);

  const pendingCount = computed(
    () =>
      items.value.filter(
        (t) => t.status === 'ready' || t.status === 'permission',
      ).length,
  );

  const hasPermissionRequests = computed(() =>
    items.value.some((t) => t.status === 'permission'),
  );

  const sortedItems = computed(() =>
    [...items.value].sort((a, b) => {
      if (a.status === 'permission' && b.status !== 'permission') return -1;
      if (b.status === 'permission' && a.status !== 'permission') return 1;
      if (a.status === 'approved' && b.status !== 'approved') return 1;
      if (b.status === 'approved' && a.status !== 'approved') return -1;
      if (a.status === 'deferred' && b.status !== 'deferred') return 1;
      if (b.status === 'deferred' && a.status !== 'deferred') return -1;
      return b.updated_at - a.updated_at;
    }),
  );

  async function fetchItems() {
    loading.value = true;
    try {
      items.value = await api.tasks.list([...INBOX_STATUSES]);
    } finally {
      loading.value = false;
    }
  }

  async function updateTaskStatus(id: string, status: string): Promise<void> {
    await api.tasks.update(id, { status } as any);
  }

  // SSE handlers
  function onInboxNew(task: Task) {
    upsertOrRemove(items, task, INBOX_STATUSES);
  }

  function onTaskUpdated(task: Task) {
    upsertOrRemove(items, task, INBOX_STATUSES);
  }

  function onTaskRemoved(id: string) {
    items.value = items.value.filter((t) => t.id !== id);
  }

  async function clearAll() {
    await api.tasks.clearAll([...INBOX_STATUSES]);
    items.value = [];
  }

  return {
    items,
    sortedItems,
    loading,
    pendingCount,
    hasPermissionRequests,
    fetchItems,
    updateTaskStatus,
    onInboxNew,
    onTaskUpdated,
    onTaskRemoved,
    clearAll,
  };
});
