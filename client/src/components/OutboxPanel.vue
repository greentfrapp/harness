<script setup lang="ts">
import { ref } from 'vue';
import { useOutbox } from '../stores/useOutbox';
import TaskCard from './TaskCard.vue';

const outbox = useOutbox();
const confirming = ref(false);

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
        v-for="task in outbox.sortedTasks"
        :key="task.id"
        :task="task"
        context="outbox"
        @cancel="handleCancel"
        @delete="handleDelete"
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
