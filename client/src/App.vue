<script setup lang="ts">
import { ref, provide, onMounted, onUnmounted } from 'vue';
import type { Project, CreateTaskInput, TagConfig } from '@shared/types';
import { api } from './api';
import { useEvents } from './stores/useEvents';
import { useOutbox } from './stores/useOutbox';
import { useInbox } from './stores/useInbox';
import { useCheckouts } from './stores/useCheckouts';
import OutboxPanel from './components/OutboxPanel.vue';
import InboxPanel from './components/InboxPanel.vue';
import NewTaskModal from './components/NewTaskModal.vue';
import SettingsModal from './components/SettingsModal.vue';
import ActivityLog from './components/ActivityLog.vue';
import { useLog } from './stores/useLog';

const events = useEvents();
const outbox = useOutbox();
const inbox = useInbox();
const checkoutsStore = useCheckouts();
const log = useLog();

const showNewTask = ref(false);
const editingDraft = ref<import('@shared/types').Task | null>(null);
const showSettings = ref(false);
const projects = ref<Project[]>([]);
const taskTypes = ref<string[]>([]);
const tagConfigs = ref<Record<string, TagConfig>>({});

provide('tagConfigs', tagConfigs);

function onKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName;
  const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable;

  if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditing) {
    e.preventDefault();
    showNewTask.value = true;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    showSettings.value = true;
  }
}

async function refreshConfig() {
  const [configData] = await Promise.all([
    api.config.get(),
    api.projects.list().then((p) => (projects.value = p)),
  ]);
  taskTypes.value = Object.keys(configData.task_types || {});
  tagConfigs.value = configData.tags || {};
}

async function handleCreateTask(input: CreateTaskInput) {
  await outbox.createTask(input);
}

async function handleDraftTask(input: CreateTaskInput) {
  await outbox.createTask({ ...input, as_draft: true });
}

function handleEditDraft(draft: import('@shared/types').Task) {
  editingDraft.value = draft;
  showNewTask.value = true;
}

async function handleUpdateDraft(id: string, input: CreateTaskInput) {
  await outbox.updateDraft(id, {
    prompt: input.prompt,
    priority: input.priority,
    type: input.type,
  });
  // If the update came from "Send Task" (no as_draft flag), also send it
  if (!input.as_draft) {
    await outbox.sendDraft(id);
  }
}

async function handleSettingsClose() {
  showSettings.value = false;
  await refreshConfig();
}

const returningCheckout = ref<string | null>(null);
const approvingCheckout = ref<string | null>(null);
const showReviseCheckout = ref<string | null>(null);
const reviseCheckoutPrompt = ref('');
const revisingCheckout = ref<string | null>(null);

async function handleReturnCheckout(taskId: string) {
  returningCheckout.value = taskId;
  try {
    await api.tasks.return_(taskId);
  } catch {
    // Error will show via SSE or be silently handled
  } finally {
    returningCheckout.value = null;
  }
}

async function handleApproveCheckout(taskId: string) {
  approvingCheckout.value = taskId;
  try {
    await api.tasks.approve(taskId);
  } catch {
    // Error will show via SSE or be silently handled
  } finally {
    approvingCheckout.value = null;
  }
}

async function handleReviseCheckout(taskId: string) {
  const prompt = reviseCheckoutPrompt.value.trim();
  if (!prompt) return;
  revisingCheckout.value = taskId;
  try {
    await api.tasks.revise(taskId, prompt);
    showReviseCheckout.value = null;
    reviseCheckoutPrompt.value = '';
  } catch {
    // Error will show via SSE or be silently handled
  } finally {
    revisingCheckout.value = null;
  }
}

function handleOpenSettingsFromTask() {
  showNewTask.value = false;
  showSettings.value = true;
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  events.connect();

  await Promise.all([
    outbox.fetchTasks(),
    inbox.fetchItems(),
    checkoutsStore.fetchCheckouts(),
    log.fetchRecent(),
    refreshConfig(),
  ]);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  events.disconnect();
});
</script>

