import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessConfig, Project, Task } from '../shared/types'
import type { AgentAdapter } from './agents/adapter'
import type { AgentRegistry } from './agents/index'
import { AgentPool } from './pool'

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
    title: null,
    prompt: 'Fix the bug',
    status: 'in_progress',
    priority: 'P2',
    tags: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    agent_type: 'claude-code',
    worktree_path: null,
    branch_name: null,
    agent_summary: null,
    agent_session_data: null,
    depends_on: null,
    parent_task_id: null,
    diff_summary: null,
    error_message: null,
    retry_count: 0,
    queue_position: null,
    ...overrides,
  } as Task
}

function makeProject(): Project {
  return {
    id: 'proj-1',
    name: 'Test',
    repo_path: '/tmp/repo',
    target_branch: 'main',
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

describe('AgentPool progress broadcasting', () => {
  let broadcast: ReturnType<typeof vi.fn>
  let pool: AgentPool

  beforeEach(() => {
    broadcast = vi.fn()

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any

    pool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast,
      getTaskById: () => makeTask(),
      onTaskCompleted: vi.fn(),
    })
  })

  it('broadcasts task:progress events when stdout emits JSON lines', async () => {
    const task = makeTask()
    const project = makeProject()

    // This triggers spawnAgent internally
    await pool.dispatchDoTask(task, project)

    // Simulate Claude Code stdout output
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

    // Verify broadcasts were made
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

  it('reuses existing worktree for revised tasks instead of creating a new one', async () => {
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
    const project = makeProject()

    await pool.dispatchDoTask(task, project)

    // Should NOT create a new worktree or compute a new branch name
    expect(mockCreateWorktree).not.toHaveBeenCalled()
    expect(mockMakeBranchName).not.toHaveBeenCalled()

    // Should NOT overwrite worktree_path/branch_name on the task
    const updateTask = pool['deps'].updateTask as ReturnType<typeof vi.fn>
    for (const call of updateTask.mock.calls) {
      const updates = call[1]
      expect(updates).not.toHaveProperty('worktree_path')
      expect(updates).not.toHaveProperty('branch_name')
    }
  })

  it('creates a new worktree for fresh tasks without existing worktree', async () => {
    const git = await import('./git.ts')
    const mockCreateWorktree = git.createWorktree as ReturnType<typeof vi.fn>
    mockCreateWorktree.mockClear()

    const task = makeTask({
      worktree_path: null,
      branch_name: null,
    })
    const project = makeProject()

    await pool.dispatchDoTask(task, project)

    // Should create a new worktree
    expect(mockCreateWorktree).toHaveBeenCalled()

    // Should update task with worktree info
    const updateTask = pool['deps'].updateTask as ReturnType<typeof vi.fn>
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      worktree_path: '/tmp/wt',
      branch_name: 'branch-test',
    })
  })

  it('kills agent and moves task to permission status on permission_request', async () => {
    const updateTask = vi.fn(() => makeTask({ status: 'permission' as any }))
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any

    const permPool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast,
      getTaskById: () => makeTask({ status: 'in_progress' }),
      onTaskCompleted,
    })

    const task = makeTask()
    const project = makeProject()
    await permPool.dispatchDoTask(task, project)

    // Clear setup calls
    updateTask.mockClear()
    createTaskEvent.mockClear()
    broadcast.mockClear()

    // First, emit an assistant message with a tool_use block (to track tool name)
    const toolUseMsg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01VEtj6LusjYDzCWYq7CnALj',
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

    // Then emit the permission_request event (real CLI format)
    const permMsg = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: 'This command requires approval',
            is_error: true,
            tool_use_id: 'toolu_01VEtj6LusjYDzCWYq7CnALj',
          },
        ],
      },
      tool_use_result: 'Error: This command requires approval',
      session_id: 'sess-1',
    }

    // Clear again after the tool_use progress broadcast
    updateTask.mockClear()
    createTaskEvent.mockClear()
    broadcast.mockClear()

    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(permMsg) + '\n'))

    // Should have killed the agent
    expect(spawnedProc.kill).toHaveBeenCalledWith('SIGTERM')

    // Should have updated status to permission with tool name, command, and pending_tool_input
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      status: 'permission',
      error_message: 'Tool requiring permission: Bash — curl example.com',
      agent_session_data: expect.stringContaining('"pending_tool":"Bash"'),
    })
    // Verify pending_tool_input is stored in session data
    const sessionArg = JSON.parse(
      updateTask.mock.calls[0][1].agent_session_data,
    )
    expect(sessionArg.pending_tool_input).toEqual({
      command: 'curl example.com',
    })

    // Should have created a task event with the tool name
    expect(createTaskEvent).toHaveBeenCalledWith(
      'task-1',
      'permission_requested',
      JSON.stringify({ tool: 'Bash' }),
    )

    // Should have broadcast to inbox
    expect(broadcast).toHaveBeenCalledWith('inbox:new', expect.anything())

    // Should have freed the slot
    expect(onTaskCompleted).toHaveBeenCalledWith('task-1')

    // Should NOT have broadcast as task:progress
    expect(broadcast).not.toHaveBeenCalledWith(
      'task:progress',
      expect.anything(),
    )
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
    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any

    const preservePool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent: vi.fn(),
      broadcast,
      getTaskById: () => taskWithGrants,
      onTaskCompleted: vi.fn(),
    })

    await preservePool.dispatchDoTask(taskWithGrants, makeProject())

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

  it('flushes remaining buffer on close to capture result event without trailing newline', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any

    const flushPool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast,
      getTaskById: () => makeTask({ branch_name: 'harness/test-branch' }),
      onTaskCompleted,
    })

    const task = makeTask({ branch_name: 'harness/test-branch' })
    const project = makeProject()
    await flushPool.dispatchDoTask(task, project)

    // Emit a result event WITHOUT a trailing newline (stays in buffer)
    const resultMsg = {
      type: 'result',
      result: 'I updated the README with new docs.',
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(resultMsg)))

    // Clear setup calls
    updateTask.mockClear()

    // Close with success
    spawnedProc.emit('close', 0)

    // Should have stored the agent_summary from the flushed buffer
    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'ready',
        agent_summary: 'I updated the README with new docs.',
      }),
    )
  })

  it('intercepts ExitPlanMode tool use and moves task to held status', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any

    // Use a parser that detects ExitPlanMode (like the real ClaudeCodeAdapter)
    const planAdapter: AgentAdapter = {
      ...fakeAdapter,
      parseMessage(line: string) {
        try {
          const msg = JSON.parse(line)
          const base = { sessionId: msg.session_id, raw: msg }
          if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
                return {
                  ...base,
                  type: 'plan_approval_request' as const,
                  summary: block.input?.plan,
                }
              }
            }
          }
          return { ...base, type: 'progress' as const }
        } catch {
          return null
        }
      },
    }
    const planRegistry: AgentRegistry = {
      register: vi.fn(),
      getOrDefault: () => planAdapter,
    } as any

    const planPool = new AgentPool({
      config,
      agentRegistry: planRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast,
      getTaskById: () => makeTask({ status: 'in_progress' }),
      onTaskCompleted,
    })

    const task = makeTask()
    await planPool.dispatchDoTask(task, makeProject())

    updateTask.mockClear()
    createTaskEvent.mockClear()
    broadcast.mockClear()

    // Emit an ExitPlanMode tool use (as the real CLI does)
    const exitPlanMsg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'ExitPlanMode',
            input: { plan: 'Step 1: do X\nStep 2: do Y' },
          },
        ],
      },
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(exitPlanMsg) + '\n'),
    )

    // Should have killed the agent
    expect(spawnedProc.kill).toHaveBeenCalledWith('SIGTERM')

    // Should have set status to held with plan as summary
    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'held',
        agent_summary: 'Step 1: do X\nStep 2: do Y',
      }),
    )
    expect(createTaskEvent).toHaveBeenCalledWith(
      'task-1',
      'plan_completed',
      null,
    )
    expect(broadcast).toHaveBeenCalledWith('inbox:new', expect.anything())
    expect(onTaskCompleted).toHaveBeenCalledWith('task-1')
  })

  it('routes plan-approved do task to ready status on success', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: {
          prompt_template: '{user_prompt}',
          uses_worktree: true,
          permission_mode: 'plan',
        },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any

    const taskWithApproval = makeTask({
      branch_name: 'harness/test-branch',
      agent_session_data: JSON.stringify({
        session_id: 'sess-1',
        pid: 0,
        plan_approved: true,
      }),
    })

    const execPool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast,
      getTaskById: () => taskWithApproval,
      onTaskCompleted,
    })

    const task = makeTask({
      branch_name: 'harness/test-branch',
      worktree_path: '/existing/wt',
      agent_session_data: JSON.stringify({
        session_id: 'sess-1',
        pid: 0,
        plan_approved: true,
      }),
    })
    await execPool.dispatchDoTask(task, makeProject())

    const resultMsg = {
      type: 'result',
      result: 'Executed the plan successfully.',
      session_id: 'sess-1',
    }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(resultMsg) + '\n'),
    )

    updateTask.mockClear()
    createTaskEvent.mockClear()

    spawnedProc.emit('close', 0)

    // Should set status to 'ready' (execute phase complete)
    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'ready',
        agent_summary: 'Executed the plan successfully.',
      }),
    )
    expect(createTaskEvent).toHaveBeenCalledWith('task-1', 'completed', null)
  })

  it('overrides permission mode to undefined for plan-approved tasks', async () => {
    const { spawn } = await import('node:child_process')
    const _mockSpawn = spawn as ReturnType<typeof vi.fn>

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: {
          prompt_template: '{user_prompt}',
          uses_worktree: true,
          permission_mode: 'plan',
        },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any

    // Track what buildResumeArgs receives
    const buildResumeArgsSpy = vi.fn(() => ['--resume', 'sess-1', '-p', 'test'])
    const spyAdapter = { ...fakeAdapter, buildResumeArgs: buildResumeArgsSpy }
    const spyRegistry: AgentRegistry = {
      register: vi.fn(),
      getOrDefault: () => spyAdapter,
    } as any

    const overridePool = new AgentPool({
      config,
      agentRegistry: spyRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast,
      getTaskById: () => makeTask(),
      onTaskCompleted: vi.fn(),
    })

    const task = makeTask({
      worktree_path: '/existing/wt',
      branch_name: 'harness/test-branch',
      agent_session_data: JSON.stringify({
        session_id: 'sess-1',
        pid: 0,
        plan_approved: true,
      }),
    })
    await overridePool.dispatchDoTask(task, makeProject())

    // Should call buildResumeArgs with permissionMode undefined (not 'plan')
    expect(buildResumeArgsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: undefined,
      }),
    )
  })

  it('does not process success/failure when task is waiting_on_subtasks', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any

    const waitingPool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast,
      // Return waiting_on_subtasks status to simulate agent being killed after proposing subtasks
      getTaskById: () =>
        makeTask({ status: 'waiting_on_subtasks' as any }),
      onTaskCompleted,
    })

    const task = makeTask()
    const project = makeProject()
    await waitingPool.dispatchDoTask(task, project)

    // Clear setup calls
    updateTask.mockClear()
    createTaskEvent.mockClear()
    onTaskCompleted.mockClear()

    // Simulate process exit with code 0
    spawnedProc.emit('close', 0)

    // Should NOT have updated task status (early return)
    expect(updateTask).not.toHaveBeenCalled()
    expect(createTaskEvent).not.toHaveBeenCalled()
    expect(onTaskCompleted).not.toHaveBeenCalled()
  })

  it('injects HARNESS_TASK_ID, HARNESS_API_URL, and HARNESS_CLI env vars', async () => {
    const { spawn } = await import('node:child_process')
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    mockSpawn.mockClear()

    const task = makeTask()
    const project = makeProject()
    await pool.dispatchDoTask(task, project)

    expect(mockSpawn).toHaveBeenCalled()
    const spawnCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1]
    const spawnOpts = spawnCall[2]

    expect(spawnOpts.env.HARNESS_TASK_ID).toBe('task-1')
    expect(spawnOpts.env.HARNESS_API_URL).toMatch(/^http:\/\/localhost:\d+$/)
    expect(spawnOpts.env.HARNESS_CLI).toMatch(/cli\/harness\.mjs$/)
  })

  it('includes title in system prompt when task has both title and prompt', async () => {
    const spyAdapter: AgentAdapter = {
      ...fakeAdapter,
      buildArgs: vi.fn(() => ['--output-format', 'stream-json', '-p', 'test']),
    }
    const spyRegistry: AgentRegistry = {
      register: vi.fn(),
      getOrDefault: () => spyAdapter,
    } as any

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: {
          prompt_template: 'Task:\n{user_prompt}',
          needs_worktree: true,
          default_priority: 'P2',
        },
      },
      tags: {},
    } as any

    const titlePool = new AgentPool({
      config,
      agentRegistry: spyRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () => makeTask(),
      onTaskCompleted: vi.fn(),
    })

    const task = makeTask({ title: 'Fix auth bug', prompt: 'The login page returns 500' })
    await titlePool.dispatchDoTask(task, makeProject())

    expect(spyAdapter.buildArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Fix auth bug\n\nThe login page returns 500',
        systemPrompt: expect.stringContaining('Fix auth bug\n\nThe login page returns 500'),
      }),
    )
  })

  it('uses title alone as prompt when task has no prompt', async () => {
    const spyAdapter: AgentAdapter = {
      ...fakeAdapter,
      buildArgs: vi.fn(() => ['--output-format', 'stream-json', '-p', 'test']),
    }
    const spyRegistry: AgentRegistry = {
      register: vi.fn(),
      getOrDefault: () => spyAdapter,
    } as any

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: {
          prompt_template: 'Task:\n{user_prompt}',
          needs_worktree: true,
          default_priority: 'P2',
        },
      },
      tags: {},
    } as any

    const titlePool = new AgentPool({
      config,
      agentRegistry: spyRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () => makeTask(),
      onTaskCompleted: vi.fn(),
    })

    const task = makeTask({ title: 'Fix auth bug', prompt: null })
    await titlePool.dispatchDoTask(task, makeProject())

    expect(spyAdapter.buildArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Fix auth bug',
        systemPrompt: expect.stringContaining('Fix auth bug'),
      }),
    )
  })

  it('supports {title} placeholder in prompt template', async () => {
    const spyAdapter: AgentAdapter = {
      ...fakeAdapter,
      buildArgs: vi.fn(() => ['--output-format', 'stream-json', '-p', 'test']),
    }
    const spyRegistry: AgentRegistry = {
      register: vi.fn(),
      getOrDefault: () => spyAdapter,
    } as any

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: {
          prompt_template: '# {title}\n\n{user_prompt}',
          needs_worktree: true,
          default_priority: 'P2',
        },
      },
      tags: {},
    } as any

    const titlePool = new AgentPool({
      config,
      agentRegistry: spyRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast: vi.fn(),
      getTaskById: () => makeTask(),
      onTaskCompleted: vi.fn(),
    })

    const task = makeTask({ title: 'Fix auth bug', prompt: 'Details here' })
    await titlePool.dispatchDoTask(task, makeProject())

    expect(spyAdapter.buildArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('# Fix auth bug\n\nFix auth bug\n\nDetails here'),
      }),
    )
  })

  it('falls back to last assistant text when result has no summary', async () => {
    const updateTask = vi.fn(() => makeTask())
    const createTaskEvent = vi.fn()
    const onTaskCompleted = vi.fn()

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any

    const fallbackPool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast,
      getTaskById: () => makeTask({ branch_name: 'harness/test-branch' }),
      onTaskCompleted,
    })

    const task = makeTask({ branch_name: 'harness/test-branch' })
    const project = makeProject()
    await fallbackPool.dispatchDoTask(task, project)

    // Emit an assistant message with text
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

    // Result event without a result string (no summary)
    const resultMsg = { type: 'result', session_id: 'sess-1' }
    spawnedProc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(resultMsg) + '\n'),
    )

    updateTask.mockClear()
    spawnedProc.emit('close', 0)

    // Should fall back to the last assistant text
    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'ready',
        agent_summary: 'Done! I fixed the bug in server.ts.',
      }),
    )
  })
})
