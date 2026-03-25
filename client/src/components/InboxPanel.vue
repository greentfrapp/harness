<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import type { Task, TagConfig } from '@shared/types';
import { useInbox } from '../stores/useInbox';
import { useTaskSelection } from '../composables/useTaskSelection';
import TaskCard from './TaskCard.vue';
import TaskModal from './TaskModal.vue';

const tagConfigs = inject<import('vue').Ref<Record<string, TagConfig>>>('tagConfigs');

const inbox = useInbox();
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

async function handleFollowUp(_id: string) {
  // Follow-up task is created by TaskDetail via api.tasks.followUp()
  // The SSE event will add the new task to the outbox automatically.
  await inbox.fetchItems();
}

const maximizedTask = ref<Task | null>(null);

function handleMaximize(id: string) {
  const task = inbox.sortedItems.find((t) => t.id === id);
  if (task) maximizedTask.value = task;
}

async function handleMaximizeApprove(id: string) {
  await handleApprove(id);
  maximizedTask.value = null;
}

async function handleMaximizeReject(id: string) {
  await handleReject(id);
  maximizedTask.value = null;
}

async function handleMaximizeDelete(id: string) {
  await handleDelete(id);
  maximizedTask.value = null;
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="px-4 h-12 border-b border-gray-800 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <template v-if="hasSelection">
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
        </template>
        <template v-else>
          <h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
            Inbox
          </h2>
          <span
            v-if="inbox.pendingCount"
            class="text-xs px-2 py-0.5 rounded-full font-medium"
            :class="
              inbox.hasPermissionRequests
                ? 'bg-red-600 text-white animate-pulse'
                : 'bg-zinc-600 text-white'
            "
          >
            {{ inbox.pendingCount }}
          </span>
        </template>
      </div>
      <div v-if="inbox.sortedItems.length" class="flex items-center gap-2 text-xs">
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

    <div class="flex-1 overflow-y-auto p-3 space-y-2">
      <TaskCard
        v-for="item in inbox.sortedItems"
        :key="item.id"
        :task="item"
        context="inbox"
        :hasSelection="hasSelection"
        :selected="isSelected(item.id)"
        :tag-configs="tagConfigs?.value"
        @approve="handleApprove"
        @reject="handleReject"
        @retry="handleRetry"
        @defer="handleDefer"
        @delete="handleDelete"
        @follow-up="handleFollowUp"
        @toggleSelect="toggle"
        @maximize="handleMaximize"
      />
      <div
        v-if="!inbox.sortedItems.length && !inbox.loading"
        class="text-center text-gray-600 py-12 text-sm"
      >
        No items to review
      </div>
    </div>

    <!-- Task Modal -->
    <TaskModal
      v-if="maximizedTask"
      :task="maximizedTask"
      context="inbox"
      @close="maximizedTask = null"
      @approve="handleMaximizeApprove"
      @reject="handleMaximizeReject"
      @retry="handleRetry"
      @defer="handleDefer"
      @delete="handleMaximizeDelete"
      @follow-up="handleFollowUp"
    />
  </div>
</template>
