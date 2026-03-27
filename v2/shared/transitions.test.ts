import { describe, expect, it } from 'vitest'
import {
  TRANSITION_MAP,
  canTransition,
  findAction,
  transition,
  type TransitionAction,
} from './transitions'
import type { TaskStatus, TaskSubstatus } from './types'
import { ALL_STATUS_PAIRS, TERMINAL_PAIRS, VALID_SUBSTATUSES } from './types'

describe('TRANSITION_MAP', () => {
  it('every non-terminal (status, substatus) pair appears in at least one from array', () => {
    const terminalKeys = new Set(
      TERMINAL_PAIRS.map((p) =>
        p.substatus ? `${p.status}:${p.substatus}` : p.status,
      ),
    )
    const coveredKeys = new Set<string>()
    for (const rule of Object.values(TRANSITION_MAP)) {
      for (const p of rule.from) {
        coveredKeys.add(p.substatus ? `${p.status}:${p.substatus}` : p.status)
      }
    }
    for (const pair of ALL_STATUS_PAIRS) {
      const key = pair.substatus
        ? `${pair.status}:${pair.substatus}`
        : pair.status
      if (terminalKeys.has(key)) continue
      expect(
        coveredKeys.has(key),
        `Pair '${key}' has no outgoing transitions`,
      ).toBe(true)
    }
  })

  it('terminal pairs have no outgoing transitions', () => {
    const coveredKeys = new Set<string>()
    for (const rule of Object.values(TRANSITION_MAP)) {
      for (const p of rule.from) {
        coveredKeys.add(p.substatus ? `${p.status}:${p.substatus}` : p.status)
      }
    }
    for (const pair of TERMINAL_PAIRS) {
      const key = pair.substatus
        ? `${pair.status}:${pair.substatus}`
        : pair.status
      expect(
        coveredKeys.has(key),
        `Terminal pair '${key}' should not have outgoing transitions`,
      ).toBe(false)
    }
  })

  it('every target pair is a valid (status, substatus) combination', () => {
    for (const [action, rule] of Object.entries(TRANSITION_MAP)) {
      const validSubs = VALID_SUBSTATUSES[rule.to.status]
      expect(
        validSubs?.includes(rule.to.substatus),
        `Action '${action}' targets invalid pair '${rule.to.status}:${rule.to.substatus}'`,
      ).toBe(true)
    }
  })

  it('every source pair is a valid (status, substatus) combination', () => {
    for (const [action, rule] of Object.entries(TRANSITION_MAP)) {
      for (const p of rule.from) {
        const validSubs = VALID_SUBSTATUSES[p.status]
        expect(
          validSubs?.includes(p.substatus),
          `Action '${action}' has invalid source pair '${p.status}:${p.substatus}'`,
        ).toBe(true)
      }
    }
  })
})

