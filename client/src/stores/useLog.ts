import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { LogEntry } from '@shared/types';
import { api } from '../api';

const MAX_ENTRIES = 200;

export const useLog = defineStore('log', () => {
  const entries = ref<LogEntry[]>([]);

  async function fetchRecent() {
    entries.value = await api.log.recent();
  }

  function onLogEntry(entry: LogEntry) {
    entries.value.push(entry);
    if (entries.value.length > MAX_ENTRIES) {
      entries.value = entries.value.slice(-MAX_ENTRIES);
    }
  }

  return { entries, fetchRecent, onLogEntry };
});
