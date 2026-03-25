<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick } from 'vue';
import { html as diff2html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';
import { api } from '../api';

const props = defineProps<{
  taskId: string;
}>();

const diffText = ref('');
const stats = ref('');
const loading = ref(true);
const error = ref('');
const diffContainer = ref<HTMLElement | null>(null);
const fileListVisible = ref(false);

onMounted(async () => {
  try {
    const data = await api.tasks.diff(props.taskId);
    diffText.value = data.diff;
    stats.value = data.stats;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load diff';
  } finally {
    loading.value = false;
  }
});

const renderedHtml = computed(() => {
  if (!diffText.value) return '';
  return diff2html(diffText.value, {
    drawFileList: true,
    matching: 'lines',
    outputFormat: 'side-by-side',
  });
});

function toggleFileList() {
  fileListVisible.value = !fileListVisible.value;
  if (!diffContainer.value) return;
  const wrapper = diffContainer.value.querySelector('.d2h-file-list-wrapper') as HTMLElement;
  if (wrapper) {
    wrapper.style.display = fileListVisible.value ? '' : 'none';
  }
}

function toggleFileDiff(header: HTMLElement) {
  const fileWrapper = header.closest('.d2h-file-wrapper');
  if (!fileWrapper) return;
  const diff = fileWrapper.querySelector('.d2h-file-diff') as HTMLElement;
  if (!diff) return;
  const isHidden = diff.style.display === 'none';
  diff.style.display = isHidden ? '' : 'none';
  header.classList.toggle('is-collapsed', !isHidden);
}

watch(renderedHtml, async () => {
  await nextTick();
  if (!diffContainer.value) return;

  // Hide file list by default
  const fileListWrapper = diffContainer.value.querySelector('.d2h-file-list-wrapper') as HTMLElement;
  if (fileListWrapper) {
    fileListWrapper.style.display = 'none';
  }

  // Remove the default non-functional toggle button from diff2html
  const defaultToggles = diffContainer.value.querySelectorAll('.d2h-file-list-title');
  defaultToggles.forEach((el) => {
    (el as HTMLElement).style.display = 'none';
  });

  // Add click-to-collapse on each file header
  const fileHeaders = diffContainer.value.querySelectorAll('.d2h-file-header');
  fileHeaders.forEach((header) => {
    (header as HTMLElement).style.cursor = 'pointer';
    header.addEventListener('click', () => toggleFileDiff(header as HTMLElement));
  });
});
</script>

<template>
  <div class="space-y-1">
    <!-- Stats summary + file list toggle -->
    <div v-if="stats || renderedHtml" class="flex items-center gap-2">
      <div v-if="stats" class="text-xs text-gray-500 font-mono whitespace-pre flex-1">{{ stats }}</div>
      <button
        v-if="renderedHtml"
        class="text-xs text-gray-500 hover:text-gray-300 transition-colors shrink-0 px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700"
        @click="toggleFileList"
      >
        {{ fileListVisible ? 'Hide' : 'Show' }} file list
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-sm text-gray-500 py-4 text-center">Loading diff...</div>

    <!-- Error -->
    <div v-else-if="error" class="text-sm text-red-400 py-4 text-center">{{ error }}</div>

    <!-- No changes -->
    <div v-else-if="!diffText" class="text-sm text-gray-500 py-4 text-center">No changes</div>

    <!-- Diff display -->
    <div
      v-else
      ref="diffContainer"
      class="diff-container overflow-x-auto overflow-y-auto rounded border border-gray-800"
      style="max-height: 70vh;"
      v-html="renderedHtml"
    />
  </div>
</template>

<style>
/* diff2html theme overrides for dark mode — compact variant */
.diff-container .d2h-wrapper {
  --d2h-del-highlight-bg-color: #6e3630;
  --d2h-ins-highlight-bg-color: #265a38;
  background: #0d1117;
}
.diff-container .d2h-file-header {
  background: #161b22;
  border-color: #30363d;
  color: #c9d1d9;
  padding: 4px 8px;
  user-select: none;
}
.diff-container .d2h-file-header:hover {
  background: #1c2330;
}
.diff-container .d2h-file-header.is-collapsed {
  opacity: 0.7;
}
.diff-container .d2h-file-name-wrapper {
  font-size: 12px;
}
.diff-container .d2h-file-name {
  color: #58a6ff;
}
.diff-container .d2h-file-stats {
  font-size: 11px;
}
.diff-container .d2h-code-line,
.diff-container .d2h-code-side-line {
  background: #0d1117;
  color: #c9d1d9;
  font-size: 11px;
  line-height: 1.3;
  padding: 0 8px;
}
.diff-container .d2h-code-line-prefix {
  color: #8b949e;
}
.diff-container .d2h-del {
  background: #3d1f28;
}
.diff-container .d2h-ins {
  background: #1a3324;
}
.diff-container .d2h-del .d2h-code-line-ctn {
  background: #3d1f28;
  color: #ffa198;
}
.diff-container .d2h-ins .d2h-code-line-ctn {
  background: #1a3324;
  color: #7ee787;
}
.diff-container .d2h-code-linenumber,
.diff-container .d2h-code-side-linenumber {
  background: #161b22;
  border-color: #30363d;
  color: #8b949e;
  font-size: 11px;
  line-height: 1.3;
  padding: 0 4px;
  position: sticky !important;
  left: 0;
  z-index: 1;
}
.diff-container .d2h-diff-table {
  border-color: #30363d;
  font-size: 11px;
}
.diff-container .d2h-emptyplaceholder {
  background: #161b22;
}
.diff-container .d2h-info {
  background: #161b22;
  color: #8b949e;
  border-color: #30363d;
  padding: 2px 8px;
  font-size: 11px;
}
.diff-container .d2h-file-diff .d2h-del.d2h-change {
  background: #3d1f28;
}
.diff-container .d2h-file-diff .d2h-ins.d2h-change {
  background: #1a3324;
}
.diff-container .d2h-file-list-wrapper {
  background: #161b22;
  border-color: #30363d;
  margin: 0;
  padding: 4px 0;
}
.diff-container .d2h-file-list-header {
  display: none;
}
.diff-container .d2h-file-list-line {
  color: #c9d1d9;
  font-size: 12px;
  padding: 2px 8px;
}
.diff-container .d2h-file-list td {
  padding: 2px 4px;
}
/* Compact spacing between files */
.diff-container .d2h-file-wrapper {
  margin-bottom: 2px;
  border: none;
}
.diff-container .d2h-files-diff {
  display: flex;
  flex-direction: row;
  gap: 2px;
}
/* Reduce diff table cell padding */
.diff-container .d2h-diff-table td {
  padding: 0;
  position: relative;
}
.diff-container .d2h-diff-tbody tr td {
  line-height: 1.3;
}
/* Ensure side-by-side containers render as two columns */
.diff-container .d2h-file-side-diff {
  display: inline-block;
  width: 50%;
  position: relative;
  overflow-x: auto;
  overflow-y: hidden;
  vertical-align: top;
  margin: 0;
}
/* Prevent diff wrapper from breaking out of container */
.diff-container .d2h-file-diff {
  overflow: auto;
  white-space: nowrap;
  font-size: 0; /* Remove inline-block whitespace gap */
}
</style>
