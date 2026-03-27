import type { TaskStatus, TaskSubstatus } from './types'

/**
 * Every named action that can cause a task status transition.
 */
export type TransitionAction =
  // Route-driven (user actions)
  | 'send'
  | 'approve'
  | 'reject'
  | 'fix'
  | 'revise'
  | 'cancel'
  | 'grant_permission'
  | 'approve_subtasks'
  | 'dismiss_all_subtasks'
  | 'dismiss'
  | 'approve_transition'
  // Agent-driven
  | 'complete'
  | 'complete_readonly'
  | 'fail'
  | 'max_retries'
  | 'request_permission'
  | 'propose_subtasks'
  | 'auto_approve_subtasks'
  | 'request_transition'
  // Dispatcher-driven
  | 'dispatch'
  | 'dispatch_retry'
  | 'dispatch_error'
  // Subtask-driven
  | 'subtasks_completed'
  // Recovery-driven
  | 'recover_requeue'
  | 'recover_error'

interface StatusPair {
  readonly status: TaskStatus
  readonly substatus: TaskSubstatus
}

interface TransitionRule {
  readonly from: readonly StatusPair[]
  readonly to: StatusPair
}

/** Helper to create a StatusPair concisely. */
function sp(status: TaskStatus, substatus: TaskSubstatus = null): StatusPair {
  return { status, substatus }
}

/**
 * The complete task status state machine. Every legal transition is listed here.
 *
 * Read as: action { from: [legal source (status,substatus) pairs], to: target pair }
 */
export const TRANSITION_MAP: Readonly<
  Record<TransitionAction, TransitionRule>
> = {
  // --- Route-driven (user actions) ---
  send: { from: [sp('draft')], to: sp('queued') },
  approve: { from: [sp('pending', 'review')], to: sp('done', 'accepted') },
  reject: {
    from: [sp('pending', 'review'), sp('pending', 'error'), sp('pending', 'subtask_approval')],
    to: sp('done', 'rejected'),
  },
  fix: { from: [sp('pending', 'review'), sp('pending', 'error')], to: sp('queued') },
  revise: {
    from: [sp('pending', 'review'), sp('pending', 'response'), sp('pending', 'error'), sp('pending', 'subtask_approval')],
    to: sp('queued'),
  },
  grant_permission: {
    from: [sp('pending', 'permission')],
    to: sp('queued'),
  },
  approve_subtasks: {
    from: [sp('pending', 'subtask_approval')],
    to: sp('in_progress', 'waiting_on_subtasks'),
  },
  dismiss_all_subtasks: {
    from: [sp('pending', 'subtask_approval')],
    to: sp('queued'),
  },
  dismiss: {
    from: [sp('pending', 'response')],
    to: sp('done'),
  },
  approve_transition: {
    from: [sp('pending', 'review'), sp('pending', 'response')],
    to: sp('done', 'accepted'),
  },
  cancel: {
    from: [
      sp('queued'),
      sp('in_progress', 'running'),
      sp('in_progress', 'retrying'),
      sp('in_progress', 'waiting_on_subtasks'),
      sp('pending', 'review'),
      sp('pending', 'response'),
      sp('pending', 'error'),
      sp('pending', 'permission'),
      sp('pending', 'subtask_approval'),
    ],
    to: sp('cancelled'),
  },

  // --- Agent-driven ---
  complete: {
    from: [sp('in_progress', 'running')],
    to: sp('pending', 'review'),
  },
  complete_readonly: {
    from: [sp('in_progress', 'running')],
    to: sp('pending', 'response'),
  },
  fail: {
    from: [sp('in_progress', 'running')],
    to: sp('in_progress', 'retrying'),
  },
  max_retries: {
    from: [sp('in_progress', 'running'), sp('in_progress', 'retrying')],
    to: sp('pending', 'error'),
  },
  request_permission: {
    from: [sp('in_progress', 'running')],
    to: sp('pending', 'permission'),
  },
  propose_subtasks: {
    from: [sp('in_progress', 'running')],
    to: sp('pending', 'subtask_approval'),
  },
  auto_approve_subtasks: {
    from: [sp('in_progress', 'running')],
    to: sp('in_progress', 'waiting_on_subtasks'),
  },
  request_transition: {
    from: [sp('in_progress', 'running')],
    to: sp('pending', 'review'),
  },

  // --- Dispatcher-driven ---
  dispatch: {
    from: [sp('queued')],
    to: sp('in_progress', 'running'),
  },
  dispatch_retry: {
    from: [sp('in_progress', 'retrying')],
    to: sp('in_progress', 'running'),
  },
  dispatch_error: {
    from: [
      sp('queued'),
      sp('in_progress', 'running'),
      sp('in_progress', 'retrying'),
    ],
    to: sp('pending', 'error'),
  },

  // --- Subtask-driven ---
  subtasks_completed: {
    from: [sp('in_progress', 'waiting_on_subtasks')],
    to: sp('queued'),
  },

  // --- Recovery-driven ---
  recover_requeue: {
    from: [
      sp('in_progress', 'running'),
      sp('in_progress', 'retrying'),
      sp('in_progress', 'waiting_on_subtasks'),
    ],
    to: sp('queued'),
  },
  recover_error: {
    from: [
      sp('in_progress', 'running'),
      sp('in_progress', 'retrying'),
      sp('in_progress', 'waiting_on_subtasks'),
    ],
    to: sp('pending', 'error'),
  },
}

