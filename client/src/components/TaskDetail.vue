<script setup lang="ts">
import { ref, nextTick, onMounted, computed } from 'vue';
import type { Task, TaskEvent } from '@shared/types';
import { marked } from 'marked';
import { api } from '../api';
import { useCheckouts } from '../stores/useCheckouts';
import SessionStream from './SessionStream.vue';
import DiffViewer from './DiffViewer.vue';

const props = defineProps<{
  task: Task;
  context: 'outbox' | 'inbox';
  autoFollowUp?: boolean;
  actionsDisabled?: boolean;
}>();

const emit = defineEmits<{
  cancel: [id: string];
  approve: [id: string];
  reject: [id: string];
  retry: [id: string];
  defer: [id: string];
  delete: [id: string];
  followUp: [id: string];
}>();

const events = ref<TaskEvent[]>([]);
const approving = ref(false);
const rejecting = ref(false);
const retrying = ref(false);
const fixing = ref(false);
const actionError = ref('');
const isMergeError = ref(false);
const deleting = ref(false);
const confirmingDelete = ref(false);
const blockedDependents = ref<Array<{ id: string; prompt: string; status: string }>>([]);
const followUpPrompt = ref('');
const followingUp = ref(false);
const showFollowUp = ref(false);
const followUpTextarea = ref<HTMLTextAreaElement | null>(null);
const revisePrompt = ref('');
const revising = ref(false);
const showRevise = ref(false);
const checkingOut = ref(false);
const returning = ref(false);
const granting = ref(false);
const approvingPlan = ref(false);
const checkoutsStore = useCheckouts();

const isTaskCheckedOut = computed(() => checkoutsStore.isCheckedOut(props.task.id));

const permissionToolInput = computed(() => {
  if (props.task.status !== 'permission' || !props.task.agent_session_data) return null;
  try {
    const data = JSON.parse(props.task.agent_session_data);
    const input = data.pending_tool_input;
    if (!input) return null;
    // For Bash, show the command directly
    if (data.pending_tool === 'Bash' && input.command) return input.command;
    // For other tools, show formatted JSON
    return JSON.stringify(input, null, 2);
  } catch {
    return null;
  }
});

async function handleGrant() {
  granting.value = true;
  try {
    await api.tasks.grantPermission(props.task.id);
  } finally {
    granting.value = false;
  }
}

async function handleApprovePlan() {
  approvingPlan.value = true;
  actionError.value = '';
  try {
    await api.tasks.approvePlan(props.task.id);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Approve plan failed';
  } finally {
    approvingPlan.value = false;
  }
}

onMounted(async () => {
  try {
    events.value = await api.tasks.events(props.task.id);
  } catch {
    // Ignore fetch errors
  }
  if (props.autoFollowUp) {
    showFollowUp.value = true;
    await nextTick();
    followUpTextarea.value?.focus();
  }
});

const showSessionStream = computed(() =>
  props.context === 'outbox' && (props.task.status === 'in_progress' || props.task.status === 'retrying'),
);

const showDiffViewer = computed(() =>
  props.context === 'inbox' && props.task.branch_name && (props.task.status === 'ready' || props.task.status === 'error'),
);

const renderedSummary = computed(() => {
  if (!props.task.agent_summary) return '';
  return marked.parse(props.task.agent_summary, { async: false }) as string;
});

async function handleApprove() {
  approving.value = true;
  actionError.value = '';
  try {
    const result = await api.tasks.approve(props.task.id);
    if (result.blocked_dependents?.length) {
      blockedDependents.value = result.blocked_dependents;
    }
    emit('approve', props.task.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Approve failed';
    actionError.value = msg;
    isMergeError.value = msg.toLowerCase().includes('merge failed');
  } finally {
    approving.value = false;
  }
}

async function handleReject() {
  rejecting.value = true;
  actionError.value = '';
  try {
    const result = await api.tasks.reject(props.task.id);
    if (result.blocked_dependents?.length) {
      blockedDependents.value = result.blocked_dependents;
    }
    emit('reject', props.task.id);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Reject failed';
  } finally {
    rejecting.value = false;
  }
}

async function handleFix() {
  fixing.value = true;
  actionError.value = '';
  isMergeError.value = false;
  try {
    await api.tasks.fix(props.task.id);
    emit('approve', props.task.id);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Fix failed';
  } finally {
    fixing.value = false;
  }
}

async function handleRetry() {
  retrying.value = true;
  actionError.value = '';
  try {
    await api.tasks.retry(props.task.id);
    emit('retry', props.task.id);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Retry failed';
  } finally {
    retrying.value = false;
  }
}

const isTerminal = computed(() =>
  ['approved', 'rejected', 'cancelled'].includes(props.task.status),
);

async function handleDelete() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true;
    return;
  }
  deleting.value = true;
  actionError.value = '';
  try {
    emit('delete', props.task.id);
  } finally {
    deleting.value = false;
    confirmingDelete.value = false;
  }
}

