import { describe, expect, it } from 'vitest'
import {
  TRANSITION_MAP,
  canTransition,
  findAction,
  transition,
  type TransitionAction,
} from './transitions'
import type { TaskStatus } from './types'

const ALL_STATUSES: TaskStatus[] = [
  'draft',
  'queued',
  'in_progress',
  'retrying',
  'waiting_on_subtasks',
  'ready',
  'held',
  'error',
  'permission',
  'approved',
  'rejected',
  'cancelled',
]

describe('TRANSITION_MAP', () => {
  it('every non-terminal status appears in at least one from array', () => {
    const terminalStatuses = new Set(['approved', 'rejected', 'cancelled'])
    const coveredStatuses = new Set<string>()
    for (const rule of Object.values(TRANSITION_MAP)) {
      for (const s of rule.from) coveredStatuses.add(s)
    }
    for (const status of ALL_STATUSES) {
      if (terminalStatuses.has(status)) continue
      expect(
        coveredStatuses.has(status),
        `Status '${status}' has no outgoing transitions`,
      ).toBe(true)
    }
  })

  it('terminal statuses have no outgoing transitions', () => {
    const terminalStatuses: TaskStatus[] = ['approved', 'rejected', 'cancelled']
    const coveredStatuses = new Set<string>()
    for (const rule of Object.values(TRANSITION_MAP)) {
      for (const s of rule.from) coveredStatuses.add(s)
    }
    for (const status of terminalStatuses) {
      expect(
        coveredStatuses.has(status),
        `Terminal status '${status}' should not have outgoing transitions`,
      ).toBe(false)
    }
  })

  it('every target status is a valid TaskStatus', () => {
    for (const [action, rule] of Object.entries(TRANSITION_MAP)) {
      expect(
        ALL_STATUSES.includes(rule.to),
        `Action '${action}' targets invalid status '${rule.to}'`,
      ).toBe(true)
    }
  })

  it('every source status is a valid TaskStatus', () => {
    for (const [action, rule] of Object.entries(TRANSITION_MAP)) {
      for (const s of rule.from) {
        expect(
          ALL_STATUSES.includes(s),
          `Action '${action}' has invalid source status '${s}'`,
        ).toBe(true)
      }
    }
  })
})

describe('transition()', () => {
  // Test every legal transition
  const legalCases: [TaskStatus, TransitionAction, TaskStatus][] = [
    // Route-driven
    ['draft', 'send', 'queued'],
    ['ready', 'approve', 'approved'],
    ['error', 'approve', 'approved'],
    ['ready', 'reject', 'rejected'],
    ['error', 'reject', 'rejected'],
    ['held', 'reject', 'rejected'],
    ['ready', 'fix', 'queued'],
    ['error', 'fix', 'queued'],
    ['held', 'approve_plan', 'queued'],
    ['permission', 'grant_permission', 'queued'],
    ['error', 'retry', 'queued'],
    ['ready', 'revise', 'queued'],
    ['error', 'revise', 'queued'],
    ['held', 'revise', 'queued'],
    ['queued', 'cancel', 'cancelled'],
    ['in_progress', 'cancel', 'cancelled'],
    ['retrying', 'cancel', 'cancelled'],
    ['ready', 'cancel', 'cancelled'],
    ['held', 'cancel', 'cancelled'],
    ['error', 'cancel', 'cancelled'],
    ['permission', 'cancel', 'cancelled'],
    // Agent-driven
    ['in_progress', 'complete', 'ready'],
    ['in_progress', 'plan_approval_request', 'held'],
    ['in_progress', 'permission_request', 'permission'],
    ['in_progress', 'propose_subtasks', 'waiting_on_subtasks'],
    ['in_progress', 'fail', 'retrying'],
    ['in_progress', 'max_retries', 'error'],
    ['retrying', 'max_retries', 'error'],
    // Dispatcher-driven
    ['queued', 'dispatch', 'in_progress'],
    ['queued', 'dispatch_error', 'error'],
    ['in_progress', 'dispatch_error', 'error'],
    ['retrying', 'dispatch_error', 'error'],
    // Subtask-driven
    ['waiting_on_subtasks', 'subtasks_completed', 'queued'],
    ['waiting_on_subtasks', 'cancel', 'cancelled'],
    // Recovery-driven
    ['in_progress', 'recover_requeue', 'queued'],
    ['retrying', 'recover_requeue', 'queued'],
    ['waiting_on_subtasks', 'recover_requeue', 'queued'],
    ['in_progress', 'recover_error', 'error'],
    ['retrying', 'recover_error', 'error'],
    ['waiting_on_subtasks', 'recover_error', 'error'],
  ]

  for (const [from, action, expected] of legalCases) {
    it(`${from} + ${action} → ${expected}`, () => {
      expect(transition(from, action)).toBe(expected)
    })
  }

  // Test illegal transitions
  const illegalCases: [TaskStatus, TransitionAction][] = [
    ['queued', 'send'], // not draft
    ['approved', 'approve'], // terminal
    ['draft', 'approve'], // wrong phase
    ['in_progress', 'approve'], // still running
    ['cancelled', 'cancel'], // already terminal
    ['ready', 'dispatch'], // wrong status
    ['approved', 'revise'], // terminal
    ['draft', 'cancel'], // draft uses delete, not cancel
  ]

  for (const [from, action] of illegalCases) {
    it(`${from} + ${action} → throws`, () => {
      expect(() => transition(from, action)).toThrow(`Cannot ${action}`)
    })
  }
})

describe('canTransition()', () => {
  it('returns true for legal transitions', () => {
    expect(canTransition('draft', 'send')).toBe(true)
    expect(canTransition('ready', 'approve')).toBe(true)
    expect(canTransition('in_progress', 'complete')).toBe(true)
  })

  it('returns false for illegal transitions', () => {
    expect(canTransition('queued', 'send')).toBe(false)
    expect(canTransition('approved', 'revise')).toBe(false)
    expect(canTransition('draft', 'dispatch')).toBe(false)
  })
})

describe('findAction()', () => {
  it('finds a valid action for legal transitions', () => {
    expect(findAction('draft', 'queued')).toBe('send')
    expect(findAction('ready', 'approved')).toBe('approve')
    expect(findAction('held', 'rejected')).toBe('reject')
    expect(findAction('in_progress', 'ready')).toBe('complete')
  })

  it('returns null for impossible transitions', () => {
    expect(findAction('draft', 'approved')).toBeNull()
    expect(findAction('approved', 'queued')).toBeNull()
    expect(findAction('cancelled', 'in_progress')).toBeNull()
  })

  it('returns null for same-status transitions', () => {
    expect(findAction('queued', 'queued')).toBeNull()
    expect(findAction('error', 'error')).toBeNull()
  })
})
