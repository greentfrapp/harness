# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev              # Start server (localhost:3001) + client (localhost:5173) concurrently
pnpm dev:server       # Hono backend only, with tsx watch hot-reload
pnpm dev:client       # Vite frontend only
pnpm test             # Run all tests (vitest run, server only)
pnpm test:watch       # Vitest in watch mode
pnpm build            # Production build of Vue client
pnpm start            # Production server (serves built client from client/dist)
pnpm lint             # ESLint
pnpm format           # Prettier
```

Run a single test file: `npx vitest run server/queue.test.ts`

Tests cover `server/**/*.test.ts`, `shared/**/*.test.ts`, and `client/**/*.test.ts`, and run with `fileParallelism: false`.

## Architecture

Harness is a local task queue that dispatches coding tasks to Claude Code CLI agents. Users submit tasks via a web UI (outbox), agents work on them in git worktrees, and completed results land in an inbox for batch review.

**Two built-in task types with different execution models:**

- **`do`** tasks: get a git worktree + branch, agent runs with `--permission-mode bypassPermissions` (full access), changes are merged on approval
- **`discuss`** tasks: run in the repo directly with read-only tools only (`--allowedTools Read,Glob,Grep,WebSearch,WebFetch`), no worktree

Task types are configurable via `task_types` in config. Each `TaskTypeConfig` can set `needs_worktree`, `permission_mode`, and `agent` (referencing the `agents` map). The `agents` map defines named agents with `adapter` and optional `extra_args`.

**Server data flow:** `routes/tasks.ts` (REST) → `TaskQueue` (priority ordering) → `Dispatcher` (slot checking) → `AgentPool` (spawns `claude --output-format stream-json --verbose` subprocesses) → on exit, results go to inbox via SSE broadcast.

**Agent adapter pattern:** `server/agents/adapter.ts` defines a pluggable `AgentAdapter` interface. Currently only `ClaudeCodeAdapter` (`server/agents/claude-code.ts`) is implemented. Adapters handle CLI arg building and stream parsing.

**Dependency injection pattern:** All server modules accept a deps object with function references rather than importing directly. This enables testability — tests pass mock functions instead of hitting the real DB. See `AppContext` in `server/context.ts` for the top-level wiring.

**Key circular dependency:** `AgentPool` and `Dispatcher` reference each other — pool calls `onTaskCompleted` which triggers `dispatcher.tryDispatch()`. Resolved in `server/index.ts` by creating pool first with a closure over `dispatcher`.

**Config:** Stored at `~/.harness/config.jsonc` (JSONC with comments). Parsed with `jsonc-parser`. Projects must point to real git repos with valid target branches. The config is validated at startup and can be edited live via the settings UI (`PUT /api/config/raw`).

**Database:** SQLite via better-sqlite3 + Drizzle ORM. DB lives at `~/.harness/harness.db`. Schema in `server/db/schema.ts`. All queries are synchronous (better-sqlite3 is sync).

**Frontend:** Vue 3 + Pinia stores + Tailwind. SSE connection managed in `stores/useEvents.ts`. The `@shared` path alias maps to `shared/` for importing types shared between server and client.

**Crash recovery:** `server/recovery.ts` detects stale `in_progress`/`retrying` tasks on startup, kills orphaned processes, and re-queues or errors them based on worktree/commit state.

## Task Lifecycle

Beyond basic CRUD, tasks support several flows (routes in `server/routes/tasks.ts`):

- **Draft → send**: Tasks can be created as drafts (`as_draft: true`), then sent to queue via `/tasks/:id/send`
- **Fix**: Re-queue errored/ready tasks with a fix tag (merge-conflict, checkout-failed, needs-commit) via `/tasks/:id/fix` — fix instructions built at dispatch time via `buildFixPrompt()` in `pool.ts`
- **Revise**: Return a ready/error/held task to outbox with feedback via `/tasks/:id/revise`, preserving worktree and session
- **Follow-up**: Create a new task linked to an approved task via `parent_task_id`, sharing the session
- **Plan approval**: Discuss tasks can request plan approval via `ExitPlanMode` tool → task moves to `held` → user approves via `/tasks/:id/approve-plan` → resumes with full permissions
- **Permission grant**: Tasks needing tool approval move to `permission` status → user grants via `/tasks/:id/grant-permission` → tool added to `granted_tools` and task resumes
- **Checkout/return**: Check out a task's branch into the main repo for manual testing (`/tasks/:id/checkout`), then return (`/tasks/:id/return`)
- **Retry**: Failed tasks auto-retry with `--resume` up to 3 attempts. Fix tags provide targeted instructions on retry.

## Shared Types

`shared/types.ts` is the single source of truth for types used by both server and client. Task statuses are split into `DRAFT_STATUSES` (draft), `OUTBOX_STATUSES` (queued, in_progress, retrying), and `INBOX_STATUSES` (ready, held, deferred, error, permission, approved, rejected). Tasks can also be `cancelled`.
