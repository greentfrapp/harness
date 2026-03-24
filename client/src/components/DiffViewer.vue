<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { html as diff2html } from 'diff2html';
import { api } from '../api';

const props = defineProps<{
  taskId: string;
}>();

const diffText = ref('');
const stats = ref('');
const loading = ref(true);
const error = ref('');

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
</script>

<template>
  <div class="space-y-2">
    <!-- Stats summary -->
    <div v-if="stats" class="text-xs text-gray-500 font-mono whitespace-pre">{{ stats }}</div>

    <!-- Loading -->
    <div v-if="loading" class="text-sm text-gray-500 py-4 text-center">Loading diff...</div>

    <!-- Error -->
    <div v-else-if="error" class="text-sm text-red-400 py-4 text-center">{{ error }}</div>

    <!-- No changes -->
    <div v-else-if="!diffText" class="text-sm text-gray-500 py-4 text-center">No changes</div>

    <!-- Diff display -->
    <div v-else class="diff-container overflow-x-auto rounded border border-gray-800" v-html="renderedHtml" />
  </div>
</template>

<style>
/* diff2html theme overrides for dark mode */
.diff-container .d2h-wrapper {
  background: #0d1117;
}
.diff-container .d2h-file-header {
  background: #161b22;
  border-color: #30363d;
  color: #c9d1d9;
}
.diff-container .d2h-file-name {
  color: #58a6ff;
}
.diff-container .d2h-code-line,
.diff-container .d2h-code-side-line {
  background: #0d1117;
  color: #c9d1d9;
  font-size: 12px;
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
.diff-container .d2h-code-linenumber {
  background: #161b22;
  border-color: #30363d;
  color: #8b949e;
}
.diff-container .d2h-diff-table {
  border-color: #30363d;
}
.diff-container .d2h-emptyplaceholder {
  background: #161b22;
}
.diff-container .d2h-info {
  background: #161b22;
  color: #8b949e;
  border-color: #30363d;
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
}
.diff-container .d2h-file-list-line {
  color: #c9d1d9;
}
.diff-container .d2h-file-list-header {
  background: #161b22;
  color: #c9d1d9;
}
</style>
