<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { api } from '../api';

const emit = defineEmits<{
  close: [];
}>();

const content = ref('');
const originalContent = ref('');
const configPath = ref('');
const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const serverError = ref('');
const parseErrors = ref<ParseError[]>([]);

onMounted(async () => {
  try {
    const data = await api.config.getRaw();
    content.value = data.content;
    originalContent.value = data.content;
    configPath.value = data.path;
  } catch (e) {
    serverError.value = e instanceof Error ? e.message : 'Failed to load config';
  } finally {
    loading.value = false;
  }
});

watch(content, (val) => {
  serverError.value = '';
  const errors: ParseError[] = [];
  parseJsonc(val, errors);
  parseErrors.value = errors;
});

const hasParseErrors = computed(() => parseErrors.value.length > 0);
const isUnchanged = computed(() => content.value === originalContent.value);
const canSave = computed(() => !hasParseErrors.value && !isUnchanged.value && !saving.value);

function formatParseError(err: ParseError): string {
  // Find the line number from the offset
  const lines = content.value.slice(0, err.offset).split('\n');
  const line = lines.length;
  const col = (lines[lines.length - 1]?.length ?? 0) + 1;
  return `Line ${line}, col ${col}: syntax error`;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close');
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    handleSave();
  }
}

async function handleSave() {
  if (!canSave.value) return;

  saving.value = true;
  serverError.value = '';

  try {
    await api.config.saveRaw(content.value);
    originalContent.value = content.value;
    saved.value = true;
    setTimeout(() => {
      emit('close');
    }, 600);
  } catch (e) {
    serverError.value = e instanceof Error ? e.message : 'Failed to save config';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center"
      @keydown="onKeydown"
    >
      <!-- Backdrop -->
      <div
        class="absolute inset-0 bg-black/60"
        @click="emit('close')"
      />

      <!-- Modal -->
      <div class="relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-2xl mx-4">
        <div class="px-6 py-4 border-b border-zinc-800">
          <h2 class="text-lg font-semibold">Settings</h2>
          <p v-if="configPath" class="text-xs text-zinc-500 mt-0.5 font-mono">{{ configPath }}</p>
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
              class="w-full bg-zinc-800 border rounded-md px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-600 resize-y"
              :class="hasParseErrors ? 'border-red-600' : 'border-zinc-700'"
              autofocus
            />

            <!-- Parse errors -->
            <div v-if="hasParseErrors" class="text-xs text-red-400 space-y-0.5">
              <p v-for="(err, i) in parseErrors" :key="i">{{ formatParseError(err) }}</p>
            </div>

            <!-- Server error -->
            <div v-if="serverError" class="rounded bg-red-950 border border-red-900 p-3">
              <p class="text-sm text-red-300">{{ serverError }}</p>
            </div>

            <!-- Saved indicator -->
            <div v-if="saved" class="text-sm text-green-400 text-center">
              Saved
            </div>
          </template>

          <!-- Actions -->
          <div class="flex justify-end gap-2 pt-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              @click="emit('close')"
            >
              Cancel
            </button>
            <button
              :disabled="!canSave"
              class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 rounded-md transition-colors disabled:opacity-50"
              @click="handleSave"
            >
              {{ saving ? 'Saving...' : 'Save' }}
              <kbd class="ml-1 text-xs opacity-60">⌘↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
