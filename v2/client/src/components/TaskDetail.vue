<script setup lang="ts">
import type { TaskProposal, Task, TaskEvent } from '@shared/types'
import {
  isRunning,
  isTerminal as checkTerminal,
} from '@shared/types'
import { marked } from 'marked'
import { computed, inject, nextTick, onMounted, ref } from 'vue'
import { api } from '../api'
import { useCheckouts } from '../stores/useCheckouts'
import DiffViewer from './DiffViewer.vue'
import SessionStream from './SessionStream.vue'
import Tooltip from './BaseTooltip.vue'

const props = defineProps<{
  task: Task
  context?: 'outbox' | 'inbox' | 'draft'
  autoFollowUp?: boolean
  autoFollowUpType?: string
  actionsDisabled?: boolean
}>()

const taskTypes = inject<import('vue').Ref<string[]>>('taskTypes')
const transitionTypes = computed(() =>
  (taskTypes?.value ?? []).filter((t) => t !== props.task.type),
)

const emit = defineEmits<{
  cancel: [id: string]
  approve: [id: string]
  reject: [id: string]
  delete: [id: string]
  followUp: [id: string]
}>()

const events = ref<TaskEvent[]>([])
const approving = ref(false)
const rejecting = ref(false)
const fixing = ref(false)
const dismissing = ref(false)
const actionError = ref('')
const isMergeError = ref(false)
const deleting = ref(false)
const confirmingDelete = ref(false)
const blockedDependents = ref<
  Array<{ id: string; prompt: string; status: string }>
>([])
const followUpPrompt = ref('')
const followUpType = ref('')
const followingUp = ref(false)
const showFollowUp = ref(false)
const followUpTextarea = ref<HTMLTextAreaElement | null>(null)
const revisePrompt = ref('')
const revising = ref(false)
const showRevise = ref(false)
const checkingOut = ref(false)
const returning = ref(false)
const granting = ref(false)
const proposals = ref<TaskProposal[]>([])
const loadingProposals = ref(false)
const resolvingProposals = ref(false)
const proposalDecisions = ref<
  Map<number, { action: 'approve' | 'dismiss'; feedback: string }>
>(new Map())
const checkoutsStore = useCheckouts()

const isTaskCheckedOut = computed(() =>
  checkoutsStore.isCheckedOut(props.task.id),
)

const permissionToolInput = computed(() => {
  if (
    !(props.task.status === 'pending' && props.task.substatus === 'permission') ||
    !props.task.agent_session_data
  )
    return null
  try {
    const data = JSON.parse(props.task.agent_session_data)
    const input = data.pending_tool_input
    if (!input) return null
    if (data.pending_tool === 'Bash' && input.command) return input.command
    return JSON.stringify(input, null, 2)
  } catch {
    return null
  }
})

const permissionToolName = computed(() => {
  if (!props.task.agent_session_data) return null
  try {
    const data = JSON.parse(props.task.agent_session_data)
    return data.pending_tool ?? null
  } catch {
    return null
  }
})

async function handleGrant() {
  granting.value = true
  try {
    await api.tasks.grantPermission(props.task.id)
  } finally {
    granting.value = false
  }
}

async function handleDismiss() {
  dismissing.value = true
  actionError.value = ''
  try {
    await api.tasks.dismiss(props.task.id)
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Dismiss failed'
  } finally {
    dismissing.value = false
  }
}

async function fetchProposals() {
  if (!(props.task.status === 'pending' && props.task.substatus === 'task_proposal'))
    return
  loadingProposals.value = true
  try {
    proposals.value = await api.tasks.getProposals(props.task.id)
    proposalDecisions.value = new Map(
      proposals.value.map((p) => [p.id, { action: 'approve', feedback: '' }]),
    )
  } catch {
    // Ignore
  } finally {
    loadingProposals.value = false
  }
}

function setAllDecisions(action: 'approve' | 'dismiss') {
  for (const [_id, decision] of proposalDecisions.value) {
    decision.action = action
  }
}

