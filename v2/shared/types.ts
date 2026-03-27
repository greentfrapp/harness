// Task types
export type TaskType = 'do' | 'discuss' | 'plan' | (string & {})
export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'in_progress'
  | 'pending'
  | 'done'
  | 'cancelled'
export type TaskSubstatus =
  | 'running'
  | 'retrying'
  | 'waiting_on_subtasks'
  | 'review'
  | 'permission'
  | 'subtask_approval'
  | 'accepted'
  | 'rejected'
  | null
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'
export type SubtaskProposalStatus = 'pending' | 'approved' | 'dismissed'

// Valid substatus values for each status
export const VALID_SUBSTATUSES: Record<TaskStatus, readonly TaskSubstatus[]> = {
  draft: [null],
  queued: [null],
  in_progress: ['running', 'retrying', 'waiting_on_subtasks'],
  pending: ['review', 'permission', 'subtask_approval'],
  done: ['accepted', 'rejected'],
  cancelled: [null],
}

export interface StatusPair {
  status: TaskStatus
  substatus: TaskSubstatus
}

// All valid (status, substatus) pairs
export const ALL_STATUS_PAIRS: readonly StatusPair[] = Object.entries(
  VALID_SUBSTATUSES,
).flatMap(([status, subs]) =>
  subs.map((substatus) => ({ status: status as TaskStatus, substatus })),
)

// Status groups
export const OUTBOX_PAIRS: readonly StatusPair[] = [
  { status: 'draft', substatus: null },
  { status: 'queued', substatus: null },
  { status: 'in_progress', substatus: 'running' },
  { status: 'in_progress', substatus: 'retrying' },
  { status: 'in_progress', substatus: 'waiting_on_subtasks' },
]

export const INBOX_PAIRS: readonly StatusPair[] = [
  { status: 'pending', substatus: 'review' },
  { status: 'pending', substatus: 'permission' },
  { status: 'pending', substatus: 'subtask_approval' },
  { status: 'done', substatus: 'accepted' },
  { status: 'done', substatus: 'rejected' },
  { status: 'cancelled', substatus: null },
]

export const TERMINAL_PAIRS: readonly StatusPair[] = [
  { status: 'done', substatus: 'accepted' },
  { status: 'done', substatus: 'rejected' },
  { status: 'cancelled', substatus: null },
]

export const RUNNING_PAIRS: readonly StatusPair[] = [
  { status: 'in_progress', substatus: 'running' },
  { status: 'in_progress', substatus: 'retrying' },
]

// Helper functions for status checking
function matchesPair(
  status: TaskStatus,
  substatus: TaskSubstatus,
  pairs: readonly StatusPair[],
): boolean {
  return pairs.some((p) => p.status === status && p.substatus === substatus)
}

export function isTerminal(
  status: TaskStatus,
  substatus: TaskSubstatus,
): boolean {
  return matchesPair(status, substatus, TERMINAL_PAIRS)
}

export function isRunning(
  status: TaskStatus,
  substatus: TaskSubstatus,
): boolean {
  return matchesPair(status, substatus, RUNNING_PAIRS)
}

export function isOutbox(
  status: TaskStatus,
  substatus: TaskSubstatus,
): boolean {
  return matchesPair(status, substatus, OUTBOX_PAIRS)
}

export function isInbox(
  status: TaskStatus,
  substatus: TaskSubstatus,
): boolean {
  return matchesPair(status, substatus, INBOX_PAIRS)
}

// View types
export interface ViewFilter {
  statuses?: TaskStatus[]
  substatuses?: TaskSubstatus[]
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
      statuses: ['draft', 'queued', 'in_progress'],
    },
  },
  {
    id: 'inbox',
    name: 'Inbox',
    filter: {
      statuses: ['pending', 'done', 'cancelled'],
    },
  },
]

export function getTaskContext(
  status: TaskStatus,
): 'outbox' | 'inbox' | 'draft' {
  if (status === 'draft') return 'draft'
  if (status === 'queued' || status === 'in_progress') return 'outbox'
  return 'inbox'
}

// Config types
export interface AgentConfig {
  adapter: string
  extra_args?: string[]
}

export interface TaskTypeConfig {
  prompt_template: string
  needs_worktree: boolean
  default_priority: Priority
  agent?: string
  permission_mode?: string
}

export interface TagConfig {
  color: string
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
  substatus: TaskSubstatus
  title: string | null
  prompt: string | null
  result: string | null
  priority: Priority
  tags: string[]
  references: string[]
  depends_on: string | null
  parent_task_id: string | null
  agent_type: string
  agent_session_data: string | null
  session_id: string | null
  worktree_path: string | null
  branch_name: string | null
  retry_count: number
  queue_position: number | null
  created_at: number
  updated_at: number
  started_at: number | null
  completed_at: number | null
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

export interface TaskTransition {
  id: number
  source_task_id: string
  target_task_id: string
  transition_type: string
  created_at: number
}

// API input types
export interface CreateTaskInput {
  project_id: string
  type: TaskType
  title?: string
  prompt?: string
  priority?: Priority
  tags?: string[]
  depends_on?: string | null
  parent_task_id?: string | null
  references?: string[]
  agent_type?: string
  as_draft?: boolean
}

export interface UpdateTaskInput {
  status?: TaskStatus
  substatus?: TaskSubstatus
  title?: string | null
  prompt?: string
  result?: string | null
  priority?: Priority
  tags?: string[]
  references?: string[]
  depends_on?: string | null
  parent_task_id?: string | null
  agent_session_data?: string | null
  session_id?: string | null
  worktree_path?: string | null
  branch_name?: string | null
  started_at?: number | null
  completed_at?: number | null
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
  | 'chat:complete'
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
