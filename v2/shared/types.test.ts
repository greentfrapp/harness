import { describe, expect, it } from 'vitest'
import {
  ALL_STATUS_PAIRS,
  VALID_SUBSTATUSES,
  comparePriority,
  isRunning,
  isTerminal,
  type Priority,
  type Task,
  type TaskStatus,
} from './types'

describe('VALID_SUBSTATUSES', () => {
  it('covers every TaskStatus', () => {
    const allStatuses: TaskStatus[] = [
      'draft',
      'queued',
      'in_progress',
      'pending',
      'done',
      'cancelled',
    ]
    for (const status of allStatuses) {
      expect(
        VALID_SUBSTATUSES[status],
        `Missing VALID_SUBSTATUSES entry for '${status}'`,
      ).toBeDefined()
      expect(VALID_SUBSTATUSES[status].length).toBeGreaterThan(0)
    }
  })

  it('has correct substatuses for each status', () => {
    expect(VALID_SUBSTATUSES.draft).toEqual([null])
    expect(VALID_SUBSTATUSES.queued).toEqual([null])
    expect(VALID_SUBSTATUSES.in_progress).toEqual([
      'running',
      'retrying',
      'waiting_on_subtasks',
    ])
    expect(VALID_SUBSTATUSES.pending).toEqual([
      'review',
      'response',
      'error',
      'permission',
      'task_proposal',
    ])
    expect(VALID_SUBSTATUSES.done).toEqual([null, 'approved', 'rejected'])
    expect(VALID_SUBSTATUSES.cancelled).toEqual([null])
  })
})

describe('ALL_STATUS_PAIRS', () => {
  it('contains the right number of pairs', () => {
    const expected = Object.values(VALID_SUBSTATUSES).reduce(
      (sum, subs) => sum + subs.length,
      0,
    )
    expect(ALL_STATUS_PAIRS).toHaveLength(expected)
  })

  it('every pair has a valid status and substatus', () => {
    for (const pair of ALL_STATUS_PAIRS) {
      const validSubs = VALID_SUBSTATUSES[pair.status]
      expect(
        validSubs,
        `Unknown status '${pair.status}'`,
      ).toBeDefined()
      expect(
        validSubs.includes(pair.substatus),
        `Invalid substatus '${pair.substatus}' for status '${pair.status}'`,
      ).toBe(true)
    }
  })
})


describe('helper functions', () => {
  describe('isTerminal', () => {
    it('returns true for terminal pairs', () => {
      expect(isTerminal('done', 'approved')).toBe(true)
      expect(isTerminal('done', 'rejected')).toBe(true)
      expect(isTerminal('done', null)).toBe(true)
      expect(isTerminal('cancelled', null)).toBe(true)
    })

    it('returns false for non-terminal pairs', () => {
      expect(isTerminal('draft', null)).toBe(false)
      expect(isTerminal('queued', null)).toBe(false)
      expect(isTerminal('in_progress', 'running')).toBe(false)
      expect(isTerminal('pending', 'review')).toBe(false)
    })
  })

  describe('isRunning', () => {
    it('returns true for running pairs', () => {
      expect(isRunning('in_progress', 'running')).toBe(true)
      expect(isRunning('in_progress', 'retrying')).toBe(true)
    })

    it('returns false for non-running pairs', () => {
      expect(isRunning('in_progress', 'waiting_on_subtasks')).toBe(false)
      expect(isRunning('queued', null)).toBe(false)
      expect(isRunning('pending', 'review')).toBe(false)
    })
  })

})

describe('comparePriority', () => {
  function makeTask(priority: Priority, created_at: number): Task {
    return { priority, created_at } as Task
  }

  it('sorts by priority (P0 first)', () => {
    const a = makeTask('P0', 100)
    const b = makeTask('P2', 100)
    expect(comparePriority(a, b)).toBeLessThan(0)
    expect(comparePriority(b, a)).toBeGreaterThan(0)
  })

  it('sorts by created_at when priorities are equal', () => {
    const a = makeTask('P1', 100)
    const b = makeTask('P1', 200)
    expect(comparePriority(a, b)).toBeLessThan(0)
    expect(comparePriority(b, a)).toBeGreaterThan(0)
  })

  it('returns 0 for identical priority and created_at', () => {
    const a = makeTask('P2', 100)
    const b = makeTask('P2', 100)
    expect(comparePriority(a, b)).toBe(0)
  })

  it('sorts all priorities in correct order', () => {
    const tasks = [
      makeTask('P3', 1),
      makeTask('P0', 1),
      makeTask('P2', 1),
      makeTask('P1', 1),
    ]
    tasks.sort(comparePriority)
    expect(tasks.map((t) => t.priority)).toEqual(['P0', 'P1', 'P2', 'P3'])
  })
})
