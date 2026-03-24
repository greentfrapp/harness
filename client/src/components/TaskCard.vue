<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Task } from '@shared/types';
import TaskDetail from './TaskDetail.vue';

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

const expanded = ref(false);

const statusConfig: Record<
  string,
  { color: string; label: string; pulse?: boolean }
> = {
  queued: { color: 'bg-gray-500', label: 'Queued' },
  in_progress: { color: 'bg-blue-500', label: 'Running', pulse: true },
  retrying: { color: 'bg-yellow-500', label: 'Retrying', pulse: true },
  ready: { color: 'bg-green-500', label: 'Ready' },
  held: { color: 'bg-gray-500', label: 'Held' },
  deferred: { color: 'bg-gray-600', label: 'Deferred' },
  error: { color: 'bg-red-500', label: 'Error' },
  permission: { color: 'bg-red-500', label: 'Permission', pulse: true },
  approved: { color: 'bg-green-600', label: 'Approved' },
  rejected: { color: 'bg-red-600', label: 'Rejected' },
  cancelled: { color: 'bg-gray-600', label: 'Cancelled' },
};

const status = computed(() => statusConfig[props.task.status] ?? statusConfig.queued);

const elapsed = computed(() => {
  const ms = Date.now() - props.task.created_at;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
});

const truncatedPrompt = computed(() => {
  const text = props.task.prompt;
  return text.length > 120 ? text.slice(0, 120) + '...' : text;
});
</script>

<template>
  <div class="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
    <!-- Summary row -->
    <button
      class="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-gray-800/50 transition-colors"
      @click="expanded = !expanded"
    >
      <!-- Status dot -->
      <span
        class="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
        :class="[status.color, status.pulse ? 'animate-pulse' : '']"
      />

      <!-- Content -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-xs font-medium px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
            {{ task.type }}
          </span>
          <span
            v-if="task.priority === 'urgent'"
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-red-900 text-red-300"
          >
            urgent
          </span>
          <span class="text-xs text-gray-600 ml-auto">{{ elapsed }}</span>
        </div>
        <p class="text-sm text-gray-300 leading-snug">{{ truncatedPrompt }}</p>
      </div>

      <!-- Queue position -->
      <span
        v-if="context === 'outbox' && task.queue_position"
        class="text-xs text-gray-600 font-mono mt-1"
      >
        #{{ task.queue_position }}
      </span>

      <!-- Expand chevron -->
      <svg
        class="w-4 h-4 text-gray-600 mt-1 shrink-0 transition-transform"
        :class="expanded ? 'rotate-180' : ''"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <!-- Detail accordion -->
    <TaskDetail
      v-if="expanded"
      :task="task"
      :context="context"
      @cancel="emit('cancel', $event)"
      @approve="emit('approve', $event)"
      @reject="emit('reject', $event)"
      @defer="emit('defer', $event)"
    />
  </div>
</template>
