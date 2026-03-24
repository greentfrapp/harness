import { eq, inArray, and } from 'drizzle-orm';
import { getDb } from './index.ts';
import { projects, tasks, taskEvents, subtaskProposals } from './schema.ts';
import type {
  HarnessConfig,
  CreateTaskInput,
  UpdateTaskInput,
  Task,
  TaskEvent,
  Project,
} from '../../shared/types.ts';

// --- Projects ---

export function seedProjects(config: HarnessConfig): void {
  const db = getDb();
  const now = Date.now();

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
        },
      })
      .run();
  }
}

export function getAllProjects(): Project[] {
  return getDb().select().from(projects).all() as Project[];
}

export function getProjectById(id: string): Project | undefined {
  return getDb()
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .get() as Project | undefined;
}

// --- Tasks ---

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();

  const task: typeof tasks.$inferInsert = {
    id,
    project_id: input.project_id,
    type: input.type,
    status: 'queued',
    prompt: input.prompt,
    priority: input.priority ?? 'normal',
    depends_on: input.depends_on ?? null,
    agent_type: 'claude-code',
    retry_count: 0,
    created_at: now,
    updated_at: now,
  };

  db.insert(tasks).values(task).run();

  // Log creation event
  createTaskEvent(id, 'created', null);

  return getTaskById(id)!;
}

export function getTaskById(id: string): Task | undefined {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.id, id))
    .get() as Task | undefined;
}

export function getTasksByStatus(statusList: string[]): Task[] {
  return getDb()
    .select()
    .from(tasks)
    .where(inArray(tasks.status, statusList))
    .all() as Task[];
}

export function getTasksByProject(projectId: string): Task[] {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.project_id, projectId))
    .all() as Task[];
}

export function getQueuedTasks(projectId?: string): Task[] {
  const db = getDb();
  const conditions = [eq(tasks.status, 'queued')];
  if (projectId) {
    conditions.push(eq(tasks.project_id, projectId));
  }
  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .all() as Task[];
}

export function updateTask(
  id: string,
  updates: UpdateTaskInput & { status?: string; queue_position?: number | null; retry_count?: number },
): Task | undefined {
  const db = getDb();
  db.update(tasks)
    .set({ ...updates, updated_at: Date.now() })
    .where(eq(tasks.id, id))
    .run();
  return getTaskById(id);
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
    .run();
}

export function getTaskEvents(taskId: string): TaskEvent[] {
  return getDb()
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.task_id, taskId))
    .all() as TaskEvent[];
}
