import type { SSEEventType } from '../shared/types.ts';

interface SSEClient {
  id: string;
  write: (data: string) => void;
  close: () => void;
}

export class SSEManager {
  private clients = new Map<string, SSEClient>();

  addClient(client: SSEClient): void {
    this.clients.set(client.id, client);
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  broadcast(event: SSEEventType, data: unknown): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, client] of this.clients) {
      try {
        client.write(message);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export type { SSEClient };