describe('transition()', () => {
  const legalCases: [
    TaskStatus,
    TaskSubstatus,
    TransitionAction,
    TaskStatus,
    TaskSubstatus,
  ][] = [
    // Route-driven
    ['draft', null, 'send', 'queued', null],
    ['pending', 'review', 'approve', 'done', 'approved'],
    ['pending', 'review', 'reject', 'done', 'rejected'],
    ['pending', 'error', 'reject', 'done', 'rejected'],
    ['pending', 'subtask_approval', 'reject', 'done', 'rejected'],
    ['pending', 'review', 'fix', 'queued', null],
    ['pending', 'error', 'fix', 'queued', null],
    ['pending', 'review', 'revise', 'queued', null],
    ['pending', 'response', 'revise', 'queued', null],
    ['pending', 'error', 'revise', 'queued', null],
    ['pending', 'subtask_approval', 'revise', 'queued', null],
    ['pending', 'permission', 'grant_permission', 'queued', null],
    [
      'pending',
      'subtask_approval',
      'approve_subtasks',
      'in_progress',
      'waiting_on_subtasks',
    ],
    ['pending', 'subtask_approval', 'dismiss_all_subtasks', 'queued', null],
    ['pending', 'response', 'dismiss', 'done', null],
    ['pending', 'review', 'approve_transition', 'done', 'approved'],
    ['pending', 'response', 'approve_transition', 'done', 'approved'],
    // Cancel from various states
    ['queued', null, 'cancel', 'cancelled', null],
    ['in_progress', 'running', 'cancel', 'cancelled', null],
    ['in_progress', 'retrying', 'cancel', 'cancelled', null],
    ['in_progress', 'waiting_on_subtasks', 'cancel', 'cancelled', null],
    ['pending', 'review', 'cancel', 'cancelled', null],
    ['pending', 'response', 'cancel', 'cancelled', null],
    ['pending', 'error', 'cancel', 'cancelled', null],
    ['pending', 'permission', 'cancel', 'cancelled', null],
    ['pending', 'subtask_approval', 'cancel', 'cancelled', null],
    // Agent-driven
    ['in_progress', 'running', 'complete', 'pending', 'review'],
    ['in_progress', 'running', 'complete_readonly', 'pending', 'response'],
    ['in_progress', 'running', 'fail', 'in_progress', 'retrying'],
    ['in_progress', 'running', 'max_retries', 'pending', 'error'],
    ['in_progress', 'retrying', 'max_retries', 'pending', 'error'],
    ['in_progress', 'running', 'request_permission', 'pending', 'permission'],
    [
      'in_progress',
      'running',
      'propose_subtasks',
      'pending',
      'subtask_approval',
    ],
    [
      'in_progress',
      'running',
      'auto_approve_subtasks',
      'in_progress',
      'waiting_on_subtasks',
    ],
    ['in_progress', 'running', 'request_transition', 'pending', 'review'],
    // Dispatcher-driven
    ['queued', null, 'dispatch', 'in_progress', 'running'],
    ['in_progress', 'retrying', 'dispatch_retry', 'in_progress', 'running'],
    ['queued', null, 'dispatch_error', 'pending', 'error'],
    ['in_progress', 'running', 'dispatch_error', 'pending', 'error'],
    ['in_progress', 'retrying', 'dispatch_error', 'pending', 'error'],
    // Subtask-driven
    [
      'in_progress',
      'waiting_on_subtasks',
      'subtasks_completed',
      'queued',
      null,
    ],
    // Recovery-driven
    ['in_progress', 'running', 'recover_requeue', 'queued', null],
    ['in_progress', 'retrying', 'recover_requeue', 'queued', null],
    [
      'in_progress',
      'waiting_on_subtasks',
      'recover_requeue',
      'queued',
      null,
    ],
    ['in_progress', 'running', 'recover_error', 'pending', 'error'],
    ['in_progress', 'retrying', 'recover_error', 'pending', 'error'],
    [
      'in_progress',
      'waiting_on_subtasks',
      'recover_error',
      'pending',
      'error',
    ],
  ]

  for (const [fromStatus, fromSub, action, toStatus, toSub] of legalCases) {
    const fromLabel = fromSub ? `${fromStatus}:${fromSub}` : fromStatus
    const toLabel = toSub ? `${toStatus}:${toSub}` : toStatus
    it(`${fromLabel} + ${action} → ${toLabel}`, () => {
      const result = transition(fromStatus, fromSub, action)
      expect(result.status).toBe(toStatus)
      expect(result.substatus).toBe(toSub)
    })
  }

  // Illegal transitions
  const illegalCases: [TaskStatus, TaskSubstatus, TransitionAction][] = [
    ['queued', null, 'send'], // not draft
    ['done', 'approved', 'approve'], // terminal
    ['draft', null, 'approve'], // wrong phase
    ['in_progress', 'running', 'approve'], // still running
    ['cancelled', null, 'cancel'], // already terminal
    ['pending', 'review', 'dispatch'], // wrong status
    ['done', 'approved', 'revise'], // terminal
    ['draft', null, 'cancel'], // draft uses delete, not cancel
    ['in_progress', 'retrying', 'complete'], // only running can complete
    ['pending', 'permission', 'approve'], // wrong substatus
    ['pending', 'error', 'approve'], // cannot approve errored task
  ]

  for (const [fromStatus, fromSub, action] of illegalCases) {
    const fromLabel = fromSub ? `${fromStatus}:${fromSub}` : fromStatus
    it(`${fromLabel} + ${action} → throws`, () => {
      expect(() => transition(fromStatus, fromSub, action)).toThrow(
        `Cannot ${action}`,
      )
    })
  }
})

describe('canTransition()', () => {
  it('returns true for legal transitions', () => {
    expect(canTransition('draft', null, 'send')).toBe(true)
    expect(canTransition('pending', 'review', 'approve')).toBe(true)
    expect(canTransition('in_progress', 'running', 'complete')).toBe(true)
    expect(canTransition('queued', null, 'dispatch')).toBe(true)
  })

  it('returns false for illegal transitions', () => {
    expect(canTransition('queued', null, 'send')).toBe(false)
    expect(canTransition('done', 'approved', 'revise')).toBe(false)
    expect(canTransition('draft', null, 'dispatch')).toBe(false)
    expect(canTransition('in_progress', 'retrying', 'complete')).toBe(false)
  })
})

describe('findAction()', () => {
  it('finds a valid action for legal transitions', () => {
    expect(findAction('draft', null, 'queued', null)).toBe('send')
    expect(findAction('pending', 'review', 'done', 'approved')).toBe(
      'approve',
    )
    expect(findAction('in_progress', 'running', 'pending', 'review')).toBe(
      'complete',
    )
    expect(findAction('queued', null, 'in_progress', 'running')).toBe(
      'dispatch',
    )
  })

  it('returns null for impossible transitions', () => {
    expect(findAction('draft', null, 'done', 'approved')).toBeNull()
    expect(findAction('done', 'approved', 'queued', null)).toBeNull()
    expect(findAction('cancelled', null, 'in_progress', 'running')).toBeNull()
  })

  it('returns null for same-status transitions', () => {
    expect(findAction('queued', null, 'queued', null)).toBeNull()
    expect(findAction('pending', 'review', 'pending', 'review')).toBeNull()
  })

  it('returns one of multiple valid actions for ambiguous transitions', () => {
    // pending:review → done:approved can be either 'approve' or 'approve_transition'
    const action = findAction('pending', 'review', 'done', 'approved')
    expect(['approve', 'approve_transition']).toContain(action)
  })

  it('returns one of multiple valid actions for in_progress:running → pending:review', () => {
    // in_progress:running → pending:review can be complete or request_transition
    const action = findAction('in_progress', 'running', 'pending', 'review')
    expect(['complete', 'request_transition']).toContain(action)
  })

  it('returns one of multiple valid actions for in_progress:running → pending:error', () => {
    // in_progress:running → pending:error can be max_retries or dispatch_error
    const action = findAction('in_progress', 'running', 'pending', 'error')
    expect(['max_retries', 'dispatch_error']).toContain(action)
  })
})
