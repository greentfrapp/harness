<script setup lang="ts">
import { useInbox } from '../stores/useInbox';
import TaskCard from './TaskCard.vue';

const inbox = useInbox();

async function handleApprove(id: string) {
  await inbox.updateTaskStatus(id, 'approved');
}

async function handleReject(id: string) {
  await inbox.updateTaskStatus(id, 'rejected');
}

async function handleDefer(id: string) {
  await inbox.updateTaskStatus(id, 'deferred');
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
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
    <div class="flex-1 overflow-y-auto p-3 space-y-2">
      <TaskCard
        v-for="item in inbox.sortedItems"
        :key="item.id"
        :task="item"
        context="inbox"
        @approve="handleApprove"
        @reject="handleReject"
        @defer="handleDefer"
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
