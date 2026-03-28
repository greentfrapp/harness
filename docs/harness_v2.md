# Harness v2

## Background

Harness is a tool for developers to manage coding agents the way a team lead manages developers: asynchronously, in parallel, via discrete work assignments.

The developer assigns tasks with clear intent and constraints, checks on progress periodically, reviews deliverables, gives feedback, and unblocks when needed. The agents are fast - minutes per round, not hours. This means the developer context-switches frequently and may have many tasks in flight at once.

## Core Concepts

### Task

The atomic unit in Harness is the Task, which is essentially an assignment from the developer to the agent.

The interface is flat (no nested objects) since the DB columns are flat and nesting would add serialization overhead. Fields are grouped by section comments.

```
Task
  // Core
  id: uuid
  project_id: string
  type: TaskType
  status: TaskStatus
  substatus: TaskSubstatus
  title: string
  prompt: string
  result: string

  // Metadata
  priority: P0 to P3
  tags: string[]
  created_at, updated_at, started_at, completed_at

  // Relations
  parent_id: uuid (subtask of, or follow-up of)
  depends_on: uuid (only start when this task is approved)
  references: uuid[] (informational links for context)

  // Agent
  agent_type: string
  agent_session_data: string
  session_id: string

  // Worktree
  worktree_path: string
  branch_name: string

  // Queue
  retry_count: number
  queue_position: number
```

### Task Type

A task's type is **immutable** — it is set at creation and never changes. There are three task types: `discuss`, `plan`, `do`.

#### `discuss`

The developer talks through a preliminary idea or a question with the agent. This task only has read permissions. The outcome is an analysis or clarification.

#### `plan`

When implementing a larger feature, developers will often break the larger feature into smaller steps. The `plan` task is meant for the agent to do that. This task only has read permissions and the outcome is a set of sub-tasks proposed by the agent via the CLI, along with details about the plan.

#### `do`

The most common task in a development workflow. This may be a standalone implementation of a small edit or as part of a larger feature build. The `do` task has write permissions and the outcome is a set of file changes, as well as a summary of the changes.

#### Transitions (Mode Escalation)

The three task types can be conceived as standalone, but also play their roles in a continuous workflow where an agent may "transition" between task types.

In Harness, these "transitions" act as **task boundaries** — the original task completes and a new task of the target type is spawned, inheriting the session for full conversation continuity. The task's type never mutates.

For example, a developer might start a `discuss` task to explore an idea. When the discussion reaches a natural conclusion, instead of the `discuss` task becoming a `plan` task, a new `plan` task is spun off. The `discuss` task is marked `done` (its result is the analysis/discussion), and the `plan` task resumes the same `session_id` with full conversation context.

Similarly, a `plan` task proposes `do` subtasks via the CLI. The `plan` task stays `in_progress` (substatus: `waiting_on_subtasks`) until all subtasks reach a terminal state. Once they do, the `plan` task itself completes.

This approach is cleaner than in-place mode escalation because:
- Each task's result is preserved cleanly (the discussion, the plan, the code)
- Permissions only widen at task boundaries, never mid-task
- The audit trail is explicit — the chain of discuss → plan → do is visible as linked tasks

The agent requests transitions via the CLI, and the user approves before the new task is created.

### Task Status

A Task has a **status** and an optional **substatus**, stored as separate fields for clean querying.

Statuses: `draft`, `queued`, `in_progress`, `pending`, `done`, `cancelled`.

Substatuses by status:
- `in_progress` → `running`, `retrying`, `waiting_on_subtasks`
- `pending` → `review`, `response`, `error`, `permission`, `task_proposal`
- `done` → (none), `approved`, `rejected`

`done` with no substatus is for read-only tasks (`discuss`, `plan`) that complete without needing approve/reject review. `do` tasks always go through `pending:review` first and end as `done:approved` or `done:rejected`.

### Task Lifecycle Flows

Beyond the basic draft → queued → in_progress → pending:review → done cycle, tasks support several additional flows carried over from v1:

#### Fix

