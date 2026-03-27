import type { SSEStreamingApi } from 'hono/streaming'
import type { SSEEventType } from '../shared/types'

interface SSEClient {
  id: string
  stream: SSEStreamingApi
}

export class SSEManager {
  private clients = new Map<string, SSEClient>()

  addClient(client: SSEClient): void {
    this.clients.set(client.id, client)
  }

  removeClient(id: string): void {
    this.clients.delete(id)
  }

  broadcast(event: SSEEventType, data: unknown): void {
    for (const [id, client] of this.clients) {
      client.stream
        .writeSSE({ event, data: JSON.stringify(data) })
        .catch(() => {
          this.clients.delete(id)
        })
    }
  }

  get clientCount(): number {
    return this.clients.size
  }
}

export type { SSEClient }
