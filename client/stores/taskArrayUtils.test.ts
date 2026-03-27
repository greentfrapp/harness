import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { Task, TaskStatus } from '@shared/types'
import { upsertOrRemove } from '../src/stores/taskArrayUtils'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    project_id: 'proj-1',
    type: 'do',
    status: 'queued',
    title: null,
    prompt: 'test',
    original_prompt: null,
    priority: 'P2',
    tags: [],
    depends_on: null,
    parent_task_id: null,
    agent_type: 'claude-code',
    agent_session_data: null,
    worktree_path: null,
    branch_name: null,
    diff_summary: null,
    diff_full: null,
    agent_summary: null,
    error_message: null,
    retry_count: 0,
    queue_position: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  }
}

const VALID: readonly TaskStatus[] = ['queued', 'in_progress']

describe('upsertOrRemove', () => {
  it('inserts a new task when status is valid', () => {
    const arr = ref<Task[]>([])
    const task = makeTask({ status: 'queued' })
    upsertOrRemove(arr, task, VALID)
    expect(arr.value).toHaveLength(1)
    expect(arr.value[0].id).toBe(task.id)
  })

  it('updates an existing task when status is valid', () => {
    const task = makeTask({ status: 'queued', prompt: 'old' })
    const arr = ref<Task[]>([task])
    const updated = { ...task, prompt: 'new', status: 'in_progress' as const }
    upsertOrRemove(arr, updated, VALID)
    expect(arr.value).toHaveLength(1)
    expect(arr.value[0].prompt).toBe('new')
    expect(arr.value[0].status).toBe('in_progress')
  })

  it('removes a task when status becomes invalid', () => {
    const task = makeTask({ status: 'queued' })
    const arr = ref<Task[]>([task])
    const updated = { ...task, status: 'ready' as const }
    upsertOrRemove(arr, updated, VALID)
    expect(arr.value).toHaveLength(0)
  })

  it('does nothing when removing a task that does not exist', () => {
    const existing = makeTask({ status: 'queued' })
    const arr = ref<Task[]>([existing])
    const other = makeTask({ status: 'ready' })
    upsertOrRemove(arr, other, VALID)
    expect(arr.value).toHaveLength(1)
    expect(arr.value[0].id).toBe(existing.id)
  })
})
