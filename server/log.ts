import type { LogEntry } from '../shared/types.ts';

type LogListener = (entry: LogEntry) => void;

const MAX_ENTRIES = 200;

class ServerLog {
  private entries: LogEntry[] = [];
  private listeners: LogListener[] = [];

  log(level: LogEntry['level'], message: string, taskId?: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      taskId,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  info(message: string, taskId?: string): void {
    this.log('info', message, taskId);
  }

  warn(message: string, taskId?: string): void {
    this.log('warn', message, taskId);
  }

  error(message: string, taskId?: string): void {
    this.log('error', message, taskId);
  }

  getRecent(limit = MAX_ENTRIES): LogEntry[] {
    return this.entries.slice(-limit);
  }

  onEntry(listener: LogListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}

export const serverLog = new ServerLog();
