<script setup lang="ts">
import { ref } from 'vue';
import { useInbox } from '../stores/useInbox';
import TaskCard from './TaskCard.vue';

const inbox = useInbox();
const confirming = ref(false);

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
      </div>
    </div>
    <div class="flex-1 overflow-y-auto p-3 space-y-2">
      <TaskCard
        v-for="item in inbox.sortedItems"
        :key="item.id"
        :task="item"
        context="inbox"
        @approve="handleApprove"
        @reject="handleReject"
        @retry="handleRetry"
        @defer="handleDefer"
        @delete="handleDelete"
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
