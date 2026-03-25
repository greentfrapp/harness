import { ref, computed } from 'vue';

export function useTaskSelection() {
  const selectedIds = ref<Set<string>>(new Set());

  const selectedCount = computed(() => selectedIds.value.size);
  const hasSelection = computed(() => selectedIds.value.size > 0);

  function toggle(id: string) {
    const next = new Set(selectedIds.value);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    selectedIds.value = next;
  }

  function isSelected(id: string): boolean {
    return selectedIds.value.has(id);
  }

  function selectAll(ids: string[]) {
    selectedIds.value = new Set(ids);
  }

  function clearSelection() {
    selectedIds.value = new Set();
  }

  return {
    selectedIds,
    selectedCount,
    hasSelection,
    toggle,
    isSelected,
    selectAll,
    clearSelection,
  };
}
