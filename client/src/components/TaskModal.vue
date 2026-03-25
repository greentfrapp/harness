<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import type { Task } from '@shared/types';
import TaskDetail from './TaskDetail.vue';
import { useCheckouts } from '../stores/useCheckouts';

const checkoutsStore = useCheckouts();

const props = defineProps<{
  task: Task;
  context: 'outbox' | 'inbox';
}>();

const emit = defineEmits<{
  close: [];
  cancel: [id: string];
  approve: [id: string];
  reject: [id: string];
  retry: [id: string];
  defer: [id: string];
  delete: [id: string];
  followUp: [id: string];
}>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close');
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});

const statusConfig: Record<string, { color: string; label: string }> = {
  queued: { color: 'text-gray-400', label: 'Queued' },
  in_progress: { color: 'text-blue-400', label: 'Running' },
  retrying: { color: 'text-yellow-400', label: 'Retrying' },
  ready: { color: 'text-green-400', label: 'Ready' },
  held: { color: 'text-gray-400', label: 'Held' },
  deferred: { color: 'text-gray-500', label: 'Deferred' },
  error: { color: 'text-red-400', label: 'Error' },
  permission: { color: 'text-red-400', label: 'Permission' },
  approved: { color: 'text-gray-400', label: 'Approved' },
  rejected: { color: 'text-red-500', label: 'Rejected' },
  cancelled: { color: 'text-gray-500', label: 'Cancelled' },
};

function statusLabel(status: string) {
  return statusConfig[status]?.label ?? status;
}

function statusColor(status: string) {
  return statusConfig[status]?.color ?? 'text-gray-400';
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <!-- Backdrop -->
      <div
        class="absolute inset-0 bg-black/60"
        @click="emit('close')"
      />

      <!-- Modal -->
      <div class="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col">
        <!-- Header -->
        <div class="px-6 py-4 border-b border-gray-800 flex items-center justify-between shrink-0">
          <div class="flex items-center gap-3 min-w-0">
            <h2 class="text-lg font-semibold truncate">Task</h2>
            <span class="text-xs font-medium px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 shrink-0">
              {{ task.type }}
            </span>
            <span
              class="text-xs font-medium px-1.5 py-0.5 rounded shrink-0"
              :class="{
                'bg-red-900 text-red-300': task.priority === 'P0',
                'bg-orange-900 text-orange-300': task.priority === 'P1',
                'bg-gray-800 text-gray-400': task.priority === 'P2',
                'bg-gray-800 text-gray-500': task.priority === 'P3',
              }"
            >
              {{ task.priority }}
            </span>
            <span class="text-xs font-medium shrink-0" :class="statusColor(task.status)">
              {{ statusLabel(task.status) }}
            </span>
            <span class="text-xs text-gray-600 font-mono shrink-0">
              {{ task.id.slice(0, 8) }}
            </span>
          </div>
          <button
            class="p-1.5 text-gray-400 hover:text-gray-200 transition-colors rounded-md hover:bg-gray-800 shrink-0"
            title="Close (Esc)"
            @click="emit('close')"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Content (scrollable) -->
        <div class="flex-1 overflow-y-auto">
          <TaskDetail
            :task="task"
            :context="context"
            :actions-disabled="checkoutsStore.isProjectLockedByOtherTask(task.project_id, task.id)"
            @cancel="emit('cancel', $event)"
            @approve="emit('approve', $event)"
            @reject="emit('reject', $event)"
            @retry="emit('retry', $event)"
            @defer="emit('defer', $event)"
            @delete="emit('delete', $event)"
            @follow-up="emit('followUp', $event)"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>
