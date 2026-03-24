<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import type { Task, TaskEvent } from '@shared/types';
import { marked } from 'marked';
import { api } from '../api';
import SessionStream from './SessionStream.vue';
import DiffViewer from './DiffViewer.vue';

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

const events = ref<TaskEvent[]>([]);
const approving = ref(false);
const rejecting = ref(false);
const actionError = ref('');
const deleting = ref(false);
const confirmingDelete = ref(false);
const blockedDependents = ref<Array<{ id: string; prompt: string; status: string }>>([]);

onMounted(async () => {
  try {
    events.value = await api.tasks.events(props.task.id);
  } catch {
    // Ignore fetch errors
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
    actionError.value = e instanceof Error ? e.message : 'Approve failed';
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

    <!-- Status & Priority & Branch -->
    <div class="flex gap-4 text-xs text-gray-500 flex-wrap">
      <span>Status: <span class="text-gray-300">{{ task.status }}</span></span>
      <span>Priority: <span class="text-gray-300">{{ task.priority }}</span></span>
      <span v-if="task.depends_on">
        Depends on: <span class="text-gray-300 font-mono">{{ task.depends_on.slice(0, 8) }}</span>
      </span>
      <span v-if="task.branch_name">
        Branch: <span class="text-gray-300 font-mono">{{ task.branch_name }}</span>
      </span>
    </div>

    <!-- Live session stream for in-progress tasks -->
    <div v-if="showSessionStream">
      <h4 class="text-xs font-medium text-gray-500 uppercase mb-2">Live Session</h4>
      <SessionStream :task-id="task.id" />
    </div>

    <!-- Agent summary -->
    <div v-if="task.agent_summary">
      <h4 class="text-xs font-medium text-gray-500 uppercase mb-1">Agent Summary</h4>
      <div class="text-sm text-gray-300 prose prose-invert prose-sm max-w-none" v-html="renderedSummary"></div>
    </div>

    <!-- Diff viewer for completed Do tasks in inbox -->
    <div v-if="showDiffViewer">
      <h4 class="text-xs font-medium text-gray-500 uppercase mb-2">Changes</h4>
      <DiffViewer :task-id="task.id" />
    </div>

    <!-- Diff stats (when no full diff viewer, but stats exist) -->
    <div v-else-if="task.diff_summary && !showDiffViewer">
      <h4 class="text-xs font-medium text-gray-500 uppercase mb-1">Diff Summary</h4>
      <p class="text-xs text-gray-400 font-mono whitespace-pre overflow-y-auto" style="max-height: 40vh;">{{ task.diff_summary }}</p>
    </div>

    <!-- Error -->
    <div v-if="task.error_message" class="rounded bg-red-950 border border-red-900 p-3">
      <h4 class="text-xs font-medium text-red-400 uppercase mb-1">Error</h4>
      <p class="text-sm text-red-300">{{ task.error_message }}</p>
    </div>

    <!-- Action error -->
    <div v-if="actionError" class="rounded bg-red-950 border border-red-900 p-3">
      <p class="text-sm text-red-300">{{ actionError }}</p>
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
          class="px-3 py-1.5 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors"
          @click="emit('defer', task.id)"
        >
          Defer
        </button>
      </template>
      <!-- Delete button for terminal-state tasks -->
      <template v-if="isTerminal">
        <span class="flex-1" />
        <button
          class="px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-50"
          :class="confirmingDelete
            ? 'bg-red-800 hover:bg-red-700 text-red-200'
            : 'bg-gray-800 hover:bg-gray-700 text-gray-500 hover:text-red-400'"
          :disabled="deleting"
          @click="handleDelete"
        >
          {{ deleting ? 'Deleting...' : confirmingDelete ? 'Confirm Delete' : 'Delete' }}
        </button>
        <button
          v-if="confirmingDelete && !deleting"
          class="px-3 py-1.5 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 text-gray-500 transition-colors"
          @click="confirmingDelete = false"
        >
          Cancel
        </button>
      </template>
    </div>
  </div>
</template>
