import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn before importing pool
const mockProc = () => {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 12345;
  proc.kill = vi.fn();
  return proc;
};

let spawnedProc: ReturnType<typeof mockProc>;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    spawnedProc = mockProc();
    return spawnedProc;
  }),
}));

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
}));

import { AgentPool } from './pool.ts';
import type { AgentAdapter } from './agents/adapter.ts';
import type { AgentRegistry } from './agents/index.ts';
import type { Task, Project, HarnessConfig } from '../shared/types.ts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    type: 'do',
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
  } as Task;
}

function makeProject(): Project {
  return {
    id: 'proj-1',
    name: 'Test',
    repo_path: '/tmp/repo',
    target_branch: 'main',
  };
}

const fakeAdapter: AgentAdapter = {
  id: 'claude-code',
  executable: 'claude',
  buildArgs: () => ['--output-format', 'stream-json', '-p', 'test'],
  buildResumeArgs: () => ['--resume', 'sess-1', '-p', 'test'],
  parseMessage(line: string) {
    try {
      const msg = JSON.parse(line);
      const base = {
        sessionId: msg.session_id,
        summary: msg.result,
        costUsd: msg.cost_usd,
        toolName: msg.tool,
        content: msg.content,
        raw: msg,
      };
      if (
        msg.type === 'user' &&
        typeof msg.tool_use_result === 'string' &&
        msg.tool_use_result.includes('requires approval')
      ) {
        return { ...base, type: 'permission_request' as const };
      }
      return {
        ...base,
        type: (msg.type === 'result' ? 'result' : 'progress') as 'result' | 'progress',
      };
    } catch {
      return null;
    }
  },
};

const fakeRegistry: AgentRegistry = {
  register: vi.fn(),
  getOrDefault: () => fakeAdapter,
} as any;

