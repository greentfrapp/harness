import type { CheckoutInfo } from '@shared/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'

export const useCheckouts = defineStore('checkouts', () => {
  const checkouts = ref<CheckoutInfo[]>([])

  async function fetchCheckouts() {
    try {
      checkouts.value = await api.checkouts.list()
    } catch {
      // Ignore fetch errors
    }
  }

  function onCheckedOut(info: CheckoutInfo) {
    // Upsert by taskId
    const idx = checkouts.value.findIndex((c) => c.taskId === info.taskId)
    if (idx >= 0) {
      checkouts.value[idx] = info
    } else {
      checkouts.value.push(info)
    }
  }

  function onReturned(payload: { taskId: string }) {
    checkouts.value = checkouts.value.filter((c) => c.taskId !== payload.taskId)
  }

  const hasCheckouts = computed(() => checkouts.value.length > 0)

  function isCheckedOut(taskId: string): boolean {
    return checkouts.value.some((c) => c.taskId === taskId)
  }

  function getCheckoutForRepo(repoPath: string): CheckoutInfo | undefined {
    return checkouts.value.find((c) => c.repoPath === repoPath)
  }

  /** Returns the checkout for a given project, if any. */
  function getCheckoutForProject(projectId: string): CheckoutInfo | undefined {
    return checkouts.value.find((c) => c.projectId === projectId)
  }

  /**
   * Returns true if the project has a checked-out task that is NOT the given taskId.
   * Used to disable actions on sibling tasks when one task is checked out.
   */
  function isProjectLockedByOtherTask(
    projectId: string,
    taskId: string,
  ): boolean {
    const checkout = getCheckoutForProject(projectId)
    return checkout != null && checkout.taskId !== taskId
  }

  return {
    checkouts,
    hasCheckouts,
    fetchCheckouts,
    onCheckedOut,
    onReturned,
    isCheckedOut,
    getCheckoutForRepo,
    getCheckoutForProject,
    isProjectLockedByOtherTask,
  }
})
