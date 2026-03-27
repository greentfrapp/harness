import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Task } from '../shared/types'
import { recoverStaleTasks } from './recovery'

// Mock git module
vi.mock('./git.ts', () => ({
  hasCommits: vi.fn().mockReturnValue(false),
  getDiffStats: vi.fn().mockReturnValue('1 file changed'),
  removeWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  listWorktrees: vi.fn().mockReturnValue([]),
}))

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    type: 'do',
    status: 'in_progress',
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
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  }
}

function makeProject(): Project {
  return {
    id: 'proj-1',
    name: 'test',
    repo_path: '/tmp/test',
    target_branch: 'main',
    worktree_limit: 3,
    conversation_limit: 5,
    created_at: 1000,
  }
}

function makeDeps() {
  return {
    getTasksByStatus: vi.fn().mockReturnValue([]),
    getProjectById: vi.fn().mockReturnValue(makeProject()),
    updateTask: vi.fn(),
    createTaskEvent: vi.fn(),
    getAllProjects: vi.fn().mockReturnValue([makeProject()]),
  }
}

describe('recoverStaleTasks', () => {
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    deps = makeDeps()
    vi.clearAllMocks()
  })

  it('returns 0 when no stale tasks', () => {
    deps.getTasksByStatus.mockReturnValue([])
    expect(recoverStaleTasks(deps)).toBe(0)
  })

  it('re-queues discuss tasks (no worktree)', () => {
    const task = makeTask({
      type: 'discuss',
      worktree_path: null,
      branch_name: null,
    })
    deps.getTasksByStatus.mockReturnValue([task])

    const count = recoverStaleTasks(deps)

    expect(count).toBe(1)
    expect(deps.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: 'queued' }),
    )
    expect(deps.createTaskEvent).toHaveBeenCalledWith(
      task.id,
      'recovered',
      expect.stringContaining('requeued'),
    )
  })

  it('tries to kill orphaned process via stored PID', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const task = makeTask({
      agent_session_data: JSON.stringify({ session_id: 'abc', pid: 99999 }),
    })
    deps.getTasksByStatus.mockReturnValue([task])

    recoverStaleTasks(deps)

    expect(killSpy).toHaveBeenCalledWith(99999, 'SIGTERM')
    killSpy.mockRestore()
  })

  it('handles missing project gracefully', () => {
    const task = makeTask()
    deps.getTasksByStatus.mockReturnValue([task])
    deps.getProjectById.mockReturnValue(undefined)

    recoverStaleTasks(deps)

    expect(deps.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: 'error' }),
    )
  })
})
