import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Task } from '@shared/types';
import { useOutbox } from './useOutbox';
import { useInbox } from './useInbox';

export const useEvents = defineStore('events', () => {
  const connected = ref(false);
  let eventSource: EventSource | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1000;

  function connect() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/events');

    eventSource.addEventListener('connected', () => {
      connected.value = true;
      reconnectDelay = 1000;
    });

    eventSource.addEventListener('task:created', (e) => {
      const task: Task = JSON.parse(e.data);
      const outbox = useOutbox();
      outbox.onTaskCreated(task);
    });

    eventSource.addEventListener('task:updated', (e) => {
      const task: Task = JSON.parse(e.data);
      const outbox = useOutbox();
      const inbox = useInbox();
      outbox.onTaskUpdated(task);
      inbox.onTaskUpdated(task);
    });

    eventSource.addEventListener('inbox:new', (e) => {
      const task: Task = JSON.parse(e.data);
      const inbox = useInbox();
      inbox.onInboxNew(task);
      // Remove from outbox
      const outbox = useOutbox();
      outbox.onTaskRemoved(task.id);
    });

    eventSource.addEventListener('inbox:updated', (e) => {
      const task: Task = JSON.parse(e.data);
      const inbox = useInbox();
      inbox.onTaskUpdated(task);
    });

    eventSource.addEventListener('task:removed', (e) => {
      const { id } = JSON.parse(e.data);
      const outbox = useOutbox();
      const inbox = useInbox();
      outbox.onTaskRemoved(id);
      inbox.onTaskRemoved(id);
    });

    // Forward task:progress events as custom DOM events for SessionStream
    eventSource.addEventListener('task:progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        window.dispatchEvent(
          new CustomEvent('task:progress', { detail: data }),
        );
      } catch {
        // Ignore parse errors
      }
    });

    eventSource.onerror = () => {
      connected.value = false;
      eventSource?.close();
      eventSource = null;

      // Reconnect with backoff
      reconnectTimeout = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        connect();
      }, reconnectDelay);
    };
  }

  function disconnect() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    connected.value = false;
  }

  // On reconnect, refetch everything to catch missed events
  function refetchAll() {
    const outbox = useOutbox();
    const inbox = useInbox();
    outbox.fetchTasks();
    inbox.fetchItems();
  }

  return { connected, connect, disconnect, refetchAll };
});
