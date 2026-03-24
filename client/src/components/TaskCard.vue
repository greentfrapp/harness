<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
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
  delete: [id: string];
}>();

const expanded = ref(false);
const confirmingDelete = ref(false);
const deleting = ref(false);

const isTerminal = computed(() =>
  ['approved', 'rejected', 'cancelled'].includes(props.task.status),
);

function handleDelete(e: Event) {
  e.stopPropagation();
  if (!confirmingDelete.value) {
    confirmingDelete.value = true;
    return;
  }
  deleting.value = true;
  emit('delete', props.task.id);
  deleting.value = false;
  confirmingDelete.value = false;
}

function cancelDelete(e: Event) {
  e.stopPropagation();
  confirmingDelete.value = false;
}

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

const now = ref(Date.now());
let tickInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  tickInterval = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (tickInterval) clearInterval(tickInterval);
});

const elapsed = computed(() => {
  const ms = now.value - props.task.created_at;
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

function handleApprove(id: string) {
  expanded.value = false;
  emit('approve', id);
}

function handleReject(id: string) {
  expanded.value = false;
  emit('reject', id);
}
</script>

<template>
  <div class="rounded-lg border overflow-hidden" :class="task.status === 'approved' ? 'border-green-900/50 bg-gray-900/60 opacity-75' : 'border-gray-800 bg-gray-900'">
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
            v-if="task.status === 'approved'"
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-green-900 text-green-300"
          >
            Accepted
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

      <!-- Delete button (visible in collapsed state for terminal tasks) -->
      <div v-if="isTerminal && !expanded" class="flex items-center gap-1 shrink-0" @click.stop>
        <button
          class="px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50"
          :class="confirmingDelete
            ? 'bg-red-800 hover:bg-red-700 text-red-200'
            : 'bg-gray-800 hover:bg-gray-700 text-gray-500 hover:text-red-400'"
          :disabled="deleting"
          @click="handleDelete"
        >
          {{ deleting ? 'Deleting...' : confirmingDelete ? 'Confirm' : 'Delete' }}
        </button>
        <button
          v-if="confirmingDelete && !deleting"
          class="px-2 py-1 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 text-gray-500 transition-colors"
          @click="cancelDelete"
        >
          ✕
        </button>
      </div>

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
      @approve="handleApprove($event)"
      @reject="handleReject($event)"
      @defer="emit('defer', $event)"
      @delete="emit('delete', $event)"
    />
  </div>
</template>
