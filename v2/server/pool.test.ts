import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessConfig, Project, Task } from '../shared/types'
import type { AgentAdapter } from './agents/adapter'
import type { AgentRegistry } from './agents/index'
import {
  AgentPool,
  getSessionData,
  parseSessionData,
  updateSessionData,
} from './pool'

// Mock child_process.spawn before importing pool
const mockProc = () => {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.pid = 12345
  proc.kill = vi.fn()
  return proc
}

let spawnedProc: ReturnType<typeof mockProc>

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    spawnedProc = mockProc()
    return spawnedProc
  }),
}))

// Mock git to avoid real filesystem operations
vi.mock('./git.ts', () => ({
  makeBranchName: vi.fn(() => 'branch-test'),
  worktreePath: vi.fn(() => '/tmp/wt'),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  getDiff: vi.fn(() => ''),
  getDiffStats: vi.fn(() => ''),
  hasCommits: vi.fn(() => false),
  mergeBranch: vi.fn(),
}))

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    type: 'do',
    status: 'in_progress',
    substatus: 'running',
    title: null,
    prompt: 'Fix the bug',
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
    created_at: Date.now(),
    updated_at: Date.now(),
    started_at: null,
    completed_at: null,
    ...overrides,
  }
}

function makeProject(): Project {
  return {
    id: 'proj-1',
    name: 'Test',
    repo_path: '/tmp/repo',
    target_branch: 'main',
    worktree_limit: 3,
    conversation_limit: 5,
    auto_push: false,
    created_at: 1000,
  }
}

const fakeAdapter: AgentAdapter = {
  id: 'claude-code',
  executable: 'claude',
  buildArgs: () => ['--output-format', 'stream-json', '-p', 'test'],
  buildResumeArgs: () => ['--resume', 'sess-1', '-p', 'test'],
  parseMessage(line: string) {
    try {
      const msg = JSON.parse(line)
      const base = {
        sessionId: msg.session_id,
        summary: msg.result,
        costUsd: msg.cost_usd,
        toolName: msg.tool,
        content: msg.content,
        raw: msg,
      }
      if (
        msg.type === 'user' &&
        typeof msg.tool_use_result === 'string' &&
        msg.tool_use_result.includes('requires approval')
      ) {
        return { ...base, type: 'permission_request' as const }
      }
      return {
        ...base,
        type: (msg.type === 'result' ? 'result' : 'progress') as
          | 'result'
          | 'progress',
      }
    } catch {
      return null
    }
  },
}

const fakeRegistry: AgentRegistry = {
  register: vi.fn(),
  getOrDefault: () => fakeAdapter,
} as any

const defaultConfig: HarnessConfig = {
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
    plan: {
      prompt_template: '{user_prompt}',
      needs_worktree: false,
      default_priority: 'P2',
    },
  },
  tags: {},
  projects: [],
}

// --- Session data helpers ---

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

// --- AgentPool progress broadcasting ---

