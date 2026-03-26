<script setup lang="ts">
import {
  type DisplayItem,
  type StreamMessage,
  expandMessages,
} from '@shared/streamFilters'
import { marked } from 'marked'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '../api'

const props = defineProps<{
  taskId: string
}>()

const messages = ref<StreamMessage[]>([])
const containerRef = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)

/** Filter toggles for each display type. All enabled by default. */
type FilterType = 'text' | 'tools' | 'result' | 'system' | 'error'
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
    type: 'tools',
    label: 'Tools',
    color: 'text-yellow-400',
    activeColor: 'bg-yellow-900/60 border-yellow-700 text-yellow-300',
  },
  {
    type: 'error',
    label: 'Errors',
    color: 'text-red-400',
    activeColor: 'bg-red-900/60 border-red-700 text-red-300',
  },
]
const activeFilters = ref<Set<FilterType>>(
  new Set(['text', 'tools', 'result', 'system', 'error']),
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

// ── Tool call grouping ──

interface ToolCallGroup {
  kind: 'tool_call'
  toolUse: DisplayItem
  toolResult: DisplayItem | null
  id: string
}

interface SingleItem {
  kind: 'single'
  item: DisplayItem
}

type GroupedItem = ToolCallGroup | SingleItem

/** Group tool_use + tool_result pairs into collapsible units. */
const groupedItems = computed<GroupedItem[]>(() => {
  const items = allDisplayItems.value
  const result: GroupedItem[] = []
  const consumedIndices = new Set<number>()

  for (let i = 0; i < items.length; i++) {
    if (consumedIndices.has(i)) continue
    const item = items[i]

    if (item.displayType === 'tool_use') {
      // Find matching tool_result by toolUseId or proximity
      let matchedResult: DisplayItem | null = null
      for (let j = i + 1; j < items.length; j++) {
        if (consumedIndices.has(j)) continue
        if (items[j].displayType === 'tool_result') {
          if (
            item.toolUseId &&
            items[j].toolUseId &&
            items[j].toolUseId === item.toolUseId
          ) {
            matchedResult = items[j]
            consumedIndices.add(j)
            break
          }
          // No toolUseId — match by proximity (next unmatched tool_result)
          if (!item.toolUseId || !items[j].toolUseId) {
            matchedResult = items[j]
            consumedIndices.add(j)
            break
          }
        }
        // Stop searching if we hit another tool_use (results come in order)
        if (items[j].displayType === 'tool_use') break
      }

      result.push({
        kind: 'tool_call',
        toolUse: item,
        toolResult: matchedResult,
        id: item.toolUseId || `tc-${i}`,
      })
    } else if (item.displayType === 'tool_result') {
      // Orphan tool_result (no matching tool_use) — wrap as tool_call group
      result.push({
        kind: 'tool_call',
        toolUse: {
          displayType: 'tool_use',
          toolName: 'Tool',
          toolInput: undefined,
        },
        toolResult: item,
        id: item.toolUseId || `tr-${i}`,
      })
    } else {
      result.push({ kind: 'single', item })
    }
  }

  return result
})

/** Filtered grouped items based on active type filters. */
const filteredGroupedItems = computed(() =>
  groupedItems.value.filter((g) => {
    if (g.kind === 'tool_call') {
      return activeFilters.value.has('tools')
    }
    const item = g.item
    if (
      item.displayType === 'unknown' ||
      item.displayType === 'result' ||
      item.displayType === 'system'
    )
      return true
    if (item.displayType === 'text') return activeFilters.value.has('text')
    if (item.displayType === 'error') return activeFilters.value.has('error')
    return true
  }),
)

// ── Collapse state management ──
// Track IDs that the user has manually toggled.
// Default: completed tool calls (have result) are collapsed, except the last one.
const manuallyToggled = ref<Set<string>>(new Set())

/** Find the ID of the last tool call group that has no result yet, or the last one overall. */
function lastToolCallId(): string | null {
  const groups = filteredGroupedItems.value.filter(
    (g) => g.kind === 'tool_call',
  ) as ToolCallGroup[]
  if (groups.length === 0) return null
  // Prefer the last in-progress (no result) tool call
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i].toolResult) return groups[i].id
  }
  // All have results — the last one stays expanded
  return groups[groups.length - 1].id
}

function isToolCallCollapsed(group: ToolCallGroup): boolean {
  const wasToggled = manuallyToggled.value.has(group.id)
  const isLast = group.id === lastToolCallId()
  // Default state: collapsed if completed and not the last
  const defaultCollapsed = group.toolResult !== null && !isLast
  // If user manually toggled, flip the default
  return wasToggled ? !defaultCollapsed : defaultCollapsed
}

function toggleToolCall(id: string) {
  const s = new Set(manuallyToggled.value)
  if (s.has(id)) {
    s.delete(id)
  } else {
    s.add(id)
  }
  manuallyToggled.value = s
}

