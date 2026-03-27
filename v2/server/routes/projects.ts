import { Hono } from 'hono'
import {
  CONFIG_PATH,
  getDefaultTaskTypes,
  readConfigRaw,
  saveConfigRaw,
} from '../config'
import type { AppContext } from '../context'
import * as git from '../git'

export function createProjectRoutes(ctx: AppContext) {
  const app = new Hono()
  const { queries, config } = ctx

  app.get('/projects', (c) => {
    return c.json(queries.getAllProjects())
  })

  app.get('/projects/status', (c) => {
    const projects = queries.getAllProjects()
    const statuses = projects.map((p) => {
      const { dirty, fileCount } = git.getRepoStatus(p.repo_path)
      return { projectId: p.id, projectName: p.name, dirty, fileCount }
    })
    return c.json(statuses)
  })

  app.get('/config', (c) => {
    return c.json({ task_types: config.task_types, tags: config.tags })
  })

  /** Return built-in default task types for the "restore defaults" button. */
  app.get('/config/defaults/task-types', (c) => {
    return c.json(getDefaultTaskTypes())
  })

  /** Read raw config.jsonc content for the settings editor. */
  app.get('/config/raw', (c) => {
    return c.json({ content: readConfigRaw(), path: CONFIG_PATH })
  })

  /** Validate and save raw config.jsonc content. */
  app.put('/config/raw', async (c) => {
    const body = await c.req.json<{ content: string }>()
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400)
    }

    const result = saveConfigRaw(body.content)
    if (!result.ok) {
      return c.json({ error: result.error }, 400)
    }

    // Reload config in the running context
    Object.assign(ctx.config, result.config)

    // Re-seed projects from updated config
    queries.seedProjects(result.config)

    return c.json({ ok: true })
  })

  return app
}
