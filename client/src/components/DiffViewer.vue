<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick } from 'vue';
import { html as diff2html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';
import { api } from '../api';

const props = defineProps<{
  taskId: string;
}>();

const emit = defineEmits<{ revised: [] }>();

const diffText = ref('');
const stats = ref('');
const loading = ref(true);
const error = ref('');
const activeFileIndex = ref(0);
const uncommitted = ref(false);
const requesting = ref(false);

interface FileDiff {
  fileName: string;
  html: string;
  additions: number;
  deletions: number;
}

const fileDiffs = ref<FileDiff[]>([]);

onMounted(async () => {
  try {
    const data = await api.tasks.diff(props.taskId);
    diffText.value = data.diff;
    stats.value = data.stats;
    uncommitted.value = !!data.uncommitted;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load diff';
  } finally {
    loading.value = false;
  }
});

// Parse the unified diff into per-file diffs
function parseDiffIntoFiles(diff: string): string[] {
  const files: string[] = [];
  const lines = diff.split('\n');
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git') && current.length > 0) {
      files.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    files.push(current.join('\n'));
  }
  return files;
}

function extractFileName(singleDiff: string): string {
  // Try to get filename from +++ line
  const match = singleDiff.match(/^\+\+\+ b\/(.+)$/m);
  if (match) return match[1];
  // Fallback to diff --git line
  const gitMatch = singleDiff.match(/^diff --git a\/.+ b\/(.+)$/m);
  if (gitMatch) return gitMatch[1];
  return 'unknown';
}

function countChanges(singleDiff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  const lines = singleDiff.split('\n');
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

watch(diffText, () => {
  if (!diffText.value) return;

  const rawFiles = parseDiffIntoFiles(diffText.value);
  fileDiffs.value = rawFiles.map((raw) => {
    const fileName = extractFileName(raw);
    const { additions, deletions } = countChanges(raw);
    const html = diff2html(raw, {
      drawFileList: false,
      matching: 'lines',
      outputFormat: 'side-by-side',
    });
    return { fileName, html, additions, deletions };
  });

  activeFileIndex.value = 0;
});

function shortName(fullPath: string): string {
  const parts = fullPath.split('/');
  return parts[parts.length - 1];
}

async function requestCommit() {
  requesting.value = true;
  try {
    await api.tasks.revise(props.taskId, 'Please commit all your changes.');
    emit('revised');
  } catch {
    // Error will propagate via SSE
  } finally {
    requesting.value = false;
  }
}
</script>

<template>
  <div class="space-y-1">
    <!-- Stats summary -->
    <div v-if="stats" class="text-xs text-zinc-500 font-mono whitespace-pre">{{ stats }}</div>

    <!-- Uncommitted changes warning -->
    <div v-if="uncommitted" class="flex items-center justify-between gap-3 px-3 py-2 rounded border border-amber-700/50 bg-amber-950/30 text-sm">
      <span class="text-amber-300">These changes are uncommitted in the worktree.</span>
      <button
        class="shrink-0 px-3 py-1 rounded bg-purple-900 hover:bg-purple-800 text-purple-300 text-xs font-medium transition-colors disabled:opacity-50"
        :disabled="requesting"
        @click="requestCommit"
      >
        {{ requesting ? 'Requesting...' : 'Request commit' }}
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-sm text-zinc-500 py-4 text-center">Loading diff...</div>

    <!-- Error -->
    <div v-else-if="error" class="text-sm text-red-400 py-4 text-center">{{ error }}</div>

    <!-- No changes -->
    <div v-else-if="!diffText" class="text-sm text-zinc-500 py-4 text-center">No changes</div>

    <!-- Tabbed diff display -->
    <div v-else-if="fileDiffs.length" class="rounded border border-zinc-800 overflow-hidden">
      <!-- Tab bar -->
      <div class="diff-tab-bar flex overflow-x-auto border-b border-zinc-800 bg-[#0d1117]">
        <button
          v-for="(file, idx) in fileDiffs"
          :key="file.fileName"
          class="diff-tab shrink-0 px-3 py-1.5 text-xs font-mono border-r border-zinc-800 transition-colors whitespace-nowrap"
          :class="idx === activeFileIndex
            ? 'bg-[#161b22] text-[#58a6ff] border-b-2 border-b-[#58a6ff]'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#161b22]/50'"
          :title="file.fileName"
          @click="activeFileIndex = idx"
        >
          {{ shortName(file.fileName) }}
          <span v-if="file.additions" class="text-green-400 ml-1">+{{ file.additions }}</span>
          <span v-if="file.deletions" class="text-red-400 ml-1">-{{ file.deletions }}</span>
        </button>
      </div>

      <!-- Full path of active file -->
      <div class="px-2 py-1 bg-[#161b22] text-xs text-zinc-500 font-mono border-b border-zinc-800 truncate">
        {{ fileDiffs[activeFileIndex]?.fileName }}
      </div>

      <!-- Active file diff -->
      <div
        class="diff-container overflow-x-auto overflow-y-auto"
        style="max-height: 65vh;"
        v-html="fileDiffs[activeFileIndex]?.html"
      />
    </div>
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
/* Compact spacing between files */
.diff-container .d2h-file-wrapper {
  margin-bottom: 0;
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

/* Tab bar styling */
.diff-tab-bar {
  scrollbar-width: thin;
  scrollbar-color: #30363d transparent;
}
.diff-tab-bar::-webkit-scrollbar {
  height: 4px;
}
.diff-tab-bar::-webkit-scrollbar-track {
  background: transparent;
}
.diff-tab-bar::-webkit-scrollbar-thumb {
  background: #30363d;
  border-radius: 2px;
}
</style>
