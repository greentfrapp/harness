import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  repo_path: text('repo_path').notNull(),
  target_branch: text('target_branch').notNull().default('main'),
  worktree_limit: integer('worktree_limit').notNull().default(3),
  conversation_limit: integer('conversation_limit').notNull().default(5),
  auto_push: integer('auto_push', { mode: 'boolean' }).notNull().default(false),
  created_at: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
})

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  project_id: text('project_id')
    .notNull()
    .references(() => projects.id),
  type: text('type').notNull(),
  status: text('status').notNull(),
  title: text('title'),
  prompt: text('prompt').notNull(),
  priority: text('priority').notNull().default('P2'),
  depends_on: text('depends_on').references(() => tasks.id),
  parent_task_id: text('parent_task_id'),
  tags: text('tags').notNull().default('[]'),
  agent_type: text('agent_type').notNull().default('claude-code'),
  agent_session_data: text('agent_session_data'),
  worktree_path: text('worktree_path'),
  branch_name: text('branch_name'),
  diff_summary: text('diff_summary'),
  diff_full: text('diff_full'),
  agent_summary: text('agent_summary'),
  error_message: text('error_message'),
  retry_count: integer('retry_count').notNull().default(0),
  queue_position: integer('queue_position'),
  created_at: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
  updated_at: integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now()),
})

export const taskEvents = sqliteTable('task_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task_id: text('task_id')
    .notNull()
    .references(() => tasks.id),
  event_type: text('event_type').notNull(),
  data: text('data'),
  created_at: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
})

export const subtaskProposals = sqliteTable('subtask_proposals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task_id: text('task_id')
    .notNull()
    .references(() => tasks.id),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  priority: text('priority').notNull().default('P2'),
  depends_on_title: text('depends_on_title'),
  status: text('status').notNull().default('pending'),
  feedback: text('feedback'),
  spawned_task_id: text('spawned_task_id').references(() => tasks.id),
  created_at: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
})