/** Create a string key for a (status, substatus) pair for efficient lookups. */
function pairKey(status: TaskStatus, substatus: TaskSubstatus): string {
  return substatus ? `${status}:${substatus}` : status
}

// Build a lookup map for O(1) transition validation
const transitionLookup = new Map<string, Map<TransitionAction, StatusPair>>()
for (const [action, rule] of Object.entries(TRANSITION_MAP)) {
  for (const from of rule.from) {
    const key = pairKey(from.status, from.substatus)
    if (!transitionLookup.has(key)) {
      transitionLookup.set(key, new Map())
    }
    transitionLookup.get(key)!.set(action as TransitionAction, rule.to)
  }
}

/**
 * Validate and return the target (status, substatus) for a transition.
 * Throws if the transition is illegal.
 */
export function transition(
  currentStatus: TaskStatus,
  currentSubstatus: TaskSubstatus,
  action: TransitionAction,
): { status: TaskStatus; substatus: TaskSubstatus } {
  const key = pairKey(currentStatus, currentSubstatus)
  const actionMap = transitionLookup.get(key)
  const target = actionMap?.get(action)
  if (!target) {
    const currentPair = currentSubstatus
      ? `${currentStatus}:${currentSubstatus}`
      : currentStatus
    const rule = TRANSITION_MAP[action]
    const expected = rule.from
      .map((p) => (p.substatus ? `${p.status}:${p.substatus}` : p.status))
      .join(', ')
    throw new Error(
      `Cannot ${action}: task is '${currentPair}', expected one of [${expected}]`,
    )
  }
  return { status: target.status, substatus: target.substatus }
}

/**
 * Check if a transition is valid without throwing.
 */
export function canTransition(
  currentStatus: TaskStatus,
  currentSubstatus: TaskSubstatus,
  action: TransitionAction,
): boolean {
  const key = pairKey(currentStatus, currentSubstatus)
  const actionMap = transitionLookup.get(key)
  return actionMap?.has(action) ?? false
}

/**
 * Find a valid action connecting two (status, substatus) pairs, or null if none exists.
 */
export function findAction(
  fromStatus: TaskStatus,
  fromSubstatus: TaskSubstatus,
  toStatus: TaskStatus,
  toSubstatus: TaskSubstatus,
): TransitionAction | null {
  const key = pairKey(fromStatus, fromSubstatus)
  const actionMap = transitionLookup.get(key)
  if (!actionMap) return null

  for (const [action, target] of actionMap) {
    if (target.status === toStatus && target.substatus === toSubstatus) {
      return action
    }
  }
  return null
}
