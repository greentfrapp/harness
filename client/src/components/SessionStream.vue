<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue';

const props = defineProps<{
  taskId: string;
}>();

interface StreamMessage {
  type: string;
  message?: string;
  content?: unknown;
  tool?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  [key: string]: unknown;
}

const messages = ref<StreamMessage[]>([]);
const containerRef = ref<HTMLElement | null>(null);

function handleProgress(event: CustomEvent<{ task_id: string; message: StreamMessage }>) {
  if (event.detail.task_id !== props.taskId) return;
  messages.value.push(event.detail.message);
  nextTick(() => {
    containerRef.value?.scrollTo({ top: containerRef.value.scrollHeight });
  });
}

onMounted(() => {
  window.addEventListener('task:progress', handleProgress as EventListener);
});

onUnmounted(() => {
  window.removeEventListener('task:progress', handleProgress as EventListener);
});

function formatMessage(msg: StreamMessage): string {
  if (msg.type === 'assistant' && msg.message) return msg.message;
  if (msg.type === 'assistant' && typeof msg.content === 'string') return msg.content;
  if (msg.type === 'tool_use') return `Tool: ${msg.tool ?? 'unknown'}`;
  if (msg.type === 'tool_result' && typeof msg.content === 'string') return msg.content;
  if (msg.type === 'result' && msg.result) return msg.result;
  if (msg.type === 'system' && msg.message) return msg.message;
  return '';
}

function messageIcon(msg: StreamMessage): string {
  switch (msg.type) {
    case 'assistant': return 'A';
    case 'tool_use': return 'T';
    case 'tool_result': return 'R';
    case 'result': return 'D'; // Done
    case 'system': return 'S';
    default: return '?';
  }
}

function messageColor(msg: StreamMessage): string {
  if (msg.is_error) return 'text-red-400';
  switch (msg.type) {
    case 'assistant': return 'text-blue-400';
    case 'tool_use': return 'text-yellow-400';
    case 'tool_result': return 'text-green-400';
    case 'result': return 'text-emerald-400';
    case 'system': return 'text-gray-500';
    default: return 'text-gray-400';
  }
}
</script>

<template>
  <div ref="containerRef" class="overflow-y-auto max-h-96 font-mono text-xs space-y-1 p-2 bg-gray-950 rounded">
    <div v-if="messages.length === 0" class="text-gray-600 text-center py-4">
      Waiting for agent output...
    </div>
    <div
      v-for="(msg, i) in messages"
      :key="i"
      class="flex gap-2 leading-relaxed"
    >
      <span
        class="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold shrink-0 bg-gray-800"
        :class="messageColor(msg)"
      >
        {{ messageIcon(msg) }}
      </span>
      <span class="text-gray-300 whitespace-pre-wrap break-all" :class="msg.is_error ? 'text-red-300' : ''">
        {{ formatMessage(msg) }}
      </span>
    </div>
  </div>
</template>