describe('AgentPool progress broadcasting', () => {
  let broadcast: ReturnType<typeof vi.fn>;
  let pool: AgentPool;

  beforeEach(() => {
    broadcast = vi.fn();

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any;

    pool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask: vi.fn(() => makeTask()),
      createTaskEvent: vi.fn(),
      broadcast,
      getTaskById: () => makeTask(),
      onTaskCompleted: vi.fn(),
    });
  });

  it('broadcasts task:progress events when stdout emits JSON lines', async () => {
    const task = makeTask();
    const project = makeProject();

    // This triggers spawnAgent internally
    await pool.dispatchDoTask(task, project);

    // Simulate Claude Code stdout output
    const assistantMsg = { type: 'assistant', content: [{ type: 'text', text: 'Hello' }], session_id: 'sess-1' };
    const toolUseMsg = { type: 'tool_use', tool: 'Read', content: { file_path: '/src/index.ts' } };

    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(assistantMsg) + '\n'));
    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(toolUseMsg) + '\n'));

    // Verify broadcasts were made
    expect(broadcast).toHaveBeenCalledWith('task:progress', {
      task_id: 'task-1',
      message: assistantMsg,
    });
    expect(broadcast).toHaveBeenCalledWith('task:progress', {
      task_id: 'task-1',
      message: toolUseMsg,
    });
  });

  it('buffers progress messages for late-joining clients', async () => {
    const task = makeTask();
    const project = makeProject();

    await pool.dispatchDoTask(task, project);

    const msg1 = { type: 'assistant', content: 'hello', session_id: 'sess-1' };
    const msg2 = { type: 'tool_use', tool: 'Read' };

    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(msg1) + '\n'));
    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(msg2) + '\n'));

    const buffer = pool.getProgressBuffer('task-1');
    expect(buffer).toHaveLength(2);
    expect(buffer[0]).toEqual(msg1);
    expect(buffer[1]).toEqual(msg2);
  });

  it('handles multi-line chunks and incomplete lines', async () => {
    const task = makeTask();
    const project = makeProject();

    await pool.dispatchDoTask(task, project);

    const msg1 = { type: 'assistant', content: 'first' };
    const msg2 = { type: 'tool_use', tool: 'Read' };

    // Send two messages in one chunk
    spawnedProc.stdout.emit('data', Buffer.from(
      JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n'
    ));

    expect(broadcast).toHaveBeenCalledTimes(2);

    // Send an incomplete line, then complete it
    broadcast.mockClear();
    const msg3 = { type: 'tool_result', content: 'data' };
    const full = JSON.stringify(msg3);
    spawnedProc.stdout.emit('data', Buffer.from(full.slice(0, 10)));
    expect(broadcast).not.toHaveBeenCalled();

    spawnedProc.stdout.emit('data', Buffer.from(full.slice(10) + '\n'));
    expect(broadcast).toHaveBeenCalledWith('task:progress', {
      task_id: 'task-1',
      message: msg3,
    });
  });

  it('skips non-JSON lines without crashing', async () => {
    const task = makeTask();
    const project = makeProject();

    await pool.dispatchDoTask(task, project);

    spawnedProc.stdout.emit('data', Buffer.from('not valid json\n'));
    spawnedProc.stdout.emit('data', Buffer.from('\n'));

    const validMsg = { type: 'assistant', content: 'hello' };
    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(validMsg) + '\n'));

    // Only the valid message should have been broadcast
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('task:progress', {
      task_id: 'task-1',
      message: validMsg,
    });
  });

  it('reuses existing worktree for revised tasks instead of creating a new one', async () => {
    const git = await import('./git.ts');
    const mockCreateWorktree = git.createWorktree as ReturnType<typeof vi.fn>;
    const mockMakeBranchName = git.makeBranchName as ReturnType<typeof vi.fn>;
    mockCreateWorktree.mockClear();
    mockMakeBranchName.mockClear();

    const task = makeTask({
      worktree_path: '/existing/wt',
      branch_name: 'harness/original-branch',
      agent_session_data: '{"session_id":"sess-1","pid":123}',
    });
    const project = makeProject();

    await pool.dispatchDoTask(task, project);

    // Should NOT create a new worktree or compute a new branch name
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockMakeBranchName).not.toHaveBeenCalled();

    // Should NOT overwrite worktree_path/branch_name on the task
    const updateTask = pool['deps'].updateTask as ReturnType<typeof vi.fn>;
    for (const call of updateTask.mock.calls) {
      const updates = call[1];
      expect(updates).not.toHaveProperty('worktree_path');
      expect(updates).not.toHaveProperty('branch_name');
    }
  });

  it('creates a new worktree for fresh tasks without existing worktree', async () => {
    const git = await import('./git.ts');
    const mockCreateWorktree = git.createWorktree as ReturnType<typeof vi.fn>;
    mockCreateWorktree.mockClear();

    const task = makeTask({
      worktree_path: null,
      branch_name: null,
    });
    const project = makeProject();

    await pool.dispatchDoTask(task, project);

    // Should create a new worktree
    expect(mockCreateWorktree).toHaveBeenCalled();

    // Should update task with worktree info
    const updateTask = pool['deps'].updateTask as ReturnType<typeof vi.fn>;
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      worktree_path: '/tmp/wt',
      branch_name: 'branch-test',
    });
  });

  it('kills agent and moves task to permission status on permission_request', async () => {
    const updateTask = vi.fn(() => makeTask({ status: 'permission' as any }));
    const createTaskEvent = vi.fn();
    const onTaskCompleted = vi.fn();

    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any;

    const permPool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent,
      broadcast,
      getTaskById: () => makeTask({ status: 'permission' as any }),
      onTaskCompleted,
    });

    const task = makeTask();
    const project = makeProject();
    await permPool.dispatchDoTask(task, project);

    // Clear setup calls
    updateTask.mockClear();
    createTaskEvent.mockClear();
    broadcast.mockClear();

    // First, emit an assistant message with a tool_use block (to track tool name)
    const toolUseMsg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_01VEtj6LusjYDzCWYq7CnALj',
          name: 'Bash',
          input: { command: 'curl example.com' },
        }],
      },
      session_id: 'sess-1',
    };
    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(toolUseMsg) + '\n'));

    // Then emit the permission_request event (real CLI format)
    const permMsg = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: 'This command requires approval',
          is_error: true,
          tool_use_id: 'toolu_01VEtj6LusjYDzCWYq7CnALj',
        }],
      },
      tool_use_result: 'Error: This command requires approval',
      session_id: 'sess-1',
    };

    // Clear again after the tool_use progress broadcast
    updateTask.mockClear();
    createTaskEvent.mockClear();
    broadcast.mockClear();

    spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(permMsg) + '\n'));

    // Should have killed the agent
    expect(spawnedProc.kill).toHaveBeenCalledWith('SIGTERM');

    // Should have updated status to permission with tool name, command, and pending_tool_input
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      status: 'permission',
      error_message: 'Tool requiring permission: Bash — curl example.com',
      agent_session_data: expect.stringContaining('"pending_tool":"Bash"'),
    });
    // Verify pending_tool_input is stored in session data
    const sessionArg = JSON.parse(updateTask.mock.calls[0][1].agent_session_data);
    expect(sessionArg.pending_tool_input).toEqual({ command: 'curl example.com' });

    // Should have created a task event with the tool name
    expect(createTaskEvent).toHaveBeenCalledWith(
      'task-1',
      'permission_requested',
      JSON.stringify({ tool: 'Bash' }),
    );

    // Should have broadcast to inbox
    expect(broadcast).toHaveBeenCalledWith('inbox:new', expect.anything());

    // Should have freed the slot
    expect(onTaskCompleted).toHaveBeenCalledWith('task-1');

    // Should NOT have broadcast as task:progress
    expect(broadcast).not.toHaveBeenCalledWith('task:progress', expect.anything());
  });

  it('preserves granted_tools in session data across spawn cycles', async () => {
    const taskWithGrants = makeTask({
      agent_session_data: JSON.stringify({
        session_id: 'sess-1',
        pid: 111,
        granted_tools: ['Bash(curl:*)', 'WebSearch'],
      }),
      worktree_path: '/existing/wt',
      branch_name: 'harness/test-branch',
    });

    const updateTask = vi.fn(() => taskWithGrants);
    const config: HarnessConfig = {
      projects: [],
      task_types: {
        do: { prompt_template: '{user_prompt}', uses_worktree: true },
      },
      concurrency: { max_worktrees: 2, max_conversations: 2 },
    } as any;

    const preservePool = new AgentPool({
      config,
      agentRegistry: fakeRegistry,
      getProjectById: () => makeProject(),
      updateTask,
      createTaskEvent: vi.fn(),
      broadcast,
      getTaskById: () => taskWithGrants,
      onTaskCompleted: vi.fn(),
    });

    await preservePool.dispatchDoTask(taskWithGrants, makeProject());

    // The PID update should preserve granted_tools
    const pidUpdateCall = updateTask.mock.calls.find(
      (call: any) => call[1].agent_session_data && call[1].agent_session_data.includes('granted_tools'),
    );
    expect(pidUpdateCall).toBeTruthy();
    const sessionData = JSON.parse(pidUpdateCall![1].agent_session_data);
    expect(sessionData.granted_tools).toEqual(['Bash(curl:*)', 'WebSearch']);
    expect(sessionData.session_id).toBe('sess-1');
  });
});