Re-queue an errored or ready task with a fix tag (merge-conflict, checkout-failed, needs-commit). Fix instructions are built at dispatch time. The task returns to `queued` and the agent receives targeted instructions on retry.

#### Revise

Return a pending:review, error, or held task to the outbox with user feedback. The task goes back to `queued`, preserving its worktree, branch, and session. The agent resumes with `--resume` and receives the feedback as its new prompt.

#### Follow-up

Create a new task linked to an approved task via `parent_id`, sharing the session for continuity. The follow-up gets a fresh worktree but inherits the conversation context via `--resume`.

#### Checkout / Return

Check out a `do` task's branch into the main repo for manual testing before accepting. Each repo can have at most one task checked out at a time. Return restores the repo to its target branch. Checkout does not modify the task's branch or status.

#### Retry

Failed tasks auto-retry with `--resume` up to 3 attempts. After max retries, the task moves to the inbox with the error for user decision (revise, fix, or reject).

#### Chat

Any completed task includes a chat UI for inline read-only Q&A. Chat agents run separately from the main task agent, using read-only tools only, without changing task status. Conversation slots are held only during active streaming.

### CLI

The user interacts with Harness via the web client, while the agent interacts with Harness via the CLI. Both rely on the same REST API. The CLI replaces stdout parsing — all structured communication between agent and harness is explicit.

Environment variables injected into agent processes: `HARNESS_TASK_ID`, `HARNESS_API_URL`, `HARNESS_CLI`.

#### Modify Own Task

An agent can use the CLI to modify its own task:
- Set the task result
- Request permissions (task moves to `pending:permission`)

#### Propose Tasks

Both subtasks and mode transitions use the same unified proposal mechanism (`POST /tasks/:id/propose-tasks`). Each proposal can specify `title`, `prompt`, `type`, `priority`, `tags`, `parent_task_id`, `depends_on`, `references`, and `inherit_session`.

- **Subtasks** (`propose-subtasks` CLI): `parent_task_id` defaults to the proposing task. The proposing task waits (`in_progress:waiting_on_subtasks`) until all children complete.
- **Transitions** (`propose-transition-task` CLI): `parent_task_id` is null, `inherit_session` is true. The proposing task completes (`done:approved`) when approved.

Proposals are stored in the `task_proposals` table and surfaced in the UI. The user can approve (spawns the task), dismiss (with feedback), or edit before approving. All proposals are resolved via a single `POST /tasks/:id/resolve-proposals` endpoint.

#### Read Other Tasks

An agent can query data from any other task. This is useful when the user references another task, e.g. "Implement the changes discussed in #abc".

#### (Deferred) Write Other Tasks

Write permissions for other tasks is deferred for now.

## Other Highlights

- For `do` tasks, each task gets its own git worktree and branch. When approved (merged) or rejected, the worktree is deleted but the branch is retained. The branch is only deleted when the task itself is deleted, allowing diff review even after approval.
- `discuss` and `plan` tasks run in the main repo directory with read-only permissions. No worktree needed since no writes occur.
- Worktrees are reused on revise and fix (preserving original commits); fresh worktrees are only created for new tasks.
- Session history is persisted to disk on agent exit for viewing completed task sessions in the UI.
- Two independent concurrency limits: worktree slots (default 3) for `do` tasks, conversation slots (default 5) for `--resume` sessions.
- Dependencies are satisfied only when a task is **approved**, not when the agent finishes.
- Crash recovery: detect stale in_progress/retrying tasks on startup, kill orphaned processes, re-queue or error based on state.

---

## Implementation Checklist

The main idea is to re-implement the current version of Harness but with the above core concepts, mainly:
- Reduced set of statuses with cleaner transitions
- First-class CLI to elevate agent with more task capabilities and reduce the need to parse the JSON
- Task types with Mode Escalation

### Out of scope
- Artifacts will not be implemented for now
- Write Other Tasks CLI command (deferred)

### Phase 0: Shared Foundation ✓

Implemented in `v2/shared/`. The shared layer defines the contract between server, client, and CLI.

