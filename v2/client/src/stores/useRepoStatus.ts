import type { RepoStatus } from '@shared/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'

const POLL_INTERVAL = 30_000

export const useRepoStatus = defineStore('repoStatus', () => {
  const statuses = ref<RepoStatus[]>([])
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const dirtyProjects = computed(() => statuses.value.filter((s) => s.dirty))
  const hasDirtyRepos = computed(() => dirtyProjects.value.length > 0)

  async function fetchStatus() {
    try {
      statuses.value = await api.projects.status()
    } catch {
      // Ignore fetch errors
    }
  }

  function startPolling() {
    fetchStatus()
    pollTimer = setInterval(fetchStatus, POLL_INTERVAL)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    statuses,
    dirtyProjects,
    hasDirtyRepos,
    fetchStatus,
    startPolling,
    stopPolling,
  }
})