describe('AgentPool progress broadcasting', () => {
  let broadcast: ReturnType<typeof vi.fn>
  let pool: AgentPool

  beforeEach(() => {
    broadcast = vi.fn()

    pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast,
      getTaskById: () => makeTask(),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted: vi.fn(),
    })
  })

  it('broadcasts task:progress events when stdout emits JSON lines', async () => {
    const task = makeTask()
    const project = makeProject()

    await pool.dispatchDoTask(task, project)

    const assistantMsg = {
      type: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      session_id: 'sess-1',
    }
    const toolUseMsg = {
      type: 'tool_use',
      tool: 'Read',
      content: { file_path: '/src/index.ts' },
    }

    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(assistantMsg) + '\n'),
    )
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(toolUseMsg) + '\n'),
    )

    expect(broadcast).toHaveBeenCalledWith('task:progress', {
      task_id: 'task-1',
      message: assistantMsg,
    })
    expect(broadcast).toHaveBeenCalledWith('task:progress', {
      task_id: 'task-1',
      message: toolUseMsg,
    })
  })

  it('buffers progress messages for late-joining clients', async () => {
    const task = makeTask()
    const project = makeProject()

    await pool.dispatchDoTask(task, project)

    const msg1 = { type: 'assistant', content: 'hello', session_id: 'sess-1' }
    const msg2 = { type: 'tool_use', tool: 'Read' }

    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(msg1) + '\n'))
    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(msg2) + '\n'))

    const buffer = pool.getProgressBuffer('task-1')
    expect(buffer).toHaveLength(2)
    expect(buffer[0]).toEqual(msg1)
    expect(buffer[1]).toEqual(msg2)
  })

  it('handles multi-line chunks and incomplete lines', async () => {
    const task = makeTask()
    const project = makeProject()

    await pool.dispatchDoTask(task, project)

    const msg1 = { type: 'assistant', content: 'first' }
    const msg2 = { type: 'tool_use', tool: 'Read' }

    // Send two messages in one chunk
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n'),
    )

    expect(broadcast).toHaveBeenCalledTimes(2)

    // Send an incomplete line, then complete it
    broadcast.mockClear()
    const msg3 = { type: 'tool_result', content: 'data' }
    const full = JSON.stringify(msg3)
    spawnedProc.stdout.emit('data', Buffer.from(full.slice(0, 10)))
    expect(broadcast).not.toHaveBeenCalled()

    spawnedProc.stdout.emit('data', Buffer.from(full.slice(10) + '\n'))
    expect(broadcast).toHaveBeenCalledWith('task:progress', {
      task_id: 'task-1',
      message: msg3,
    })
  })

  it('skips non-JSON lines without crashing', async () => {
    const task = makeTask()
    const project = makeProject()

    await pool.dispatchDoTask(task, project)

    spawnedProc.stdout.emit('data', Buffer.from('not valid json\n'))
    spawnedProc.stdout.emit('data', Buffer.from('\n'))

    const validMsg = { type: 'assistant', content: 'hello' }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(validMsg) + '\n'),
    )

    // Only the valid message should have been broadcast
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('task:progress', {
      task_id: 'task-1',
      message: validMsg,
    })
  })
})

// --- Worktree management ---

describe('AgentPool worktree management', () => {
  it('reuses existing worktree for revised tasks', async () => {
    const broadcast = vi.fn()
    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast,
      getTaskById: () => makeTask(),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted: vi.fn(),
    })

    const git = await import('./git.ts')
    const mockCreateWorktree = git.createWorktree as ReturnType<typeof vi.fn>
    const mockMakeBranchName = git.makeBranchName as ReturnType<typeof vi.fn>
    mockCreateWorktree.mockClear()
    mockMakeBranchName.mockClear()

    const task = makeTask({
      worktree_path: '/existing/wt',
      branch_name: 'harness/original-branch',
      agent_session_data: '{"session_id":"sess-1","pid":123}',
    })

    await pool.dispatchDoTask(task, makeProject())

    // Should NOT create a new worktree or compute a new branch name
    expect(mockCreateWorktree).not.toHaveBeenCalled()
    expect(mockMakeBranchName).not.toHaveBeenCalled()
  })

  it('creates a new worktree for fresh tasks', async () => {
    const updateTask = vi.fn(() => makeTask())
    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () => makeTask(),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted: vi.fn(),
    })

    const git = await import('./git.ts')
    const mockCreateWorktree = git.createWorktree as ReturnType<typeof vi.fn>
    mockCreateWorktree.mockClear()

    const task = makeTask({ worktree_path: null, branch_name: null })
    await pool.dispatchDoTask(task, makeProject())

    expect(mockCreateWorktree).toHaveBeenCalled()
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      worktree_path: '/tmp/wt',
      branch_name: 'branch-test',
    })
  })
})

// --- Task completion ---

