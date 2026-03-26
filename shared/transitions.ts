import type { TaskStatus } from './types'

/**
 * Every named action that can cause a task status transition.
 */
export type TransitionAction =
  // Route-driven (user actions)
  | 'send'
  | 'approve'
  | 'reject'
  | 'fix'
  | 'approve_plan'
  | 'grant_permission'
  | 'retry'
  | 'revise'
  | 'cancel'
  // Agent-driven
  | 'complete'
  | 'plan_approval_request'
  | 'permission_request'
  | 'propose_subtasks'
  | 'auto_approve_subtasks'
  | 'fail'
  | 'max_retries'
  // Dispatcher-driven
  | 'dispatch'
  | 'dispatch_error'
  // Subtask-driven
  | 'approve_subtasks'
  | 'dismiss_all_subtasks'
  | 'subtasks_completed'
  // Recovery-driven
  | 'recover_requeue'
  | 'recover_error'

interface TransitionRule {
  readonly from: readonly TaskStatus[]
  readonly to: TaskStatus
}

/**
 * The complete task status state machine. Every legal transition is listed here.
 *
 * Read as: action { from: [legal source statuses], to: target status }
 */
export const TRANSITION_MAP: Readonly<Record<TransitionAction, TransitionRule>> =
  {
    // --- Route-driven (user actions) ---
    send: { from: ['draft'], to: 'queued' },
    approve: { from: ['ready', 'error'], to: 'approved' },
    reject: { from: ['ready', 'error', 'held', 'subtasks_proposed'], to: 'rejected' },
    fix: { from: ['ready', 'error'], to: 'queued' },
    approve_plan: { from: ['held'], to: 'queued' },
    grant_permission: { from: ['permission'], to: 'queued' },
    retry: { from: ['error'], to: 'queued' },
    revise: { from: ['ready', 'error', 'held', 'subtasks_proposed'], to: 'queued' },
    cancel: {
      from: [
        'queued',
        'in_progress',
        'retrying',
        'waiting_on_subtasks',
        'subtasks_proposed',
        'ready',
        'held',
        'error',
        'permission',
      ],
      to: 'cancelled',
    },

    // --- Agent-driven ---
    complete: { from: ['in_progress'], to: 'ready' },
    plan_approval_request: { from: ['in_progress'], to: 'held' },
    permission_request: { from: ['in_progress'], to: 'permission' },
    propose_subtasks: { from: ['in_progress'], to: 'subtasks_proposed' },
    auto_approve_subtasks: { from: ['in_progress'], to: 'waiting_on_subtasks' },
    fail: { from: ['in_progress'], to: 'retrying' },
    max_retries: { from: ['in_progress', 'retrying'], to: 'error' },

    // --- Dispatcher-driven ---
    dispatch: { from: ['queued'], to: 'in_progress' },
    dispatch_error: {
      from: ['queued', 'in_progress', 'retrying'],
      to: 'error',
    },

    // --- Subtask-driven ---
    approve_subtasks: { from: ['subtasks_proposed'], to: 'waiting_on_subtasks' },
    dismiss_all_subtasks: { from: ['subtasks_proposed'], to: 'queued' },
    subtasks_completed: { from: ['waiting_on_subtasks'], to: 'queued' },

    // --- Recovery-driven ---
    recover_requeue: { from: ['in_progress', 'retrying', 'waiting_on_subtasks'], to: 'queued' },
    recover_error: { from: ['in_progress', 'retrying', 'waiting_on_subtasks'], to: 'error' },
  }

/**
 * Validate and return the target status for a transition.
 * Throws if the transition is illegal.
 */
export function transition(
  currentStatus: TaskStatus,
  action: TransitionAction,
): TaskStatus {
  const rule = TRANSITION_MAP[action]
  if (!rule.from.includes(currentStatus)) {
    throw new Error(
      `Cannot ${action}: task is '${currentStatus}', expected one of [${rule.from.join(', ')}]`,
    )
  }
  return rule.to
}

/**
 * Check if a transition is valid without throwing.
 */
export function canTransition(
  currentStatus: TaskStatus,
  action: TransitionAction,
): boolean {
  const rule = TRANSITION_MAP[action]
  return rule.from.includes(currentStatus)
}

/**
 * Find a valid action connecting two statuses, or null if none exists.
 * Used by the PATCH endpoint to validate arbitrary status changes.
 */
export function findAction(
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
): TransitionAction | null {
  for (const [action, rule] of Object.entries(TRANSITION_MAP)) {
    if (rule.to === toStatus && rule.from.includes(fromStatus)) {
      return action as TransitionAction
    }
  }
  return null
}
