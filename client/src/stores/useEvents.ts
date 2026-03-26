import type { LogEntry, Task } from '@shared/types'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useCheckouts } from './useCheckouts'
import { useLog } from './useLog'
import { useRepoStatus } from './useRepoStatus'
import { useTasks } from './useTasks'

export const useEvents = defineStore('events', () => {
  const connected = ref(false)
  let eventSource: EventSource | null = null
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 1000
  let hasConnectedBefore = false

  function connect() {
    if (eventSource) {
      eventSource.close()
    }

    eventSource = new EventSource('/events')

    eventSource.addEventListener('connected', () => {
      connected.value = true

      // On reconnect, refetch everything to catch events missed while disconnected
      if (hasConnectedBefore) {
        refetchAll()
      }
      hasConnectedBefore = true

      reconnectDelay = 1000
    })

    eventSource.addEventListener('task:created', (e) => {
      const task: Task = JSON.parse(e.data)
      useTasks().onTaskCreated(task)
    })

    eventSource.addEventListener('task:updated', (e) => {
      const task: Task = JSON.parse(e.data)
      useTasks().onTaskUpdated(task)
    })

    eventSource.addEventListener('inbox:new', (e) => {
      const task: Task = JSON.parse(e.data)
      useTasks().onInboxNew(task)
    })

    eventSource.addEventListener('inbox:updated', (e) => {
      const task: Task = JSON.parse(e.data)
      useTasks().onTaskUpdated(task)
    })

    eventSource.addEventListener('task:removed', (e) => {
      const { id } = JSON.parse(e.data)
      useTasks().onTaskRemoved(id)
    })

    eventSource.addEventListener('log:entry', (e) => {
      const entry: LogEntry = JSON.parse(e.data)
      const log = useLog()
      log.onLogEntry(entry)
    })

    eventSource.addEventListener('task:checked_out', (e) => {
      const data = JSON.parse(e.data)
      const checkoutsStore = useCheckouts()
      checkoutsStore.onCheckedOut(data)
      useRepoStatus().fetchStatus()
    })

    eventSource.addEventListener('task:returned', (e) => {
      const data = JSON.parse(e.data)
      const checkoutsStore = useCheckouts()
      checkoutsStore.onReturned(data)
      useRepoStatus().fetchStatus()
    })

    // Forward task:progress events as custom DOM events for SessionStream
    eventSource.addEventListener('task:progress', (e) => {
      try {
        const data = JSON.parse(e.data)
        window.dispatchEvent(new CustomEvent('task:progress', { detail: data }))
      } catch {
        // Ignore parse errors
      }
    })

    eventSource.onerror = () => {
      connected.value = false
      eventSource?.close()
      eventSource = null

      // Reconnect with backoff
      reconnectTimeout = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
        connect()
      }, reconnectDelay)
    }
  }

  function disconnect() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    connected.value = false
  }

  // On reconnect, refetch everything to catch missed events
  function refetchAll() {
    useTasks().fetchAll()
  }

  return { connected, connect, disconnect, refetchAll }
})
