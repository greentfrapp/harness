import { and, eq, inArray } from 'drizzle-orm'
import type {
  CreateTaskInput,
  HarnessConfig,
  Project,
  SubtaskProposal,
  SubtaskProposalInput,
  Task,
  TaskEvent,
  UpdateTaskInput,
} from '../../shared/types'
import { getDb } from './index'
import { projects, subtaskProposals, taskEvents, tasks } from './schema'

/** Parse the JSON tags column into a string array. */
function deserializeTags(row: Record<string, unknown>): Task {
  const tags = row.tags
  return {
    ...row,
    tags:
      typeof tags === 'string' ? JSON.parse(tags) : ((tags as string[]) ?? []),
  } as Task
}

// --- Projects ---

export function seedProjects(config: HarnessConfig): void {
  const db = getDb()
  const now = Date.now()

  for (const project of config.projects) {
    db.insert(projects)
      .values({
        id: crypto.randomUUID(),
        name: project.name,
        repo_path: project.repo_path,
        target_branch: project.target_branch ?? 'main',
        worktree_limit: project.worktree_limit ?? config.worktree_limit,
        conversation_limit:
          project.conversation_limit ?? config.conversation_limit,
        auto_push: project.auto_push ?? false,
        created_at: now,
      })
      .onConflictDoUpdate({
        target: projects.name,
        set: {
          repo_path: project.repo_path,
          target_branch: project.target_branch ?? 'main',
          worktree_limit: project.worktree_limit ?? config.worktree_limit,
          conversation_limit:
            project.conversation_limit ?? config.conversation_limit,
          auto_push: project.auto_push ?? false,
        },
      })
      .run()
  }
}

export function getAllProjects(): Project[] {
  return getDb().select().from(projects).all() as Project[]
}

export function getProjectById(id: string): Project | undefined {
  return getDb().select().from(projects).where(eq(projects.id, id)).get() as
    | Project
    | undefined
}

// --- Tasks ---

export function createTask(input: CreateTaskInput): Task {
  const db = getDb()
  const now = Date.now()
  const id = crypto.randomUUID()

  const task: typeof tasks.$inferInsert = {
    id,
    project_id: input.project_id,
    type: input.type,
    status: input.as_draft ? 'draft' : 'queued',
    prompt: input.prompt,
    priority: input.priority ?? 'P2',
    tags: JSON.stringify(input.tags ?? []),
    depends_on: input.depends_on ?? null,
    agent_type: input.agent_type ?? 'claude-code',
    retry_count: 0,
    created_at: now,
    updated_at: now,
  }

  db.insert(tasks).values(task).run()

  // Log creation event
  createTaskEvent(id, 'created', null)

  return getTaskById(id)!
}

export function getTaskById(id: string): Task | undefined {
  const row = getDb().select().from(tasks).where(eq(tasks.id, id)).get()
  return row ? deserializeTags(row as Record<string, unknown>) : undefined
}

export function getTasksByStatus(statusList: string[]): Task[] {
  return getDb()
    .select()
    .from(tasks)
    .where(inArray(tasks.status, statusList))
    .all()
    .map((row) => deserializeTags(row as Record<string, unknown>))
}

export function getTasksByProject(projectId: string): Task[] {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.project_id, projectId))
    .all()
    .map((row) => deserializeTags(row as Record<string, unknown>))
}

export function getQueuedTasks(projectId?: string): Task[] {
  const db = getDb()
  const conditions = [eq(tasks.status, 'queued')]
  if (projectId) {
    conditions.push(eq(tasks.project_id, projectId))
  }
  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .all()
    .map((row) => deserializeTags(row as Record<string, unknown>))
}

export function updateTask(
  id: string,
  updates: UpdateTaskInput & {
    status?: string
    queue_position?: number | null
    retry_count?: number
  },
): Task | undefined {
  const db = getDb()
  const dbUpdates: Record<string, unknown> = {
    ...updates,
    updated_at: Date.now(),
  }
  // Serialize tags array to JSON string for storage
  if (Array.isArray(dbUpdates.tags)) {
    dbUpdates.tags = JSON.stringify(dbUpdates.tags)
  }
  db.update(tasks).set(dbUpdates).where(eq(tasks.id, id)).run()
  return getTaskById(id)
}

// --- Task Events ---

export function createTaskEvent(
  taskId: string,
  eventType: string,
  data: string | null,
): void {
  getDb()
    .insert(taskEvents)
    .values({
      task_id: taskId,
      event_type: eventType,
      data,
      created_at: Date.now(),
    })
    .run()
}

export function getTaskEvents(taskId: string): TaskEvent[] {
  return getDb()
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.task_id, taskId))
    .all() as TaskEvent[]
}

export function clearParentReferences(parentId: string): void {
  const db = getDb()
  db.update(tasks)
    .set({ depends_on: null, updated_at: Date.now() })
    .where(eq(tasks.depends_on, parentId))
    .run()
  db.update(tasks)
    .set({ parent_task_id: null, updated_at: Date.now() })
    .where(eq(tasks.parent_task_id, parentId))
    .run()
}

/** Delete tasks and their related records (events, subtask proposals) by ID list. */
function deleteTasksAndRelated(ids: string[]): void {
  const db = getDb()
  for (const id of ids) clearParentReferences(id)
  db.delete(subtaskProposals)
    .where(inArray(subtaskProposals.task_id, ids))
    .run()
  db.delete(taskEvents).where(inArray(taskEvents.task_id, ids)).run()
  db.delete(tasks).where(inArray(tasks.id, ids)).run()
}

export function deleteTasksByIds(ids: string[]): Task[] {
  const db = getDb()
  const toDelete = db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, ids))
    .all()
    .map((row) => deserializeTags(row as Record<string, unknown>))
  if (!toDelete.length) return []
  deleteTasksAndRelated(ids)
  return toDelete
}

// --- Subtask Proposals ---

export function createSubtaskProposals(
  taskId: string,
  proposals: SubtaskProposalInput[],
): SubtaskProposal[] {
  const db = getDb()
  const now = Date.now()
  const results: SubtaskProposal[] = []

  for (const p of proposals) {
    const row = db
      .insert(subtaskProposals)
      .values({
        task_id: taskId,
        title: p.title,
        prompt: p.prompt,
        priority: p.priority ?? 'P2',
        status: 'pending',
        created_at: now,
      })
      .returning()
      .get()
    results.push(row as SubtaskProposal)
  }

  return results
}

export function getSubtaskProposals(taskId: string): SubtaskProposal[] {
  return getDb()
    .select()
    .from(subtaskProposals)
    .where(eq(subtaskProposals.task_id, taskId))
    .all() as SubtaskProposal[]
}

export function updateSubtaskProposal(
  id: number,
  updates: {
    status?: string
    feedback?: string | null
    spawned_task_id?: string | null
  },
): void {
  getDb()
    .update(subtaskProposals)
    .set(updates)
    .where(eq(subtaskProposals.id, id))
    .run()
}

export function getChildTasks(parentTaskId: string): Task[] {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.parent_task_id, parentTaskId))
    .all()
    .map((row) => deserializeTags(row as Record<string, unknown>))
}
