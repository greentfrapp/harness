import type { Task, Priority, SSEEventType } from '../shared/types.ts';

const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 0,
  normal: 1,
  low: 2,
};

interface TaskQueueDeps {
  getTaskById: (id: string) => Task | undefined;
  getQueuedTasks: (projectId?: string) => Task[];
  updateTask: (id: string, updates: Record<string, unknown>) => Task | undefined;
  createTaskEvent: (taskId: string, eventType: string, data: string | null) => void;
  broadcast: (event: SSEEventType, data: unknown) => void;
}

export class TaskQueue {
  constructor(private deps: TaskQueueDeps) {}

  isDependencySatisfied(task: Task): boolean {
    if (!task.depends_on) return true;
    const dep = this.deps.getTaskById(task.depends_on);
    return dep?.status === 'approved';
  }

  getNextReady(projectId?: string): Task | null {
    const queued = this.deps.getQueuedTasks(projectId);
    const ready = queued.filter((t) => this.isDependencySatisfied(t));
    ready.sort(comparePriority);
    return ready[0] ?? null;
  }

  recomputePositions(projectId: string): void {
    const queued = this.deps.getQueuedTasks(projectId);
    queued.sort(comparePriority);

    const ready: Task[] = [];
    const blocked: Task[] = [];
    for (const task of queued) {
      if (this.isDependencySatisfied(task)) {
        ready.push(task);
      } else {
        blocked.push(task);
      }
    }

    const ordered = [...ready, ...blocked];
    for (let i = 0; i < ordered.length; i++) {
      this.deps.updateTask(ordered[i].id, { queue_position: i + 1 });
    }
  }

  dispatch(taskId: string): Task | undefined {
    const task = this.deps.getTaskById(taskId);
    if (!task || task.status !== 'queued') return undefined;

    const updated = this.deps.updateTask(taskId, { status: 'in_progress' });
    this.deps.createTaskEvent(taskId, 'dispatched', null);
    this.deps.broadcast('task:updated', updated);
    return updated;
  }
}

function comparePriority(a: Task, b: Task): number {
  const pa = PRIORITY_ORDER[a.priority as Priority] ?? 1;
  const pb = PRIORITY_ORDER[b.priority as Priority] ?? 1;
  if (pa !== pb) return pa - pb;
  return a.created_at - b.created_at;
}