describe('AgentPool task completion', () => {
  it('moves do task to pending:review on success', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()
    const broadcast = vi.fn()

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast,
      getTaskById: () =>
        makeTask({
          status: 'in_progress',
          substatus: 'running',
          branch_name: 'harness/test-branch',
        }),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted,
    })

    const task = makeTask({ branch_name: 'harness/test-branch' })
    await pool.dispatchDoTask(task, makeProject())

    const resultMsg = {
      type: 'result',
      result: 'Updated the README.',
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(resultMsg) + '\n'),
    )

    updateTask.mockClear()
    spawnedProc.emit('close', 0)

    // v2: do tasks → pending:review
    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'pending',
        substatus: 'review',
        result: expect.any(String),
        completed_at: expect.any(Number),
      }),
    )
    expect(createTaskEvent).toHaveBeenCalledWith('task-1', 'completed', null)
    expect(onTaskCompleted).toHaveBeenCalledWith('task-1')
  })

  it('moves discuss task to done:null on success', async () => {
    const updateTask = vi.fn(() => makeTask({ type: 'discuss' }))
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast: vi.fn(),
      getTaskById: () =>
        makeTask({
          type: 'discuss',
          status: 'in_progress',
          substatus: 'running',
        }),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted,
    })

    const task = makeTask({ type: 'discuss' })
    await pool.dispatchDiscussTask(task, makeProject())

    const resultMsg = {
      type: 'result',
      result: 'Analysis complete.',
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(resultMsg) + '\n'),
    )

    updateTask.mockClear()
    spawnedProc.emit('close', 0)

    // v2: discuss tasks → done:null
    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'done',
        substatus: null,
        completed_at: expect.any(Number),
      }),
    )
  })

  it('flushes remaining buffer on close to capture result without trailing newline', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast: vi.fn(),
      getTaskById: () =>
        makeTask({
          status: 'in_progress',
          substatus: 'running',
          branch_name: 'harness/test-branch',
        }),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted,
    })

    const task = makeTask({ branch_name: 'harness/test-branch' })
    await pool.dispatchDoTask(task, makeProject())

    // Emit result WITHOUT trailing newline (stays in buffer)
    const resultMsg = {
      type: 'result',
      result: 'Updated docs.',
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(resultMsg)))

    updateTask.mockClear()
    spawnedProc.emit('close', 0)

    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'pending',
        substatus: 'review',
        result: expect.stringContaining('Updated docs.'),
      }),
    )
  })

  it('falls back to last assistant text when result has no summary', async () => {
    const updateTask = vi.fn(() => makeTask())
    const onTaskCompleted = vi.fn()

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () =>
        makeTask({
          status: 'in_progress',
          substatus: 'running',
          branch_name: 'harness/test-branch',
        }),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted,
    })

    const task = makeTask({ branch_name: 'harness/test-branch' })
    await pool.dispatchDoTask(task, makeProject())

    // Assistant message with text
    const assistantMsg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Done! I fixed the bug in server.ts.' },
        ],
      },
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(assistantMsg) + '\n'),
    )

    // Result event without result string
    const resultMsg = { type: 'result', session_id: 'sess-1' }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(resultMsg) + '\n'),
    )

    updateTask.mockClear()
    spawnedProc.emit('close', 0)

    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        result: expect.stringContaining('Done! I fixed the bug in server.ts.'),
      }),
    )
  })
})

// --- Permission requests ---

