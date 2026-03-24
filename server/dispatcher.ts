import type { Task, Project, HarnessConfig, SSEEventType } from '../shared/types.ts';

interface AgentPoolLike {
  activeWorktreeCount: number;
  activeConversationCount: number;
  dispatchDoTask: (task: Task, project: Project) => Promise<void>;
  dispatchDiscussTask: (task: Task, project: Project) => Promise<void>;
}

interface DispatcherDeps {
  config: HarnessConfig;
  pool: AgentPoolLike;
  getProjectById: (id: string) => Project | undefined;
  getTaskById: (id: string) => Task | undefined;
  getQueuedTasks: (projectId?: string) => Task[];
  getTasksByStatus: (statusList: string[]) => Task[];
  updateTask: (id: string, updates: Record<string, unknown>) => Task | undefined;
  createTaskEvent: (taskId: string, eventType: string, data: string | null) => void;
  broadcast: (event: SSEEventType, data: unknown) => void;
  isDependencySatisfied: (task: Task) => boolean;
}

/**
 * Dispatcher watches the queue and dispatches tasks to the agent pool
 * when slots are available. Called after task creation, completion,
 * approval, rejection, or cancellation.
 */
export class Dispatcher {
  private deps: DispatcherDeps;
  private dispatching = false;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
  }

  /** Check the queue and dispatch tasks if slots are available. */
  async tryDispatch(): Promise<void> {
    // Prevent concurrent dispatch runs
    if (this.dispatching) return;
    this.dispatching = true;

    try {
      await this.dispatchDoTasks();
      await this.dispatchDiscussTasks();
    } finally {
      this.dispatching = false;
    }
  }

  private async dispatchDoTasks(): Promise<void> {
    const { pool, config } = this.deps;
    const worktreeLimit = config.worktree_limit;

    while (pool.activeWorktreeCount < worktreeLimit) {
      const task = this.getNextReadyDoTask();
      if (!task) break;

      const project = this.deps.getProjectById(task.project_id);
      if (!project) {
        this.deps.updateTask(task.id, {
          status: 'error',
          error_message: 'Project not found',
        });
        continue;
      }

      // Mark as dispatched
      this.deps.updateTask(task.id, { status: 'in_progress' });
      this.deps.createTaskEvent(task.id, 'dispatched', null);
      const updated = this.deps.getTaskById(task.id);
      this.deps.broadcast('task:updated', updated);

      try {
        await pool.dispatchDoTask(
          this.deps.getTaskById(task.id)!,
          project,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.updateTask(task.id, {
          status: 'error',
          error_message: `Failed to dispatch: ${msg}`,
        });
        this.deps.createTaskEvent(task.id, 'error', JSON.stringify({ error: msg }));
        const errTask = this.deps.getTaskById(task.id);
        this.deps.broadcast('inbox:new', errTask);
      }
    }
  }

  private async dispatchDiscussTasks(): Promise<void> {
    const { pool, config } = this.deps;
    const conversationLimit = config.conversation_limit;

    while (pool.activeConversationCount < conversationLimit) {
      const task = this.getNextReadyDiscussTask();
      if (!task) break;

      const project = this.deps.getProjectById(task.project_id);
      if (!project) {
        this.deps.updateTask(task.id, {
          status: 'error',
          error_message: 'Project not found',
        });
        continue;
      }

      this.deps.updateTask(task.id, { status: 'in_progress' });
      this.deps.createTaskEvent(task.id, 'dispatched', null);
      const updated = this.deps.getTaskById(task.id);
      this.deps.broadcast('task:updated', updated);

      try {
        await pool.dispatchDiscussTask(
          this.deps.getTaskById(task.id)!,
          project,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.updateTask(task.id, {
          status: 'error',
          error_message: `Failed to dispatch: ${msg}`,
        });
        this.deps.createTaskEvent(task.id, 'error', JSON.stringify({ error: msg }));
        const errTask = this.deps.getTaskById(task.id);
        this.deps.broadcast('inbox:new', errTask);
      }
    }
  }

  private getNextReadyDoTask(): Task | null {
    const queued = this.deps.getQueuedTasks();
    const ready = queued.filter((t) => {
      const typeConfig = this.deps.config.task_types[t.type];
      const needsWorktree = typeConfig?.needs_worktree ?? (t.type === 'do');
      return needsWorktree && this.deps.isDependencySatisfied(t);
    });
    ready.sort(comparePriority);
    return ready[0] ?? null;
  }

  private getNextReadyDiscussTask(): Task | null {
    const queued = this.deps.getQueuedTasks();
    const ready = queued.filter((t) => {
      const typeConfig = this.deps.config.task_types[t.type];
      const needsWorktree = typeConfig?.needs_worktree ?? (t.type === 'do');
      return !needsWorktree && this.deps.isDependencySatisfied(t);
    });
    ready.sort(comparePriority);
    return ready[0] ?? null;
  }
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  normal: 1,
  low: 2,
};

function comparePriority(a: Task, b: Task): number {
  const pa = PRIORITY_ORDER[a.priority] ?? 1;
  const pb = PRIORITY_ORDER[b.priority] ?? 1;
  if (pa !== pb) return pa - pb;
  return a.created_at - b.created_at;
}
