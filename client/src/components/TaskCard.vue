<script setup lang="ts">
import type { TagConfig, Task } from '@shared/types'
import { getTaskContext, OUTBOX_STATUSES, TERMINAL_STATUSES } from '@shared/types'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from '../api'
import { useCheckouts } from '../stores/useCheckouts'
import TaskDetail from './TaskDetail.vue'

const TAG_COLORS: Record<string, { bg: string; text: string }> = {
  red: { bg: 'bg-red-900', text: 'text-red-300' },
  green: { bg: 'bg-green-900', text: 'text-green-300' },
  blue: { bg: 'bg-blue-900', text: 'text-blue-300' },
  yellow: { bg: 'bg-yellow-900', text: 'text-yellow-300' },
  purple: { bg: 'bg-purple-900', text: 'text-purple-300' },
  orange: { bg: 'bg-orange-900', text: 'text-orange-300' },
  pink: { bg: 'bg-pink-900', text: 'text-pink-300' },
  gray: { bg: 'bg-zinc-800', text: 'text-zinc-400' },
  cyan: { bg: 'bg-cyan-900', text: 'text-cyan-300' },
  indigo: { bg: 'bg-indigo-900', text: 'text-indigo-300' },
  teal: { bg: 'bg-teal-900', text: 'text-teal-300' },
}

const props = defineProps<{
  task: Task
  context?: 'outbox' | 'inbox' | 'draft'
  hasSelection?: boolean
  selected?: boolean
  tagConfigs?: Record<string, TagConfig>
  isCheckedOut?: boolean
  actionsDisabled?: boolean
}>()

const derivedContext = computed(
  () => props.context ?? getTaskContext(props.task.status),
)

const emit = defineEmits<{
  cancel: [id: string]
  approve: [id: string]
  reject: [id: string]
  retry: [id: string]
  delete: [id: string]
  toggleSelect: [id: string]
  followUp: [id: string]
  maximize: [id: string]
}>()

const checkoutsStore = useCheckouts()

const expanded = ref(false)
const autoFollowUp = ref(false)
const confirmingDelete = ref(false)
const deleting = ref(false)
const collapsedCheckingOut = ref(false)
const collapsedReturning = ref(false)

const FIX_TAGS = ['merge-conflict', 'checkout-failed', 'needs-commit']

const isTerminal = computed(() => TERMINAL_STATUSES.includes(props.task.status))

const needsInput = computed(() => props.task.status === 'ready')

const isError = computed(() => props.task.status === 'error')

const isPermission = computed(() => props.task.status === 'permission')

const isHeld = computed(() => props.task.status === 'held')

const isWaitingOnSubtasks = computed(
  () => props.task.status === 'waiting_on_subtasks',
)

const hasNoChanges = computed(
  () =>
    props.task.status === 'ready' &&
    !props.task.diff_full &&
    !props.task.diff_summary,
)

const collapsedApproving = ref(false)
const collapsedRejecting = ref(false)
const collapsedRetrying = ref(false)
const collapsedFixing = ref(false)
const collapsedGranting = ref(false)
const collapsedApprovingPlan = ref(false)
const collapsedMergeError = ref('')

function handleDelete(e: Event) {
  e.stopPropagation()
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  deleting.value = true
  emit('delete', props.task.id)
  deleting.value = false
  confirmingDelete.value = false
}

function cancelDelete(e: Event) {
  e.stopPropagation()
  confirmingDelete.value = false
}

const statusConfig: Record<
  string,
  { color: string; label: string; pulse?: boolean }
> = {
  draft: { color: 'bg-zinc-600', label: 'Draft' },
  queued: { color: 'bg-zinc-500', label: 'Queued' },
  in_progress: { color: 'bg-blue-500', label: 'Running', pulse: true },
  retrying: { color: 'bg-yellow-500', label: 'Retrying', pulse: true },
  ready: { color: 'bg-green-500', label: 'Ready' },
  held: { color: 'bg-amber-500', label: 'Plan Review' },
  error: { color: 'bg-red-500', label: 'Error' },
  waiting_on_subtasks: { color: 'bg-purple-500', label: 'Subtasks', pulse: true },
  permission: { color: 'bg-red-500', label: 'Permission', pulse: true },
  approved: { color: 'bg-zinc-500', label: 'Approved' },
  rejected: { color: 'bg-red-600', label: 'Rejected' },
  cancelled: { color: 'bg-zinc-600', label: 'Cancelled' },
}