async function handleResolveProposals() {
  resolvingProposals.value = true
  actionError.value = ''
  try {
    const approved: Array<{ id: number }> = []
    const dismissed: Array<{ id: number; feedback?: string }> = []
    for (const [id, decision] of proposalDecisions.value) {
      if (decision.action === 'approve') {
        approved.push({ id })
      } else {
        dismissed.push({
          id,
          feedback: decision.feedback || undefined,
        })
      }
    }
    await api.tasks.resolveProposals(props.task.id, { approved, dismissed })
  } catch (e) {
    actionError.value =
      e instanceof Error ? e.message : 'Failed to resolve proposals'
  } finally {
    resolvingProposals.value = false
  }
}

onMounted(async () => {
  try {
    events.value = await api.tasks.events(props.task.id)
  } catch {
    // Ignore fetch errors
  }
  if (props.autoFollowUp) {
    followUpType.value = props.autoFollowUpType || props.task.type
    showFollowUp.value = true
    await nextTick()
    followUpTextarea.value?.focus()
  }
  fetchProposals()
})

// Status-based computed flags
const isTerminal = computed(() =>
  checkTerminal(props.task.status, props.task.substatus),
)

const showSessionStream = computed(() =>
  isRunning(props.task.status, props.task.substatus),
)

const isPendingReview = computed(
  () => props.task.status === 'pending' && props.task.substatus === 'review',
)

const isPendingError = computed(
  () => props.task.status === 'pending' && props.task.substatus === 'error',
)

const isPendingResponse = computed(
  () => props.task.status === 'pending' && props.task.substatus === 'response',
)

const isReviewable = computed(
  () => isPendingReview.value || isPendingError.value,
)

const isRevisable = computed(
  () =>
    props.task.status === 'pending' &&
    ['review', 'response', 'error', 'task_proposal'].includes(props.task.substatus ?? ''),
)

const showDiffViewer = computed(
  () =>
    props.task.branch_name &&
    (isReviewable.value || isTerminal.value),
)

const canChat = computed(() =>
  ['draft', 'pending', 'done'].includes(props.task.status),
)

const showHistoricalOrChat = computed(
  () =>
    !isRunning(props.task.status, props.task.substatus) &&
    (canChat.value || isTerminal.value || isReviewable.value),
)

const renderedSummary = computed(() => {
  if (!props.task.result) return ''
  return marked.parse(props.task.result, { async: false }) as string
})

const hasNoChanges = computed(
  () =>
    isPendingReview.value &&
    !props.task.branch_name,
)

async function handleApprove() {
  approving.value = true
  actionError.value = ''
  try {
    const result = await api.tasks.approve(props.task.id)
    if (result.blocked_dependents?.length) {
      blockedDependents.value = result.blocked_dependents
    }
    emit('approve', props.task.id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Approve failed'
    actionError.value = msg
    isMergeError.value = msg.toLowerCase().includes('merge failed')
  } finally {
    approving.value = false
  }
}

async function handleReject() {
  rejecting.value = true
  actionError.value = ''
  try {
    const result = await api.tasks.reject(props.task.id)
    if (result.blocked_dependents?.length) {
      blockedDependents.value = result.blocked_dependents
    }
    emit('reject', props.task.id)
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Reject failed'
  } finally {
    rejecting.value = false
  }
}

async function handleFix() {
  fixing.value = true
  actionError.value = ''
  isMergeError.value = false
  try {
    await api.tasks.fix(props.task.id)
    emit('approve', props.task.id)
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Fix failed'
  } finally {
    fixing.value = false
  }
}

async function handleDelete() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  deleting.value = true
  actionError.value = ''
  try {
    emit('delete', props.task.id)
  } finally {
    deleting.value = false
    confirmingDelete.value = false
  }
}

function cancelRevise() {
  showRevise.value = false
  revisePrompt.value = ''
}

function openFollowUp(type?: string) {
  followUpType.value = type || props.task.type
  showFollowUp.value = true
  nextTick(() => followUpTextarea.value?.focus())
}

function cancelFollowUp() {
  showFollowUp.value = false
  followUpPrompt.value = ''
  followUpType.value = ''
}

async function handleRevise() {
  if (!revisePrompt.value.trim()) return
  revising.value = true
  actionError.value = ''
  try {
    await api.tasks.revise(props.task.id, revisePrompt.value.trim())
    revisePrompt.value = ''
    showRevise.value = false
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Revise failed'
  } finally {
    revising.value = false
  }
}

