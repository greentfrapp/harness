import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { CheckoutInfo } from '@shared/types';
import { api } from '../api';

export const useCheckouts = defineStore('checkouts', () => {
  const checkouts = ref<CheckoutInfo[]>([]);

  async function fetchCheckouts() {
    try {
      checkouts.value = await api.checkouts.list();
    } catch {
      // Ignore fetch errors
    }
  }

  function onCheckedOut(info: CheckoutInfo) {
    // Upsert by taskId
    const idx = checkouts.value.findIndex((c) => c.taskId === info.taskId);
    if (idx >= 0) {
      checkouts.value[idx] = info;
    } else {
      checkouts.value.push(info);
    }
  }

  function onReturned(payload: { taskId: string }) {
    checkouts.value = checkouts.value.filter((c) => c.taskId !== payload.taskId);
  }

  const hasCheckouts = computed(() => checkouts.value.length > 0);

  function isCheckedOut(taskId: string): boolean {
    return checkouts.value.some((c) => c.taskId === taskId);
  }

  function getCheckoutForRepo(repoPath: string): CheckoutInfo | undefined {
    return checkouts.value.find((c) => c.repoPath === repoPath);
  }

  return {
    checkouts,
    hasCheckouts,
    fetchCheckouts,
    onCheckedOut,
    onReturned,
    isCheckedOut,
    getCheckoutForRepo,
  };
});
