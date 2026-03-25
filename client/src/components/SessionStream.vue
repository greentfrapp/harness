<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { marked } from 'marked';
import { api } from '../api';
import { extractText, hasDisplayableContent, getAssistantText, type StreamMessage } from '@shared/streamFilters';

const props = defineProps<{
  taskId: string;
}>();

const messages = ref<StreamMessage[]>([]);
const containerRef = ref<HTMLElement | null>(null);
const collapsedToolResults = ref<Set<number>>(new Set());

/** Filtered messages — excludes usage/metadata-only entries. */
const displayMessages = computed(() =>
  messages.value
    .map((msg, index) => ({ msg, index }))
    .filter(({ msg }) => hasDisplayableContent(msg)),
);

function handleProgress(event: CustomEvent<{ task_id: string; message: StreamMessage }>) {
  if (event.detail.task_id !== props.taskId) return;
  messages.value.push(event.detail.message);
  nextTick(() => {
    containerRef.value?.scrollTo({ top: containerRef.value.scrollHeight });
  });
}

async function fetchBufferedProgress() {
  try {
    const { messages: buffered } = await api.tasks.progress(props.taskId);
    if (buffered.length > 0) {
      const existing = new Set(messages.value.map((m) => JSON.stringify(m)));
      for (const msg of buffered) {
        const key = JSON.stringify(msg);
        if (!existing.has(key)) {
          messages.value.push(msg as StreamMessage);
        }
      }
      nextTick(() => {
        containerRef.value?.scrollTo({ top: containerRef.value.scrollHeight });
      });
    }
  } catch {
    // Ignore fetch errors — live stream still works
  }
}

onMounted(async () => {
  window.addEventListener('task:progress', handleProgress as EventListener);
  await fetchBufferedProgress();
  // Retry once after 2s if nothing arrived yet (handles race where agent just started)
  if (messages.value.length === 0) {
    setTimeout(() => fetchBufferedProgress(), 2000);
  }
});

onUnmounted(() => {
  window.removeEventListener('task:progress', handleProgress as EventListener);
});

/** Render text as markdown HTML. */
function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

/** Get a human-readable tool name. */
function formatToolName(tool: string | undefined): string {
  return tool ?? 'Unknown Tool';
}

