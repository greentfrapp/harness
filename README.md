# Harness

**Version: 0.1.0**

Harness is a local web application that coordinates coding agents around a task queue. Developers dispatch tasks to agents via an outbox, then batch-review completed results in an inbox — optimizing for flow during review rather than during writing.

## Quick Start

```bash
cd harness
pnpm install
pnpm dev
```

This starts the Hono backend on `localhost:3001` and the Vite dev server on `localhost:5173`.

## Configuration

Harness stores its config and database in `~/.harness/`. On first run it creates a default `config.jsonc`:

```jsonc
{
  "worktree_limit": 3,
  "conversation_limit": 5,
  "task_types": {
    "do": { "prompt_template": "...", "needs_worktree": true, "default_priority": "normal" },
    "discuss": { "prompt_template": "...", "needs_worktree": false, "default_priority": "normal" }
  },
  "projects": [
    {
      "name": "my-app",
      "repo_path": "/path/to/repo",
      "target_branch": "main"
    }
  ]
}
```

Add your repositories to the `projects` array. Each project must point to a valid git repo with the specified target branch.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start server and client in development mode |
| `pnpm dev:server` | Start Hono backend with hot-reload |
| `pnpm dev:client` | Start Vite frontend dev server |
| `pnpm build` | Production build of the Vue client |
| `pnpm start` | Start the production server |
| `pnpm test` | Run tests |
| `pnpm test:watch` | Run tests in watch mode |

## Architecture

```
┌─────────────────────────────────────────┐
│           Vue 3 Frontend                │
│  ┌──────────────┐ ┌──────────────────┐  │
│  │   Outbox     │ │     Inbox        │  │
│  │  (Queue)     │ │    (Review)      │  │
│  └──────────────┘ └──────────────────┘  │
└──────────────┬──────────────────────────┘
               │ SSE + REST
┌──────────────┴──────────────────────────┐
│           Hono Backend                  │
│  ┌────────┐ ┌───────┐ ┌─────────────┐  │
│  │ Queue  │ │  SSE  │ │   SQLite    │  │
│  │Manager │ │Manager│ │ (Drizzle)   │  │
│  └────────┘ └───────┘ └─────────────┘  │
└─────────────────────────────────────────┘
```

**Stack:** Hono, Vue 3, Tailwind, Pinia, SQLite (better-sqlite3), Drizzle ORM, SSE, Vitest

## Project Structure

```
harness/
├── server/
│   ├── index.ts              # Hono entry, startup, SSE endpoint
│   ├── config.ts             # ~/.harness/config.jsonc loader + validation
│   ├── context.ts            # Typed AppContext for dependency injection
│   ├── queue.ts              # Priority queue with dependency tracking
│   ├── sse.ts                # SSE broadcast manager
│   ├── db/
│   │   ├── schema.ts         # Drizzle ORM table definitions
│   │   ├── index.ts          # Database initialization
│   │   └── queries.ts        # CRUD operations
│   └── routes/
│       └── tasks.ts          # REST API route factory
├── client/
│   ├── src/
│   │   ├── App.vue           # Two-column layout, keyboard shortcuts
│   │   ├── api.ts            # Centralized API client
│   │   ├── components/
│   │   │   ├── OutboxPanel.vue
│   │   │   ├── InboxPanel.vue
│   │   │   ├── TaskCard.vue
│   │   │   ├── TaskDetail.vue
│   │   │   └── NewTaskModal.vue
│   │   └── stores/
│   │       ├── useOutbox.ts
│   │       ├── useInbox.ts
│   │       └── useEvents.ts  # SSE connection + reconnection
│   └── vite.config.ts
└── shared/
    └── types.ts              # TypeScript types shared by server + client
```

## Status

Phase 1 (Foundation) is complete: project scaffolding, database, config, task queue, SSE real-time transport, two-column Vue UI with task creation, and critical tests. See `docs/design.md` for the full roadmap.
