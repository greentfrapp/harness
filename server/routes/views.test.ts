import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewConfig } from '../../shared/types'
import { DEFAULT_VIEWS } from '../../shared/types'
import { loadViews, resetViews, saveViews } from '../views'
import { createViewRoutes } from './views'

vi.mock('../views.ts', () => ({
  loadViews: vi.fn(),
  saveViews: vi.fn(),
  resetViews: vi.fn(),
}))

const mockLoadViews = loadViews as ReturnType<typeof vi.fn>
const mockSaveViews = saveViews as ReturnType<typeof vi.fn>
const mockResetViews = resetViews as ReturnType<typeof vi.fn>

describe('View Routes', () => {
  let app: ReturnType<typeof createViewRoutes>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createViewRoutes()
  })

  describe('GET /views', () => {
    it('returns views from loadViews', async () => {
      const views: ViewConfig[] = [
        { id: 'v1', name: 'V1', filter: { statuses: ['queued'] } },
      ]
      mockLoadViews.mockReturnValue(views)

      const res = await app.request('/views')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(views)
    })

    it('returns default views when no custom views', async () => {
      mockLoadViews.mockReturnValue(DEFAULT_VIEWS)

      const res = await app.request('/views')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveLength(2)
      expect(body[0].id).toBe('outbox')
      expect(body[1].id).toBe('inbox')
    })
  })

  describe('PUT /views', () => {
    it('saves valid views', async () => {
      const views: ViewConfig[] = [
        { id: 'v1', name: 'V1', filter: { statuses: ['error'] } },
      ]
      mockSaveViews.mockReturnValue({ ok: true, views })

      const res = await app.request('/views', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ views }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(views)
      expect(mockSaveViews).toHaveBeenCalledWith(views)
    })

    it('returns 400 when body has no views array', async () => {
      const res = await app.request('/views', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ something: 'else' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('views')
    })

    it('returns 400 when saveViews fails validation', async () => {
      mockSaveViews.mockReturnValue({
        ok: false,
        error: 'Duplicate view ID: "dup"',
      })

      const res = await app.request('/views', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          views: [
            { id: 'dup', name: 'A', filter: {} },
            { id: 'dup', name: 'B', filter: {} },
          ],
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Duplicate')
    })

    it('saves views with all filter types', async () => {
      const views: ViewConfig[] = [
        {
          id: 'full',
          name: 'Full Filters',
          filter: {
            statuses: ['queued', 'ready'],
            priorities: ['P0'],
            tags: ['bug', 'feature'],
            project_id: 'proj-1',
          },
        },
      ]
      mockSaveViews.mockReturnValue({ ok: true, views })

      const res = await app.request('/views', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ views }),
      })
      expect(res.status).toBe(200)
      expect(mockSaveViews).toHaveBeenCalledWith(views)
    })
  })

  describe('POST /views/reset', () => {
    it('resets to default views', async () => {
      mockResetViews.mockReturnValue(DEFAULT_VIEWS)

      const res = await app.request('/views/reset', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(DEFAULT_VIEWS)
      expect(mockResetViews).toHaveBeenCalled()
    })
  })
})