- [x] **New status/substatus types** — 6 statuses + substatuses. Status group constants use `StatusPair[]`. Helper functions: `isTerminal()`, `isRunning()`, `isOutbox()`, `isInbox()`.
- [x] **Updated Task type** — Flat interface (no nested metadata/relations objects) with section comments. Added `substatus`, `result`, `references`, `session_id`, `started_at`, `completed_at`. Removed `original_prompt`, `diff_summary`, `diff_full`, `agent_summary`, `error_message`.
- [x] **New transition state machine** — Keyed on `(status, substatus)` pairs with O(1) lookup map. Includes `complete_readonly` (discuss/plan → `done:null`), `request_transition`/`approve_transition` for mode escalation, `dispatch_retry` for retrying dispatch.
- [x] **ViewFilter update** — Filters on `statuses` + `substatuses` arrays.
- [x] **Utility updates** — `getTaskContext()`, `comparePriority()`, status group helpers all updated.
- [x] **Tests** — 53 transition test cases, 37 query test cases. All passing.

### Phase 1: Database & Schema ✓

Implemented in `v2/server/db/`. Fresh schema with no v1 migration baggage.

- [x] **New schema** — `substatus`, `result`, `references` (JSON text), `session_id`, `started_at`, `completed_at` columns. New `task_transitions` table for mode-escalation links. Compound index on `(status, substatus)`.
- [x] **Updated queries** — `deserializeTask()` parses both `tags` and `references` JSON. `getTasksByStatus()` accepts optional substatus filter. New `createTaskTransition()`, `getTaskTransitions()`, `getTransitionChain()`.
- [x] **Tests** — Full coverage including substatus filtering, references round-trip, transition chain traversal.

### Phase 2: Server Core ✓

Implemented in `v2/server/`. These modules form the task execution pipeline, ported from v1 with the v2 status+substatus model.

- [x] **Config** — `v2/server/config.ts` unchanged from Phase 1 — already validates `task_types` with v2 model. Prompt templates, JSONC parsing, project validation all carried over.
- [x] **Queue** — `v2/server/queue.ts` — `isDependencySatisfied()` checks `done:approved`. `dispatch()` sets `in_progress:running` (was just `in_progress`). Priority ordering and position recomputation unchanged.
- [x] **Dispatcher** — `v2/server/dispatcher.ts` — Uses 3-arg `transition(status, substatus, action)`. `dispatch` → `in_progress:running`. `dispatch_error` → `pending:review` (was `error`). Same worktree/conversation slot loop with re-dispatch flag.
- [x] **Pool (AgentPool)** — `v2/server/pool.ts`:
  - Success: `complete` → `pending:review` for `do` tasks, `complete_readonly` → `done:null` for `discuss`/`plan`
  - Failure: `fail` → `in_progress:retrying`, `max_retries` / `dispatch_error` → `pending:review`
  - Permission: `request_permission` → `pending:permission`
  - Plan approval: uses `request_transition` → `pending:review` (was `plan_approval_request` → `held`)
  - Subtasks: `propose_subtasks` → `pending:subtask_approval`, `auto_approve_subtasks` → `in_progress:waiting_on_subtasks`
  - Uses `result` field instead of `error_message`/`agent_summary`/`diff_summary`/`diff_full`
  - `buildFixPrompt()` retained for fix tags (merge-conflict, checkout-failed, needs-commit)
