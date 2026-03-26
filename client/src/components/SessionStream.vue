<script setup lang="ts">
import {
  type DisplayItem,
  type StreamMessage,
  expandMessages,
} from '@shared/streamFilters'
import { marked } from 'marked'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { api } from '../api'

const props = defineProps<{
  taskId: string
}>()

const messages = ref<StreamMessage[]>([])
const containerRef = ref<HTMLElement | null>(null)
const collapsedToolResults = ref<Set<number>>(new Set())
const userScrolledUp = ref(false)

/** Filter toggles for each display type. All enabled by default. */
type FilterType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'system'
  | 'error'
const filterLabels: {
  type: FilterType
  label: string
  color: string
  activeColor: string
}[] = [
  {
    type: 'text',
    label: 'Text',
    color: 'text-zinc-400',
    activeColor: 'bg-zinc-800/60 border-zinc-700 text-zinc-300',
  },
  {
    type: 'tool_use',
    label: 'Tools',
    color: 'text-yellow-400',
    activeColor: 'bg-yellow-900/60 border-yellow-700 text-yellow-300',
  },
  {
    type: 'tool_result',
    label: 'Results',
    color: 'text-green-400',
    activeColor: 'bg-green-900/60 border-green-700 text-green-300',
  },
  {
    type: 'error',
    label: 'Errors',
    color: 'text-red-400',
    activeColor: 'bg-red-900/60 border-red-700 text-red-300',
  },
]
const activeFilters = ref<Set<FilterType>>(
  new Set(['text', 'tool_use', 'tool_result', 'result', 'system', 'error']),
)

function toggleFilter(type: FilterType) {
  const s = new Set(activeFilters.value)
  if (s.has(type)) {
    // Don't allow disabling all filters
    if (s.size <= 1) return
    s.delete(type)
  } else {
    s.add(type)
  }
  activeFilters.value = s
}

/** Expand raw messages into flat display items. */
const allDisplayItems = computed(() => expandMessages(messages.value))

/** Filtered display items based on active type filters. */
const displayItems = computed(() =>
  allDisplayItems.value.filter((item) => {
    // 'unknown' always shown; 'result' and 'system' follow their own type but are always shown
    if (
      item.displayType === 'unknown' ||
      item.displayType === 'result' ||
      item.displayType === 'system'
    )
      return true
    return activeFilters.value.has(item.displayType as FilterType)
  }),
)

/** Check if the container is scrolled to the bottom (within a small threshold). */
function isScrolledToBottom(): boolean {
  const el = containerRef.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 30
}

/** Scroll to bottom if auto-scroll is active. */
function scrollToBottomIfAllowed() {
  if (!userScrolledUp.value) {
    nextTick(() => {
      containerRef.value?.scrollTo({ top: containerRef.value.scrollHeight })
    })
  }
}

/** Handle user scroll events to detect scroll-up / scroll-to-bottom. */
function handleScroll() {
  if (isScrolledToBottom()) {
    userScrolledUp.value = false
  } else {
    userScrolledUp.value = true
  }
}

function handleProgress(
  event: CustomEvent<{ task_id: string; message: StreamMessage }>,
) {
  if (event.detail.task_id !== props.taskId) return
  messages.value.push(event.detail.message)
  scrollToBottomIfAllowed()
}

async function fetchBufferedProgress() {
  try {
    const { messages: buffered } = await api.tasks.progress(props.taskId)
    if (buffered.length > 0) {
      const existing = new Set(messages.value.map((m) => JSON.stringify(m)))
      for (const msg of buffered) {
        const key = JSON.stringify(msg)
        if (!existing.has(key)) {
          messages.value.push(msg as StreamMessage)
        }
      }
      scrollToBottomIfAllowed()
    }
  } catch {
    // Ignore fetch errors — live stream still works
  }
}

onMounted(async () => {
  // Reset auto-scroll when (re-)opening the task
  userScrolledUp.value = false
  window.addEventListener('task:progress', handleProgress as EventListener)
  await fetchBufferedProgress()
  // Retry once after 2s if nothing arrived yet (handles race where agent just started)
  if (messages.value.length === 0) {
    setTimeout(() => fetchBufferedProgress(), 2000)
  }
})

onUnmounted(() => {
  window.removeEventListener('task:progress', handleProgress as EventListener)
})

/** Render text as markdown HTML. */
function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string
}

/** Format tool input for display. */
function formatToolInput(input: unknown): string {
  if (!input) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/** Format tool result content for display. */
function formatToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === undefined || result === null) return ''
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/** Get a short summary of tool input for the collapsed header. */
function toolInputSummary(input: unknown): string {
  if (!input) return ''
  if (typeof input === 'string') {
    return input.length > 80 ? input.slice(0, 80) + '…' : input
  }
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>
    // For common tools, show useful summary
    if (obj.file_path) return String(obj.file_path)
    if (obj.command) {
      const cmd = String(obj.command)
      return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd
    }
    if (obj.pattern) return String(obj.pattern)
    if (obj.query) return String(obj.query)
    if (obj.url) return String(obj.url)
    if (obj.description) return String(obj.description)
    // Generic fallback: first key=value
    const keys = Object.keys(obj).slice(0, 2)
    return keys.map((k) => `${k}: ${String(obj[k]).slice(0, 40)}`).join(', ')
  }
  return ''
}

function toggleToolResult(index: number) {
  const s = new Set(collapsedToolResults.value)
  if (s.has(index)) {
    s.delete(index)
  } else {
    s.add(index)
  }
  collapsedToolResults.value = s
}

