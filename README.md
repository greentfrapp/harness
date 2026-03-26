# Harness

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
    "do": {
      "prompt_template": "...",
      "needs_worktree": true,
      "default_priority": "normal",
    },
    "discuss": {
      "prompt_template": "...",
      "needs_worktree": false,
      "default_priority": "normal",
    },
  },
  "projects": [
    {
      "name": "my-app",
      "repo_path": "/path/to/repo",
      "target_branch": "main",
    },
  ],
}
```

Add your repositories to the `projects` array. Each project must point to a valid git repo with the specified target branch.

## Agent Configuration

Agents are spawned as child processes of the harness server, so they inherit your global Claude Code settings (e.g. `~/.claude/settings.json`). However, the harness explicitly sets permission flags on the CLI command:

- **`do` tasks** default to `--permission-mode bypassPermissions` (full tool access in the isolated worktree)
- **`discuss` tasks** default to `--allowedTools Read,Glob,Grep,WebSearch,WebFetch` (read-only)

### Customizing with `extra_args`

Use the `agents` config block to append extra CLI flags to every agent invocation:

```jsonc
{
  "agents": {
    "claude-code": {
      "adapter": "claude-code",
      "extra_args": ["--allowedTools", "Bash(npm test),Bash(npm run lint)"],
    },
  },
}
```

`extra_args` are appended after the built-in flags. For `--allowedTools`, the CLI merges multiple flags additively, so this extends the default set rather than replacing it. For `do` tasks this is a no-op since `bypassPermissions` already allows everything.

Other useful `extra_args` examples:

```jsonc
"extra_args": ["--model", "sonnet"]           // use a different model
"extra_args": ["--max-turns", "50"]           // limit agent turns
```

### Overriding permission mode per task type

You can also set `permission_mode` on individual task types:

```jsonc
{
  "task_types": {
    "do": {
      "prompt_template": "...",
      "needs_worktree": true,
      "default_priority": "P2",
      "permission_mode": "plan",
    },
  },
}
```

This overrides the adapter's default permission mode for that task type.

## Scripts

| Command           | Description                                 |
| ----------------- | ------------------------------------------- |
| `pnpm dev`        | Start server and client in development mode |
| `pnpm dev:server` | Start Hono backend with hot-reload          |
| `pnpm dev:client` | Start Vite frontend dev server              |
| `pnpm build`      | Production build of the Vue client          |
| `pnpm start`      | Start the production server                 |
| `pnpm test`       | Run tests                                   |
| `pnpm test:watch` | Run tests in watch mode                     |

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Vue 3 Frontend                     │
│  ┌──────────────┐ ┌─────────────────────────┐   │
│  │   Outbox     │ │        Inbox            │   │
│  │  (Queue +    │ │  (Review + Diff Viewer  │   │
│  │   Session)   │ │   + Actions)            │   │
│  └──────────────┘ └─────────────────────────┘   │
└───────────────────┬─────────────────────────────┘
                    │ SSE + REST
┌───────────────────┴─────────────────────────────┐
│              Hono Backend                       │
│  ┌──────────┐ ┌────────────┐ ┌──────────────┐  │
│  │  Queue   │ │ Dispatcher │ │  Agent Pool  │  │
│  │  Manager │ │            │ │ (Claude Code) │  │
│  └──────────┘ └────────────┘ └──────────────┘  │
│  ┌──────────┐ ┌────────────┐ ┌──────────────┐  │
│  │   SSE    │ │    Git     │ │    SQLite    │  │
│  │ Manager  │ │ Worktrees  │ │  (Drizzle)   │  │
│  └──────────┘ └────────────┘ └──────────────┘  │
└─────────────────────────────────────────────────┘
```

**Stack:** Hono, Vue 3, Tailwind, Pinia, SQLite (better-sqlite3), Drizzle ORM, SSE, Vitest, diff2html

## Project Structure

```
harness/
├── server/
│   ├── index.ts              # Hono entry, startup, SSE endpoint
│   ├── config.ts             # ~/.harness/config.jsonc loader + validation
│   ├── context.ts            # Typed AppContext for dependency injection
│   ├── queue.ts              # Priority queue with dependency tracking
│   ├── dispatcher.ts         # Slot-aware task dispatch scheduler
│   ├── pool.ts               # Agent pool, process lifecycle management
│   ├── git.ts                # Git worktree creation, branch management, merging
│   ├── recovery.ts           # Crash recovery: stale tasks, orphaned processes
│   ├── sse.ts                # SSE broadcast manager
│   ├── log.ts                # Logging utilities
│   ├── agents/
│   │   ├── adapter.ts        # AgentAdapter interface
│   │   ├── claude-code.ts    # Claude Code CLI adapter (spawn, stream, resume)
│   │   └── index.ts          # Adapter registry
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
│   │   │   ├── NewTaskModal.vue
│   │   │   ├── DiffViewer.vue       # Diff display (diff2html)
│   │   │   ├── SessionStream.vue    # Live agent session output
│   │   │   ├── SettingsModal.vue    # Config editor UI
│   │   │   └── ActivityLog.vue      # Task event history
│   │   └── stores/
│   │       ├── useOutbox.ts
│   │       ├── useInbox.ts
│   │       ├── useEvents.ts         # SSE connection + reconnection
│   │       ├── useLog.ts            # Activity log state
│   │       └── taskArrayUtils.ts    # Shared array helpers
│   └── vite.config.ts
└── shared/
    └── types.ts              # TypeScript types shared by server + client
```

## Status

Phase 1 (Foundation) and Phase 2 (Agent Integration + Basic Review) are complete.

- **Phase 1:** Project scaffolding, database, config, task queue, SSE real-time transport, two-column Vue UI with task creation, and critical tests.
- **Phase 2:** Claude Code agent pool with worktree isolation, task dispatch scheduler, live session streaming, diff review in inbox, approve/reject/cancel actions with branch merging, automatic retry via `--resume`, and crash recovery on startup.

See `harness_design.md` for the full roadmap.
