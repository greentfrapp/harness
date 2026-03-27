import type { SSEEventType, Task } from '../shared/types'
import { comparePriority } from '../shared/types'

interface TaskQueueDeps {
  getTaskById: (id: string) => Task | undefined
  getQueuedTasks: (projectId?: string) => Task[]
  updateTask: (id: string, updates: Record<string, unknown>) => Task | undefined
  createTaskEvent: (
    taskId: string,
    eventType: string,
    data: string | null,
  ) => void
  broadcast: (event: SSEEventType, data: unknown) => void
}

export class TaskQueue {
  constructor(private deps: TaskQueueDeps) {}

  isDependencySatisfied(task: Task): boolean {
    if (!task.depends_on) return true
    const dep = this.deps.getTaskById(task.depends_on)
    // v2: dependencies are satisfied when task is done:accepted
    return dep?.status === 'done' && dep?.substatus === 'accepted'
  }

  getNextReady(projectId?: string): Task | null {
    const queued = this.deps.getQueuedTasks(projectId)
    const ready = queued.filter((t) => this.isDependencySatisfied(t))
    ready.sort(comparePriority)
    return ready[0] ?? null
  }

  recomputePositions(projectId: string): void {
    const queued = this.deps.getQueuedTasks(projectId)
    queued.sort(comparePriority)

    const ready: Task[] = []
    const blocked: Task[] = []
    for (const task of queued) {
      if (this.isDependencySatisfied(task)) {
        ready.push(task)
      } else {
        blocked.push(task)
      }
    }

    const ordered = [...ready, ...blocked]
    for (let i = 0; i < ordered.length; i++) {
      this.deps.updateTask(ordered[i].id, { queue_position: i + 1 })
    }
  }

  dispatch(taskId: string): Task | undefined {
    const task = this.deps.getTaskById(taskId)
    if (!task || task.status !== 'queued') return undefined

    const updated = this.deps.updateTask(taskId, {
      status: 'in_progress',
      substatus: 'running',
    })
    this.deps.createTaskEvent(taskId, 'dispatched', null)
    this.deps.broadcast('task:updated', updated)
    return updated
  }
}