async function handleFollowUp() {
  if (!followUpPrompt.value.trim()) return
  followingUp.value = true
  actionError.value = ''
  try {
    const type =
      followUpType.value && followUpType.value !== props.task.type
        ? followUpType.value
        : undefined
    await api.tasks.followUp(props.task.id, followUpPrompt.value.trim(), type)
    followUpPrompt.value = ''
    followUpType.value = ''
    showFollowUp.value = false
    emit('followUp', props.task.id)
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Follow-up failed'
  } finally {
    followingUp.value = false
  }
}

async function handleCheckout() {
  checkingOut.value = true
  actionError.value = ''
  isMergeError.value = false
  try {
    await api.tasks.checkout(props.task.id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Checkout failed'
    actionError.value = msg
    isMergeError.value = msg.toLowerCase().includes('checkout failed')
  } finally {
    checkingOut.value = false
  }
}

async function handleReturn() {
  returning.value = true
  actionError.value = ''
  try {
    await api.tasks.return_(props.task.id)
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Return failed'
  } finally {
    returning.value = false
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}
</script>

<template>
  <div
    class="border-t border-zinc-800 px-4 py-3 space-y-4 bg-zinc-900/50 overflow-auto max-h-100">
    <!-- Parent task lineage -->
    <div v-if="task.parent_task_id" class="text-xs text-zinc-500">
      Follow-up of
      <span class="font-mono text-zinc-400">{{
        task.parent_task_id.slice(0, 8)
      }}</span>
    </div>

    <!-- Title -->
    <div v-if="task.title">
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-1">Title</h4>
      <p class="text-sm font-medium text-zinc-200">{{ task.title }}</p>
    </div>

    <!-- Full prompt -->
    <div>
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-1">Prompt</h4>
      <p class="text-sm text-zinc-300 whitespace-pre-wrap">{{ task.prompt }}</p>
    </div>

    <!-- Status & Priority & Tags & Branch -->
    <div class="flex gap-4 text-xs text-zinc-500 flex-wrap">
      <span
        >Status:
        <span class="text-zinc-300">{{ task.status }}{{ task.substatus ? `:${task.substatus}` : '' }}</span></span
      >
      <span
        >Priority: <span class="text-zinc-300">{{ task.priority }}</span></span
      >
      <span v-if="task.tags?.length"
        >Tags:
        <span class="text-zinc-300">{{ task.tags.join(', ') }}</span></span
      >
      <span v-if="task.depends_on">
        Depends on:
        <span class="text-zinc-300 font-mono">{{
          task.depends_on.slice(0, 8)
        }}</span>
      </span>
      <span v-if="task.branch_name">
        Branch:
        <span class="text-zinc-300 font-mono">{{ task.branch_name }}</span>
      </span>
    </div>

    <!-- Live session stream for running tasks -->
    <div v-if="showSessionStream">
      <SessionStream :task-id="task.id" />
    </div>

    <!-- Result (replaces agent_summary) -->
    <div v-if="task.result && !isPendingError">
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-1">
        Result
      </h4>
      <div
        class="text-sm text-zinc-300 prose prose-invert prose-sm max-w-none"
        v-html="renderedSummary"></div>
    </div>

    <!-- Historical session + inline chat for completed/reviewable tasks -->
    <div v-if="showHistoricalOrChat">
      <SessionStream :task-id="task.id" :historical="true" :chat-enabled="canChat" />
    </div>

    <!-- Diff viewer for Do tasks with branches -->
    <div v-if="showDiffViewer">
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-2">Changes</h4>
      <DiffViewer :task-id="task.id" @revised="showRevise = false" />
    </div>

    <!-- Permission request detail -->
    <div
      v-if="task.status === 'pending' && task.substatus === 'permission'"
      class="rounded bg-red-950 border border-red-900 p-3 space-y-3">
      <h4 class="text-xs font-medium text-red-400 uppercase">
        Permission Required
      </h4>
      <p class="text-sm text-red-300">{{ permissionToolName ?? 'Unknown tool' }}</p>
      <div
        v-if="permissionToolInput"
        class="rounded bg-zinc-900 border border-zinc-800 p-2">
        <pre
          class="text-xs text-zinc-300 whitespace-pre-wrap break-all font-mono"
          >{{ permissionToolInput }}</pre
        >
      </div>
      <div class="flex gap-2">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
          :disabled="granting"
          @click="handleGrant">
          {{ granting ? 'Granting...' : 'Grant' }}
        </button>
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
          @click="emit('reject', task.id)">
          Reject
        </button>
      </div>
    </div>

    <!-- Task proposals review -->
    <div
      v-if="task.status === 'pending' && task.substatus === 'task_proposal'"
      class="rounded bg-purple-950 border border-purple-900 p-3 space-y-3">
      <h4 class="text-xs font-medium text-purple-400 uppercase">
        Task Proposals
      </h4>

      <div v-if="loadingProposals" class="text-sm text-purple-300">
        Loading proposals...
      </div>

      <div v-else-if="proposals.length === 0" class="text-sm text-purple-300">
        No proposals found.
      </div>

      <template v-else>
        <div class="flex gap-2 mb-2">
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-green-900/50 hover:bg-green-900 text-green-300 transition-colors"
            @click="setAllDecisions('approve')">
            Approve All
          </button>
          <button
            class="px-2 py-1 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            @click="setAllDecisions('dismiss')">
            Dismiss All
          </button>
        </div>

        <div
          v-for="proposal in proposals"
          :key="proposal.id"
          class="rounded border p-2.5 space-y-2"
          :class="
            proposalDecisions.get(proposal.id)?.action === 'approve'
              ? 'border-green-900 bg-green-950/30'
              : 'border-zinc-800 bg-zinc-900/30'
          ">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-zinc-200">{{
                  proposal.title
                }}</span>
                <span
                  v-if="proposal.type"
                  class="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  {{ proposal.type }}
                </span>
                <span
                  class="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  {{ proposal.priority }}
                </span>
              </div>
              <p class="text-xs text-zinc-400 mt-1 line-clamp-2">
                {{ proposal.prompt }}
              </p>
            </div>
            <select
              class="text-xs bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-zinc-300 shrink-0"
              :value="proposalDecisions.get(proposal.id)?.action ?? 'approve'"
              @change="
                (e: Event) => {
                  const val = (e.target as HTMLSelectElement).value as
                    | 'approve'
                    | 'dismiss'
                  const d = proposalDecisions.get(proposal.id)
                  if (d) d.action = val
                }
              ">
              <option value="approve">Approve</option>
              <option value="dismiss">Dismiss</option>
            </select>
          </div>
          <input
            v-if="proposalDecisions.get(proposal.id)?.action === 'dismiss'"
            type="text"
            placeholder="Feedback (optional)"
            class="w-full text-xs bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-300 placeholder-zinc-600"
            :value="proposalDecisions.get(proposal.id)?.feedback ?? ''"
            @input="
              (e: Event) => {
                const d = proposalDecisions.get(proposal.id)
                if (d) d.feedback = (e.target as HTMLInputElement).value
              }
            " />
        </div>

        <div class="flex gap-2 pt-1">
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
            :disabled="resolvingProposals"
            @click="handleResolveProposals">
            {{ resolvingProposals ? 'Submitting...' : 'Submit Decisions' }}
          </button>
        </div>
      </template>
    </div>

    <!-- Error result (for pending:error tasks) -->
    <div
      v-if="task.result && isPendingError"
      class="rounded bg-red-950 border border-red-900 p-3">
      <h4 class="text-xs font-medium text-red-400 uppercase mb-1">Error</h4>
      <p class="text-sm text-red-300">{{ task.result }}</p>
    </div>

    <!-- Action error -->
    <div
      v-if="actionError"
      class="rounded bg-red-950 border border-red-900 p-3">
      <div class="flex items-center gap-3">
        <p class="text-sm text-red-300 flex-1">{{ actionError }}</p>
        <button
          v-if="isMergeError"
          class="px-3 py-1.5 text-xs font-medium rounded bg-yellow-900 hover:bg-yellow-800 text-yellow-300 transition-colors disabled:opacity-50 shrink-0"
          :disabled="fixing"
          @click="handleFix">
          {{ fixing ? 'Re-queuing...' : 'Fix' }}
        </button>
      </div>
    </div>

    <!-- Blocked dependents warning -->
    <div
      v-if="blockedDependents.length"
      class="rounded bg-yellow-950 border border-yellow-900 p-3">
      <h4 class="text-xs font-medium text-yellow-400 uppercase mb-2">
        Blocked Dependent Tasks
      </h4>
      <div
        v-for="dep in blockedDependents"
        :key="dep.id"
        class="text-xs text-yellow-300 mb-1">
        <span class="font-mono">{{ dep.id.slice(0, 8) }}</span> —
        {{ dep.prompt }}
      </div>
    </div>

    <!-- Event timeline -->
    <div v-if="events.length">
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-2">Timeline</h4>
      <div class="space-y-1">
        <div
          v-for="event in events"
          :key="event.id"
          class="flex items-center gap-2 text-xs">
          <span class="text-zinc-600 font-mono">{{
            formatTime(event.created_at)
          }}</span>
          <span class="text-zinc-400">{{ event.event_type }}</span>
        </div>
      </div>
    </div>

    <!-- Revise for revisable tasks in inbox -->
    <div
      v-if="
        isRevisable &&
        (!actionsDisabled || isTaskCheckedOut)
      "
      class="space-y-2">
      <div v-if="!showRevise">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors"
          @click="showRevise = true">
          Revise
        </button>
      </div>
      <div v-else class="space-y-2">
        <h4 class="text-xs font-medium text-zinc-500 uppercase">Revise Task</h4>
        <textarea
          v-model="revisePrompt"
          class="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-purple-600 focus:outline-none resize-y"
          rows="3"
          placeholder="Enter feedback for the agent..."
          :disabled="revising"
          @keydown.meta.enter="handleRevise"
          @keydown.ctrl.enter="handleRevise" />
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors disabled:opacity-50"
            :disabled="revising || !revisePrompt.trim()"
            @click="handleRevise">
            {{ revising ? 'Sending...' : 'Send Revision' }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            :disabled="revising"
            @click="cancelRevise()">
            Cancel
          </button>
          <span class="text-xs text-zinc-600 self-center ml-auto"
            >Cmd+Enter to send</span
          >
        </div>
      </div>
    </div>

    <!-- Follow-up for approved tasks -->
    <div v-if="task.status === 'done' && task.substatus === 'approved'" class="space-y-2">
      <div v-if="!showFollowUp" class="flex gap-2 flex-wrap">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          @click="openFollowUp()">
          Follow Up
        </button>
        <button
          v-for="t in transitionTypes"
          :key="t"
          class="px-3 py-1.5 text-xs font-medium rounded bg-indigo-900 hover:bg-indigo-800 text-indigo-300 transition-colors"
          @click="openFollowUp(t)">
          Start {{ t.charAt(0).toUpperCase() + t.slice(1) }} Task
        </button>
      </div>
      <div v-else class="space-y-2">
        <h4 class="text-xs font-medium text-zinc-500 uppercase">
          {{
            followUpType === task.type
              ? 'Continue Conversation'
              : `Start ${followUpType} task from this conversation`
          }}
        </h4>
        <textarea
          ref="followUpTextarea"
          v-model="followUpPrompt"
          class="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-zinc-600 focus:outline-none resize-y"
          rows="3"
          :placeholder="
            followUpType === task.type
              ? 'Enter your follow-up request...'
              : `Describe what the ${followUpType} task should accomplish...`
          "
          :disabled="followingUp"
          @keydown.meta.enter="handleFollowUp"
          @keydown.ctrl.enter="handleFollowUp" />
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-50"
            :class="
              followUpType === task.type
                ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
                : 'bg-indigo-900 hover:bg-indigo-800 text-indigo-300'
            "
            :disabled="followingUp || !followUpPrompt.trim()"
            @click="handleFollowUp">
            {{
              followingUp
                ? 'Sending...'
                : followUpType === task.type
                  ? 'Send Follow-Up'
                  : `Start ${followUpType.charAt(0).toUpperCase() + followUpType.slice(1)} Task`
            }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            :disabled="followingUp"
            @click="cancelFollowUp()">
            Cancel
          </button>
          <span class="text-xs text-zinc-600 self-center ml-auto"
            >Cmd+Enter to send</span
          >
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex gap-2 pt-2 border-t border-zinc-800">
      <!-- Cancel for outbox tasks -->
      <template v-if="task.status === 'queued' || task.status === 'in_progress'">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
          @click="emit('cancel', task.id)">
          Cancel
        </button>
      </template>

      <!-- Task proposal actions -->
      <template v-if="task.status === 'pending' && task.substatus === 'task_proposal'">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors disabled:opacity-50"
          :disabled="rejecting"
          @click="handleReject">
          {{ rejecting ? 'Rejecting...' : 'Reject' }}
        </button>
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
          @click="emit('cancel', task.id)">
          Cancel
        </button>
      </template>

      <!-- Response actions (dismiss for discuss/plan) -->
      <template v-if="isPendingResponse">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
          :disabled="dismissing"
          @click="handleDismiss">
          {{ dismissing ? 'Dismissing...' : 'Dismiss' }}
        </button>
      </template>

      <!-- Error actions -->
      <template v-if="isPendingError">
        <Tooltip v-if="actionsDisabled" text="Return the checked-out task first">
          <span class="text-xs text-zinc-500 italic self-center">
            Actions locked — another task in this repo is checked out
          </span>
        </Tooltip>
        <template v-else>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-yellow-900 hover:bg-yellow-800 text-yellow-300 transition-colors disabled:opacity-50"
            :disabled="fixing"
            @click="handleFix">
            {{ fixing ? 'Re-queuing...' : 'Fix' }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors"
            @click="showRevise = true">
            Revise
          </button>
        </template>
      </template>

      <!-- Review actions -->
      <template v-if="isPendingReview">
        <Tooltip v-if="actionsDisabled" text="Return the checked-out task first">
          <span class="text-xs text-zinc-500 italic self-center">
            Actions locked — another task in this repo is checked out
          </span>
        </Tooltip>
        <template v-else-if="hasNoChanges">
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors"
            @click="showRevise = true">
            Revise
          </button>
          <span class="flex-1" />
          <button
            class="px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-50"
            :class="
              confirmingDelete
                ? 'bg-red-800 hover:bg-red-700 text-red-200'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-500 hover:text-red-400'
            "
            :disabled="deleting"
            @click="handleDelete">
            {{
              deleting
                ? 'Deleting...'
                : confirmingDelete
                  ? 'Confirm Delete'
                  : 'Delete'
            }}
          </button>
          <button
            v-if="confirmingDelete && !deleting"
            class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 transition-colors"
            @click="confirmingDelete = false">
            Cancel
          </button>
        </template>
        <template v-else>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
            :disabled="approving"
            @click="handleApprove">
            {{ approving ? 'Merging...' : 'Approve' }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors disabled:opacity-50"
            :disabled="rejecting"
            @click="handleReject">
            {{ rejecting ? 'Rejecting...' : 'Reject' }}
          </button>
        </template>
        <template v-if="task.branch_name && !hasNoChanges">
          <template v-if="isTaskCheckedOut">
            <button
              class="px-3 py-1.5 text-xs font-medium rounded bg-amber-900 hover:bg-amber-800 text-amber-300 transition-colors disabled:opacity-50"
              :disabled="returning"
              @click="handleReturn">
              {{ returning ? 'Returning...' : 'Return' }}
            </button>
            <button
              class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
              :disabled="approving"
              @click="handleApprove">
              {{ approving ? 'Merging...' : 'Approve' }}
            </button>
            <button
              class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors"
              @click="showRevise = true">
              Revise
            </button>
          </template>
          <button
            v-else-if="!actionsDisabled"
            class="px-3 py-1.5 text-xs font-medium rounded bg-teal-900 hover:bg-teal-800 text-teal-300 transition-colors disabled:opacity-50"
            :disabled="checkingOut"
            @click="handleCheckout">
            {{ checkingOut ? 'Checking out...' : 'Checkout' }}
          </button>
        </template>
      </template>

      <!-- Delete button for terminal-state tasks -->
      <template v-if="isTerminal">
        <span class="flex-1" />
        <button
          class="px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-50"
          :class="
            confirmingDelete
              ? 'bg-red-800 hover:bg-red-700 text-red-200'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-500 hover:text-red-400'
          "
          :disabled="deleting"
          @click="handleDelete">
          {{
            deleting
              ? 'Deleting...'
              : confirmingDelete
                ? 'Confirm Delete'
                : 'Delete'
          }}
        </button>
        <button
          v-if="confirmingDelete && !deleting"
          class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 transition-colors"
          @click="confirmingDelete = false">
          Cancel
        </button>
      </template>
    </div>
  </div>
</template>
