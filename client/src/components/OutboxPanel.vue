<script setup lang="ts">
import { ref, computed } from 'vue';
import { useOutbox } from '../stores/useOutbox';
import { useTaskSelection } from '../composables/useTaskSelection';
import TaskCard from './TaskCard.vue';

const outbox = useOutbox();
const confirming = ref(false);
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
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Outbox
        </h2>
        <span
          v-if="outbox.sortedTasks.length"
          class="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full"
        >
          {{ outbox.sortedTasks.length }}
        </span>
      </div>
      <div v-if="outbox.sortedTasks.length" class="flex items-center gap-2 text-xs">
        <template v-if="hasSelection">
          <button
            class="text-gray-400 hover:text-gray-200 transition-colors"
            @click="toggleSelectAll()"
          >
            {{ allSelected ? 'Deselect All' : 'Select All' }}
          </button>
          <span class="text-gray-500">{{ selectedCount }} selected</span>
          <button
            class="text-gray-500 hover:text-gray-300 transition-colors"
            @click="clearSelection()"
          >
            Cancel
          </button>
        </template>
        <template v-else>
          <template v-if="confirming">
            <span class="text-gray-400">Clear all?</span>
            <button class="text-red-400 hover:text-red-300 font-medium" @click="handleClear()">Yes</button>
            <button class="text-gray-500 hover:text-gray-300" @click="confirming = false">No</button>
          </template>
          <button
            v-else
            class="text-gray-500 hover:text-gray-300 transition-colors"
            @click="confirming = true"
          >
            Clear
          </button>
        </template>
      </div>
    </div>

    <!-- Bulk action bar -->
    <div
      v-if="hasSelection"
      class="px-4 py-2 border-b border-gray-800 bg-gray-900/80 flex items-center gap-2"
    >
      <template v-if="confirmingBulkDelete">
        <span class="text-xs text-gray-400">Delete {{ selectedCount }} task{{ selectedCount > 1 ? 's' : '' }}?</span>
        <button
          class="px-2 py-1 text-xs font-medium rounded bg-red-800 hover:bg-red-700 text-red-200 transition-colors disabled:opacity-50"
          :disabled="bulkDeleting"
          @click="handleBulkDelete()"
        >
          {{ bulkDeleting ? 'Deleting...' : 'Confirm' }}
        </button>
        <button
          class="px-2 py-1 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors"
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
    </div>

    <div class="flex-1 overflow-y-auto p-3 space-y-2">
      <TaskCard
        v-for="task in outbox.sortedTasks"
        :key="task.id"
        :task="task"
        context="outbox"
        :hasSelection="hasSelection"
        :selected="isSelected(task.id)"
        @cancel="handleCancel"
        @delete="handleDelete"
        @toggleSelect="toggle"
      />
      <div
        v-if="!outbox.sortedTasks.length && !outbox.loading"
        class="text-center text-gray-600 py-12 text-sm"
      >
        No tasks in queue
      </div>
    </div>
  </div>
</template>
