// Task types
export type TaskType = 'do' | 'discuss' | (string & {})
export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'in_progress'
  | 'retrying'
  | 'ready'
  | 'held'
  | 'error'
  | 'waiting_on_subtasks'
  | 'permission'
  | 'approved'
  | 'rejected'
  | 'cancelled'
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'
export type SubtaskProposalStatus = 'pending' | 'approved' | 'dismissed'

// Statuses for draft tasks (saved but not queued)
export const DRAFT_STATUSES: TaskStatus[] = ['draft']

// Statuses that appear in the outbox
export const OUTBOX_STATUSES: TaskStatus[] = [
  'queued',
  'in_progress',
  'retrying',
  'waiting_on_subtasks',
]

// Statuses that appear in the inbox
export const INBOX_STATUSES: TaskStatus[] = [
  'ready',
  'held',
  'error',
  'permission',
  'approved',
  'rejected',
]

// Terminal statuses (task is done, can only be deleted)
export const TERMINAL_STATUSES: TaskStatus[] = [
  'approved',
  'rejected',
  'cancelled',
]

// Statuses where the agent is actively running
export const RUNNING_STATUSES: TaskStatus[] = ['in_progress', 'retrying']

// Statuses where the task can be approved/fixed/checked out
export const REVIEWABLE_STATUSES: TaskStatus[] = ['ready', 'error']

// Statuses where the task can be rejected/revised
export const REJECTABLE_STATUSES: TaskStatus[] = ['ready', 'error', 'held']

// Non-terminal statuses (task is still in the pipeline)
export const ACTIVE_STATUSES: TaskStatus[] = [
  'queued',
  'in_progress',
  'retrying',
  'waiting_on_subtasks',
  'ready',
  'held',
]

// View types
export interface ViewFilter {
  statuses?: TaskStatus[]
  priorities?: Priority[]
  tags?: string[]
  project_id?: string
}

export interface ViewConfig {
  id: string
  name: string
  filter: ViewFilter
}

export const DEFAULT_VIEWS: ViewConfig[] = [
  {
    id: 'outbox',
    name: 'Outbox',
    filter: {
      statuses: ['draft', 'queued', 'in_progress', 'retrying', 'waiting_on_subtasks'],
    },
  },
  {
    id: 'inbox',
    name: 'Inbox',
    filter: {
      statuses: [
        'ready',
        'held',
        'error',
        'permission',
        'approved',
        'rejected',
        'cancelled',
      ],
    },
  },
]

export function getTaskContext(
  status: TaskStatus,
): 'outbox' | 'inbox' | 'draft' {
  if ((DRAFT_STATUSES as string[]).includes(status)) return 'draft'
  if ((OUTBOX_STATUSES as string[]).includes(status)) return 'outbox'
  return 'inbox'
}

// Config types
export interface AgentConfig {
  adapter: string // references AgentAdapter.id
  extra_args?: string[] // appended to adapter's buildArgs output
}

export interface TaskTypeConfig {
  prompt_template: string
  needs_worktree: boolean
  default_priority: Priority
  agent?: string // key into HarnessConfig.agents
  permission_mode?: string // e.g. 'bypassPermissions'; omit to use adapter default
}

export interface TagConfig {
  color: string // Tailwind color name (e.g. "red", "blue", "green")
  description?: string
}

export interface ProjectConfig {
  name: string
  repo_path: string
  target_branch?: string
  worktree_limit?: number
  conversation_limit?: number
  auto_push?: boolean
}

export interface HarnessConfig {
  worktree_limit: number
  conversation_limit: number
  auto_approve_subtasks?: boolean
  agents?: Record<string, AgentConfig>
  task_types: Record<string, TaskTypeConfig>
  tags: Record<string, TagConfig>
  projects: ProjectConfig[]
}

export interface SubtaskProposalInput {
  title: string
  prompt: string
  priority?: Priority
}

// Data model types
export interface Project {
  id: string
  name: string
  repo_path: string
  target_branch: string
  worktree_limit: number
  conversation_limit: number
  auto_push: boolean
  created_at: number
}

export interface Task {
  id: string
  project_id: string
  type: TaskType
  status: TaskStatus
  prompt: string
  priority: Priority
  tags: string[]
  depends_on: string | null
  parent_task_id: string | null
  agent_type: string
  agent_session_data: string | null
  worktree_path: string | null
  branch_name: string | null
  diff_summary: string | null
  diff_full: string | null
  agent_summary: string | null
  error_message: string | null
  retry_count: number
  queue_position: number | null
  created_at: number
  updated_at: number
}

export interface TaskEvent {
  id: number
  task_id: string
  event_type: string
  data: string | null
  created_at: number
}

export interface SubtaskProposal {
  id: number
  task_id: string
  title: string
  prompt: string
  priority: Priority
  depends_on_title: string | null
  status: SubtaskProposalStatus
  feedback: string | null
  spawned_task_id: string | null
  created_at: number
}

// API input types
export interface CreateTaskInput {
  project_id: string
  type: TaskType
  prompt: string
  priority?: Priority
  tags?: string[]
  depends_on?: string | null
  agent_type?: string
  as_draft?: boolean
}

export interface UpdateTaskInput {
  status?: TaskStatus
  prompt?: string
  priority?: Priority
  tags?: string[]
  depends_on?: string | null
  parent_task_id?: string | null
  agent_session_data?: string | null
  worktree_path?: string | null
  branch_name?: string | null
  diff_summary?: string | null
  diff_full?: string | null
  agent_summary?: string | null
  error_message?: string | null
}

// Server log entry
export interface LogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error'
  message: string
  taskId?: string
}

// SSE event types
export type SSEEventType =
  | 'task:created'
  | 'task:updated'
  | 'task:removed'
  | 'task:progress'
  | 'inbox:new'
  | 'inbox:updated'
  | 'task:checked_out'
  | 'task:returned'
  | 'log:entry'

// Checkout state exposed to clients
export interface CheckoutInfo {
  taskId: string
  taskPrompt: string
  repoPath: string
  projectName: string
  projectId: string
}

export interface RepoStatus {
  projectId: string
  projectName: string
  dirty: boolean
  fileCount: number
}

export interface SSEEvent<T = unknown> {
  type: SSEEventType
  data: T
}

/** Extract error message from unknown catch value. */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Priority ordering — shared between queue and dispatcher
export const PRIORITY_ORDER: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
}

export function comparePriority(a: Task, b: Task): number {
  const pa = PRIORITY_ORDER[a.priority] ?? 1
  const pb = PRIORITY_ORDER[b.priority] ?? 1
  if (pa !== pb) return pa - pb
  return a.created_at - b.created_at
}
