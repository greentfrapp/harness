<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import type { Project, Task, Priority, CreateTaskInput, TagConfig } from '@shared/types';

const TAG_COLORS: Record<string, { bg: string; text: string; activeBg: string }> = {
  red: { bg: 'bg-red-900/40', text: 'text-red-400', activeBg: 'bg-red-900' },
  green: { bg: 'bg-green-900/40', text: 'text-green-400', activeBg: 'bg-green-900' },
  blue: { bg: 'bg-blue-900/40', text: 'text-blue-400', activeBg: 'bg-blue-900' },
  yellow: { bg: 'bg-yellow-900/40', text: 'text-yellow-400', activeBg: 'bg-yellow-900' },
  purple: { bg: 'bg-purple-900/40', text: 'text-purple-400', activeBg: 'bg-purple-900' },
  orange: { bg: 'bg-orange-900/40', text: 'text-orange-400', activeBg: 'bg-orange-900' },
  pink: { bg: 'bg-pink-900/40', text: 'text-pink-400', activeBg: 'bg-pink-900' },
  gray: { bg: 'bg-zinc-800/40', text: 'text-zinc-500', activeBg: 'bg-zinc-800' },
  cyan: { bg: 'bg-cyan-900/40', text: 'text-cyan-400', activeBg: 'bg-cyan-900' },
  indigo: { bg: 'bg-indigo-900/40', text: 'text-indigo-400', activeBg: 'bg-indigo-900' },
  teal: { bg: 'bg-teal-900/40', text: 'text-teal-400', activeBg: 'bg-teal-900' },
};

const props = defineProps<{
  projects: Project[];
  taskTypes: string[];
  existingTasks: Task[];
  tagConfigs?: Record<string, TagConfig>;
  editingDraft?: Task | null;
}>();

const emit = defineEmits<{
  close: [];
  create: [input: CreateTaskInput];
  draft: [input: CreateTaskInput];
  updateDraft: [id: string, input: CreateTaskInput];
  settings: [];
}>();

const isEditing = computed(() => !!props.editingDraft);

const projectId = ref(props.editingDraft?.project_id ?? props.projects[0]?.id ?? '');
const taskType = ref(props.editingDraft?.type ?? 'do');
const prompt = ref(props.editingDraft?.prompt ?? '');
const priority = ref<Priority>(props.editingDraft?.priority ?? 'P2');
const selectedTags = ref<string[]>(props.editingDraft?.tags ? [...props.editingDraft.tags] : []);
const dependsOn = ref<string | null>(props.editingDraft?.depends_on ?? null);
const submitting = ref(false);
const error = ref('');
const promptInput = ref<HTMLTextAreaElement | null>(null);

const availableTags = computed(() =>
  Object.entries(props.tagConfigs ?? {}).map(([name, config]) => ({
    name,
    ...config,
  })),
);

function toggleTag(tag: string) {
  const idx = selectedTags.value.indexOf(tag);
  if (idx === -1) {
    selectedTags.value.push(tag);
  } else {
    selectedTags.value.splice(idx, 1);
  }
}