const status = computed(
  () => statusConfig[props.task.status] ?? statusConfig.queued,
)

const now = ref(Date.now())
let tickInterval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  tickInterval = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (tickInterval) clearInterval(tickInterval)
})

const elapsed = computed(() => {
  const ms = now.value - props.task.created_at
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
})

function getTagClasses(tag: string): string {
  const config = props.tagConfigs?.[tag]
  const colorName = config?.color ?? 'gray'
  const colors = TAG_COLORS[colorName] ?? TAG_COLORS.gray
  return `${colors.bg} ${colors.text}`
}

const truncatedPrompt = computed(() => {
  const text = props.task.prompt
  return text.length > 120 ? text.slice(0, 120) + '...' : text
})

function handleApprove(id: string) {
  expanded.value = false
  emit('approve', id)
}

function handleReject(id: string) {
  expanded.value = false
  emit('reject', id)
}

async function handleCollapsedApprove(e: Event) {
  e.stopPropagation()
  collapsedApproving.value = true
  collapsedMergeError.value = ''
  try {
    await api.tasks.approve(props.task.id)
    emit('approve', props.task.id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Approve failed'
    if (msg.toLowerCase().includes('merge failed')) {
      collapsedMergeError.value = msg
    }
  } finally {
    collapsedApproving.value = false
  }
}

async function handleCollapsedFix(e: Event) {
  e.stopPropagation()
  collapsedFixing.value = true
  try {
    await api.tasks.fix(props.task.id)
    collapsedMergeError.value = ''
    emit('approve', props.task.id)
  } finally {
    collapsedFixing.value = false
  }
}

async function handleCollapsedReject(e: Event) {
  e.stopPropagation()
  collapsedRejecting.value = true
  try {
    await api.tasks.reject(props.task.id)
    emit('reject', props.task.id)
  } finally {
    collapsedRejecting.value = false
  }
}

async function handleCollapsedRetry(e: Event) {
  e.stopPropagation()
  collapsedRetrying.value = true
  try {
    await api.tasks.retry(props.task.id)
    emit('retry', props.task.id)
  } finally {
    collapsedRetrying.value = false
  }
}

function handleRetry(id: string) {
  expanded.value = false
  emit('retry', id)
}

async function handleCollapsedGrantPermission(e: Event) {
  e.stopPropagation()
  collapsedGranting.value = true
  try {
    await api.tasks.grantPermission(props.task.id)
  } finally {
    collapsedGranting.value = false
  }
}

async function handleCollapsedApprovePlan(e: Event) {
  e.stopPropagation()
  collapsedApprovingPlan.value = true
  try {
    await api.tasks.approvePlan(props.task.id)
  } finally {
    collapsedApprovingPlan.value = false
  }
}

const isTaskCheckedOut = computed(() =>
  checkoutsStore.isCheckedOut(props.task.id),
)

const collapsedCheckoutError = ref('')

async function handleCollapsedCheckout(e: Event) {
  e.stopPropagation()
  collapsedCheckingOut.value = true
  collapsedCheckoutError.value = ''
  try {
    await api.tasks.checkout(props.task.id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Checkout failed'
    if (msg.toLowerCase().includes('checkout failed')) {
      collapsedCheckoutError.value = msg
    }
  } finally {
    collapsedCheckingOut.value = false
  }
}

async function handleCollapsedCheckoutFix(e: Event) {
  e.stopPropagation()
  collapsedFixing.value = true
  try {
    await api.tasks.fix(props.task.id, 'checkout-failed')
    collapsedCheckoutError.value = ''
    emit('approve', props.task.id)
  } finally {
    collapsedFixing.value = false
  }
}

async function handleCollapsedReturn(e: Event) {
  e.stopPropagation()
  collapsedReturning.value = true
  try {
    await api.tasks.return_(props.task.id)
  } finally {
    collapsedReturning.value = false
  }
}
</script>

<template>
  <div
    class="group rounded-lg border overflow-hidden"
    :class="[
      isCheckedOut
        ? 'border-teal-500/60 bg-teal-950/30 ring-1 ring-teal-500/30'
        : task.status === 'approved'
          ? 'border-green-900/50 bg-zinc-900/60 opacity-75'
          : task.status === 'rejected'
            ? 'border-red-900/50 bg-zinc-900/60 opacity-75'
            : 'border-zinc-800 bg-zinc-900',
      selected ? 'ring-1 ring-zinc-500/60 border-zinc-500/40' : '',
    ]">
    <!-- Summary row -->
    <button
      class="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-zinc-800/50 transition-colors"
      @click="
        hasSelection ? emit('toggleSelect', task.id) : (expanded = !expanded)
      ">
      <!-- Selection checkbox (visible on hover or when selected/hasSelection) -->
      <span
        v-if="selected || hasSelection"
        class="mt-1 w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors cursor-pointer"
        :class="
          selected
            ? 'bg-zinc-600 border-zinc-500 text-white'
            : 'border-zinc-600 bg-zinc-800 hover:border-zinc-400'
        "
        @click.stop="emit('toggleSelect', task.id)">
        <svg
          v-if="selected"
          class="w-3 h-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="3"
            d="M5 13l4 4L19 7" />
        </svg>
      </span>

      <!-- Status dot / hover checkbox container (fixed size to prevent layout shift) -->
      <span
        v-if="!selected && !hasSelection"
        class="mt-1 w-4 h-4 shrink-0 relative flex items-center justify-center">
        <!-- Hover checkbox (hidden by default, shown on group hover) -->
        <span
          class="w-4 h-4 rounded border items-center justify-center transition-colors cursor-pointer border-zinc-600 bg-zinc-800 hover:border-zinc-400 hidden group-hover:flex absolute inset-0"
          @click.stop="emit('toggleSelect', task.id)" />
        <!-- Status dot (hidden on hover) -->
        <span
          class="w-2.5 h-2.5 rounded-full group-hover:hidden"
          :class="[status.color, status.pulse ? 'animate-pulse' : '']" />
      </span>

      <!-- Content -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <span
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
            {{ task.type }}
          </span>
          <span
            v-if="isCheckedOut"
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-teal-900 text-teal-300">
            Checked Out
          </span>
          <span
            v-if="task.status === 'approved'"
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
            Accepted
          </span>
          <span
            v-if="task.status === 'rejected'"
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
            Rejected
          </span>
          <span
            v-if="task.parent_task_id"
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
            follow-up
          </span>
          <span
            v-for="fixTag in task.tags.filter((t) => FIX_TAGS.includes(t))"
            :key="'fix-' + fixTag"
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-yellow-900 text-yellow-300">
            {{ fixTag }}
          </span>
          <span
            v-for="tag in task.tags.filter((t) => !FIX_TAGS.includes(t))"
            :key="tag"
            class="text-xs font-medium px-1.5 py-0.5 rounded"
            :class="getTagClasses(tag)">
            {{ tag }}
          </span>
          <span
            class="text-xs font-medium px-1.5 py-0.5 rounded"
            :class="{
              'bg-red-900 text-red-300': task.priority === 'P0',
              'bg-orange-900 text-orange-300': task.priority === 'P1',
              'bg-zinc-800 text-zinc-400': task.priority === 'P2',
              'bg-zinc-800 text-zinc-500': task.priority === 'P3',
            }">
            {{ task.priority }}
          </span>
          <span class="text-xs text-zinc-600 ml-auto">{{ elapsed }}</span>
        </div>
        <p class="text-sm text-zinc-300 leading-snug">{{ truncatedPrompt }}</p>
      </div>

      <!-- Queue position -->
      <span
        v-if="OUTBOX_STATUSES.includes(task.status) && task.queue_position"
        class="text-xs text-zinc-600 font-mono mt-1">
        #{{ task.queue_position }}
      </span>

      <!-- Action buttons (visible in collapsed state for tasks needing input) -->
      <div
        v-if="needsInput"
        class="flex items-center gap-1 shrink-0"
        @click.stop>
        <template v-if="actionsDisabled">
          <span
            class="text-xs text-zinc-500 italic"
            title="Another task in this repo is checked out"
            >Locked</span
          >
        </template>
        <template v-else-if="collapsedMergeError || collapsedCheckoutError">
          <span
            class="text-xs text-red-400 max-w-48 truncate"
            :title="collapsedMergeError || collapsedCheckoutError"
            >{{
              collapsedMergeError ? 'Merge failed' : 'Checkout failed'
            }}</span
          >
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-yellow-900 hover:bg-yellow-800 text-yellow-300 transition-colors disabled:opacity-50"
            :disabled="collapsedFixing"
            @click="
              collapsedMergeError
                ? handleCollapsedFix($event)
                : handleCollapsedCheckoutFix($event)
            ">
            {{ collapsedFixing ? 'Re-queuing...' : 'Fix' }}
          </button>
        </template>
        <!-- No changes: show Delete instead of Approve/Reject/Checkout -->
        <template v-else-if="hasNoChanges">
          <button
            class="px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50"
            :class="
              confirmingDelete
                ? 'bg-red-800 hover:bg-red-700 text-red-200'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-500 hover:text-red-400'
            "
            :disabled="deleting"
            @click="handleDelete">
            {{
              deleting ? 'Deleting...' : confirmingDelete ? 'Confirm' : 'Delete'
            }}
          </button>
          <button
            v-if="confirmingDelete && !deleting"
            class="px-2 py-1 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 transition-colors"
            @click="cancelDelete">
            ✕
          </button>
        </template>
        <template v-else>
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
            :disabled="collapsedApproving"
            @click="handleCollapsedApprove">
            {{ collapsedApproving ? 'Merging...' : 'Accept' }}
          </button>
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors disabled:opacity-50"
            :disabled="collapsedRejecting"
            @click="handleCollapsedReject">
            {{ collapsedRejecting ? 'Rejecting...' : 'Reject' }}
          </button>
          <template v-if="task.branch_name">
            <button
              v-if="isTaskCheckedOut"
              class="px-2 py-1 text-xs font-medium rounded bg-amber-900 hover:bg-amber-800 text-amber-300 transition-colors disabled:opacity-50"
              :disabled="collapsedReturning"
              @click="handleCollapsedReturn">
              {{ collapsedReturning ? 'Returning...' : 'Return' }}
            </button>
            <button
              v-else-if="!actionsDisabled"
              class="px-2 py-1 text-xs font-medium rounded bg-teal-900 hover:bg-teal-800 text-teal-300 transition-colors disabled:opacity-50"
              :disabled="collapsedCheckingOut"
              @click="handleCollapsedCheckout">
              {{ collapsedCheckingOut ? 'Checking out...' : 'Checkout' }}
            </button>
          </template>
        </template>
      </div>

      <!-- Retry button (visible in collapsed state for error tasks) -->
      <div v-if="isError" class="flex items-center gap-1 shrink-0" @click.stop>
        <template v-if="actionsDisabled">
          <span
            class="text-xs text-zinc-500 italic"
            title="Another task in this repo is checked out"
            >Locked</span
          >
        </template>
        <template v-else>
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-yellow-900 hover:bg-yellow-800 text-yellow-300 transition-colors disabled:opacity-50"
            :disabled="collapsedRetrying"
            @click="handleCollapsedRetry">
            {{ collapsedRetrying ? 'Retrying...' : 'Retry' }}
          </button>
        </template>
      </div>

      <!-- Grant/Reject buttons (visible in collapsed state for permission tasks) -->
      <div
        v-if="isPermission"
        class="flex items-center gap-1 shrink-0"
        @click.stop>
        <span
          class="text-xs text-red-400 max-w-48 truncate"
          :title="task.error_message ?? ''">
          {{ task.error_message ?? 'Permission needed' }}
        </span>
        <button
          class="px-2 py-1 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
          :disabled="collapsedGranting"
          @click="handleCollapsedGrantPermission">
          {{ collapsedGranting ? 'Granting...' : 'Grant' }}
        </button>
        <button
          class="px-2 py-1 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
          @click="
            (e: Event) => {
              e.stopPropagation()
              emit('reject', task.id)
            }
          ">
          Reject
        </button>
      </div>

      <!-- Approve Plan / Reject buttons (visible in collapsed state for held/plan-review tasks) -->
      <div v-if="isHeld" class="flex items-center gap-1 shrink-0" @click.stop>
        <button
          class="px-2 py-1 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
          :disabled="collapsedApprovingPlan"
          @click="handleCollapsedApprovePlan">
          {{ collapsedApprovingPlan ? 'Approving...' : 'Approve Plan' }}
        </button>
        <button
          class="px-2 py-1 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
          @click="
            (e: Event) => {
              e.stopPropagation()
              emit('reject', task.id)
            }
          ">
          Reject
        </button>
      </div>

      <!-- Review Subtasks button (visible in collapsed state for waiting_on_subtasks tasks) -->
      <div
        v-if="isWaitingOnSubtasks"
        class="flex items-center gap-1 shrink-0"
        @click.stop>
        <span class="text-xs text-purple-400">Subtasks proposed</span>
        <button
          class="px-2 py-1 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors"
          @click="
            (e: Event) => {
              e.stopPropagation()
              expanded = true
            }
          ">
          Review
        </button>
      </div>

      <!-- Follow Up + Delete buttons (visible in collapsed state for terminal tasks) -->
      <div
        v-if="isTerminal"
        class="flex items-center gap-1 shrink-0"
        @click.stop>
        <button
          v-if="task.status === 'approved'"
          class="px-2 py-1 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          @click="
            (e: Event) => {
              e.stopPropagation()
              autoFollowUp = true
              expanded = true
            }
          ">
          Follow Up
        </button>
        <button
          class="px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50"
          :class="
            confirmingDelete
              ? 'bg-red-800 hover:bg-red-700 text-red-200'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-500 hover:text-red-400'
          "
          :disabled="deleting"
          @click="handleDelete">
          {{
            deleting ? 'Deleting...' : confirmingDelete ? 'Confirm' : 'Delete'
          }}
        </button>
        <button
          v-if="confirmingDelete && !deleting"
          class="px-2 py-1 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 transition-colors"
          @click="cancelDelete">
          ✕
        </button>
      </div>

      <!-- Maximize button -->
      <span
        role="button"
        tabindex="0"
        class="w-4 h-4 text-zinc-600 hover:text-zinc-300 mt-1 shrink-0 transition-colors cursor-pointer"
        title="Open in modal"
        @click.stop="emit('maximize', task.id)"
        @keydown.enter.stop="emit('maximize', task.id)"
        @keydown.space.stop="emit('maximize', task.id)">
        <svg
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
        </svg>
      </span>

      <!-- Expand chevron -->
      <svg
        class="w-4 h-4 text-zinc-600 mt-1 shrink-0 transition-transform"
        :class="expanded ? 'rotate-180' : ''"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <!-- Detail accordion -->
    <TaskDetail
      v-if="expanded"
      :task="task"
      :context="derivedContext"
      :auto-follow-up="autoFollowUp"
      :actions-disabled="actionsDisabled"
      @cancel="emit('cancel', $event)"
      @approve="handleApprove($event)"
      @reject="handleReject($event)"
      @retry="handleRetry($event)"
      @delete="emit('delete', $event)"
      @follow-up="emit('followUp', $event)" />
  </div>
</template>
