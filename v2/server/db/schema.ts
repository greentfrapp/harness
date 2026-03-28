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
  substatus: text('substatus'),
  title: text('title'),
  prompt: text('prompt'),
  result: text('result'),
  priority: text('priority').notNull().default('P2'),
  depends_on: text('depends_on').references(() => tasks.id),
  parent_task_id: text('parent_task_id'),
  tags: text('tags').notNull().default('[]'),
  references: text('references').notNull().default('[]'),
  agent_type: text('agent_type').notNull().default('claude-code'),
  agent_session_data: text('agent_session_data'),
  session_id: text('session_id'),
  worktree_path: text('worktree_path'),
  branch_name: text('branch_name'),
  retry_count: integer('retry_count').notNull().default(0),
  queue_position: integer('queue_position'),
  created_at: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
  updated_at: integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now()),
  started_at: integer('started_at'),
  completed_at: integer('completed_at'),
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

export const taskProposals = sqliteTable('task_proposals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task_id: text('task_id')
    .notNull()
    .references(() => tasks.id),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  type: text('type'),
  priority: text('priority').notNull().default('P2'),
  tags: text('tags').notNull().default('[]'),
  parent_task_id: text('parent_task_id'),
  depends_on: text('depends_on'),
  references: text('references').notNull().default('[]'),
  inherit_session: integer('inherit_session', { mode: 'boolean' }).notNull().default(false),
  depends_on_title: text('depends_on_title'),
  status: text('status').notNull().default('pending'),
  feedback: text('feedback'),
  spawned_task_id: text('spawned_task_id').references(() => tasks.id),
  created_at: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
})

export const taskTransitions = sqliteTable('task_transitions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source_task_id: text('source_task_id')
    .notNull()
    .references(() => tasks.id),
  target_task_id: text('target_task_id')
    .notNull()
    .references(() => tasks.id),
  transition_type: text('transition_type').notNull(),
  created_at: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
})
