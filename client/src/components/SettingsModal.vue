<script setup lang="ts">
import {
  type ParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
} from 'jsonc-parser'
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { api } from '../api'

const emit = defineEmits<{
  close: []
}>()

const content = ref('')
const originalContent = ref('')
const configPath = ref('')
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const serverError = ref('')
const parseErrors = ref<ParseError[]>([])

onMounted(async () => {
  try {
    const data = await api.config.getRaw()
    content.value = data.content
    originalContent.value = data.content
    configPath.value = data.path
  } catch (e) {
    serverError.value = e instanceof Error ? e.message : 'Failed to load config'
  } finally {
    loading.value = false
  }
})

watch(content, (val) => {
  serverError.value = ''
  const errors: ParseError[] = []
  parseJsonc(val, errors)
  parseErrors.value = errors
})

const hasParseErrors = computed(() => parseErrors.value.length > 0)
const isUnchanged = computed(() => content.value === originalContent.value)
const canSave = computed(
  () => !hasParseErrors.value && !isUnchanged.value && !saving.value,
)

function formatParseError(err: ParseError): string {
  // Find the line number from the offset
  const lines = content.value.slice(0, err.offset).split('\n')
  const line = lines.length
  const col = (lines[lines.length - 1]?.length ?? 0) + 1
  return `Line ${line}, col ${col}: syntax error`
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    handleSave()
  }
}

function onTextareaKeydown(e: KeyboardEvent) {
  const textarea = e.target as HTMLTextAreaElement
  const { selectionStart, selectionEnd, value } = textarea
  const indent = '  '

  if (e.key === 'Tab') {
    e.preventDefault()
    e.stopPropagation()

    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1

    if (selectionStart === selectionEnd) {
      // No selection: insert/remove indent at cursor
      if (e.shiftKey) {
        const line = value.slice(lineStart, selectionStart)
        const stripped = line.replace(new RegExp(`^ {1,${indent.length}}`), '')
        const removed = line.length - stripped.length
        content.value =
          value.slice(0, lineStart) + stripped + value.slice(selectionStart)
        nextTick(() => {
          textarea.selectionStart = textarea.selectionEnd =
            selectionStart - removed
        })
      } else {
        content.value =
          value.slice(0, selectionStart) + indent + value.slice(selectionEnd)
        nextTick(() => {
          textarea.selectionStart = textarea.selectionEnd =
            selectionStart + indent.length
        })
      }
    } else {
      // Multi-line selection: indent/unindent all selected lines
      const lineEnd = value.indexOf('\n', selectionEnd - 1)
      const blockEnd = lineEnd === -1 ? value.length : lineEnd
      const block = value.slice(lineStart, blockEnd)
      let newBlock: string
      let startDelta = 0
      let endDelta = 0

      if (e.shiftKey) {
        const lines = block.split('\n')
        newBlock = lines
          .map((line, i) => {
            const stripped = line.replace(
              new RegExp(`^ {1,${indent.length}}`),
              '',
            )
            const removed = line.length - stripped.length
            if (i === 0) startDelta = -removed
            endDelta -= removed
            return stripped
          })
          .join('\n')
      } else {
        const lines = block.split('\n')
        newBlock = lines
          .map((line, i) => {
            if (i === 0) startDelta = indent.length
            endDelta += indent.length
            return indent + line
          })
          .join('\n')
      }

      content.value =
        value.slice(0, lineStart) + newBlock + value.slice(blockEnd)
      nextTick(() => {
        textarea.selectionStart = Math.max(
          lineStart,
          selectionStart + startDelta,
        )
        textarea.selectionEnd = selectionEnd + endDelta
      })
    }
    return
  }

  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()

    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
    const currentLine = value.slice(lineStart, selectionStart)
    const leadingWhitespace = currentLine.match(/^(\s*)/)?.[1] ?? ''
    const charBefore = value[selectionStart - 1]
    const charAfter = value[selectionStart]

    const isOpener = charBefore === '{' || charBefore === '['
    const isCloser = charAfter === '}' || charAfter === ']'

    if (isOpener && isCloser) {
      // Between brackets: expand to 3 lines
      const innerIndent = leadingWhitespace + indent
      const insertion = '\n' + innerIndent + '\n' + leadingWhitespace
      content.value =
        value.slice(0, selectionStart) + insertion + value.slice(selectionEnd)
      const cursorPos = selectionStart + 1 + innerIndent.length
      nextTick(() => {
        textarea.selectionStart = textarea.selectionEnd = cursorPos
      })
    } else {
      const newIndent = isOpener
        ? leadingWhitespace + indent
        : leadingWhitespace
      const insertion = '\n' + newIndent
      content.value =
        value.slice(0, selectionStart) + insertion + value.slice(selectionEnd)
      nextTick(() => {
        textarea.selectionStart = textarea.selectionEnd =
          selectionStart + insertion.length
      })
    }
    return
  }

  // Auto-dedent closing brackets
  if (e.key === '}' || e.key === ']') {
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
    const beforeCursor = value.slice(lineStart, selectionStart)
    if (/^\s+$/.test(beforeCursor) && beforeCursor.length >= indent.length) {
      e.preventDefault()
      const dedented = beforeCursor.slice(0, -indent.length)
      content.value =
        value.slice(0, lineStart) + dedented + e.key + value.slice(selectionEnd)
      const cursorPos = lineStart + dedented.length + 1
      nextTick(() => {
        textarea.selectionStart = textarea.selectionEnd = cursorPos
      })
      return
    }
  }
}

