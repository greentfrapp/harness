import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckoutInfo } from '@shared/types'
import { useCheckouts } from '../src/stores/useCheckouts'

vi.mock('../src/api', () => ({
  api: {
    checkouts: {
      list: vi.fn().mockResolvedValue([]),
    },
  },
}))

function makeCheckout(overrides: Partial<CheckoutInfo> = {}): CheckoutInfo {
  return {
    taskId: crypto.randomUUID(),
    taskPrompt: 'test task',
    repoPath: '/repo',
    projectName: 'test-project',
    projectId: 'proj-1',
    ...overrides,
  }
}

describe('useCheckouts', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts empty', () => {
    const store = useCheckouts()
    expect(store.checkouts).toEqual([])
    expect(store.hasCheckouts).toBe(false)
  })

  describe('onCheckedOut', () => {
    it('inserts a new checkout', () => {
      const store = useCheckouts()
      const info = makeCheckout()
      store.onCheckedOut(info)
      expect(store.checkouts).toHaveLength(1)
      expect(store.hasCheckouts).toBe(true)
    })

    it('upserts an existing checkout by taskId', () => {
      const store = useCheckouts()
      const info = makeCheckout({ repoPath: '/old' })
      store.onCheckedOut(info)
      store.onCheckedOut({ ...info, repoPath: '/new' })
      expect(store.checkouts).toHaveLength(1)
      expect(store.checkouts[0].repoPath).toBe('/new')
    })
  })

  describe('onReturned', () => {
    it('removes checkout by taskId', () => {
      const store = useCheckouts()
      const info = makeCheckout()
      store.onCheckedOut(info)
      store.onReturned({ taskId: info.taskId })
      expect(store.checkouts).toHaveLength(0)
    })
  })

  describe('queries', () => {
    it('isCheckedOut returns true for checked-out task', () => {
      const store = useCheckouts()
      const info = makeCheckout()
      store.onCheckedOut(info)
      expect(store.isCheckedOut(info.taskId)).toBe(true)
      expect(store.isCheckedOut('other')).toBe(false)
    })

    it('getCheckoutForRepo finds by repoPath', () => {
      const store = useCheckouts()
      const info = makeCheckout({ repoPath: '/my/repo' })
      store.onCheckedOut(info)
      expect(store.getCheckoutForRepo('/my/repo')?.taskId).toBe(info.taskId)
      expect(store.getCheckoutForRepo('/other')).toBeUndefined()
    })

    it('getCheckoutForProject finds by projectId', () => {
      const store = useCheckouts()
      const info = makeCheckout({ projectId: 'proj-x' })
      store.onCheckedOut(info)
      expect(store.getCheckoutForProject('proj-x')?.taskId).toBe(info.taskId)
      expect(store.getCheckoutForProject('proj-y')).toBeUndefined()
    })

    it('isProjectLockedByOtherTask returns true for a different task', () => {
      const store = useCheckouts()
      const info = makeCheckout({ projectId: 'proj-1' })
      store.onCheckedOut(info)
      expect(store.isProjectLockedByOtherTask('proj-1', 'other-task')).toBe(true)
    })

    it('isProjectLockedByOtherTask returns false for the same task', () => {
      const store = useCheckouts()
      const info = makeCheckout({ projectId: 'proj-1' })
      store.onCheckedOut(info)
      expect(store.isProjectLockedByOtherTask('proj-1', info.taskId)).toBe(false)
    })

    it('isProjectLockedByOtherTask returns false when no checkout', () => {
      const store = useCheckouts()
      expect(store.isProjectLockedByOtherTask('proj-1', 'any')).toBe(false)
    })
  })
})