- [x] **Recovery** — `v2/server/recovery.ts` — Detects stale `in_progress:running`, `in_progress:retrying`, `in_progress:waiting_on_subtasks`. `recover_requeue` → `queued:null`, `recover_error` → `pending:review`. Orphaned worktree reconciliation unchanged.
- [x] **SSE** — `v2/server/sse.ts` — Identical to v1. Event payloads carry new status+substatus shape via shared types.
- [x] **Sessions** — `v2/server/sessions.ts` — Identical to v1. Save/load/append/delete session files. Session reuse across mode-escalation chains handled by session_id on Task.
- [x] **Git** — `v2/server/git.ts` — Copied from v1. No changes needed.
- [x] **Agents** — `v2/server/agents/` — Adapter interface and ClaudeCodeAdapter copied from v1. No status-level changes needed.
- [x] **Log** — `v2/server/log.ts` — Identical to v1.
- [x] **Context** — `v2/server/context.ts` — Full `AppContext` with `SSEManager`, `TaskQueue`, `AgentPool`, `Dispatcher`, `queries`, `checkoutState`.
- [x] **Views** — `v2/server/views.ts` — Default views use v2 statuses (`draft`, `queued`, `in_progress` for outbox; `pending`, `done`, `cancelled` for inbox). Removed v1 migration logic.
- [x] **Tests** — 6 test files: `sse.test.ts`, `sessions.test.ts`, `queue.test.ts`, `dispatcher.test.ts`, `pool.test.ts`, `recovery.test.ts`. All assertions updated for v2 status+substatus model. 211 total tests passing.

### Phase 3: Routes (REST API) ✓

Implemented in `v2/server/routes/`. All routes use the v2 transition machine with `(status, substatus)` pairs.

- [x] **Task CRUD** — `GET /tasks` queries by v2 statuses. `POST /tasks` creates with `substatus: null`. `PATCH /tasks/:id` validates transitions via `findAction(fromStatus, fromSubstatus, toStatus, toSubstatus)`.
- [x] **Lifecycle routes** — All action endpoints use `guardTransition(c, status, substatus, action)`:
  - `POST /tasks/:id/send` — `draft:null` → `queued:null`
  - `POST /tasks/:id/fix` — `pending:review` → `queued:null`
  - `POST /tasks/:id/revise` — `pending:review` → `queued:null`
  - `POST /tasks/:id/approve` — `pending:review` → `done:approved` (merge + cleanup for `do` tasks)
  - `POST /tasks/:id/reject` — `pending:review`/`pending:subtask_approval` → `done:rejected`
  - `DELETE /tasks/:id` — cancel via `cancel` action → `cancelled:null`, or permanent delete for terminal/draft
  - `POST /tasks/:id/grant-permission` — `pending:permission` → `queued:null`
  - `POST /tasks/:id/resolve-proposals` — `pending:subtask_approval` → `in_progress:waiting_on_subtasks` or `queued:null`
- [x] **Mode escalation route** — New `POST /tasks/:id/approve-transition` — user approves transition request. Completes source task (`done:approved`), spawns new task of target type with same `session_id` and `parent_task_id`. Records transition in `task_transitions` table.
- [x] **Checkout/return** — Checkout restricted to `pending:review` tasks. Return unchanged.
- [x] **Chat** — `POST /tasks/:id/chat` works on `draft`, `pending`, `done` status tasks.
- [x] **Views** — `v2/server/routes/views.ts` — Unchanged structure, imports from v2 views module.
- [x] **Additional endpoints** — `GET /tasks/:id/transitions` returns mode-escalation chain. `POST /tasks/:id/follow-up` creates follow-up tasks from `pending`/`done` tasks. `GET /tasks/:id/diff` sources diff from branch (no `diff_full` cache field).

### Phase 4: CLI (Agent-Facing) ✓

Implemented in `v2/cli/`. The CLI is the agent's interface to Harness, replacing stdout parsing with explicit commands.