describe('AgentPool permission handling', () => {
  it('kills agent and moves task to pending:permission on permission_request', async () => {
    const updateTask = vi.fn(() =>
      makeTask({ status: 'pending' as any, substatus: 'permission' as any }),
    )
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()
    const broadcast = vi.fn()

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast,
      getTaskById: () =>
        makeTask({ status: 'in_progress', substatus: 'running' }),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted,
    })

    const task = makeTask()
    await pool.dispatchDoTask(task, makeProject())

    // Clear setup calls
    updateTask.mockClear()
    createTaskEvent.mockClear()
    broadcast.mockClear()

    // Emit assistant message with tool_use (to track tool name)
    const toolUseMsg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Bash',
            input: { command: 'curl example.com' },
          },
        ],
      },
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(toolUseMsg) + '\n'),
    )

    // Clear progress broadcasts
    updateTask.mockClear()
    createTaskEvent.mockClear()
    broadcast.mockClear()

    // Emit permission_request
    const permMsg = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: 'This command requires approval',
            is_error: true,
            tool_use_id: 'toolu_01',
          },
        ],
      },
      tool_use_result: 'Error: This command requires approval',
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(permMsg) + '\n'),
    )

    // Should have killed the agent
    expect(spawnedProc.kill).toHaveBeenCalledWith('SIGTERM')

    // v2: should move to pending:permission with tool info in result
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      status: 'pending',
      substatus: 'permission',
      result: 'Tool requiring permission: Bash — curl example.com',
      agent_session_data: expect.stringContaining('"pending_tool":"Bash"'),
    })

    // Verify pending_tool_input is stored
    const sessionArg = JSON.parse(
      updateTask.mock.calls[0][1].agent_session_data,
    )
    expect(sessionArg.pending_tool_input).toEqual({
      command: 'curl example.com',
    })

    expect(createTaskEvent).toHaveBeenCalledWith(
      'task-1',
      'permission_requested',
      JSON.stringify({ tool: 'Bash' }),
    )
    expect(broadcast).toHaveBeenCalledWith('inbox:new', expect.anything())
    expect(onTaskCompleted).toHaveBeenCalledWith('task-1')
  })

  it('preserves granted_tools in session data across spawn cycles', async () => {
    const taskWithGrants = makeTask({
      agent_session_data: JSON.stringify({
        session_id: 'sess-1',
        pid: 111,
        granted_tools: ['Bash(curl:*)', 'WebSearch'],
      }),
      worktree_path: '/existing/wt',
      branch_name: 'harness/test-branch',
    })

    const updateTask = vi.fn(() => taskWithGrants)

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () => taskWithGrants,
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted: vi.fn(),
    })

    await pool.dispatchDoTask(taskWithGrants, makeProject())

    // The PID update should preserve granted_tools
    const pidUpdateCall = updateTask.mock.calls.find(
      (call: any) =>
        call[1].agent_session_data &&
        call[1].agent_session_data.includes('granted_tools'),
    )
    expect(pidUpdateCall).toBeTruthy()
    const sessionData = JSON.parse(pidUpdateCall![1].agent_session_data)
    expect(sessionData.granted_tools).toEqual(['Bash(curl:*)', 'WebSearch'])
    expect(sessionData.session_id).toBe('sess-1')
  })
})

// --- Early return on special statuses ---

describe('AgentPool early return on close', () => {
  it('does not process success/failure when task is waiting_on_subtasks', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast: vi.fn(),
      // Return waiting_on_subtasks status to simulate agent killed after proposing subtasks
      getTaskById: () =>
        makeTask({
          status: 'in_progress',
          substatus: 'waiting_on_subtasks',
        }),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted,
    })

    const task = makeTask()
    await pool.dispatchDoTask(task, makeProject())

    updateTask.mockClear()
    createTaskEvent.mockClear()
    onTaskCompleted.mockClear()

    spawnedProc.emit('close', 0)

    // Should NOT have updated task status (early return)
    expect(updateTask).not.toHaveBeenCalled()
    expect(createTaskEvent).not.toHaveBeenCalled()
    expect(onTaskCompleted).not.toHaveBeenCalled()
  })

  it('does not process success/failure when task is cancelled', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast: vi.fn(),
      getTaskById: () =>
        makeTask({ status: 'cancelled', substatus: null }),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted,
    })

    const task = makeTask()
    await pool.dispatchDoTask(task, makeProject())

    updateTask.mockClear()
    createTaskEvent.mockClear()
    onTaskCompleted.mockClear()

    spawnedProc.emit('close', 0)

    expect(updateTask).not.toHaveBeenCalled()
  })

  it('does not process success/failure when task is pending (permission/subtask_approval)', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast: vi.fn(),
      getTaskById: () =>
        makeTask({ status: 'pending', substatus: 'permission' }),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted,
    })

    const task = makeTask()
    await pool.dispatchDoTask(task, makeProject())

    updateTask.mockClear()
    createTaskEvent.mockClear()
    onTaskCompleted.mockClear()

    spawnedProc.emit('close', 0)

    expect(updateTask).not.toHaveBeenCalled()
  })
})

// --- Plan task subtask validation ---

