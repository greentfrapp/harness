import type BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createRequire } from 'node:module'
import { DB_PATH } from '../config'
import * as schema from './schema'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

let sqlite: BetterSqlite3.Database
let db: ReturnType<typeof drizzle<typeof schema>>

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    repo_path TEXT NOT NULL,
    target_branch TEXT NOT NULL DEFAULT 'main',
    worktree_limit INTEGER NOT NULL DEFAULT 3,
    conversation_limit INTEGER NOT NULL DEFAULT 5,
    auto_push INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    substatus TEXT,
    title TEXT,
    prompt TEXT,
    result TEXT,
    priority TEXT NOT NULL DEFAULT 'P2',
    depends_on TEXT REFERENCES tasks(id),
    parent_task_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    \`references\` TEXT NOT NULL DEFAULT '[]',
    agent_type TEXT NOT NULL DEFAULT 'claude-code',
    agent_session_data TEXT,
    session_id TEXT,
    worktree_path TEXT,
    branch_name TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    queue_position INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    event_type TEXT NOT NULL,
    data TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    type TEXT,
    priority TEXT NOT NULL DEFAULT 'P2',
    is_subtask INTEGER NOT NULL DEFAULT 1,
    inherit_session INTEGER NOT NULL DEFAULT 0,
    depends_on_title TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    feedback TEXT,
    spawned_task_id TEXT REFERENCES tasks(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_task_id TEXT NOT NULL REFERENCES tasks(id),
    target_task_id TEXT NOT NULL REFERENCES tasks(id),
    transition_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status_substatus ON tasks(status, substatus);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_transitions_source ON task_transitions(source_task_id);
  CREATE INDEX IF NOT EXISTS idx_task_transitions_target ON task_transitions(target_task_id);
`

export function initDatabase(): void {
  sqlite = new Database(DB_PATH)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(CREATE_TABLES_SQL)
  db = drizzle(sqlite, { schema })
}

/** Initialize an in-memory database for testing. */
export function initTestDatabase(): void {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(CREATE_TABLES_SQL)
  db = drizzle(sqlite, { schema })
}

export function getDb() {
  if (!db)
    throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}

export function getSqlite() {
  if (!sqlite)
    throw new Error('Database not initialized. Call initDatabase() first.')
  return sqlite
}
