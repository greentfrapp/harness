<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import { useLog } from '../stores/useLog';

const log = useLog();
const expanded = ref(false);
const containerRef = ref<HTMLElement | null>(null);

const entries = computed(() => log.entries);
const unreadCount = ref(0);
let lastSeenLength = 0;

watch(entries, (val) => {
  if (!expanded.value) {
    unreadCount.value += val.length - lastSeenLength;
  }
  lastSeenLength = val.length;
  if (expanded.value) {
    nextTick(() => {
      containerRef.value?.scrollTo({ top: containerRef.value.scrollHeight });
    });
  }
}, { deep: true });

function toggle() {
  expanded.value = !expanded.value;
  if (expanded.value) {
    unreadCount.value = 0;
    nextTick(() => {
      containerRef.value?.scrollTo({ top: containerRef.value.scrollHeight });
    });
  }
}

function levelColor(level: string): string {
  switch (level) {
    case 'error': return 'text-red-400';
    case 'warn': return 'text-yellow-400';
    default: return 'text-gray-500';
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
</script>

<template>
  <div class="border-t border-gray-800 bg-gray-900">
    <!-- Toggle bar -->
    <button
      class="w-full px-4 py-1.5 flex items-center justify-between text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors"
      @click="toggle"
    >
      <span class="flex items-center gap-2">
        <svg
          class="w-3 h-3 transition-transform"
          :class="expanded ? 'rotate-180' : ''"
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
        </svg>
        Activity Log
        <span
          v-if="unreadCount > 0"
          class="px-1.5 py-0.5 rounded-full bg-zinc-600 text-white text-[10px] font-bold"
        >
          {{ unreadCount }}
        </span>
      </span>
      <span class="text-gray-600">{{ entries.length }} entries</span>
    </button>

    <!-- Log entries -->
    <div
      v-if="expanded"
      ref="containerRef"
      class="overflow-y-auto max-h-64 font-mono text-xs space-y-0.5 px-4 py-2 bg-gray-950"
    >
      <div v-if="entries.length === 0" class="text-gray-600 text-center py-4">
        No log entries yet
      </div>
      <div
        v-for="(entry, i) in entries"
        :key="i"
        class="flex gap-2 leading-relaxed"
      >
        <span class="text-gray-600 shrink-0">{{ formatTime(entry.timestamp) }}</span>
        <span
          class="uppercase font-bold w-10 shrink-0"
          :class="levelColor(entry.level)"
        >
          {{ entry.level }}
        </span>
        <span class="text-gray-300">
          <span v-if="entry.taskId" class="text-gray-600">[{{ entry.taskId.slice(0, 8) }}]</span>
          {{ entry.message }}
        </span>
      </div>
    </div>
  </div>
</template>
