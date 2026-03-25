<script setup lang="ts">
import { ref, computed } from 'vue';
import { useInbox } from '../stores/useInbox';
import { useTaskSelection } from '../composables/useTaskSelection';
import TaskCard from './TaskCard.vue';

const inbox = useInbox();
const confirming = ref(false);
const {
  selectionMode,
  selectedCount,
  hasSelection,
  toggle,
  isSelected,
  selectAll,
  clearSelection,
  exitSelectionMode,
  enterSelectionMode,
} = useTaskSelection();

const confirmingBulkDelete = ref(false);
const bulkDeleting = ref(false);

const allSelected = computed(() =>
  inbox.sortedItems.length > 0 && selectedCount.value === inbox.sortedItems.length,
);

function toggleSelectAll() {
  if (allSelected.value) {
    clearSelection();
  } else {
    selectAll(inbox.sortedItems.map((t) => t.id));
  }
}

async function handleBulkDelete() {
  if (!confirmingBulkDelete.value) {
    confirmingBulkDelete.value = true;
    return;
  }
  bulkDeleting.value = true;
  try {
    const ids = [...new Set(inbox.sortedItems.filter((t) => isSelected(t.id)).map((t) => t.id))];
    await inbox.bulkDelete(ids);
    exitSelectionMode();
  } finally {
    bulkDeleting.value = false;
    confirmingBulkDelete.value = false;
  }
}

function cancelBulkDelete() {
  confirmingBulkDelete.value = false;
}

async function handleClear() {
  await inbox.clearAll();
  confirming.value = false;
}

async function handleApprove(_id: string) {
  // Approve is now handled by TaskDetail directly via api.tasks.approve()
  // The SSE event will update the store. We just need to refetch to be safe.
  await inbox.fetchItems();
}

async function handleReject(_id: string) {
  // Reject is now handled by TaskDetail directly via api.tasks.reject()
  await inbox.fetchItems();
}

async function handleRetry(_id: string) {
  await inbox.fetchItems();
}

async function handleDefer(id: string) {
  await inbox.updateTaskStatus(id, 'deferred');
}

async function handleDelete(id: string) {
  await inbox.deleteTask(id);
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Inbox
        </h2>
        <span
          v-if="inbox.pendingCount"
          class="text-xs px-2 py-0.5 rounded-full font-medium"
          :class="
            inbox.hasPermissionRequests
              ? 'bg-red-600 text-white animate-pulse'
              : 'bg-blue-600 text-white'
          "
        >
          {{ inbox.pendingCount }}
        </span>
      </div>
      <div v-if="inbox.sortedItems.length" class="flex items-center gap-2 text-xs">
        <template v-if="selectionMode">
          <button
            class="text-gray-400 hover:text-gray-200 transition-colors"
            @click="toggleSelectAll()"
          >
            {{ allSelected ? 'Deselect All' : 'Select All' }}
          </button>
          <span v-if="hasSelection" class="text-gray-500">{{ selectedCount }} selected</span>
          <button
            class="text-gray-500 hover:text-gray-300 transition-colors"
            @click="exitSelectionMode()"
          >
            Cancel
          </button>
        </template>
        <template v-else>
          <button
            class="text-gray-500 hover:text-gray-300 transition-colors"
            @click="enterSelectionMode()"
          >
            Select
          </button>
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
      v-if="selectionMode && hasSelection"
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
        v-for="item in inbox.sortedItems"
        :key="item.id"
        :task="item"
        context="inbox"
        :selectionMode="selectionMode"
        :selected="isSelected(item.id)"
        @approve="handleApprove"
        @reject="handleReject"
        @retry="handleRetry"
        @defer="handleDefer"
        @delete="handleDelete"
        @toggleSelect="toggle"
      />
      <div
        v-if="!inbox.sortedItems.length && !inbox.loading"
        class="text-center text-gray-600 py-12 text-sm"
      >
        No items to review
      </div>
    </div>
  </div>
</template>