- [x] **CLI framework** — `v2/cli/harness.mjs`. Self-contained Node.js script (no dependencies). Parses subcommands, reads `HARNESS_TASK_ID` and `HARNESS_API_URL` from env. Shared `apiCall()` helper for all HTTP requests. `--task-id` override for all commands.
- [x] **`harness set-result`** — Set the task's result text. `PATCH /tasks/:id` with `result` field. Accepts positional args or `--text` flag.
- [x] **`harness request-permission <tool>`** — `POST /tasks/:id/request-permission` endpoint. Validates `in_progress:running`, transitions to `pending:permission`, stores tool in `agent_session_data.pending_tool`, kills agent via `pool.killAgent()`.
- [x] **`harness propose-subtasks`** — Posts to unified `POST /tasks/:id/propose-tasks`. Each proposal defaults `parent_task_id` to the proposing task (subtask behavior). Supports optional `type`, `priority`, `tags`, `depends_on`, `references` per proposal.
- [x] **`harness propose-transition-task`** — Posts to unified `POST /tasks/:id/propose-tasks` with `parent_task_id: null` and `inherit_session: true`. Accepts `--type <target-type>` and optional `--title`. Both proposal commands are resolved via `POST /tasks/:id/resolve-proposals`.
- [x] **`harness get-task <id>`** — Read another task's data. `GET /tasks/:id`. Prints JSON to stdout.
- [x] **`harness list-tasks [--status] [--project]`** — Query tasks with optional filters. `GET /tasks` with query params. Prints JSON to stdout.
- [x] **Unified proposal mechanism** — Subtasks and transitions share the same `task_proposals` table, `pending:task_proposal` substatus, and `resolve-proposals` endpoint. Per-proposal `parent_task_id` determines parent fate: if any approved proposals have a parent, the proposing task waits; otherwise it completes. Replaced separate `request-transition`/`approve-transition` endpoints.
- [x] **Agent prompt injection** — Updated `pool.ts` `harnessInstructions` to document all CLI commands. Updated `HARNESS_CLI` env var path to `v2/cli/harness.mjs`.
- [x] **Tests** — `v2/cli/harness.test.ts` (CLI arg parsing, mock HTTP server), `v2/server/routes/tasks.test.ts` (cancel/delete + propose-tasks + resolve-proposals with subtask, transition, mixed, and dismiss-all flows), `v2/server/db/queries.test.ts` (proposal relation fields, tags/references round-trip, parent_task_id defaulting).

### Phase 5: Frontend (Vue Client)

The client renders the new model. Depends on shared types and working routes.

- [ ] **Pinia stores** — Update `useTasks.ts` to handle status+substatus. Update `useEvents.ts` SSE handler for new event shapes. Update `useViews.ts` for substatus-aware filtering. Update `useCheckouts.ts` if checkout status references changed.
- [ ] **TaskCard** — Show substatus as a secondary badge. Update status color mapping for the reduced set.
- [ ] **TaskDetail** — Update the detail panel:
  - Show `result` field instead of separate `agent_summary`/`diff_summary`
  - Show task relations (parent chain, subtasks, references)
  - Add mode-escalation approval UI (approve/reject transition request)
  - Update action buttons for new lifecycle routes (fix, revise, approve, reject map to new statuses)
- [ ] **SessionStream** — No major changes expected; stream format is adapter-level.
- [ ] **NewTaskModal** — Ensure task type selector works with v2 types. Remove any UI for fields that no longer exist.
- [ ] **DiffViewer** — Source diff from `result` or the task's branch rather than `diff_full` field.
- [ ] **ViewEditor / ViewPanel** — Update filter UI for status+substatus model.
- [ ] **Default views** — Update outbox/inbox default view definitions to match new status groups.
- [ ] **Chat UI** — Should work with `done` status tasks. Minor wiring updates.
- [ ] **Tests** — Port `useTasks.test.ts`, `useCheckouts.test.ts`, `useLog.test.ts`, `taskArrayUtils.test.ts`, `useTaskSelection.test.ts`.

### Phase 6: Integration & Cleanup

- [ ] **End-to-end smoke test** — Create a task (draft → send → agent runs → pending:review → approve/reject) for each task type. Verify mode escalation flow (discuss → plan → do).
- [ ] **Crash recovery test** — Kill server mid-task, restart, verify recovery logic requeues or errors correctly.
- [ ] **CLI integration test** — Agent spawns, uses CLI to set result and propose subtasks, verify server state.
- [ ] **Remove dead code** — Delete any v1-only status handling, unused fields, old transition rules.
- [ ] **Update CLAUDE.md** — Reflect the new status model, CLI commands, and mode escalation in the project docs.
