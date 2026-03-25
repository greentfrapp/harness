<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import type { Project, Task, Priority, CreateTaskInput } from '@shared/types';

const props = defineProps<{
  projects: Project[];
  taskTypes: string[];
  existingTasks: Task[];
}>();

const emit = defineEmits<{
  close: [];
  create: [input: CreateTaskInput];
  draft: [input: CreateTaskInput];
  settings: [];
}>();

const projectId = ref(props.projects[0]?.id ?? '');
const taskType = ref('do');
const prompt = ref('');
const priority = ref<Priority>('P2');
const dependsOn = ref<string | null>(null);
const submitting = ref(false);
const error = ref('');
const promptInput = ref<HTMLTextAreaElement | null>(null);

onMounted(async () => {
  await nextTick();
  promptInput.value?.focus();
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close');
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
    handleSaveDraft();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    handleSubmit();
  }
}

async function handleSubmit() {
  if (!projectId.value || !prompt.value.trim()) {
    error.value = 'Project and prompt are required';
    return;
  }

  submitting.value = true;
  error.value = '';

  try {
    const input: CreateTaskInput = {
      project_id: projectId.value,
      type: taskType.value,
      prompt: prompt.value.trim(),
      priority: priority.value,
      depends_on: dependsOn.value || null,
    };
    emit('create', input);
    emit('close');
  } catch (e: any) {
    error.value = e.message || 'Failed to create task';
  } finally {
    submitting.value = false;
  }
}

function handleSaveDraft() {
  if (!projectId.value || !prompt.value.trim()) {
    error.value = 'Project and prompt are required';
    return;
  }

  const input: CreateTaskInput = {
    project_id: projectId.value,
    type: taskType.value,
    prompt: prompt.value.trim(),
    priority: priority.value,
    depends_on: dependsOn.value || null,
    as_draft: true,
  };
  emit('draft', input);
  emit('close');
}

const priorities: { value: Priority; label: string }[] = [
  { value: 'P0', label: 'P0' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
];
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center"
      @keydown="onKeydown"
    >
      <!-- Backdrop -->
      <div
        class="absolute inset-0 bg-black/60"
        @click="emit('close')"
      />

      <!-- Modal -->
      <div class="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div class="px-6 py-4 border-b border-gray-800">
          <h2 class="text-lg font-semibold">New Task</h2>
        </div>

        <!-- Empty state: no projects configured -->
        <div v-if="!projects.length" class="px-6 py-8 text-center space-y-3">
          <p class="text-sm text-gray-400">
            No projects configured. Add at least one project in Settings to create tasks.
          </p>
          <div class="flex justify-center gap-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              @click="emit('close')"
            >
              Cancel
            </button>
            <button
              type="button"
              class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 rounded-md transition-colors"
              @click="emit('settings')"
            >
              Open Settings
            </button>
          </div>
        </div>

        <form v-else class="px-6 py-4 space-y-4" @submit.prevent="handleSubmit">
          <!-- Project -->
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Project</label>
            <select
              v-model="projectId"
              class="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option v-for="p in projects" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
          </div>

          <!-- Task Type -->
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Type</label>
            <select
              v-model="taskType"
              class="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option v-for="t in taskTypes" :key="t" :value="t">
                {{ t }}
              </option>
            </select>
          </div>

          <!-- Prompt -->
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Prompt</label>
            <textarea
              ref="promptInput"
              v-model="prompt"
              rows="5"
              class="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 resize-y"
              placeholder="Describe the task..."
            />
          </div>

          <!-- Priority -->
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Priority</label>
            <div class="flex gap-1">
              <button
                v-for="p in priorities"
                :key="p.value"
                type="button"
                class="px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
                :class="
                  priority === p.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                "
                @click="priority = p.value"
              >
                {{ p.label }}
              </button>
            </div>
          </div>

          <!-- Dependency -->
          <div v-if="existingTasks.length">
            <label class="block text-xs font-medium text-gray-400 mb-1">
              Depends on (optional)
            </label>
            <select
              v-model="dependsOn"
              class="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option :value="null">None</option>
              <option
                v-for="t in existingTasks"
                :key="t.id"
                :value="t.id"
              >
                {{ t.prompt.slice(0, 60) }}{{ t.prompt.length > 60 ? '...' : '' }}
              </option>
            </select>
          </div>

          <!-- Error -->
          <p v-if="error" class="text-sm text-red-400">{{ error }}</p>

          <!-- Actions -->
          <div class="flex justify-end gap-2 pt-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              @click="emit('close')"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="submitting"
              class="px-4 py-2 text-sm font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-md transition-colors disabled:opacity-50"
              @click="handleSaveDraft"
            >
              Save Draft
              <kbd class="ml-1 text-xs opacity-60">⌘⇧↵</kbd>
            </button>
            <button
              type="submit"
              :disabled="submitting"
              class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 rounded-md transition-colors disabled:opacity-50"
            >
              {{ submitting ? 'Creating...' : 'Create Task' }}
              <kbd class="ml-1 text-xs opacity-60">⌘↵</kbd>
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
