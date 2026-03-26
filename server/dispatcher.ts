import type {
  HarnessConfig,
  Project,
  SSEEventType,
  Task,
} from '../shared/types'
import { comparePriority, getErrorMessage } from '../shared/types'

interface AgentPoolLike {
  activeWorktreeCount: number
  activeConversationCount: number
  dispatchDoTask: (task: Task, project: Project) => Promise<void>
  dispatchDiscussTask: (task: Task, project: Project) => Promise<void>
}

interface DispatcherDeps {
  config: HarnessConfig
  pool: AgentPoolLike
  getProjectById: (id: string) => Project | undefined
  getTaskById: (id: string) => Task | undefined
  getQueuedTasks: (projectId?: string) => Task[]
  getTasksByStatus: (statusList: string[]) => Task[]
  updateTask: (id: string, updates: Record<string, unknown>) => Task | undefined
  createTaskEvent: (
    taskId: string,
    eventType: string,
    data: string | null,
  ) => void
  broadcast: (event: SSEEventType, data: unknown) => void
  isDependencySatisfied: (task: Task) => boolean
}

/**
 * Dispatcher watches the queue and dispatches tasks to the agent pool
 * when slots are available. Called after task creation, completion,
 * approval, rejection, or cancellation.
 */
export class Dispatcher {
  private deps: DispatcherDeps
  private dispatching = false
  private pendingDispatch = false

  constructor(deps: DispatcherDeps) {
    this.deps = deps
  }

  /** Check the queue and dispatch tasks if slots are available. */
  async tryDispatch(): Promise<void> {
    // If already dispatching, flag a re-run so we don't miss queued tasks
    if (this.dispatching) {
      this.pendingDispatch = true
      return
    }
    this.dispatching = true

    const { pool, config } = this.deps

    try {
      do {
        this.pendingDispatch = false
        await this.dispatchTasks({
          needsWorktree: true,
          getLimit: () => config.worktree_limit,
          getActiveCount: () => pool.activeWorktreeCount,
          dispatch: (t, p) => pool.dispatchDoTask(t, p),
        })
        await this.dispatchTasks({
          needsWorktree: false,
          getLimit: () => config.conversation_limit,
          getActiveCount: () => pool.activeConversationCount,
          dispatch: (t, p) => pool.dispatchDiscussTask(t, p),
        })
      } while (this.pendingDispatch)
    } finally {
      this.dispatching = false
    }
  }

  private async dispatchTasks(opts: {
    needsWorktree: boolean
    getLimit: () => number
    getActiveCount: () => number
    dispatch: (task: Task, project: Project) => Promise<void>
  }): Promise<void> {
    while (opts.getActiveCount() < opts.getLimit()) {
      const task = this.getNextReadyTask(opts.needsWorktree)
      if (!task) break

      const project = this.deps.getProjectById(task.project_id)
      if (!project) {
        this.deps.updateTask(task.id, {
          status: 'error',
          error_message: 'Project not found',
        })
        continue
      }

      this.deps.updateTask(task.id, { status: 'in_progress' })
      this.deps.createTaskEvent(task.id, 'dispatched', null)
      const updated = this.deps.getTaskById(task.id)
      this.deps.broadcast('task:updated', updated)

      try {
        await opts.dispatch(this.deps.getTaskById(task.id)!, project)
      } catch (err) {
        const msg = getErrorMessage(err)
        this.deps.updateTask(task.id, {
          status: 'error',
          error_message: `Failed to dispatch: ${msg}`,
        })
        this.deps.createTaskEvent(
          task.id,
          'error',
          JSON.stringify({ error: msg }),
        )
        const errTask = this.deps.getTaskById(task.id)
        this.deps.broadcast('inbox:new', errTask)
      }
    }
  }

  private getNextReadyTask(needsWorktree: boolean): Task | null {
    const queued = this.deps.getQueuedTasks()
    const ready = queued.filter((t) => {
      const typeConfig = this.deps.config.task_types[t.type]
      const wt = typeConfig?.needs_worktree ?? t.type === 'do'
      return wt === needsWorktree && this.deps.isDependencySatisfied(t)
    })
    ready.sort(comparePriority)
    return ready[0] ?? null
  }
}
