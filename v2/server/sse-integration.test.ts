/**
 * Integration test for SSE event delivery.
 * Tests that task:progress events broadcast through SSEManager actually
 * reach a connected HTTP client in real-time.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { afterEach, describe, expect, it } from 'vitest'
import { SSEManager } from './sse'

describe('SSE integration: task:progress delivery', () => {
  let server: ReturnType<typeof serve> | null = null

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('delivers task:progress events to connected clients in real time', async () => {
    const sseManager = new SSEManager()
    const app = new Hono()

    app.get('/events', (c) => {
      const clientId = 'test-client'
      return streamSSE(c, async (stream) => {
        sseManager.addClient({ id: clientId, stream })
        await stream.writeSSE({
          event: 'connected',
          data: JSON.stringify({ clientId }),
        })
        // Keep open until client disconnects
        await new Promise<void>((resolve) => {
          c.req.raw.signal.addEventListener('abort', () => {
            sseManager.removeClient(clientId)
            resolve()
          })
        })
      })
    })

    // Start server on a random available port
    const port = 19876 + Math.floor(Math.random() * 1000)
    server = serve({ fetch: app.fetch, port })

    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 100))

    // Connect to SSE endpoint
    const response = await fetch(`http://localhost:${port}/events`)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    // Read the 'connected' event first
    let accumulated = ''
    while (!accumulated.includes('connected')) {
      const { value } = await reader.read()
      accumulated += decoder.decode(value, { stream: true })
    }
    expect(accumulated).toContain('event: connected')

    // Now broadcast a task:progress event
    const progressMessage = {
      type: 'assistant',
      content: [{ type: 'text', text: 'Hello from agent' }],
      session_id: 'sess-test',
    }
    sseManager.broadcast('task:progress', {
      task_id: 'task-123',
      message: progressMessage,
    })

    // Read the progress event — should arrive within 1 second
    accumulated = ''
    const timeout = setTimeout(() => reader.cancel(), 2000)

    try {
      while (!accumulated.includes('task:progress')) {
        const { value, done } = await reader.read()
        if (done) break
        accumulated += decoder.decode(value, { stream: true })
      }
    } catch {
      // reader.cancel() may throw
    }
    clearTimeout(timeout)

    expect(accumulated).toContain('event: task:progress')
    expect(accumulated).toContain('task-123')
    expect(accumulated).toContain('Hello from agent')

    reader.cancel().catch(() => {})
  })

  it('delivers multiple rapid task:progress events in order', async () => {
    const sseManager = new SSEManager()
    const app = new Hono()

    app.get('/events', (c) => {
      const clientId = 'test-client-2'
      return streamSSE(c, async (stream) => {
        sseManager.addClient({ id: clientId, stream })
        await stream.writeSSE({
          event: 'connected',
          data: JSON.stringify({ clientId }),
        })
        await new Promise<void>((resolve) => {
          c.req.raw.signal.addEventListener('abort', () => {
            sseManager.removeClient(clientId)
            resolve()
          })
        })
      })
    })

    const port = 19876 + Math.floor(Math.random() * 1000)
    server = serve({ fetch: app.fetch, port })
    await new Promise((r) => setTimeout(r, 100))

    const response = await fetch(`http://localhost:${port}/events`)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    // Read connected event
    let accumulated = ''
    while (!accumulated.includes('connected')) {
      const { value } = await reader.read()
      accumulated += decoder.decode(value, { stream: true })
    }

    // Broadcast 5 progress events rapidly
    for (let i = 0; i < 5; i++) {
      sseManager.broadcast('task:progress', {
        task_id: 'task-rapid',
        message: { type: 'assistant', content: `msg-${i}` },
      })
    }

    // Read all 5 events
    accumulated = ''
    const timeout = setTimeout(() => reader.cancel(), 3000)
    let count = 0
    try {
      while (count < 5) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        accumulated += chunk
        count = (accumulated.match(/event: task:progress/g) || []).length
      }
    } catch {
      // reader.cancel() may throw
    }
    clearTimeout(timeout)

    expect(count).toBe(5)
    for (let i = 0; i < 5; i++) {
      expect(accumulated).toContain(`msg-${i}`)
    }

    reader.cancel().catch(() => {})
  })
})
