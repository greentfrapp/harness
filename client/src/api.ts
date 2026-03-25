import type {
  Project,
  Task,
  TaskEvent,
  LogEntry,
  CreateTaskInput,
  UpdateTaskInput,
} from '@shared/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  projects: {
    list: () => request<Project[]>('/api/projects'),
  },
  config: {
    get: () =>
      request<{ task_types: Record<string, unknown> }>('/api/config'),
    getRaw: () =>
      request<{ content: string; path: string }>('/api/config/raw'),
    saveRaw: (content: string) =>
      request<{ ok: boolean }>('/api/config/raw', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
  },
  tasks: {
    list: (statuses: string[]) =>
      request<Task[]>(`/api/tasks?status=${statuses.join(',')}`),
    get: (id: string) =>
      request<Task & { events: TaskEvent[] }>(`/api/tasks/${id}`),
    create: (input: CreateTaskInput) =>
      request<Task>('/api/tasks', json(input)),
    update: (id: string, body: UpdateTaskInput) =>
      request<Task>(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    cancel: (id: string) =>
      request<Task>(`/api/tasks/${id}`, { method: 'DELETE' }),
    delete: (id: string) =>
      request<{ deleted: string }>(`/api/tasks/${id}?permanent=true`, { method: 'DELETE' }),
    clearAll: (statuses: string[]) =>
      request<{ deleted: string[] }>(`/api/tasks?status=${statuses.join(',')}`, { method: 'DELETE' }),
    approve: (id: string) =>
      request<Task & { blocked_dependents?: Array<{ id: string; prompt: string; status: string }> }>(
        `/api/tasks/${id}/approve`,
        { method: 'POST' },
      ),
    reject: (id: string) =>
      request<Task & { blocked_dependents?: Array<{ id: string; prompt: string; status: string }> }>(
        `/api/tasks/${id}/reject`,
        { method: 'POST' },
      ),
    retry: (id: string) =>
      request<Task>(`/api/tasks/${id}/retry`, { method: 'POST' }),
    fix: (id: string) =>
      request<Task>(`/api/tasks/${id}/fix`, { method: 'POST' }),
    diff: (id: string) =>
      request<{ diff: string; stats: string }>(`/api/tasks/${id}/diff`),
    events: (id: string) =>
      request<TaskEvent[]>(`/api/tasks/${id}/events`),
  },
  log: {
    recent: () => request<LogEntry[]>('/api/log'),
  },
};
