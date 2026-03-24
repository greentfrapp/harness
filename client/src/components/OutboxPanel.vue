<script setup lang="ts">
import { useOutbox } from '../stores/useOutbox';
import TaskCard from './TaskCard.vue';

const outbox = useOutbox();

async function handleCancel(id: string) {
  await outbox.cancelTask(id);
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
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
    <div class="flex-1 overflow-y-auto p-3 space-y-2">
      <TaskCard
        v-for="task in outbox.sortedTasks"
        :key="task.id"
        :task="task"
        context="outbox"
        @cancel="handleCancel"
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