// When new messages arrive and create a new "last" tool call,
// clear manual toggles for the previous last so it auto-collapses.
const prevLastId = ref<string | null>(null)
watch(
  () => lastToolCallId(),
  (newId) => {
    if (newId && newId !== prevLastId.value && prevLastId.value) {
      // Clear toggle on the old last so it collapses by default
      const s = new Set(manuallyToggled.value)
      s.delete(prevLastId.value)
      manuallyToggled.value = s
    }
    prevLastId.value = newId
  },
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
    return input.length > 80 ? input.slice(0, 80) + '...' : input
  }
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>
    // For common tools, show useful summary
    if (obj.file_path) return String(obj.file_path)
    if (obj.command) {
      const cmd = String(obj.command)
      return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd
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

/** Get a brief result summary for the collapsed header. */
function toolResultSummary(group: ToolCallGroup): string {
  if (!group.toolResult) return 'running...'
  if (group.toolResult.isError) return 'error'
  const text = formatToolResult(group.toolResult.toolResult)
  const lines = text.split('\n').length
  if (lines > 1) return `${lines} lines`
  if (text.length > 60) return `${text.length} chars`
  return text.length > 0 ? 'done' : 'done'
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
        v-if="filteredGroupedItems.length === 0"
        class="text-zinc-600 text-center py-8">
        <template v-if="messages.length === 0">
          <div class="text-lg mb-1">&#x23F3;</div>
          Waiting for agent output...
        </template>
        <template v-else>
          <div class="text-lg mb-1">&#x23F3;</div>
          Receiving events ({{ messages.length }} received, filtering...)
        </template>
      </div>

      <div class="space-y-3">
        <template v-for="(g, index) in filteredGroupedItems" :key="index">
          <!-- ── Tool call group (use + result) ── -->
          <div v-if="g.kind === 'tool_call'" class="session-tool-call">
            <!-- Clickable header — always visible -->
            <div
              class="flex items-center gap-2 cursor-pointer select-none group"
              @click="toggleToolCall(g.id)">
              <span
                class="shrink-0 text-xs text-zinc-500 group-hover:text-zinc-400 transition-colors w-3">
                {{ isToolCallCollapsed(g) ? '&#x25B6;' : '&#x25BC;' }}
              </span>
              <span class="shrink-0 text-yellow-400">&#x23FA;</span>
              <span
                class="font-semibold text-xs uppercase tracking-wide text-yellow-400">
                {{ g.toolUse.toolName ?? 'Unknown Tool' }}
              </span>
              <span
                v-if="toolInputSummary(g.toolUse.toolInput)"
                class="text-zinc-500 text-xs font-normal truncate">
                {{ toolInputSummary(g.toolUse.toolInput) }}
              </span>
              <!-- Result status indicator -->
              <span class="ml-auto shrink-0 text-xs">
                <span
                  v-if="!g.toolResult"
                  class="text-blue-400 animate-pulse"
                  >running...</span
                >
                <span
                  v-else-if="g.toolResult.isError"
                  class="text-red-400"
                  >error</span
                >
                <span v-else class="text-zinc-600">{{
                  toolResultSummary(g)
                }}</span>
              </span>
            </div>

            <!-- Expanded content -->
            <div v-if="!isToolCallCollapsed(g)" class="ml-5 mt-1 space-y-1">
              <!-- Tool input -->
              <pre
                v-if="formatToolInput(g.toolUse.toolInput)"
                class="text-xs text-zinc-400 bg-zinc-900 rounded px-2 py-1.5 overflow-x-auto max-h-40 whitespace-pre-wrap break-all"
                >{{ formatToolInput(g.toolUse.toolInput) }}</pre
              >
              <!-- Tool result -->
              <pre
                v-if="g.toolResult"
                class="text-xs bg-zinc-900 rounded px-2 py-1.5 overflow-x-auto overflow-y-auto max-h-60 whitespace-pre-wrap break-all"
                :class="
                  g.toolResult.isError
                    ? 'text-red-400 border border-red-900/50'
                    : 'text-green-400/80'
                "
                >{{ formatToolResult(g.toolResult.toolResult) }}</pre
              >
            </div>
          </div>

          <!-- ── Text (assistant message) ── -->
          <div
            v-else-if="g.kind === 'single' && g.item.displayType === 'text'"
            class="session-assistant">
            <div class="flex items-start gap-2">
              <span class="shrink-0 mt-0.5 text-zinc-400">&#x25CF;</span>
              <div
                class="prose prose-invert prose-sm max-w-none text-zinc-200"
                v-html="renderMarkdown(g.item.text ?? '')" />
            </div>
          </div>

          <!-- ── Result (final summary) ── -->
          <div
            v-else-if="g.kind === 'single' && g.item.displayType === 'result'"
            class="session-result border-t border-zinc-800 pt-3 mt-3">
            <div class="flex items-start gap-2">
              <span class="shrink-0 mt-0.5 text-emerald-400">&#x2713;</span>
              <div
                class="prose prose-invert prose-sm max-w-none text-zinc-200"
                v-html="renderMarkdown(g.item.resultText ?? '')" />
            </div>
          </div>

          <!-- ── System message ── -->
          <div
            v-else-if="g.kind === 'single' && g.item.displayType === 'system'"
            class="session-system">
            <div class="flex items-center gap-2 text-zinc-500 text-xs">
              <span class="shrink-0">&#x2139;</span>
              <span>{{ g.item.text }}</span>
            </div>
          </div>

          <!-- ── Error ── -->
          <div
            v-else-if="g.kind === 'single' && g.item.displayType === 'error'"
            class="session-error">
            <div
              class="flex items-start gap-2 text-red-400 bg-red-950/30 rounded px-2 py-1.5">
              <span class="shrink-0 mt-0.5">&#x2717;</span>
              <span class="text-sm">{{
                g.item.text || 'An error occurred'
              }}</span>
            </div>
          </div>

          <!-- ── Fallback for unrecognized message types ── -->
          <div v-else-if="g.kind === 'single'" class="session-unknown">
            <div class="flex items-start gap-2 text-zinc-500 text-xs">
              <span class="shrink-0 mt-0.5">...</span>
              <span class="text-zinc-400"
                >{{ g.item.raw?.type }}: {{ g.item.text || '' }}</span
              >
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
