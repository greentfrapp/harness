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
      return {
        type: msg.type === 'result' ? 'result' : 'progress',
        sessionId: msg.session_id,
        summary: msg.result,
        costUsd: msg.cost_usd,
        toolName: msg.tool,
        content: msg.content,
        raw: msg,
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
});
