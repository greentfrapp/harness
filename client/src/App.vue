<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { Project, CreateTaskInput } from '@shared/types';
import { api } from './api';
import { useEvents } from './stores/useEvents';
import { useOutbox } from './stores/useOutbox';
import { useInbox } from './stores/useInbox';
import OutboxPanel from './components/OutboxPanel.vue';
import InboxPanel from './components/InboxPanel.vue';
import NewTaskModal from './components/NewTaskModal.vue';

const events = useEvents();
const outbox = useOutbox();
const inbox = useInbox();

const showNewTask = ref(false);
const projects = ref<Project[]>([]);
const taskTypes = ref<string[]>([]);

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    showNewTask.value = true;
  }
}

async function handleCreateTask(input: CreateTaskInput) {
  await outbox.createTask(input);
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  events.connect();

  const [, , configData] = await Promise.all([
    outbox.fetchTasks(),
    inbox.fetchItems(),
    api.config.get(),
    api.projects.list().then((p) => (projects.value = p)),
  ]);
  taskTypes.value = Object.keys(configData.task_types || {});
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  events.disconnect();
});
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Header -->
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center justify-between">
      <div class="flex items-center gap-4">
        <h1 class="text-lg font-semibold tracking-tight">Harness</h1>
        <div
          class="w-2 h-2 rounded-full"
          :class="events.connected ? 'bg-green-500' : 'bg-red-500'"
          :title="events.connected ? 'Connected' : 'Disconnected'"
        />
      </div>
      <button
        class="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-sm font-medium rounded-md transition-colors"
        @click="showNewTask = true"
      >
        New Task
        <kbd class="ml-2 text-xs text-blue-300 opacity-70">⌘N</kbd>
      </button>
    </header>

    <!-- Main two-column layout -->
    <main class="flex-1 grid grid-cols-2 divide-x divide-gray-800 overflow-hidden">
      <OutboxPanel />
      <InboxPanel />
    </main>

    <!-- New Task Modal -->
    <NewTaskModal
      v-if="showNewTask"
      :projects="projects"
      :task-types="taskTypes"
      :existing-tasks="outbox.tasks"
      @close="showNewTask = false"
      @create="handleCreateTask"
    />
  </div>
</template>