/** Format tool input for display. */
function formatToolInput(msg: StreamMessage): string {
  if (!msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  try {
    return JSON.stringify(msg.content, null, 2);
  } catch {
    return String(msg.content);
  }
}

/** Format tool result content for display. */
function formatToolResult(msg: StreamMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (msg.content === undefined || msg.content === null) return '';
  try {
    return JSON.stringify(msg.content, null, 2);
  } catch {
    return String(msg.content);
  }
}

/** Get a short summary of tool input for the collapsed header. */
function toolInputSummary(msg: StreamMessage): string {
  if (!msg.content) return '';
  if (typeof msg.content === 'string') {
    return msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content;
  }
  if (typeof msg.content === 'object' && msg.content !== null) {
    const obj = msg.content as Record<string, unknown>;
    // For common tools, show useful summary
    if (obj.file_path) return String(obj.file_path);
    if (obj.command) {
      const cmd = String(obj.command);
      return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
    }
    if (obj.pattern) return String(obj.pattern);
    if (obj.query) return String(obj.query);
    if (obj.url) return String(obj.url);
    if (obj.description) return String(obj.description);
    // Generic fallback: first key=value
    const keys = Object.keys(obj).slice(0, 2);
    return keys.map((k) => `${k}: ${String(obj[k]).slice(0, 40)}`).join(', ');
  }
  return '';
}

function toggleToolResult(index: number) {
  const s = new Set(collapsedToolResults.value);
  if (s.has(index)) {
    s.delete(index);
  } else {
    s.add(index);
  }
  collapsedToolResults.value = s;
}

function isToolResultLong(msg: StreamMessage): boolean {
  const text = formatToolResult(msg);
  return text.length > 500 || text.split('\n').length > 10;
}
</script>

<template>
  <div ref="containerRef" class="overflow-y-auto max-h-[32rem] text-sm p-3 bg-gray-950 rounded-lg border border-gray-800">
    <!-- Empty state -->
    <div v-if="displayMessages.length === 0" class="text-gray-600 text-center py-8">
      <template v-if="messages.length === 0">
        <div class="text-lg mb-1">⏳</div>
        Waiting for agent output…
      </template>
      <template v-else>
        <div class="text-lg mb-1">⏳</div>
        Receiving events ({{ messages.length }} received, filtering…)
      </template>
    </div>

    <div class="space-y-3">
      <template v-for="{ msg, index } in displayMessages" :key="index">
        <!-- ── Assistant message ── -->
        <div v-if="msg.type === 'assistant'" class="session-assistant">
          <div class="flex items-start gap-2">
            <span class="shrink-0 mt-0.5 text-blue-400">●</span>
            <div
              v-if="getAssistantText(msg)"
              class="prose prose-invert prose-sm max-w-none text-gray-200"
              v-html="renderMarkdown(getAssistantText(msg))"
            />
          </div>
        </div>

        <!-- ── Tool use ── -->
        <div v-else-if="msg.type === 'tool_use'" class="session-tool-use">
          <div class="flex items-center gap-2 text-yellow-400">
            <span class="shrink-0">⏺</span>
            <span class="font-semibold text-xs uppercase tracking-wide">{{ formatToolName(msg.tool) }}</span>
            <span v-if="toolInputSummary(msg)" class="text-gray-500 text-xs font-normal truncate">
              {{ toolInputSummary(msg) }}
            </span>
          </div>
          <div v-if="formatToolInput(msg)" class="ml-5 mt-1">
            <pre class="text-xs text-gray-400 bg-gray-900 rounded px-2 py-1.5 overflow-x-auto max-h-40 whitespace-pre-wrap break-all">{{ formatToolInput(msg) }}</pre>
          </div>
        </div>

        <!-- ── Tool result ── -->
        <div v-else-if="msg.type === 'tool_result'" class="session-tool-result ml-5">
          <div
            v-if="isToolResultLong(msg)"
            class="cursor-pointer select-none"
            @click="toggleToolResult(index)"
          >
            <span class="text-xs text-gray-500 hover:text-gray-400 transition-colors">
              {{ collapsedToolResults.has(index) ? '▶' : '▼' }}
              <span class="ml-1">Output</span>
              <span class="text-gray-600 ml-1">({{ formatToolResult(msg).split('\n').length }} lines)</span>
            </span>
          </div>
          <pre
            v-if="!isToolResultLong(msg) || !collapsedToolResults.has(index)"
            class="text-xs bg-gray-900 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all"
            :class="msg.is_error ? 'text-red-400 border border-red-900/50' : 'text-green-400/80'"
          >{{ formatToolResult(msg) }}</pre>
        </div>

        <!-- ── Result (final summary) ── -->
        <div v-else-if="msg.type === 'result'" class="session-result border-t border-gray-800 pt-3 mt-3">
          <div class="flex items-start gap-2">
            <span class="shrink-0 mt-0.5 text-emerald-400">✓</span>
            <div
              class="prose prose-invert prose-sm max-w-none text-gray-200"
              v-html="renderMarkdown(msg.result ?? '')"
            />
          </div>
        </div>

        <!-- ── System message ── -->
        <div v-else-if="msg.type === 'system'" class="session-system">
          <div class="flex items-center gap-2 text-gray-500 text-xs">
            <span class="shrink-0">ℹ</span>
            <span>{{ msg.message }}</span>
          </div>
        </div>

        <!-- ── Error ── -->
        <div v-else-if="msg.type === 'error' || msg.is_error" class="session-error">
          <div class="flex items-start gap-2 text-red-400 bg-red-950/30 rounded px-2 py-1.5">
            <span class="shrink-0 mt-0.5">✗</span>
            <span class="text-sm">{{ msg.message || formatToolResult(msg) || 'An error occurred' }}</span>
          </div>
        </div>

        <!-- ── Fallback for unrecognized message types ── -->
        <div v-else class="session-unknown">
          <div class="flex items-start gap-2 text-gray-500 text-xs">
            <span class="shrink-0 mt-0.5">…</span>
            <span class="text-gray-400">{{ msg.type }}: {{ msg.message || extractText(msg.content) || '' }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