async function restoreDefaultTaskTypes() {
  try {
    const defaults = await api.config.getDefaultTaskTypes()
    const edits = modify(content.value, ['task_types'], defaults, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    })
    content.value = applyEdits(content.value, edits)
  } catch (e) {
    serverError.value =
      e instanceof Error ? e.message : 'Failed to fetch defaults'
  }
}

async function handleSave() {
  if (!canSave.value) return

  saving.value = true
  serverError.value = ''

  try {
    await api.config.saveRaw(content.value)
    originalContent.value = content.value
    saved.value = true
    setTimeout(() => {
      emit('close')
    }, 600)
  } catch (e) {
    serverError.value = e instanceof Error ? e.message : 'Failed to save config'
  } finally {
    saving.value = false
  }
}

const settingsModal = useTemplateRef('settings-model')
onMounted(() => {
  settingsModal.value?.focus()
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="settings-model"
      tabindex="-1"
      class="fixed inset-0 z-50 flex items-center justify-center"
      @keydown="onKeydown">
      <!-- Backdrop -->
      <div class="absolute inset-0 bg-black/60" @click="emit('close')" />

      <!-- Modal -->
      <div
        class="relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-2xl mx-4">
        <div class="px-6 py-4 border-b border-zinc-800">
          <h2 class="text-lg font-semibold">Settings</h2>
          <p v-if="configPath" class="text-xs text-zinc-500 mt-0.5 font-mono">
            {{ configPath }}
          </p>
        </div>

        <div class="px-6 py-4 space-y-3">
          <!-- Loading -->
          <div v-if="loading" class="text-sm text-zinc-500 py-8 text-center">
            Loading config...
          </div>

          <template v-else>
            <!-- Editor -->
            <textarea
              v-model="content"
              rows="20"
              spellcheck="false"
              class="w-full bg-zinc-800 border rounded-md px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-600 resize-y"
              :class="hasParseErrors ? 'border-red-600' : 'border-zinc-700'"
              autofocus
              @keydown="onTextareaKeydown" />

            <!-- Parse errors -->
            <div v-if="hasParseErrors" class="text-xs text-red-400 space-y-0.5">
              <p v-for="(err, i) in parseErrors" :key="i">
                {{ formatParseError(err) }}
              </p>
            </div>

            <!-- Server error -->
            <div
              v-if="serverError"
              class="rounded bg-red-950 border border-red-900 p-3">
              <p class="text-sm text-red-300">{{ serverError }}</p>
            </div>

            <!-- Saved indicator -->
            <div v-if="saved" class="text-sm text-green-400 text-center">
              Saved
            </div>
          </template>

          <!-- Actions -->
          <div class="flex justify-between pt-2">
            <button
              type="button"
              class="px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              @click="restoreDefaultTaskTypes">
              Restore default task types
            </button>
            <div class="flex gap-2">
              <button
                type="button"
                class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                @click="emit('close')">
                Cancel
              </button>
              <button
                :disabled="!canSave"
                class="px-4 py-2 text-sm font-medium bg-zinc-600 hover:bg-zinc-500 rounded-md transition-colors disabled:opacity-50"
                @click="handleSave">
                {{ saving ? 'Saving...' : 'Save' }}
                <kbd class="ml-1 text-xs opacity-60">⌘↵</kbd>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
