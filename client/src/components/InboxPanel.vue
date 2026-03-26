<script setup lang="ts">
import type { TagConfig, Task } from '@shared/types'
import { computed, inject, ref } from 'vue'
import { useTaskSelection } from '../composables/useTaskSelection'
import { useCheckouts } from '../stores/useCheckouts'
import { useInbox } from '../stores/useInbox'
import TaskCard from './TaskCard.vue'
import TaskModal from './TaskModal.vue'

const tagConfigs =
  inject<import('vue').Ref<Record<string, TagConfig>>>('tagConfigs')

const inbox = useInbox()
const checkoutsStore = useCheckouts()
const confirming = ref(false)
const {
  selectedCount,
  hasSelection,
  toggle,
  isSelected,
  selectAll,
  clearSelection,
} = useTaskSelection()

const confirmingBulkDelete = ref(false)
const bulkDeleting = ref(false)

const allSelected = computed(
  () =>
    inbox.sortedItems.length > 0 &&
    selectedCount.value === inbox.sortedItems.length,
)

function toggleSelectAll() {
  if (allSelected.value) {
    clearSelection()
  } else {
    selectAll(inbox.sortedItems.map((t) => t.id))
  }
}

async function handleBulkDelete() {
  if (!confirmingBulkDelete.value) {
    confirmingBulkDelete.value = true
    return
  }
  bulkDeleting.value = true
  try {
    const ids = [
      ...new Set(
        inbox.sortedItems.filter((t) => isSelected(t.id)).map((t) => t.id),
      ),
    ]
    await inbox.bulkDelete(ids)
    clearSelection()
  } finally {
    bulkDeleting.value = false
    confirmingBulkDelete.value = false
  }
}

function cancelBulkDelete() {
  confirmingBulkDelete.value = false
}

async function handleClear() {
  await inbox.clearAll()
  confirming.value = false
}

async function refreshInbox() {
  await inbox.fetchItems()
}

async function handleDefer(id: string) {
  await inbox.updateTaskStatus(id, 'deferred')
}

async function handleDelete(id: string) {
  await inbox.deleteTask(id)
}

const maximizedTask = ref<Task | null>(null)

function handleMaximize(id: string) {
  const task = inbox.sortedItems.find((t) => t.id === id)
  if (task) maximizedTask.value = task
}

async function handleMaximizeAction(
  id: string,
  action?: (id: string) => Promise<void>,
) {
  if (action) await action(id)
  else await refreshInbox()
  maximizedTask.value = null
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div
      class="px-4 h-12 border-b border-zinc-800 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <template v-if="hasSelection">
          <template v-if="confirmingBulkDelete">
            <span class="text-xs text-zinc-400"
              >Delete {{ selectedCount }} task{{
                selectedCount > 1 ? 's' : ''
              }}?</span
            >
            <button
              class="px-2 py-1 text-xs font-medium rounded bg-red-800 hover:bg-red-700 text-red-200 transition-colors disabled:opacity-50"
              :disabled="bulkDeleting"
              @click="handleBulkDelete()">
              {{ bulkDeleting ? 'Deleting...' : 'Confirm' }}
            </button>
            <button
              class="px-2 py-1 text-xs font-medium rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
              @click="cancelBulkDelete()">
              Cancel
            </button>
          </template>
          <template v-else>
            <button
              class="px-2 py-1 text-xs font-medium rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors"
              @click="handleBulkDelete()">
              Delete Selected
            </button>
          </template>
        </template>
        <template v-else>
          <h2
            class="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Inbox
          </h2>
          <span
            v-if="inbox.pendingCount"
            class="text-xs px-2 py-0.5 rounded-full font-medium"
            :class="
              inbox.hasPermissionRequests
                ? 'bg-red-600 text-white animate-pulse'
                : 'bg-zinc-600 text-white'
            ">
            {{ inbox.pendingCount }}
          </span>
        </template>
      </div>
      <div
        v-if="inbox.sortedItems.length"
        class="flex items-center gap-2 text-xs">
        <template v-if="hasSelection">
          <button
            class="text-zinc-400 hover:text-zinc-200 transition-colors"
            @click="toggleSelectAll()">
            {{ allSelected ? 'Deselect All' : 'Select All' }}
          </button>
          <span class="text-zinc-500">{{ selectedCount }} selected</span>
          <button
            class="text-zinc-500 hover:text-zinc-300 transition-colors"
            @click="clearSelection()">
            Cancel
          </button>
        </template>
        <template v-else>
          <template v-if="confirming">
            <span class="text-zinc-400">Clear all?</span>
            <button
              class="text-red-400 hover:text-red-300 font-medium"
              @click="handleClear()">
              Yes
            </button>
            <button
              class="text-zinc-500 hover:text-zinc-300"
              @click="confirming = false">
              No
            </button>
          </template>
          <button
            v-else
            class="text-zinc-500 hover:text-zinc-300 transition-colors"
            @click="confirming = true">
            Clear
          </button>
        </template>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-3 space-y-2">
      <TaskCard
        v-for="item in inbox.sortedItems"
        :key="item.id"
        :task="item"
        context="inbox"
        :hasSelection="hasSelection"
        :selected="isSelected(item.id)"
        :tag-configs="tagConfigs"
        :is-checked-out="checkoutsStore.isCheckedOut(item.id)"
        :actions-disabled="
          checkoutsStore.isProjectLockedByOtherTask(item.project_id, item.id)
        "
        @approve="refreshInbox"
        @reject="refreshInbox"
        @retry="refreshInbox"
        @defer="handleDefer"
        @delete="handleDelete"
        @follow-up="refreshInbox"
        @toggleSelect="toggle"
        @maximize="handleMaximize" />
      <div
        v-if="!inbox.sortedItems.length && !inbox.loading"
        class="text-center text-zinc-600 py-12 text-sm">
        No items to review
      </div>
    </div>

    <!-- Task Modal -->
    <TaskModal
      v-if="maximizedTask"
      :task="maximizedTask"
      context="inbox"
      @close="maximizedTask = null"
      @approve="(id) => handleMaximizeAction(id)"
      @reject="(id) => handleMaximizeAction(id)"
      @retry="(id) => handleMaximizeAction(id)"
      @defer="handleDefer"
      @delete="(id) => handleMaximizeAction(id, handleDelete)"
      @follow-up="(id) => handleMaximizeAction(id)" />
  </div>
</template>