<template>
  <div class="h-screen flex flex-col overflow-hidden">
    <!-- Header -->
    <header class="border-b border-zinc-800 bg-zinc-900 px-6 py-3 flex items-center justify-between">
      <div class="flex items-center gap-4">
        <h1 class="text-lg font-semibold tracking-tight">Harness</h1>
        <div
          class="w-2 h-2 rounded-full"
          :class="events.connected ? 'bg-green-500' : 'bg-red-500'"
          :title="events.connected ? 'Connected' : 'Disconnected'"
        />
      </div>
      <div class="flex items-center gap-2">
        <button
          class="p-1.5 text-zinc-400 hover:text-zinc-200 transition-colors rounded-md hover:bg-zinc-800"
          title="Settings (⌘,)"
          @click="showSettings = true"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <button
          class="px-4 py-1.5 bg-zinc-600 hover:bg-zinc-500 text-sm font-medium rounded-md transition-colors"
          @click="showNewTask = true"
        >
          New Task
          <kbd class="ml-2 text-xs text-zinc-300 opacity-70">C</kbd>
        </button>
      </div>
    </header>

    <!-- Checkout banner -->
    <div v-if="checkoutsStore.hasCheckouts" class="bg-amber-950 border-b border-amber-900 px-6 py-2">
      <div v-for="co in checkoutsStore.checkouts" :key="co.taskId" class="space-y-2">
        <div class="flex items-center gap-3 text-sm">
          <span class="text-amber-400 font-medium shrink-0">Checked out</span>
          <span class="text-amber-200 truncate">{{ co.projectName }}: {{ co.taskPrompt }}</span>
          <div class="ml-auto flex gap-2 shrink-0">
            <button
              class="px-3 py-1 text-xs font-medium rounded bg-amber-900 hover:bg-amber-800 text-amber-300 transition-colors disabled:opacity-50"
              :disabled="returningCheckout === co.taskId"
              @click="handleReturnCheckout(co.taskId)"
            >
              {{ returningCheckout === co.taskId ? 'Returning...' : 'Return' }}
            </button>
            <button
              class="px-3 py-1 text-xs font-medium rounded bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
              :disabled="approvingCheckout === co.taskId"
              @click="handleApproveCheckout(co.taskId)"
            >
              {{ approvingCheckout === co.taskId ? 'Merging...' : 'Approve' }}
            </button>
            <button
              class="px-3 py-1 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors"
              @click="showReviseCheckout = showReviseCheckout === co.taskId ? null : co.taskId"
            >
              Revise
            </button>
          </div>
        </div>
        <div v-if="showReviseCheckout === co.taskId" class="flex gap-2 items-start">
          <textarea
            v-model="reviseCheckoutPrompt"
            class="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-purple-600 focus:outline-none resize-y"
            rows="2"
            placeholder="Enter feedback for the agent..."
            :disabled="revisingCheckout === co.taskId"
            @keydown.meta.enter="handleReviseCheckout(co.taskId)"
            @keydown.ctrl.enter="handleReviseCheckout(co.taskId)"
          />
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-purple-900 hover:bg-purple-800 text-purple-300 transition-colors disabled:opacity-50 shrink-0"
            :disabled="revisingCheckout === co.taskId || !reviseCheckoutPrompt.trim()"
            @click="handleReviseCheckout(co.taskId)"
          >
            {{ revisingCheckout === co.taskId ? 'Sending...' : 'Send' }}
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors shrink-0"
            :disabled="revisingCheckout === co.taskId"
            @click="showReviseCheckout = null; reviseCheckoutPrompt = ''"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>

    <!-- Main two-column layout -->
    <main class="flex-1 min-h-0 grid grid-cols-2 divide-x divide-zinc-800 overflow-hidden">
      <OutboxPanel @editDraft="handleEditDraft" />
      <InboxPanel />
    </main>

    <!-- Activity Log -->
    <ActivityLog />

    <!-- New Task Modal -->
    <NewTaskModal
      v-if="showNewTask"
      :projects="projects"
      :task-types="taskTypes"
      :existing-tasks="outbox.tasks"
      :tag-configs="tagConfigs"
      :editing-draft="editingDraft"
      @close="showNewTask = false; editingDraft = null"
      @create="handleCreateTask"
      @draft="handleDraftTask"
      @updateDraft="handleUpdateDraft"
      @settings="handleOpenSettingsFromTask"
    />

    <!-- Settings Modal -->
    <SettingsModal
      v-if="showSettings"
      @close="handleSettingsClose"
    />
  </div>
</template>