function isToolResultLong(item: DisplayItem): boolean {
  const text = formatToolResult(item.toolResult)
  return text.length > 500 || text.split('\n').length > 10
}
</script>

<template>
  <div>
    <!-- Header with label and filters -->
    <div class="flex items-center gap-3 mb-2">
      <h4 class="text-xs font-medium text-zinc-500 uppercase shrink-0">
        Live Session
      </h4>
      <div class="flex items-center gap-1 flex-wrap">
        <button
          v-for="f in filterLabels"
          :key="f.type"
          class="px-1.5 py-0.5 text-[10px] font-medium rounded border transition-colors"
          :class="
            activeFilters.has(f.type)
              ? f.activeColor
              : 'bg-zinc-900 border-zinc-700 text-zinc-600 hover:text-zinc-400'
          "
          @click="toggleFilter(f.type)"
          :title="`Toggle ${f.label} messages`">
          {{ f.label }}
        </button>
      </div>
    </div>
    <div
      ref="containerRef"
      class="overflow-y-auto max-h-[32rem] text-sm p-3 bg-zinc-950 rounded-lg border border-zinc-800"
      @scroll="handleScroll">
      <!-- Empty state -->
      <div
        v-if="displayItems.length === 0"
        class="text-zinc-600 text-center py-8">
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
        <template v-for="(item, index) in displayItems" :key="index">
          <!-- ── Text (assistant message) ── -->
          <div v-if="item.displayType === 'text'" class="session-assistant">
            <div class="flex items-start gap-2">
              <span class="shrink-0 mt-0.5 text-zinc-400">●</span>
              <div
                class="prose prose-invert prose-sm max-w-none text-zinc-200"
                v-html="renderMarkdown(item.text ?? '')" />
            </div>
          </div>

          <!-- ── Tool use ── -->
          <div
            v-else-if="item.displayType === 'tool_use'"
            class="session-tool-use">
            <div class="flex items-center gap-2 text-yellow-400">
              <span class="shrink-0">⏺</span>
              <span class="font-semibold text-xs uppercase tracking-wide">{{
                item.toolName ?? 'Unknown Tool'
              }}</span>
              <span
                v-if="toolInputSummary(item.toolInput)"
                class="text-zinc-500 text-xs font-normal truncate">
                {{ toolInputSummary(item.toolInput) }}
              </span>
            </div>
            <div v-if="formatToolInput(item.toolInput)" class="ml-5 mt-1">
              <pre
                class="text-xs text-zinc-400 bg-zinc-900 rounded px-2 py-1.5 overflow-x-auto max-h-40 whitespace-pre-wrap break-all"
                >{{ formatToolInput(item.toolInput) }}</pre
              >
            </div>
          </div>

          <!-- ── Tool result ── -->
          <div
            v-else-if="item.displayType === 'tool_result'"
            class="session-tool-result ml-5">
            <div
              v-if="isToolResultLong(item)"
              class="cursor-pointer select-none"
              @click="toggleToolResult(index)">
              <span
                class="text-xs text-zinc-500 hover:text-zinc-400 transition-colors">
                {{ collapsedToolResults.has(index) ? '▶' : '▼' }}
                <span class="ml-1">Output</span>
                <span class="text-zinc-600 ml-1"
                  >({{
                    formatToolResult(item.toolResult).split('\n').length
                  }}
                  lines)</span
                >
              </span>
            </div>
            <pre
              v-if="!isToolResultLong(item) || !collapsedToolResults.has(index)"
              class="text-xs bg-zinc-900 rounded px-2 py-1.5 overflow-x-auto overflow-y-auto max-h-60 whitespace-pre-wrap break-all"
              :class="
                item.isError
                  ? 'text-red-400 border border-red-900/50'
                  : 'text-green-400/80'
              "
              >{{ formatToolResult(item.toolResult) }}</pre
            >
          </div>

          <!-- ── Result (final summary) ── -->
          <div
            v-else-if="item.displayType === 'result'"
            class="session-result border-t border-zinc-800 pt-3 mt-3">
            <div class="flex items-start gap-2">
              <span class="shrink-0 mt-0.5 text-emerald-400">✓</span>
              <div
                class="prose prose-invert prose-sm max-w-none text-zinc-200"
                v-html="renderMarkdown(item.resultText ?? '')" />
            </div>
          </div>

          <!-- ── System message ── -->
          <div v-else-if="item.displayType === 'system'" class="session-system">
            <div class="flex items-center gap-2 text-zinc-500 text-xs">
              <span class="shrink-0">ℹ</span>
              <span>{{ item.text }}</span>
            </div>
          </div>

          <!-- ── Error ── -->
          <div v-else-if="item.displayType === 'error'" class="session-error">
            <div
              class="flex items-start gap-2 text-red-400 bg-red-950/30 rounded px-2 py-1.5">
              <span class="shrink-0 mt-0.5">✗</span>
              <span class="text-sm">{{
                item.text || 'An error occurred'
              }}</span>
            </div>
          </div>

          <!-- ── Fallback for unrecognized message types ── -->
          <div v-else class="session-unknown">
            <div class="flex items-start gap-2 text-zinc-500 text-xs">
              <span class="shrink-0 mt-0.5">…</span>
              <span class="text-zinc-400"
                >{{ item.raw?.type }}: {{ item.text || '' }}</span
              >
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
