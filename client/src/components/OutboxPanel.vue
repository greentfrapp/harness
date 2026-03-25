<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import type { Task, TagConfig } from '@shared/types';
import { useOutbox } from '../stores/useOutbox';
import { useTaskSelection } from '../composables/useTaskSelection';
import TaskCard from './TaskCard.vue';
import TaskModal from './TaskModal.vue';

const tagConfigs = inject<import('vue').Ref<Record<string, TagConfig>>>('tagConfigs');

const outbox = useOutbox();
const confirming = ref(false);
const draftsCollapsed = ref(false);
const {
  selectedCount,
  hasSelection,
  toggle,
  isSelected,
  selectAll,
  clearSelection,
} = useTaskSelection();

const confirmingBulkDelete = ref(false);
const bulkDeleting = ref(false);

const allSelected = computed(() =>
  outbox.sortedTasks.length > 0 && selectedCount.value === outbox.sortedTasks.length,
);

function toggleSelectAll() {
  if (allSelected.value) {
    clearSelection();
  } else {
    selectAll(outbox.sortedTasks.map((t) => t.id));
  }
}

async function handleBulkDelete() {
  if (!confirmingBulkDelete.value) {
    confirmingBulkDelete.value = true;
    return;
  }
  bulkDeleting.value = true;
  try {
    const ids = [...new Set(outbox.sortedTasks.filter((t) => isSelected(t.id)).map((t) => t.id))];
    await outbox.bulkDelete(ids);
    clearSelection();
  } finally {
    bulkDeleting.value = false;
    confirmingBulkDelete.value = false;
  }
}

function cancelBulkDelete() {
  confirmingBulkDelete.value = false;
}

async function handleClear() {
  await outbox.clearAll();
  confirming.value = false;
}

async function handleCancel(id: string) {
  await outbox.cancelTask(id);
}

async function handleDelete(id: string) {
  await outbox.deleteTask(id);
  if (maximizedTask.value?.id === id) maximizedTask.value = null;
}

async function handleSendDraft(id: string) {
  await outbox.sendDraft(id);
}

async function handleDeleteDraft(id: string) {
  await outbox.deleteDraft(id);
}

const maximizedTask = ref<Task | null>(null);

function handleMaximize(id: string) {
  const task = outbox.sortedTasks.find((t) => t.id === id)
    || outbox.sortedDrafts.find((t) => t.id === id);
  if (task) maximizedTask.value = task;
}

