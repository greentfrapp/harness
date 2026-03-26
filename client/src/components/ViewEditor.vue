<script setup lang="ts">
import type { Priority, Project, TagConfig, TaskStatus, ViewConfig } from '@shared/types'
import { computed, inject, onMounted, ref } from 'vue'
import { api } from '../api'

const ALL_STATUSES: TaskStatus[] = [
  'draft',
  'queued',
  'in_progress',
  'retrying',
  'waiting_on_subtasks',
  'ready',
  'held',
  'error',
  'permission',
  'approved',
  'rejected',
  'cancelled',
]

const ALL_PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3']

const props = defineProps<{
  view?: ViewConfig | null
}>()

const emit = defineEmits<{
  save: [view: ViewConfig]
  delete: [id: string]
  reset: []
  close: []
}>()

const tagConfigs =
  inject<import('vue').Ref<Record<string, TagConfig>>>('tagConfigs')

const projects = ref<Project[]>([])

const name = ref(props.view?.name ?? '')
const selectedStatuses = ref<Set<TaskStatus>>(
  new Set(props.view?.filter.statuses ?? []),
)
const selectedPriorities = ref<Set<Priority>>(
  new Set(props.view?.filter.priorities ?? []),
)
const selectedTags = ref<Set<string>>(new Set(props.view?.filter.tags ?? []))
const selectedProjectId = ref(props.view?.filter.project_id ?? '')

const isNew = computed(() => !props.view)

onMounted(async () => {
  projects.value = await api.projects.list()
})

function toggleStatus(status: TaskStatus) {
  if (selectedStatuses.value.has(status)) {
    selectedStatuses.value.delete(status)
  } else {
    selectedStatuses.value.add(status)
  }
  // Force reactivity
  selectedStatuses.value = new Set(selectedStatuses.value)
}

function togglePriority(priority: Priority) {
  if (selectedPriorities.value.has(priority)) {
    selectedPriorities.value.delete(priority)
  } else {
    selectedPriorities.value.add(priority)
  }
  selectedPriorities.value = new Set(selectedPriorities.value)
}

function toggleTag(tag: string) {
  if (selectedTags.value.has(tag)) {
    selectedTags.value.delete(tag)
  } else {
    selectedTags.value.add(tag)
  }
  selectedTags.value = new Set(selectedTags.value)
}

function handleSave() {
  const id = props.view?.id ?? globalThis.crypto.randomUUID().slice(0, 8)
  const view: ViewConfig = {
    id,
    name: name.value.trim() || 'Untitled',
    filter: {
      ...(selectedStatuses.value.size > 0
        ? { statuses: [...selectedStatuses.value] }
        : {}),
      ...(selectedPriorities.value.size > 0
        ? { priorities: [...selectedPriorities.value] }
        : {}),
      ...(selectedTags.value.size > 0
        ? { tags: [...selectedTags.value] }
        : {}),
      ...(selectedProjectId.value
        ? { project_id: selectedProjectId.value }
        : {}),
    },
  }
  emit('save', view)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center"
      @keydown="onKeydown">
      <!-- Backdrop -->
      <div class="absolute inset-0 bg-black/60" @click="emit('close')" />

      <!-- Modal -->
      <div
        class="relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        <!-- Header -->
        <div
          class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <h2 class="text-lg font-semibold">
            {{ isNew ? 'New View' : 'Edit View' }}
          </h2>
          <button
            class="p-1.5 text-zinc-400 hover:text-zinc-200 transition-colors rounded-md hover:bg-zinc-800"
            title="Close (Esc)"
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
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          <!-- Name -->
          <div>
            <label class="text-xs font-medium text-zinc-500 uppercase block mb-1"
              >Name</label
            >
            <input
              v-model="name"
              type="text"
              class="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-zinc-600 focus:outline-none"
              placeholder="View name" />
          </div>

          <!-- Statuses -->
          <div>
            <label class="text-xs font-medium text-zinc-500 uppercase block mb-2"
              >Statuses</label
            >
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="status in ALL_STATUSES"
                :key="status"
                class="px-2.5 py-1 text-xs font-medium rounded transition-colors"
                :class="
                  selectedStatuses.has(status)
                    ? 'bg-zinc-600 text-zinc-100'
                    : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                "
                @click="toggleStatus(status)">
                {{ status }}
              </button>
            </div>
          </div>

          <!-- Priorities -->
          <div>
            <label class="text-xs font-medium text-zinc-500 uppercase block mb-2"
              >Priorities</label
            >
            <div class="flex gap-1.5">
              <button
                v-for="priority in ALL_PRIORITIES"
                :key="priority"
                class="px-2.5 py-1 text-xs font-medium rounded transition-colors"
                :class="
                  selectedPriorities.has(priority)
                    ? 'bg-zinc-600 text-zinc-100'
                    : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                "
                @click="togglePriority(priority)">
                {{ priority }}
              </button>
            </div>
          </div>

          <!-- Tags -->
          <div v-if="tagConfigs?.value && Object.keys(tagConfigs.value).length">
            <label class="text-xs font-medium text-zinc-500 uppercase block mb-2"
              >Tags</label
            >
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="(config, tag) in tagConfigs.value"
                :key="tag"
                class="px-2.5 py-1 text-xs font-medium rounded transition-colors"
                :class="
                  selectedTags.has(String(tag))
                    ? 'bg-zinc-600 text-zinc-100'
                    : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                "
                @click="toggleTag(String(tag))">
                {{ tag }}
              </button>
            </div>
          </div>

          <!-- Project -->
          <div v-if="projects.length">
            <label class="text-xs font-medium text-zinc-500 uppercase block mb-1"
              >Project</label
            >
            <select
              v-model="selectedProjectId"
              class="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 focus:border-zinc-600 focus:outline-none">
              <option value="">All projects</option>
              <option
                v-for="project in projects"
                :key="project.id"
                :value="project.id">
                {{ project.name }}
              </option>
            </select>
          </div>
        </div>

        <!-- Footer -->
        <div
          class="px-6 py-4 border-t border-zinc-800 flex items-center gap-2 shrink-0">
          <button
            class="px-4 py-2 text-sm font-medium rounded bg-zinc-600 hover:bg-zinc-500 text-zinc-100 transition-colors"
            @click="handleSave">
            {{ isNew ? 'Create View' : 'Save Changes' }}
          </button>
          <button
            class="px-4 py-2 text-sm font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            @click="emit('close')">
            Cancel
          </button>
          <span class="flex-1" />
          <button
            v-if="!isNew"
            class="px-3 py-2 text-sm font-medium rounded text-red-400 hover:text-red-300 hover:bg-red-950 transition-colors"
            @click="emit('delete', view!.id)">
            Delete View
          </button>
          <button
            class="px-3 py-2 text-sm font-medium rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            @click="emit('reset')">
            Reset Defaults
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