describe('AgentPool plan task validation', () => {
  it('errors plan tasks that finish without proposing subtasks', async () => {
    const updateTask = vi.fn(() =>
      makeTask({ type: 'plan', status: 'in_progress', substatus: 'running' }),
    )
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()
    const getSubtaskProposals = vi.fn(() => [])

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast: vi.fn(),
      getTaskById: () =>
        makeTask({
          type: 'plan',
          status: 'in_progress',
          substatus: 'running',
        }),
      getSubtaskProposals,
      onTaskCompleted,
    })

    const task = makeTask({ type: 'plan' })
    await pool.dispatchDiscussTask(task, makeProject())

    const resultMsg = {
      type: 'result',
      result: 'Here is my analysis.',
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(resultMsg) + '\n'),
    )

    updateTask.mockClear()
    createTaskEvent.mockClear()

    spawnedProc.emit('close', 0)

    expect(getSubtaskProposals).toHaveBeenCalledWith('task-1')

    // v2: dispatch_error → pending:review (not error)
    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'pending',
        substatus: 'review',
        result: expect.stringContaining('without proposing any subtasks'),
      }),
    )
  })

  it('does not check proposals for non-plan tasks', async () => {
    const getSubtaskProposals = vi.fn(() => [])

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () =>
        makeTask({
          status: 'in_progress',
          substatus: 'running',
          branch_name: 'harness/test-branch',
        }),
      getSubtaskProposals,
      onTaskCompleted: vi.fn(),
    })

    const task = makeTask({ branch_name: 'harness/test-branch' })
    await pool.dispatchDoTask(task, makeProject())

    const resultMsg = {
      type: 'result',
      result: 'Done.',
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(resultMsg) + '\n'),
    )

    spawnedProc.emit('close', 0)

    expect(getSubtaskProposals).not.toHaveBeenCalled()
  })
})

// --- Environment and prompt ---

describe('AgentPool environment and prompts', () => {
  it('injects HARNESS_TASK_ID, HARNESS_API_URL, and HARNESS_CLI env vars', async () => {
    const { spawn } = await import('node:child_process')
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    mockSpawn.mockClear()

    const pool = new AgentPool({
      config: defaultConfig,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () => makeTask(),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted: vi.fn(),
    })

    const task = makeTask()
    await pool.dispatchDoTask(task, makeProject())

    expect(mockSpawn).toHaveBeenCalled()
    const spawnCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1]
    const spawnOpts = spawnCall[2]

    expect(spawnOpts.env.HARNESS_TASK_ID).toBe('task-1')
    expect(spawnOpts.env.HARNESS_API_URL).toMatch(/^http:\/\/localhost:\d+$/)
    expect(spawnOpts.env.HARNESS_CLI).toMatch(/cli\/harness\.mjs$/)
  })

  it('combines title and prompt for system prompt', async () => {
    const spyAdapter: AgentAdapter = {
      ...fakeAdapter,
      buildArgs: vi.fn(() => ['--output-format', 'stream-json', '-p', 'test']),
    }
    const spyRegistry: AgentRegistry = {
      register: vi.fn(),
      getOrDefault: () => spyAdapter,
    } as any

    const config: HarnessConfig = {
      ...defaultConfig,
      task_types: {
        do: {
          prompt_template: 'Task:\n{user_prompt}',
          needs_worktree: true,
          default_priority: 'P2',
        },
      },
    }

    const pool = new AgentPool({
      config,
      agentRegistry: spyRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () => makeTask(),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted: vi.fn(),
    })

    const task = makeTask({
      title: 'Fix auth bug',
      prompt: 'The login page returns 500',
    })
    await pool.dispatchDoTask(task, makeProject())

    expect(spyAdapter.buildArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Fix auth bug\n\nThe login page returns 500',
        systemPrompt: expect.stringContaining(
          'Fix auth bug\n\nThe login page returns 500',
        ),
      }),
    )
  })

  it('uses title alone when task has no prompt', async () => {
    const spyAdapter: AgentAdapter = {
      ...fakeAdapter,
      buildArgs: vi.fn(() => ['--output-format', 'stream-json', '-p', 'test']),
    }
    const spyRegistry: AgentRegistry = {
      register: vi.fn(),
      getOrDefault: () => spyAdapter,
    } as any

    const config: HarnessConfig = {
      ...defaultConfig,
      task_types: {
        do: {
          prompt_template: 'Task:\n{user_prompt}',
          needs_worktree: true,
          default_priority: 'P2',
        },
      },
    }

    const pool = new AgentPool({
      config,
      agentRegistry: spyRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () => makeTask(),
      getSubtaskProposals: vi.fn(() => []),
      onTaskCompleted: vi.fn(),
    })

    const task = makeTask({ title: 'Fix auth bug', prompt: null })
    await pool.dispatchDoTask(task, makeProject())

    expect(spyAdapter.buildArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Fix auth bug',
      }),
    )
  })
})
