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
    title TEXT,
    prompt TEXT,
    original_prompt TEXT,
    priority TEXT NOT NULL DEFAULT 'P2',
    depends_on TEXT REFERENCES tasks(id),
    parent_task_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    agent_type TEXT NOT NULL DEFAULT 'claude-code',
    agent_session_data TEXT,
    worktree_path TEXT,
    branch_name TEXT,
    diff_summary TEXT,
    diff_full TEXT,
    agent_summary TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    queue_position INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    event_type TEXT NOT NULL,
    data TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subtask_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'P2',
    depends_on_title TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    feedback TEXT,
    spawned_task_id TEXT REFERENCES tasks(id),
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
`

export function initDatabase(): void {
  sqlite = new Database(DB_PATH)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(CREATE_TABLES_SQL)
  // Migrations for existing databases
  try {
    sqlite.exec(
      'ALTER TABLE projects ADD COLUMN auto_push INTEGER NOT NULL DEFAULT 0',
    )
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT')
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN diff_full TEXT')
  } catch {
    // Column already exists
  }
  // Migrate old priority values to new P0-P3 format
  try {
    sqlite.exec(`
      UPDATE tasks SET priority = CASE priority
        WHEN 'urgent' THEN 'P0'
        WHEN 'normal' THEN 'P2'
        WHEN 'low' THEN 'P3'
        ELSE priority
      END
      WHERE priority IN ('urgent', 'normal', 'low')
    `)
    sqlite.exec(`
      UPDATE subtask_proposals SET priority = CASE priority
        WHEN 'urgent' THEN 'P0'
        WHEN 'normal' THEN 'P2'
        WHEN 'low' THEN 'P3'
        ELSE priority
      END
      WHERE priority IN ('urgent', 'normal', 'low')
    `)
  } catch {
    // Migration already applied or tables empty
  }
  try {
    sqlite.exec('ALTER TABLE subtask_proposals ADD COLUMN feedback TEXT')
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN title TEXT')
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN original_prompt TEXT')
  } catch {
    // Column already exists
  }
  // Migrate: make tasks.prompt nullable for existing databases
  // SQLite doesn't support ALTER COLUMN, so we rebuild the table
  try {
    const promptColumnInfo = sqlite
      .prepare("SELECT `notnull` FROM pragma_table_info('tasks') WHERE name = 'prompt'")
      .get() as { notnull: number } | undefined
    if (promptColumnInfo && promptColumnInfo.notnull === 1) {
      sqlite.exec(`
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT,
          prompt TEXT,
          priority TEXT NOT NULL DEFAULT 'P2',
          depends_on TEXT REFERENCES tasks(id),
          parent_task_id TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          agent_type TEXT NOT NULL DEFAULT 'claude-code',
          agent_session_data TEXT,
          worktree_path TEXT,
          branch_name TEXT,
          diff_summary TEXT,
          diff_full TEXT,
          agent_summary TEXT,
          error_message TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          queue_position INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO tasks_new SELECT * FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
      `)
    }
  } catch {
    // Migration already applied or not needed
  }
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
