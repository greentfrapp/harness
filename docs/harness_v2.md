# Harness v2

## Background

Harness is a tool for developers to manage coding agents the way a team lead manages developers: asynchronously, in parallel, via discrete work assignments.

The developer assigns tasks with clear intent and constraints, checks on progress periodically, reviews deliverables, gives feedback, and unblocks when needed. The agents are fast - minutes per round, not hours. This means the developer context-switches frequently and may have many tasks in flight at once.

## Core Concepts

### Task

The atomic unit in Harness is the Task, which is essentially an assignment from the developer to the agent.

```
Task
- id: uuid
- title: string
- description: string
- result: string
- status: TaskStatus
- substatus: TaskSubstatus
- type: TaskType
- metadata: TaskMetadata
    - project_id: string
    - priority: P0 to P3
    - tags: string[]
    - created_at
    - updated_at
    - started_at
    - completed_at
- relations: TaskRelations
    - parent_id: uuid (subtask of, or follow-up of)
    - depends_on: uuid (only start when this task is approved)
    - references: uuid[] (informational links for context)
- artifacts: Artifact[]
- branch_name: string
- worktree_path: string
- session_id: string
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
- `pending` → `review`, `permission`, `subtask_approval`
- `done` → `accepted`, `rejected`

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
- Append task artifacts
- Request a type transition (e.g. discuss → plan), surfaced to user for approval

#### Create Subtask

Propose sub-tasks for approval by the user. Proposals are stored separately and surfaced in the UI. The user can approve (spawns the task), dismiss (with feedback), or edit before approving.

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

### Phase 0: Shared Foundation

The shared layer defines the contract between server, client, and CLI. Everything else depends on it.

- [ ] **New status/substatus types** — Replace the current flat `TaskStatus` (12 values) with `TaskStatus` (`draft`, `queued`, `in_progress`, `pending`, `done`, `cancelled`) + `TaskSubstatus` (`running`, `retrying`, `waiting_on_subtasks`, `review`, `permission`, `subtask_approval`, `accepted`, `rejected`). Update status group constants (`OUTBOX_STATUSES`, `INBOX_STATUSES`, `TERMINAL_STATUSES`, etc.) to use status+substatus pairs.
- [ ] **Updated Task type** — Restructure `Task` interface: add `substatus`, `result`, `metadata` (with `created_at`, `updated_at`, `started_at`, `completed_at`), `relations` (`parent_id`, `depends_on`, `references`). Remove `original_prompt`, `diff_summary`, `diff_full`, `agent_summary`, `error_message` as separate top-level fields (fold into `result` or `metadata` as appropriate).
- [ ] **New transition state machine** — Rewrite `transitions.ts` with transitions keyed on `(status, substatus)` pairs. All existing `TransitionAction` values need remapping (e.g. `complete` → `in_progress:running` to `pending:review`, `fail` → `in_progress:running` to `in_progress:retrying`). Add mode-escalation transitions (`request_transition`).
- [ ] **ViewFilter update** — Update `ViewFilter` and `DEFAULT_VIEWS` to filter on status+substatus pairs instead of flat status.
- [ ] **Utility updates** — Update `getTaskContext()`, `comparePriority()`, status group helpers.
- [ ] **Tests** — Port `transitions.test.ts` to the new state machine. Cover every edge: illegal transitions, substatus-aware transitions, mode escalation boundaries.

### Phase 1: Database & Schema

- [ ] **New schema** — Rewrite `server/db/schema.ts`: add `substatus` column, `result` column, restructure metadata/relations columns. Add `task_transitions` table for mode-escalation links (source_task_id → spawned_task_id, transition_type).
- [ ] **Migration** — Write a migration from the v1 schema. Map old statuses to new status+substatus pairs (e.g. `ready` → `pending:review`, `held` → `pending:subtask_approval`, `error` → `pending:review` with error in result, etc.).
- [ ] **Updated queries** — Rewrite `server/db/queries.ts` to use new schema. All queries that filter by status must also handle substatus.
- [ ] **Tests** — Port `queries.test.ts`.

### Phase 2: Server Core

These modules form the task execution pipeline. They depend on Phase 0+1.

- [ ] **Config** — Update `server/config.ts` to validate `task_types` config with the v2 model. No changes to project or agent config shape needed.
- [ ] **Queue** — Update `server/queue.ts` to order by status+substatus. Queued tasks are `queued` (no substatus).
- [ ] **Dispatcher** — Update `server/dispatcher.ts` to use new status model when checking slot availability and dispatching. `dispatch` sets status to `in_progress:running`.
- [ ] **Pool (AgentPool)** — Update `server/pool.ts`:
  - On agent exit, map exit codes/results to new statuses (`pending:review`, `in_progress:retrying`, etc.)
  - Remove `buildFixPrompt()` logic that depended on old statuses; rebuild for new model
  - Mode escalation: when agent requests a transition (via CLI), complete the current task (`done:accepted`) and spawn a new task of the target type with the same `session_id` and a `parent_id` link
- [ ] **Recovery** — Update `server/recovery.ts` to detect stale `in_progress:running` / `in_progress:retrying` tasks. Recovery actions map to new statuses.
- [ ] **SSE** — No structural changes to `server/sse.ts`, but event payloads will carry the new status+substatus shape.
- [ ] **Sessions** — Minimal changes to `server/sessions.ts`, just ensure session reuse works across mode-escalation task chains.
- [ ] **Git** — No changes to `server/git.ts` needed.
- [ ] **Context** — Update `AppContext` in `server/context.ts` if any new deps are introduced.
- [ ] **Tests** — Port `queue.test.ts`, `dispatcher.test.ts`, `pool.test.ts`, `recovery.test.ts`, `sessions.test.ts`, `sse.test.ts`, `sse-integration.test.ts`, `streamFilters.test.ts`.

### Phase 3: Routes (REST API)

All routes depend on the new shared types and server core.

- [ ] **Task CRUD** — Update `POST /tasks`, `PATCH /tasks/:id`, `GET /tasks`, `GET /tasks/:id` to use new status+substatus model. `CreateTaskInput` and `UpdateTaskInput` need the new fields.
- [ ] **Lifecycle routes** — Update all action endpoints to use the new transition machine:
  - `POST /tasks/:id/send` — `draft` → `queued`
  - `POST /tasks/:id/fix` — `pending:review` → `queued`
  - `POST /tasks/:id/revise` — `pending:review` → `queued`
  - `POST /tasks/:id/approve` — `pending:review` → `done:accepted` (merge for `do` tasks)
  - `POST /tasks/:id/reject` — various → `done:rejected`
  - `POST /tasks/:id/cancel` — various → `cancelled`
  - `POST /tasks/:id/grant-permission` — `pending:permission` → `queued`
  - `POST /tasks/:id/resolve-proposals` — `pending:subtask_approval` → `in_progress:waiting_on_subtasks` or `queued`
- [ ] **Mode escalation route** — New `POST /tasks/:id/approve-transition` — user approves the agent's transition request, spawning a new task of the target type and completing the source task.
- [ ] **Checkout/return** — Update `POST /tasks/:id/checkout` and `POST /tasks/:id/return` for new statuses.
- [ ] **Chat** — `POST /tasks/:id/chat` — no major changes, just ensure it works with `done` status tasks.
- [ ] **Views** — Update `server/routes/views.ts` for substatus-aware filtering.
- [ ] **Tests** — Port `tasks.test.ts`, `views.test.ts`.

### Phase 4: CLI (Agent-Facing)

The CLI is the agent's interface to Harness. It replaces stdout parsing with explicit commands. Depends on the routes being in place.

- [ ] **CLI framework** — Rewrite `cli/harness.mjs` (or port to TS). Parse subcommands, read `HARNESS_TASK_ID` and `HARNESS_API_URL` from env.
- [ ] **`harness set-result`** — Set the task's result text. `PATCH /tasks/:id` with `result` field.
- [ ] **`harness request-permission <tool>`** — Move task to `pending:permission`. Agent blocks until the task is resumed.
- [ ] **`harness request-transition <target_type>`** — Agent requests mode escalation (e.g. discuss → plan). Task moves to a pending state for user approval.
- [ ] **`harness propose-subtasks`** — Accepts JSON array of subtask proposals. Posts to `POST /tasks/:id/propose-subtasks`.
- [ ] **`harness get-task <id>`** — Read another task's data. `GET /tasks/:id`.
- [ ] **`harness list-tasks [--status] [--project]`** — Query tasks. `GET /tasks` with filters.
- [ ] **Agent prompt injection** — Update `pool.ts` to inject CLI usage instructions (env vars, available commands) into the agent's system prompt at spawn time.
- [ ] **Tests** — Unit tests for CLI arg parsing; integration tests that spawn the CLI against a test server.

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
