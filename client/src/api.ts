import type {
  CheckoutInfo,
  CreateTaskInput,
  LogEntry,
  Project,
  RepoStatus,
  TagConfig,
  Task,
  TaskEvent,
  UpdateTaskInput,
  ViewConfig,
} from '@shared/types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export const api = {
  projects: {
    list: () => request<Project[]>('/api/projects'),
    status: () => request<RepoStatus[]>('/api/projects/status'),
  },
  config: {
    get: () =>
      request<{
        task_types: Record<string, unknown>
        tags: Record<string, TagConfig>
      }>('/api/config'),
    getRaw: () => request<{ content: string; path: string }>('/api/config/raw'),
    saveRaw: (content: string) =>
      request<{ ok: boolean }>('/api/config/raw', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
  },
  views: {
    list: () => request<ViewConfig[]>('/api/views'),
    save: (views: ViewConfig[]) =>
      request<ViewConfig[]>('/api/views', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ views }),
      }),
    reset: () =>
      request<ViewConfig[]>('/api/views/reset', { method: 'POST' }),
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
      request<{ deleted: string }>(`/api/tasks/${id}?permanent=true`, {
        method: 'DELETE',
      }),
    clearAll: (statuses: string[]) =>
      request<{ deleted: string[] }>(
        `/api/tasks?status=${statuses.join(',')}`,
        { method: 'DELETE' },
      ),
    bulkDelete: (ids: string[]) =>
      request<{ deleted: string[] }>('/api/tasks', {
        method: 'DELETE',
        ...json({ ids }),
      }),
    approve: (id: string) =>
      request<
        Task & {
          blocked_dependents?: Array<{
            id: string
            prompt: string
            status: string
          }>
        }
      >(`/api/tasks/${id}/approve`, { method: 'POST' }),
    reject: (id: string) =>
      request<
        Task & {
          blocked_dependents?: Array<{
            id: string
            prompt: string
            status: string
          }>
        }
      >(`/api/tasks/${id}/reject`, { method: 'POST' }),
    retry: (id: string) =>
      request<Task>(`/api/tasks/${id}/retry`, { method: 'POST' }),
    fix: (
      id: string,
      type?: 'merge-conflict' | 'checkout-failed' | 'needs-commit',
    ) =>
      request<Task>(
        `/api/tasks/${id}/fix`,
        type ? json({ type }) : { method: 'POST' },
      ),
    grantPermission: (id: string) =>
      request<Task>(`/api/tasks/${id}/grant-permission`, { method: 'POST' }),
    approvePlan: (id: string) =>
      request<Task>(`/api/tasks/${id}/approve-plan`, { method: 'POST' }),
    revise: (id: string, prompt: string) =>
      request<Task>(`/api/tasks/${id}/revise`, json({ prompt })),
    followUp: (id: string, prompt: string) =>
      request<Task>(`/api/tasks/${id}/follow-up`, json({ prompt })),
    send: (
      id: string,
      body?: { prompt?: string; priority?: string; depends_on?: string | null },
    ) => request<Task>(`/api/tasks/${id}/send`, json(body ?? {})),
    diff: (id: string) =>
      request<{ diff: string; stats: string; uncommitted?: boolean }>(
        `/api/tasks/${id}/diff`,
      ),
    events: (id: string) => request<TaskEvent[]>(`/api/tasks/${id}/events`),
    progress: (id: string) =>
      request<{ messages: unknown[] }>(`/api/tasks/${id}/progress`),
    checkout: (id: string) =>
      request<{ ok: boolean; checkout_branch: string }>(
        `/api/tasks/${id}/checkout`,
        { method: 'POST' },
      ),
    return_: (id: string) =>
      request<{ ok: boolean }>(`/api/tasks/${id}/return`, { method: 'POST' }),
  },
  checkouts: {
    list: () => request<CheckoutInfo[]>('/api/checkouts'),
  },
  log: {
    recent: () => request<LogEntry[]>('/api/log'),
  },
}