function handleMaximizeCancel(id: string) {
  handleCancel(id);
  maximizedTask.value = null;
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="px-4 h-12 border-b border-zinc-800 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <template v-if="hasSelection">
          <template v-if="confirmingBulkDelete">
            <span class="text-xs text-zinc-400">Delete {{ selectedCount }} task{{ selectedCount > 1 ? 's' : '' }}?</span>
            <button
              class="px-2 py-1 text-xs font-medium rounded bg-red-800 hover:bg-red-700 text-red-200 transition-colors disabled:opacity-50"
              :disabled="bulkDeleting"
              @click="handleBulkDelete()"
            >
              {{ bulkDeleting ? 'Deleting...' : 'Confirm' }}
            </button>
            <button
              class="px-2 py-1 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
              @click="cancelBulkDelete()"
            >
              Cancel
            </button>
          </template>
          <template v-else>
            <button
              class="px-2 py-1 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
              @click="handleBulkDelete()"
            >
              Delete Selected
            </button>
          </template>
        </template>
        <template v-else>
          <h2 class="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Outbox
          </h2>
          <span
            v-if="outbox.sortedTasks.length"
            class="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full"
          >
            {{ outbox.sortedTasks.length }}
          </span>
        </template>
      </div>
      <div v-if="outbox.sortedTasks.length" class="flex items-center gap-2 text-xs">
        <template v-if="hasSelection">
          <button
            class="text-zinc-400 hover:text-zinc-200 transition-colors"
            @click="toggleSelectAll()"
          >
            {{ allSelected ? 'Deselect All' : 'Select All' }}
          </button>
          <span class="text-zinc-500">{{ selectedCount }} selected</span>
          <button
            class="text-zinc-500 hover:text-zinc-300 transition-colors"
            @click="clearSelection()"
          >
            Cancel
          </button>
        </template>
        <template v-else>
          <template v-if="confirming">
            <span class="text-zinc-400">Clear all?</span>
            <button class="text-red-400 hover:text-red-300 font-medium" @click="handleClear()">Yes</button>
            <button class="text-zinc-500 hover:text-zinc-300" @click="confirming = false">No</button>
          </template>
          <button
            v-else
            class="text-zinc-500 hover:text-zinc-300 transition-colors"
            @click="confirming = true"
          >
            Clear
          </button>
        </template>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-3 space-y-2">
      <!-- Drafts Section -->
      <div v-if="outbox.sortedDrafts.length" class="mb-3">
        <button
          class="w-full flex items-center gap-2 px-1 py-1.5 text-left group"
          @click="draftsCollapsed = !draftsCollapsed"
        >
          <svg
            class="w-3.5 h-3.5 text-zinc-500 transition-transform shrink-0"
            :class="draftsCollapsed ? '' : 'rotate-90'"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
          <span class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Drafts
          </span>
          <span class="text-xs bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded-full">
            {{ outbox.sortedDrafts.length }}
          </span>
        </button>

        <div v-if="!draftsCollapsed" class="space-y-2 mt-1">
          <div
            v-for="draft in outbox.sortedDrafts"
            :key="draft.id"
            class="group rounded-lg border border-dashed border-zinc-700 bg-zinc-900/50 hover:border-zinc-600 transition-colors"
          >
            <div class="px-4 py-3 flex items-start gap-3">
              <!-- Draft icon -->
              <span class="mt-1 w-4 h-4 shrink-0 flex items-center justify-center">
                <svg class="w-3.5 h-3.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </span>

              <!-- Content -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                    {{ draft.type }}
                  </span>
                  <span class="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-500 italic">
                    draft
                  </span>
                  <span
                    class="text-xs font-medium px-1.5 py-0.5 rounded"
                    :class="{
                      'bg-red-900 text-red-300': draft.priority === 'P0',
                      'bg-orange-900 text-orange-300': draft.priority === 'P1',
                      'bg-zinc-800 text-zinc-400': draft.priority === 'P2',
                      'bg-zinc-800 text-zinc-500': draft.priority === 'P3',
                    }"
                  >
                    {{ draft.priority }}
                  </span>
                </div>
                <p class="text-sm text-zinc-400 leading-snug">
                  {{ draft.prompt.length > 120 ? draft.prompt.slice(0, 120) + '...' : draft.prompt }}
                </p>
              </div>

              <!-- Actions -->
              <div class="flex items-center gap-1 shrink-0">
                <button
                  class="px-2 py-1 text-xs font-medium rounded bg-blue-900 hover:bg-blue-800 text-blue-300 transition-colors"
                  @click="handleSendDraft(draft.id)"
                >
                  Send
                </button>
                <button
                  class="px-2 py-1 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 hover:text-red-400 transition-colors"
                  @click="handleDeleteDraft(draft.id)"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Outbox Tasks -->
      <TaskCard
        v-for="task in outbox.sortedTasks"
        :key="task.id"
        :task="task"
        context="outbox"
        :hasSelection="hasSelection"
        :selected="isSelected(task.id)"
        :tag-configs="tagConfigs?.value"
        @cancel="handleCancel"
        @delete="handleDelete"
        @toggleSelect="toggle"
        @maximize="handleMaximize"
      />
      <div
        v-if="!outbox.sortedTasks.length && !outbox.sortedDrafts.length && !outbox.loading"
        class="text-center text-zinc-600 py-12 text-sm"
      >
        No tasks in queue
      </div>
    </div>

    <!-- Task Modal -->
    <TaskModal
      v-if="maximizedTask"
      :task="maximizedTask"
      context="outbox"
      @close="maximizedTask = null"
      @cancel="handleMaximizeCancel"
      @delete="handleDelete"
    />
  </div>
</template>
