import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewConfig } from '../shared/types'
import { DEFAULT_VIEWS, getTaskContext } from '../shared/types'
import { ensureViewsFile, loadViews, resetViews, saveViews, VIEWS_PATH } from './views'

// Mock fs to avoid touching the real filesystem
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}))

const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>
const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>
const mockWriteFileSync = fs.writeFileSync as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getTaskContext', () => {
  it('returns "draft" for draft status', () => {
    expect(getTaskContext('draft')).toBe('draft')
  })

  it('returns "outbox" for outbox statuses', () => {
    expect(getTaskContext('queued')).toBe('outbox')
    expect(getTaskContext('in_progress')).toBe('outbox')
    expect(getTaskContext('retrying')).toBe('outbox')
  })

  it('returns "inbox" for inbox statuses', () => {
    expect(getTaskContext('ready')).toBe('inbox')
    expect(getTaskContext('held')).toBe('inbox')
    expect(getTaskContext('error')).toBe('inbox')
    expect(getTaskContext('permission')).toBe('inbox')
    expect(getTaskContext('approved')).toBe('inbox')
    expect(getTaskContext('rejected')).toBe('inbox')
  })

  it('returns "inbox" for cancelled (fallthrough)', () => {
    expect(getTaskContext('cancelled')).toBe('inbox')
  })
})

describe('ensureViewsFile', () => {
  it('creates views file if it does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    ensureViewsFile()
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      VIEWS_PATH,
      expect.stringContaining('"outbox"'),
      'utf-8',
    )
  })

  it('does not overwrite existing views file', () => {
    mockExistsSync.mockReturnValue(true)
    ensureViewsFile()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })
})

describe('loadViews', () => {
  it('returns defaults when file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    const views = loadViews()
    expect(views).toEqual(DEFAULT_VIEWS)
  })

  it('parses JSONC file with comments', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(`{
      // custom views
      "views": [
        { "id": "custom", "name": "Custom", "filter": { "statuses": ["error"] } }
      ]
    }`)
    const views = loadViews()
    expect(views).toHaveLength(1)
    expect(views[0].id).toBe('custom')
    expect(views[0].filter.statuses).toEqual(['error'])
  })

  it('returns defaults for invalid JSON', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not json at all {{{')
    const views = loadViews()
    expect(views).toEqual(DEFAULT_VIEWS)
  })

  it('returns defaults when views key is missing', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{ "other": true }')
    const views = loadViews()
    expect(views).toEqual(DEFAULT_VIEWS)
  })

  it('returns defaults when views is not an array', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{ "views": "not-array" }')
    const views = loadViews()
    expect(views).toEqual(DEFAULT_VIEWS)
  })
})

describe('saveViews', () => {
  it('saves valid views and returns them', () => {
    const views: ViewConfig[] = [
      { id: 'v1', name: 'View 1', filter: { statuses: ['queued'] } },
    ]
    const result = saveViews(views)
    expect(result).toEqual({ ok: true, views })
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      VIEWS_PATH,
      expect.stringContaining('"v1"'),
      'utf-8',
    )
  })

  it('rejects views without id', () => {
    const result = saveViews([{ id: '', name: 'X', filter: {} } as ViewConfig])
    expect(result).toEqual({
      ok: false,
      error: 'Each view must have a string "id"',
    })
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('rejects views without name', () => {
    const result = saveViews([
      { id: 'v1', name: '', filter: {} } as ViewConfig,
    ])
    expect(result).toEqual({
      ok: false,
      error: 'View "v1" must have a string "name"',
    })
  })

  it('rejects views without filter object', () => {
    const result = saveViews([
      { id: 'v1', name: 'X', filter: null } as unknown as ViewConfig,
    ])
    expect(result).toEqual({
      ok: false,
      error: 'View "v1" must have a "filter" object',
    })
  })

  it('rejects duplicate view IDs', () => {
    const result = saveViews([
      { id: 'dup', name: 'A', filter: {} },
      { id: 'dup', name: 'B', filter: {} },
    ] as ViewConfig[])
    expect(result).toEqual({
      ok: false,
      error: 'Duplicate view ID: "dup"',
    })
  })

  it('saves empty views array', () => {
    const result = saveViews([])
    expect(result).toEqual({ ok: true, views: [] })
    expect(mockWriteFileSync).toHaveBeenCalled()
  })

  it('saves views with all filter fields', () => {
    const views: ViewConfig[] = [
      {
        id: 'full',
        name: 'Full',
        filter: {
          statuses: ['queued', 'error'],
          priorities: ['P0', 'P1'],
          tags: ['bug'],
          project_id: 'proj-1',
        },
      },
    ]
    const result = saveViews(views)
    expect(result).toEqual({ ok: true, views })
    const written = mockWriteFileSync.mock.calls[0][1]
    const parsed = JSON.parse(written)
    expect(parsed.views[0].filter.priorities).toEqual(['P0', 'P1'])
    expect(parsed.views[0].filter.tags).toEqual(['bug'])
  })
})

describe('resetViews', () => {
  it('writes default template and returns DEFAULT_VIEWS', () => {
    const views = resetViews()
    expect(views).toEqual(DEFAULT_VIEWS)
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      VIEWS_PATH,
      expect.stringContaining('"outbox"'),
      'utf-8',
    )
  })
})
