import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '@shared/types'
import { useLog } from '../src/stores/useLog'

const mockList = vi.fn().mockResolvedValue([])

vi.mock('../src/api', () => ({
  api: {
    log: {
      recent: (...args: unknown[]) => mockList(...args),
    },
  },
}))

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: Date.now(),
    level: 'info',
    message: 'test',
    ...overrides,
  } as LogEntry
}

describe('useLog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockList.mockResolvedValue([])
  })

  it('starts with empty entries', () => {
    const store = useLog()
    expect(store.entries).toEqual([])
  })

  it('fetchRecent populates entries from API', async () => {
    const entries = [makeEntry({ message: 'a' }), makeEntry({ message: 'b' })]
    mockList.mockResolvedValue(entries)
    const store = useLog()
    await store.fetchRecent()
    expect(store.entries).toEqual(entries)
  })

  it('onLogEntry pushes a new entry', () => {
    const store = useLog()
    const entry = makeEntry()
    store.onLogEntry(entry)
    expect(store.entries).toHaveLength(1)
  })

  it('onLogEntry trims to 200 entries when exceeding max', () => {
    const store = useLog()
    // Fill with 200 entries
    for (let i = 0; i < 200; i++) {
      store.onLogEntry(makeEntry({ message: `msg-${i}` }))
    }
    expect(store.entries).toHaveLength(200)

    // Adding one more should trim to 200, dropping the oldest
    store.onLogEntry(makeEntry({ message: 'overflow' }))
    expect(store.entries).toHaveLength(200)
    expect(store.entries[store.entries.length - 1].message).toBe('overflow')
    expect(store.entries[0].message).toBe('msg-1')
  })
})