async function handleRevise() {
  if (!revisePrompt.value.trim()) return;
  revising.value = true;
  actionError.value = '';
  try {
    await api.tasks.revise(props.task.id, revisePrompt.value.trim());
    revisePrompt.value = '';
    showRevise.value = false;
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Revise failed';
  } finally {
    revising.value = false;
  }
}

async function handleFollowUp() {
  if (!followUpPrompt.value.trim()) return;
  followingUp.value = true;
  actionError.value = '';
  try {
    await api.tasks.followUp(props.task.id, followUpPrompt.value.trim());
    followUpPrompt.value = '';
    showFollowUp.value = false;
    emit('followUp', props.task.id);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Follow-up failed';
  } finally {
    followingUp.value = false;
  }
}

async function handleCheckout() {
  checkingOut.value = true;
  actionError.value = '';
  isMergeError.value = false;
  try {
    await api.tasks.checkout(props.task.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Checkout failed';
    actionError.value = msg;
    isMergeError.value = msg.toLowerCase().includes('checkout failed');
  } finally {
    checkingOut.value = false;
  }
}

async function handleReturn() {
  returning.value = true;
  actionError.value = '';
  try {
    await api.tasks.return_(props.task.id);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Return failed';
  } finally {
    returning.value = false;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
</script>

<template>
  <div class="border-t border-zinc-800 px-4 py-3 space-y-4 bg-zinc-900/50">
    <!-- Parent task lineage -->
    <div v-if="task.parent_task_id" class="text-xs text-zinc-500">
      Follow-up of <span class="font-mono text-zinc-400">{{ task.parent_task_id.slice(0, 8) }}</span>
    </div>

    <!-- Full prompt -->
    <div>
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-1">Prompt</h4>
      <p class="text-sm text-zinc-300 whitespace-pre-wrap">{{ task.prompt }}</p>
    </div>

    <!-- Status & Priority & Tags & Branch -->
    <div class="flex gap-4 text-xs text-zinc-500 flex-wrap">
      <span>Status: <span class="text-zinc-300">{{ task.status }}</span></span>
      <span>Priority: <span class="text-zinc-300">{{ task.priority }}</span></span>
      <span v-if="task.tags?.length">Tags: <span class="text-zinc-300">{{ task.tags.join(', ') }}</span></span>
      <span v-if="task.depends_on">
        Depends on: <span class="text-zinc-300 font-mono">{{ task.depends_on.slice(0, 8) }}</span>
      </span>
      <span v-if="task.branch_name">
        Branch: <span class="text-zinc-300 font-mono">{{ task.branch_name }}</span>
      </span>
    </div>

    <!-- Live session stream for in-progress tasks -->
    <div v-if="showSessionStream">
      <SessionStream :task-id="task.id" />
    </div>

    <!-- Agent summary -->
    <div v-if="task.agent_summary">
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-1">Agent Summary</h4>
      <div class="text-sm text-zinc-300 prose prose-invert prose-sm max-w-none" v-html="renderedSummary"></div>
    </div>

    <!-- Diff viewer for completed Do tasks in inbox -->
    <div v-if="showDiffViewer">
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-2">Changes</h4>
      <DiffViewer :task-id="task.id" @revised="showRevise = false" />
    </div>

    <!-- Diff stats (when no full diff viewer, but stats exist) -->
    <div v-else-if="task.diff_summary && !showDiffViewer">
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-1">Diff Summary</h4>
      <p class="text-xs text-zinc-400 font-mono whitespace-pre overflow-y-auto" style="max-height: 40vh;">{{ task.diff_summary }}</p>
    </div>

    <!-- Permission request detail -->
    <div v-if="task.status === 'permission'" class="rounded bg-red-950 border border-red-900 p-3 space-y-3">
      <h4 class="text-xs font-medium text-red-400 uppercase">Permission Required</h4>
      <p class="text-sm text-red-300">{{ task.error_message }}</p>
      <div v-if="permissionToolInput" class="rounded bg-zinc-900 border border-zinc-800 p-2">
        <pre class="text-xs text-zinc-300 whitespace-pre-wrap break-all font-mono">{{ permissionToolInput }}</pre>
      </div>
      <div class="flex gap-2">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
          :disabled="granting"
          @click="handleGrant"
        >
          {{ granting ? 'Granting...' : 'Grant' }}
        </button>
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
          @click="emit('reject', task.id)"
        >
          Reject
        </button>
      </div>
    </div>

    <!-- Error (non-permission) -->
    <div v-if="task.error_message && task.status !== 'permission'" class="rounded bg-red-950 border border-red-900 p-3">
      <h4 class="text-xs font-medium text-red-400 uppercase mb-1">Error</h4>
      <p class="text-sm text-red-300">{{ task.error_message }}</p>
    </div>

    <!-- Action error -->
    <div v-if="actionError" class="rounded bg-red-950 border border-red-900 p-3">
      <div class="flex items-center gap-3">
        <p class="text-sm text-red-300 flex-1">{{ actionError }}</p>
        <button
          v-if="isMergeError"
          class="px-3 py-1.5 text-xs font-medium rounded bg-yellow-900 hover:bg-yellow-800 text-yellow-300 transition-colors disabled:opacity-50 shrink-0"
          :disabled="fixing"
          @click="handleFix"
        >
          {{ fixing ? 'Re-queuing...' : 'Fix' }}
        </button>
      </div>
    </div>

    <!-- Blocked dependents warning -->
    <div v-if="blockedDependents.length" class="rounded bg-yellow-950 border border-yellow-900 p-3">
      <h4 class="text-xs font-medium text-yellow-400 uppercase mb-2">Blocked Dependent Tasks</h4>
      <div v-for="dep in blockedDependents" :key="dep.id" class="text-xs text-yellow-300 mb-1">
        <span class="font-mono">{{ dep.id.slice(0, 8) }}</span> — {{ dep.prompt }}
      </div>
    </div>

    <!-- Event timeline -->
    <div v-if="events.length">
      <h4 class="text-xs font-medium text-zinc-500 uppercase mb-2">Timeline</h4>
      <div class="space-y-1">
        <div
          v-for="event in events"
          :key="event.id"
          class="flex items-center gap-2 text-xs"
        >
          <span class="text-zinc-600 font-mono">{{ formatTime(event.created_at) }}</span>
          <span class="text-zinc-400">{{ event.event_type }}</span>
        </div>
      </div>
    </div>

    <!-- Revise for ready/error tasks in inbox -->
    <div v-if="context === 'inbox' && (task.status === 'ready' || task.status === 'error' || task.status === 'held') && (!actionsDisabled || isTaskCheckedOut)" class="space-y-2">
      <div v-if="!showRevise">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors"
          @click="showRevise = true"
        >
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
          @keydown.ctrl.enter="handleRevise"
        />
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors disabled:opacity-50"
            :disabled="revising || !revisePrompt.trim()"
            @click="handleRevise"
          >
            {{ revising ? 'Sending...' : 'Send Revision' }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            :disabled="revising"
            @click="showRevise = false; revisePrompt = ''"
          >
            Cancel
          </button>
          <span class="text-xs text-zinc-600 self-center ml-auto">Cmd+Enter to send</span>
        </div>
      </div>
    </div>

    <!-- Follow-up for approved tasks -->
    <div v-if="task.status === 'approved'" class="space-y-2">
      <div v-if="!showFollowUp">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          @click="showFollowUp = true; nextTick(() => followUpTextarea?.focus())"
        >
          Follow Up
        </button>
      </div>
      <div v-else class="space-y-2">
        <h4 class="text-xs font-medium text-zinc-500 uppercase">Continue Conversation</h4>
        <textarea
          ref="followUpTextarea"
          v-model="followUpPrompt"
          class="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-zinc-600 focus:outline-none resize-y"
          rows="3"
          placeholder="Enter your follow-up request..."
          :disabled="followingUp"
          @keydown.meta.enter="handleFollowUp"
          @keydown.ctrl.enter="handleFollowUp"
        />
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-50"
            :disabled="followingUp || !followUpPrompt.trim()"
            @click="handleFollowUp"
          >
            {{ followingUp ? 'Sending...' : 'Send Follow-Up' }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            :disabled="followingUp"
            @click="showFollowUp = false; followUpPrompt = ''"
          >
            Cancel
          </button>
          <span class="text-xs text-zinc-600 self-center ml-auto">Cmd+Enter to send</span>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex gap-2 pt-2 border-t border-zinc-800">
      <template v-if="context === 'outbox'">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
          @click="emit('cancel', task.id)"
        >
          Cancel
        </button>
      </template>
      <template v-if="context === 'inbox' && task.status === 'held'">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
          :disabled="approvingPlan"
          @click="handleApprovePlan"
        >
          {{ approvingPlan ? 'Approving...' : 'Approve Plan' }}
        </button>
        <button
          class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors disabled:opacity-50"
          :disabled="rejecting"
          @click="handleReject"
        >
          {{ rejecting ? 'Rejecting...' : 'Reject' }}
        </button>
      </template>
      <template v-if="context === 'inbox' && task.status === 'error'">
        <!-- Errored tasks only show Retry and Revise -->
        <span v-if="actionsDisabled" class="text-xs text-zinc-500 italic self-center" title="Return the checked-out task first">
          Actions locked — another task in this repo is checked out
        </span>
        <template v-else>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-yellow-900 hover:bg-yellow-800 text-yellow-300 transition-colors disabled:opacity-50"
            :disabled="retrying"
            @click="handleRetry"
          >
            {{ retrying ? 'Retrying...' : 'Retry' }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors"
            @click="showRevise = true"
          >
            Revise
          </button>
        </template>
      </template>
      <template v-if="context === 'inbox' && task.status === 'ready'">
        <!-- Warning when actions are disabled due to another task being checked out -->
        <span v-if="actionsDisabled" class="text-xs text-zinc-500 italic self-center" title="Return the checked-out task first">
          Actions locked — another task in this repo is checked out
        </span>
        <template v-else>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
            :disabled="approving"
            @click="handleApprove"
          >
            {{ approving ? 'Merging...' : 'Approve' }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors disabled:opacity-50"
            :disabled="rejecting"
            @click="handleReject"
          >
            {{ rejecting ? 'Rejecting...' : 'Reject' }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            @click="emit('defer', task.id)"
          >
            Defer
          </button>
        </template>
        <template v-if="task.branch_name">
          <template v-if="isTaskCheckedOut">
            <button
              class="px-3 py-1.5 text-xs font-medium rounded bg-amber-900 hover:bg-amber-800 text-amber-300 transition-colors disabled:opacity-50"
              :disabled="returning"
              @click="handleReturn"
            >
              {{ returning ? 'Returning...' : 'Return' }}
            </button>
            <button
              class="px-3 py-1.5 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
              :disabled="approving"
              @click="handleApprove"
            >
              {{ approving ? 'Merging...' : 'Approve' }}
            </button>
            <button
              class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors"
              @click="showRevise = true"
            >
              Revise
            </button>
          </template>
          <button
            v-else-if="!actionsDisabled"
            class="px-3 py-1.5 text-xs font-medium rounded bg-teal-900 hover:bg-teal-800 text-teal-300 transition-colors disabled:opacity-50"
            :disabled="checkingOut"
            @click="handleCheckout"
          >
            {{ checkingOut ? 'Checking out...' : 'Checkout' }}
          </button>
        </template>
      </template>
      <!-- Delete button for terminal-state tasks -->
      <template v-if="isTerminal">
        <span class="flex-1" />
        <button
          class="px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-50"
          :class="confirmingDelete
            ? 'bg-red-800 hover:bg-red-700 text-red-200'
            : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-500 hover:text-red-400'"
          :disabled="deleting"
          @click="handleDelete"
        >
          {{ deleting ? 'Deleting...' : confirmingDelete ? 'Confirm Delete' : 'Delete' }}
        </button>
        <button
          v-if="confirmingDelete && !deleting"
          class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 transition-colors"
          @click="confirmingDelete = false"
        >
          Cancel
        </button>
      </template>
    </div>
  </div>
</template>
