// Task types
export type TaskType = 'do' | 'discuss' | (string & {});
export type TaskStatus =
  | 'queued'
  | 'in_progress'
  | 'retrying'
  | 'ready'
  | 'held'
  | 'deferred'
  | 'error'
  | 'permission'
  | 'approved'
  | 'rejected'
  | 'cancelled';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type SubtaskProposalStatus = 'pending' | 'approved' | 'dismissed';

// Statuses that appear in the outbox
export const OUTBOX_STATUSES: TaskStatus[] = [
  'queued',
  'in_progress',
  'retrying',
];

// Statuses that appear in the inbox
export const INBOX_STATUSES: TaskStatus[] = [
  'ready',
  'held',
  'deferred',
  'error',
  'permission',
  'approved',
];

// Config types
export interface AgentConfig {
  adapter: string; // references AgentAdapter.id
  extra_args?: string[]; // appended to adapter's buildArgs output
}

export interface TaskTypeConfig {
  prompt_template: string;
  needs_worktree: boolean;
  default_priority: Priority;
  agent?: string; // key into HarnessConfig.agents
}

export interface ProjectConfig {
  name: string;
  repo_path: string;
  target_branch?: string;
  worktree_limit?: number;
  conversation_limit?: number;
  auto_push?: boolean;
}

export interface HarnessConfig {
  worktree_limit: number;
  conversation_limit: number;
  agents?: Record<string, AgentConfig>;
  task_types: Record<string, TaskTypeConfig>;
  projects: ProjectConfig[];
}

// Data model types
export interface Project {
  id: string;
  name: string;
  repo_path: string;
  target_branch: string;
  worktree_limit: number;
  conversation_limit: number;
  auto_push: boolean;
  created_at: number;
}

export interface Task {
  id: string;
  project_id: string;
  type: TaskType;
  status: TaskStatus;
  prompt: string;
  priority: Priority;
  depends_on: string | null;
  parent_task_id: string | null;
  agent_type: string;
  agent_session_data: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  diff_summary: string | null;
  agent_summary: string | null;
  error_message: string | null;
  retry_count: number;
  queue_position: number | null;
  created_at: number;
  updated_at: number;
}

export interface TaskEvent {
  id: number;
  task_id: string;
  event_type: string;
  data: string | null;
  created_at: number;
}

export interface SubtaskProposal {
  id: number;
  task_id: string;
  title: string;
  prompt: string;
  priority: Priority;
  depends_on_title: string | null;
  status: SubtaskProposalStatus;
  spawned_task_id: string | null;
  created_at: number;
}

// API input types
export interface CreateTaskInput {
  project_id: string;
  type: TaskType;
  prompt: string;
  priority?: Priority;
  depends_on?: string | null;
  agent_type?: string;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  prompt?: string;
  priority?: Priority;
  depends_on?: string | null;
  parent_task_id?: string | null;
  agent_session_data?: string | null;
  worktree_path?: string | null;
  branch_name?: string | null;
  diff_summary?: string | null;
  agent_summary?: string | null;
  error_message?: string | null;
}

// Server log entry
export interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  taskId?: string;
}

// SSE event types
export type SSEEventType =
  | 'task:created'
  | 'task:updated'
  | 'task:removed'
  | 'task:progress'
  | 'inbox:new'
  | 'inbox:updated'
  | 'log:entry';

export interface SSEEvent<T = unknown> {
  type: SSEEventType;
  data: T;
}
