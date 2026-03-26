import { Hono } from 'hono'
import { loadViews, resetViews, saveViews } from '../views'

export function createViewRoutes(): Hono {
  const app = new Hono()

  // GET /views — list all views
  app.get('/views', (c) => {
    const views = loadViews()
    return c.json(views)
  })

  // PUT /views — save views
  app.put('/views', async (c) => {
    const body = await c.req.json()
    if (!body || !Array.isArray(body.views)) {
      return c.json({ error: 'Request body must have a "views" array' }, 400)
    }
    const result = saveViews(body.views)
    if (!result.ok) {
      return c.json({ error: result.error }, 400)
    }
    return c.json(result.views)
  })

  // POST /views/reset — reset to defaults
  app.post('/views/reset', (c) => {
    const views = resetViews()
    return c.json(views)
  })

  return app
}
