import type { AgentAdapter } from './adapter.ts';
import { ClaudeCodeAdapter } from './claude-code.ts';

export { type AgentAdapter, type AgentProgressEvent } from './adapter.ts';

const defaultAdapter = new ClaudeCodeAdapter();

export class AgentRegistry {
  private adapters = new Map<string, AgentAdapter>();

  constructor() {
    this.adapters.set(defaultAdapter.id, defaultAdapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  getOrDefault(id?: string): AgentAdapter {
    return this.adapters.get(id ?? 'claude-code') ?? defaultAdapter;
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }
}
