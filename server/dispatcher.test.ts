import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dispatcher } from './dispatcher.ts';
import type { Task, HarnessConfig, Project } from '../shared/types.ts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    type: 'do',
    status: 'queued',
    prompt: 'test',
    priority: 'P2',
    depends_on: null,
    agent_type: 'claude-code',
    agent_session_data: null,
    worktree_path: null,
    branch_name: null,
    diff_summary: null,
    agent_summary: null,
    error_message: null,
    retry_count: 0,
    queue_position: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'test',
    repo_path: '/tmp/test-repo',
    target_branch: 'main',
    worktree_limit: 3,
    conversation_limit: 5,
    created_at: 1000,
    ...overrides,
  };
}

const config: HarnessConfig = {
  worktree_limit: 3,
  conversation_limit: 5,
  task_types: {
    do: { prompt_template: '...', needs_worktree: true, default_priority: 'P2' },
    discuss: { prompt_template: '...', needs_worktree: false, default_priority: 'P2' },
  },
  projects: [],
};

function makeDeps() {
  const pool = {
    activeWorktreeCount: 0,
    activeConversationCount: 0,
    dispatchDoTask: vi.fn().mockImplementation(async () => { pool.activeWorktreeCount++; }),
    dispatchDiscussTask: vi.fn().mockImplementation(async () => { pool.activeConversationCount++; }),
  };

  return {
    config,
    pool: pool as any,
    getProjectById: vi.fn<(id: string) => Project | undefined>().mockReturnValue(makeProject()),
    getTaskById: vi.fn<(id: string) => Task | undefined>(),
    getQueuedTasks: vi.fn<(projectId?: string) => Task[]>().mockReturnValue([]),
    getTasksByStatus: vi.fn().mockReturnValue([]),
    updateTask: vi.fn().mockImplementation((id: string, updates: Record<string, unknown>) => makeTask({ id, ...updates } as any)),
    createTaskEvent: vi.fn(),
    broadcast: vi.fn(),
    isDependencySatisfied: vi.fn().mockReturnValue(true),
  };
}

describe('Dispatcher', () => {
  let deps: ReturnType<typeof makeDeps>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    deps = makeDeps();
    dispatcher = new Dispatcher(deps);
  });

  it('dispatches a queued Do task when worktree slot is available', async () => {
    const task = makeTask({ type: 'do' });
    deps.getQueuedTasks.mockReturnValue([task]);
    deps.getTaskById.mockReturnValue(task);

    await dispatcher.tryDispatch();

    expect(deps.pool.dispatchDoTask).toHaveBeenCalled();
    expect(deps.updateTask).toHaveBeenCalledWith(task.id, { status: 'in_progress' });
    expect(deps.createTaskEvent).toHaveBeenCalledWith(task.id, 'dispatched', null);
  });

  it('dispatches a queued Discuss task when conversation slot is available', async () => {
    const task = makeTask({ type: 'discuss' });
    deps.getQueuedTasks.mockReturnValue([task]);
    deps.getTaskById.mockReturnValue(task);

    await dispatcher.tryDispatch();

    expect(deps.pool.dispatchDiscussTask).toHaveBeenCalled();
  });

  it('does not dispatch Do tasks when worktree limit reached', async () => {
    deps.pool.activeWorktreeCount = 3;
    const task = makeTask({ type: 'do' });
    deps.getQueuedTasks.mockReturnValue([task]);

    await dispatcher.tryDispatch();

    expect(deps.pool.dispatchDoTask).not.toHaveBeenCalled();
  });

  it('does not dispatch Discuss tasks when conversation limit reached', async () => {
    deps.pool.activeConversationCount = 5;
    const task = makeTask({ type: 'discuss' });
    deps.getQueuedTasks.mockReturnValue([task]);

    await dispatcher.tryDispatch();

    expect(deps.pool.dispatchDiscussTask).not.toHaveBeenCalled();
  });

  it('skips tasks with unsatisfied dependencies', async () => {
    const task = makeTask({ depends_on: 'dep-1' });
    deps.getQueuedTasks.mockReturnValue([task]);
    deps.isDependencySatisfied.mockReturnValue(false);

    await dispatcher.tryDispatch();

    expect(deps.pool.dispatchDoTask).not.toHaveBeenCalled();
  });

  it('marks task as error when dispatch fails', async () => {
    const task = makeTask();
    deps.getQueuedTasks.mockReturnValueOnce([task]);
    deps.getTaskById.mockReturnValue(task);
    deps.pool.dispatchDoTask.mockRejectedValueOnce(new Error('spawn failed'));

    await dispatcher.tryDispatch();

    expect(deps.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('marks task as error when project not found', async () => {
    const task = makeTask();
    deps.getQueuedTasks.mockReturnValueOnce([task]);
    deps.getProjectById.mockReturnValue(undefined);

    await dispatcher.tryDispatch();

    expect(deps.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: 'error', error_message: 'Project not found' }),
    );
  });
});