function getTagClasses(tag: string, active: boolean): string {
  const config = props.tagConfigs?.[tag];
  const colorName = config?.color ?? 'gray';
  const colors = TAG_COLORS[colorName] ?? TAG_COLORS.gray;
  return active
    ? `${colors.activeBg} ${colors.text} ring-1 ring-current`
    : `${colors.bg} ${colors.text} hover:opacity-80`;
}

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
      tags: selectedTags.value.length > 0 ? [...selectedTags.value] : undefined,
      depends_on: dependsOn.value || null,
    };
    if (isEditing.value && props.editingDraft) {
      // When sending a draft, update it first then the parent will send it
      emit('updateDraft', props.editingDraft.id, input);
    } else {
      emit('create', input);
    }
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
    tags: selectedTags.value.length > 0 ? [...selectedTags.value] : undefined,
    depends_on: dependsOn.value || null,
    as_draft: true,
  };

  if (isEditing.value && props.editingDraft) {
    emit('updateDraft', props.editingDraft.id, input);
  } else {
    emit('draft', input);
  }
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
      <div class="relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div class="px-6 py-4 border-b border-zinc-800">
          <h2 class="text-lg font-semibold">{{ isEditing ? 'Edit Draft' : 'New Task' }}</h2>
        </div>

        <!-- Empty state: no projects configured -->
        <div v-if="!projects.length" class="px-6 py-8 text-center space-y-3">
          <p class="text-sm text-zinc-400">
            No projects configured. Add at least one project in Settings to create tasks.
          </p>
          <div class="flex justify-center gap-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              @click="emit('close')"
            >
              Cancel
            </button>
            <button
              type="button"
              class="px-4 py-2 text-sm font-medium bg-zinc-600 hover:bg-zinc-500 rounded-md transition-colors"
              @click="emit('settings')"
            >
              Open Settings
            </button>
          </div>
        </div>

        <form v-else class="px-6 py-4 space-y-4" @submit.prevent="handleSubmit">
          <!-- Project -->
          <div>
            <label class="block text-xs font-medium text-zinc-400 mb-1">Project</label>
            <select
              v-model="projectId"
              class="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-600"
            >
              <option v-for="p in projects" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
          </div>

          <!-- Task Type -->
          <div>
            <label class="block text-xs font-medium text-zinc-400 mb-1">Type</label>
            <select
              v-model="taskType"
              class="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-600"
            >
              <option v-for="t in taskTypes" :key="t" :value="t">
                {{ t }}
              </option>
            </select>
          </div>

          <!-- Prompt -->
          <div>
            <label class="block text-xs font-medium text-zinc-400 mb-1">Prompt</label>
            <textarea
              ref="promptInput"
              v-model="prompt"
              rows="5"
              class="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-600 resize-y"
              placeholder="Describe the task..."
            />
          </div>

          <!-- Priority -->
          <div>
            <label class="block text-xs font-medium text-zinc-400 mb-1">Priority</label>
            <div class="flex gap-1">
              <button
                v-for="p in priorities"
                :key="p.value"
                type="button"
                class="px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
                :class="
                  priority === p.value
                    ? 'bg-zinc-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                "
                @click="priority = p.value"
              >
                {{ p.label }}
              </button>
            </div>
          </div>

          <!-- Tags -->
          <div v-if="availableTags.length">
            <label class="block text-xs font-medium text-zinc-400 mb-1">Tags</label>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="tag in availableTags"
                :key="tag.name"
                type="button"
                class="px-2.5 py-1 text-xs font-medium rounded-md transition-all"
                :class="getTagClasses(tag.name, selectedTags.includes(tag.name))"
                :title="tag.description"
                @click="toggleTag(tag.name)"
              >
                {{ tag.name }}
              </button>
            </div>
          </div>

          <!-- Dependency -->
          <div v-if="existingTasks.length">
            <label class="block text-xs font-medium text-zinc-400 mb-1">
              Depends on (optional)
            </label>
            <select
              v-model="dependsOn"
              class="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-600"
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
              class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              @click="emit('close')"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="submitting"
              class="px-4 py-2 text-sm font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded-md transition-colors disabled:opacity-50"
              @click="handleSaveDraft"
            >
              {{ isEditing ? 'Update Draft' : 'Save Draft' }}
              <kbd class="ml-1 text-xs opacity-60">⌘⇧↵</kbd>
            </button>
            <button
              type="submit"
              :disabled="submitting"
              class="px-4 py-2 text-sm font-medium bg-zinc-600 hover:bg-zinc-500 rounded-md transition-colors disabled:opacity-50"
            >
              {{ submitting ? (isEditing ? 'Sending...' : 'Creating...') : (isEditing ? 'Send Task' : 'Create Task') }}
              <kbd class="ml-1 text-xs opacity-60">⌘↵</kbd>
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
