<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { Task, TaskEvent } from '@shared/types';
import { api } from '../api';

const props = defineProps<{
  task: Task;
  context: 'outbox' | 'inbox';
}>();

const emit = defineEmits<{
  cancel: [id: string];
  approve: [id: string];
  reject: [id: string];
  defer: [id: string];
}>();

const events = ref<TaskEvent[]>([]);

onMounted(async () => {
  try {
    events.value = await api.tasks.events(props.task.id);
  } catch {
    // Ignore fetch errors
  }
});

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
</script>

<template>
  <div class="border-t border-gray-800 px-4 py-3 space-y-4 bg-gray-900/50">
    <!-- Full prompt -->
    <div>
      <h4 class="text-xs font-medium text-gray-500 uppercase mb-1">Prompt</h4>
      <p class="text-sm text-gray-300 whitespace-pre-wrap">{{ task.prompt }}</p>
    </div>

    <!-- Status & Priority -->
    <div class="flex gap-4 text-xs text-gray-500">
      <span>Status: <span class="text-gray-300">{{ task.status }}</span></span>
      <span>Priority: <span class="text-gray-300">{{ task.priority }}</span></span>
      <span v-if="task.depends_on">
        Depends on: <span class="text-gray-300 font-mono">{{ task.depends_on.slice(0, 8) }}</span>
      </span>
    </div>

    <!-- Agent summary -->
    <div v-if="task.agent_summary">
      <h4 class="text-xs font-medium text-gray-500 uppercase mb-1">Agent Summary</h4>
      <p class="text-sm text-gray-300 whitespace-pre-wrap">{{ task.agent_summary }}</p>
    </div>

    <!-- Error -->
    <div v-if="task.error_message" class="rounded bg-red-950 border border-red-900 p-3">
      <h4 class="text-xs font-medium text-red-400 uppercase mb-1">Error</h4>
      <p class="text-sm text-red-300">{{ task.error_message }}</p>
    </div>

    <!-- Event timeline -->
    <div v-if="events.length">
      <h4 class="text-xs font-medium text-gray-500 uppercase mb-2">Timeline</h4>
      <div class="space-y-1">
        <div
          v-for="event in events"
          :key="event.id"
          class="flex items-center gap-2 text-xs"
        >
          <span class="text-gray-600 font-mono">{{ formatTime(event.created_at) }}</span>
          <span class="text-gray-400">{{ event.event_type }}</span>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex gap-2 pt-2 border-t border-gray-800">
      <template v-if="context === 'outbox'">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
          @click="emit('cancel', task.id)"
        >
          Cancel
        </button>
      </template>
      <template v-if="context === 'inbox' && (task.status === 'ready' || task.status === 'error')">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors"
          @click="emit('approve', task.id)"
        >
          Approve
        </button>
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
          @click="emit('reject', task.id)"
        >
          Reject
        </button>
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors"
          @click="emit('defer', task.id)"
        >
          Defer
        </button>
      </template>
    </div>
  </div>
</template>
