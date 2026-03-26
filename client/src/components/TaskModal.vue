<script setup lang="ts">
import type { Task } from '@shared/types'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useCheckouts } from '../stores/useCheckouts'
import Tooltip from './BaseTooltip.vue'
import TaskDetail from './TaskDetail.vue'

const checkoutsStore = useCheckouts()

defineProps<{
  task: Task
  context?: 'outbox' | 'inbox' | 'draft'
}>()

const emit = defineEmits<{
  close: []
  cancel: [id: string]
  approve: [id: string]
  reject: [id: string]
  retry: [id: string]
  delete: [id: string]
  followUp: [id: string]
}>()

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

const statusConfig: Record<string, { color: string; label: string }> = {
  queued: { color: 'text-zinc-400', label: 'Queued' },
  in_progress: { color: 'text-blue-400', label: 'Running' },
  retrying: { color: 'text-yellow-400', label: 'Retrying' },
  ready: { color: 'text-green-400', label: 'Ready' },
  held: { color: 'text-zinc-400', label: 'Held' },
  error: { color: 'text-red-400', label: 'Error' },
  permission: { color: 'text-red-400', label: 'Permission' },
  approved: { color: 'text-zinc-400', label: 'Approved' },
  rejected: { color: 'text-red-500', label: 'Rejected' },
  cancelled: { color: 'text-zinc-500', label: 'Cancelled' },
}

function statusLabel(status: string) {
  return statusConfig[status]?.label ?? status
}

function statusColor(status: string) {
  return statusConfig[status]?.color ?? 'text-zinc-400'
}

const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="mounted"
        class="fixed inset-0 z-50 flex items-center justify-center">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/60" @click="emit('close')" />

        <!-- Modal -->
        <div
          class="modal relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col">
          <!-- Header -->
          <div
            class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
            <div class="flex items-center gap-3 min-w-0">
              <h2 class="text-lg font-semibold truncate">Task</h2>
              <span
                class="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0">
                {{ task.type }}
              </span>
              <span
                class="text-xs font-medium px-1.5 py-0.5 rounded shrink-0"
                :class="{
                  'bg-red-900 text-red-300': task.priority === 'P0',
                  'bg-orange-900 text-orange-300': task.priority === 'P1',
                  'bg-zinc-800 text-zinc-400': task.priority === 'P2',
                  'bg-zinc-800 text-zinc-500': task.priority === 'P3',
                }">
                {{ task.priority }}
              </span>
              <span
                class="text-xs font-medium shrink-0"
                :class="statusColor(task.status)">
                {{ statusLabel(task.status) }}
              </span>
              <span class="text-xs text-zinc-600 font-mono shrink-0">
                {{ task.id.slice(0, 8) }}
              </span>
            </div>
            <Tooltip text="Close (Esc)">
              <button
                class="p-1.5 text-zinc-400 hover:text-zinc-200 transition-colors rounded-md hover:bg-zinc-800 shrink-0"
                @click="emit('close')">
                <svg
                  class="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </Tooltip>
          </div>

          <!-- Content (scrollable) -->
          <div class="flex-1 overflow-y-auto">
            <TaskDetail
              :task="task"
              :context="context"
              :actions-disabled="
                checkoutsStore.isProjectLockedByOtherTask(
                  task.project_id,
                  task.id,
                )
              "
              @cancel="emit('cancel', $event)"
              @approve="emit('approve', $event)"
              @reject="emit('reject', $event)"
              @retry="emit('retry', $event)"
              @delete="emit('delete', $event)"
              @follow-up="emit('followUp', $event)" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
