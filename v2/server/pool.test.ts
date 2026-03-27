import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessConfig, Project, Task } from '../shared/types'
import {
  AgentPool,
  getSessionData,
  parseSessionData,
  updateSessionData,
} from './pool'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    type: 'do',
    status: 'in_progress',
    substatus: 'running',
    title: null,
    prompt: 'test',
    result: null,
    priority: 'P2',
    tags: [],
    depends_on: null,
    parent_task_id: null,
    references: [],
    agent_type: 'claude-code',
    agent_session_data: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    retry_count: 0,
    queue_position: null,
    created_at: 1000,
    updated_at: 1000,
    started_at: null,
    completed_at: null,
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
    auto_push: false,
    created_at: 1000,
  }
}

const config: HarnessConfig = {
  worktree_limit: 3,
  conversation_limit: 5,
  task_types: {
    do: {
      prompt_template: '{user_prompt}',
      needs_worktree: true,
      default_priority: 'P2',
    },
    discuss: {
      prompt_template: '{user_prompt}',
      needs_worktree: false,
      default_priority: 'P2',
    },
  },
  tags: {},
  projects: [],
}

describe('Session data helpers', () => {
  describe('parseSessionData', () => {
    it('returns null for null input', () => {
      expect(parseSessionData(null)).toBeNull()
    })

    it('returns null for invalid JSON', () => {
      expect(parseSessionData('not json')).toBeNull()
    })

    it('parses valid session data', () => {
      const data = { session_id: 'abc', pid: 123 }
      expect(parseSessionData(JSON.stringify(data))).toEqual(data)
    })
  })

  describe('getSessionData', () => {
    it('returns null for task with no session data', () => {
      expect(getSessionData({ agent_session_data: null })).toBeNull()
    })

    it('parses session data from task', () => {
      const data = { session_id: 'abc', pid: 123 }
      expect(
        getSessionData({ agent_session_data: JSON.stringify(data) }),
      ).toEqual(data)
    })
  })

  describe('updateSessionData', () => {
    it('creates new session data when raw is null', () => {
      const result = updateSessionData(null, { session_id: 'abc', pid: 123 })
      expect(JSON.parse(result)).toEqual({ session_id: 'abc', pid: 123 })
    })

    it('merges updates into existing data', () => {
      const existing = JSON.stringify({
        session_id: 'abc',
        pid: 100,
        granted_tools: ['Read'],
      })
      const result = updateSessionData(existing, { pid: 200 })
      expect(JSON.parse(result)).toEqual({
        session_id: 'abc',
        pid: 200,
        granted_tools: ['Read'],
      })
    })
  })
})

describe('AgentPool', () => {
  it('tracks worktree and conversation counts', () => {
    // AgentPool requires deps but counts are based on internal agent maps
    // which are populated by spawnAgent. Testing just the getters with empty maps.
    const pool = new AgentPool({
      config,
      agentRegistry: { getOrDefault: vi.fn() } as any,
      getProjectById: vi.fn(),
      updateTask: vi.fn(),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: vi.fn(),
      getSubtaskProposals: vi.fn().mockReturnValue([]),
      onTaskCompleted: vi.fn(),
    })

    expect(pool.activeWorktreeCount).toBe(0)
    expect(pool.activeConversationCount).toBe(0)
  })

  it('returns empty progress buffer for unknown task', () => {
    const pool = new AgentPool({
      config,
      agentRegistry: { getOrDefault: vi.fn() } as any,
      getProjectById: vi.fn(),
      updateTask: vi.fn(),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: vi.fn(),
      getSubtaskProposals: vi.fn().mockReturnValue([]),
      onTaskCompleted: vi.fn(),
    })

    expect(pool.getProgressBuffer('unknown')).toEqual([])
  })

  it('hasAgent returns false for unknown task', () => {
    const pool = new AgentPool({
      config,
      agentRegistry: { getOrDefault: vi.fn() } as any,
      getProjectById: vi.fn(),
      updateTask: vi.fn(),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: vi.fn(),
      getSubtaskProposals: vi.fn().mockReturnValue([]),
      onTaskCompleted: vi.fn(),
    })

    expect(pool.hasAgent('unknown')).toBe(false)
    expect(pool.hasChatAgent('unknown')).toBe(false)
  })

  it('killAgent returns false for unknown task', () => {
    const pool = new AgentPool({
      config,
      agentRegistry: { getOrDefault: vi.fn() } as any,
      getProjectById: vi.fn(),
      updateTask: vi.fn(),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: vi.fn(),
      getSubtaskProposals: vi.fn().mockReturnValue([]),
      onTaskCompleted: vi.fn(),
    })

    expect(pool.killAgent('unknown')).toBe(false)
    expect(pool.killChatAgent('unknown')).toBe(false)
  })
})
