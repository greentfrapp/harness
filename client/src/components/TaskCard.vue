<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import type { Task } from '@shared/types';
import { api } from '../api';
import TaskDetail from './TaskDetail.vue';

const props = defineProps<{
  task: Task;
  context: 'outbox' | 'inbox';
  hasSelection?: boolean;
  selected?: boolean;
}>();

const emit = defineEmits<{
  cancel: [id: string];
  approve: [id: string];
  reject: [id: string];
  retry: [id: string];
  defer: [id: string];
  delete: [id: string];
  toggleSelect: [id: string];
}>();

const expanded = ref(false);
const confirmingDelete = ref(false);
const deleting = ref(false);

const isTerminal = computed(() =>
  ['approved', 'rejected', 'cancelled'].includes(props.task.status),
);

const needsInput = computed(() =>
  props.context === 'inbox' && props.task.status === 'ready',
);

const isError = computed(() =>
  props.context === 'inbox' && props.task.status === 'error',
);

const collapsedApproving = ref(false);
const collapsedRejecting = ref(false);
const collapsedRetrying = ref(false);
const collapsedFixing = ref(false);
const collapsedMergeError = ref('');

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

async function handleCollapsedApprove(e: Event) {
  e.stopPropagation();
  collapsedApproving.value = true;
  collapsedMergeError.value = '';
  try {
    await api.tasks.approve(props.task.id);
    emit('approve', props.task.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Approve failed';
    if (msg.toLowerCase().includes('merge failed')) {
      collapsedMergeError.value = msg;
    }
  } finally {
    collapsedApproving.value = false;
  }
}

async function handleCollapsedFix(e: Event) {
  e.stopPropagation();
  collapsedFixing.value = true;
  try {
    await api.tasks.fix(props.task.id);
    collapsedMergeError.value = '';
    emit('approve', props.task.id);
  } finally {
    collapsedFixing.value = false;
  }
}

async function handleCollapsedReject(e: Event) {
  e.stopPropagation();
  collapsedRejecting.value = true;
  try {
    await api.tasks.reject(props.task.id);
    emit('reject', props.task.id);
  } finally {
    collapsedRejecting.value = false;
  }
}

function handleCollapsedDefer(e: Event) {
  e.stopPropagation();
  emit('defer', props.task.id);
}

async function handleCollapsedRetry(e: Event) {
  e.stopPropagation();
  collapsedRetrying.value = true;
  try {
    await api.tasks.retry(props.task.id);
    emit('retry', props.task.id);
  } finally {
    collapsedRetrying.value = false;
  }
}

function handleRetry(id: string) {
  expanded.value = false;
  emit('retry', id);
}
</script>

<template>
  <div class="group rounded-lg border overflow-hidden" :class="[
    task.status === 'approved' ? 'border-green-900/50 bg-gray-900/60 opacity-75' : 'border-gray-800 bg-gray-900',
    selected ? 'ring-1 ring-blue-500/60 border-blue-500/40' : ''
  ]">
    <!-- Summary row -->
    <button
      class="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-gray-800/50 transition-colors"
      @click="hasSelection ? emit('toggleSelect', task.id) : (expanded = !expanded)"
    >
      <!-- Selection checkbox (visible on hover or when selected/hasSelection) -->
      <span
        v-if="selected || hasSelection"
        class="mt-1 w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors cursor-pointer"
        :class="selected
          ? 'bg-blue-600 border-blue-500 text-white'
          : 'border-gray-600 bg-gray-800 hover:border-gray-400'"
        @click.stop="emit('toggleSelect', task.id)"
      >
        <svg v-if="selected" class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
        </svg>
      </span>

      <!-- Status dot / hover checkbox container (fixed size to prevent layout shift) -->
      <span
        v-if="!selected && !hasSelection"
        class="mt-1 w-4 h-4 shrink-0 relative flex items-center justify-center"
      >
        <!-- Hover checkbox (hidden by default, shown on group hover) -->
        <span
          class="w-4 h-4 rounded border items-center justify-center transition-colors cursor-pointer border-gray-600 bg-gray-800 hover:border-gray-400 hidden group-hover:flex absolute inset-0"
          @click.stop="emit('toggleSelect', task.id)"
        />
        <!-- Status dot (hidden on hover) -->
        <span
          class="w-2.5 h-2.5 rounded-full group-hover:hidden"
          :class="[status.color, status.pulse ? 'animate-pulse' : '']"
        />
      </span>

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

      <!-- Action buttons (visible in collapsed state for tasks needing input) -->
      <div v-if="needsInput && !expanded" class="flex items-center gap-1 shrink-0" @click.stop>
        <template v-if="collapsedMergeError">
          <span class="text-xs text-red-400 max-w-48 truncate" :title="collapsedMergeError">Merge failed</span>
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-yellow-900 hover:bg-yellow-800 text-yellow-300 transition-colors disabled:opacity-50"
            :disabled="collapsedFixing"
            @click="handleCollapsedFix"
          >
            {{ collapsedFixing ? 'Re-queuing...' : 'Fix' }}
          </button>
        </template>
        <template v-else>
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
            :disabled="collapsedApproving"
            @click="handleCollapsedApprove"
          >
            {{ collapsedApproving ? 'Merging...' : 'Accept' }}
          </button>
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors disabled:opacity-50"
            :disabled="collapsedRejecting"
            @click="handleCollapsedReject"
          >
            {{ collapsedRejecting ? 'Rejecting...' : 'Reject' }}
          </button>
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors"
            @click="handleCollapsedDefer"
          >
            Defer
          </button>
        </template>
      </div>

      <!-- Retry button (visible in collapsed state for error tasks) -->
      <div v-if="isError && !expanded" class="flex items-center gap-1 shrink-0" @click.stop>
        <button
          class="px-2 py-1 text-xs font-medium rounded bg-yellow-900 hover:bg-yellow-800 text-yellow-300 transition-colors disabled:opacity-50"
          :disabled="collapsedRetrying"
          @click="handleCollapsedRetry"
        >
          {{ collapsedRetrying ? 'Retrying...' : 'Retry' }}
        </button>
      </div>

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
      @retry="handleRetry($event)"
      @defer="emit('defer', $event)"
      @delete="emit('delete', $event)"
    />
  </div>
</template>
