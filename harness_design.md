# Harness v1 — Design Document

## Context

Developers in the agentic coding era spend more time reviewing AI-generated output than writing code. No existing tool is designed around this review-first workflow. Harness addresses this by providing an inbox/outbox model where developers dispatch tasks to agents and batch-review results, optimizing for flow during review rather than during writing.

## Key Decisions

- **Platform**: Self-hosted web app (localhost)
- **Agent**: Wraps Claude Code (CLI) as the first integrated agent; designed to support additional agents later
- **Stack**: Node.js backend + Vue 3 frontend
- **Batching**: Directory-level grouping + dependency-aware holding

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    Vue 3 Frontend                     │
│                                                       │
│  ┌─────────────────────┐  ┌────────────────────────┐  │
│  │      Outbox         │  │        Inbox      [3]  │  │
│  │     (Queue)         │  │      (Review)          │  │
│  └─────────────────────┘  └────────────────────────┘  │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │  New Task (modal)     [+ New Task] / keyboard    │ │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Task Detail (accordion in-place / expand modal) │ │
│  │  - Live CC session stream (outbox tasks)          │ │
│  │  - Diff viewer (inbox Do tasks)                   │ │
│  │  - Chat UI (any task in conversation mode)        │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────┬───────────────────────────────┘
                       │ SSE
┌──────────────────────┴───────────────────────────────┐
│                  Node.js Backend                      │
│                                                       │
│  ┌──────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  Queue   │  │   Batcher   │  │     Merger      │  │
│  │ Manager  │  │  (Grouping) │  │  (Dry-merge)    │  │
│  └──────────┘  └─────────────┘  └─────────────────┘  │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │              Agent Pool                          │ │
│  │  Worktree limit: 3 (concurrent Do tasks)         │ │
│  │  Conversation limit: 5 (concurrent --resume)     │ │
│  └──────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

---

## Core Concepts

### UI Layout

The main view is a **two-column layout**: Outbox (left) and Inbox (right), both always visible. This gives the user simultaneous awareness of active work and pending reviews.

**New Task** is accessed via a button or keyboard shortcut and opens as a **modal overlay**. The user picks Do or Discuss, optionally sets priority and dependencies, and submits. The modal closes and the task appears in the Outbox.

**Task Detail** uses an **accordion pattern** — clicking a task expands it inline within its column, showing the relevant detail content. An **Expand button** opens the detail in a full modal for more space (useful for diffs and extended conversations). What the detail shows depends on context:
- For an in-progress outbox task: streams the live Claude Code session output
- For a completed Do task in the inbox: shows the diff viewer
- For any task in conversation mode: shows a chat UI (see "Conversational Mode" below)

**Notification badge**: The inbox header shows a count of pending items. The badge turns **red** when permission requests are waiting, since these block agents and need urgent attention.

### Outbox

The queue view. Shows all submitted tasks with their current state (queued, in progress, retrying). At the summary level, each task shows a status indicator, elapsed time, and queue position. The user can click into any task to see the live Claude Code session, or cancel running tasks.

### Inbox

Completed or blocked tasks surfaced for review. Items are grouped by directory overlap and ordered to minimize context-switching. The user reviews, approves, rejects, revises, or defers items. Permission requests are **prioritized above all other items** and tagged with a distinct visual indicator.

### Task Lifecycle

```
User writes task → New Task modal → Outbox/Queue → Agent executes → Batcher → Inbox → User reviews
                                        ↑               ↓ (on failure)           ↓
                                        │          Retry (up to max)    Approve (merge & done)
                                        │               ↓ (max retries) Reject (discard & done)
                                        │          Inbox (with error)    Revise (--resume, back to outbox)
                                        │                                Defer (deprioritize)
                                        └────────────────────────────────────┘
```

---

## Task Types

There are two functional task types in v1, each driving genuinely different system behavior. The user selects the type when submitting a task — no LLM classifier in v1.

| Type | Behavior |
|------|----------|
| **Do** | Dispatch to agent pool. Agent executes the task in a worktree and returns a diff. Covers all actionable work — features, fixes, refactors, tests. |
| **Discuss** | Agent researches the topic using Claude Code's **plan mode** (read-only — no file writes, no code execution). Presents structured analysis in a chat interface. May suggest subtasks that the user can approve and spawn as Do tasks. |

### Conversational Mode

Any task — not just Discuss — can transition into a conversation. When reviewing a completed Do task in the inbox, the user may want to ask quick questions about the changes ("why did you use this approach?" / "what about edge case X?") without formally revising. Clicking into the task opens a chat UI backed by the same Claude Code session (via `--resume`). This keeps the interaction lightweight — the user can ask, get an answer, and still approve/reject without re-entering the outbox flow.

Conversations don't consume worktree slots but are capped at **5 concurrent sessions** (configurable) to bound API cost. Each conversation is a full `--resume` call replaying the prior conversation history to the model.

**Chat vs. Revise boundary**: Conversational mode on Do tasks uses **plan mode** (read-only), even though the worktree still exists. The agent can explain its reasoning, reference code, and answer questions, but cannot modify files. This creates a clean rule:

- **Chat** = plan mode, read-only, stays in inbox. Quick Q&A about the work.
- **Revise** = full mode, resumes in worktree, moves to outbox. New work happens.

If the user asks for changes during chat, the agent explains what it *would* do and the UI prompts a formal **Revise**. Chat never changes code; revise always does.

Discuss tasks start in conversational mode by design. Do tasks enter it on demand.

### Why not more types?

Earlier iterations had Implement, Fix, Schedule, and Discussion as separate types. Implement and Fix were collapsed into Do because they drive identical system behavior — the distinction is cosmetic and a classifier would struggle with fuzzy boundaries ("refactor this broken function"). Schedule was moved to future work (see below).

---

## Core Components

### 1. Concurrency Model

The system uses two independent limits:

- **Worktree limit** (configurable, default 3): Caps concurrent Do tasks actively modifying code. Each Do task gets a fresh git worktree and branch. This is the isolation constraint.
- **Conversation limit** (configurable, default 5): Caps concurrent `--resume` sessions (Q&A on Do tasks, active discussions, permission-blocked agents). Each session is a full API call, so this bounds cost. When the limit is reached, new conversation requests queue until a slot frees.

Discuss tasks do **not** consume worktree slots — they run in plan mode (read-only). This means a user can have 3 Do tasks executing and 5 conversations open simultaneously.

### 2. Task Queue

- Priority queue sorted by: dependency order (blocked tasks should never be started) > priority > recency
- Priority is set by the user when submitting a task (urgent / normal / low, default normal)
- Dependencies are user-declared only. When submitting a task, the user can optionally link it to an existing task as "after X completes"
- Dependencies are satisfied only when a task is **approved** (not when the agent finishes)
- When a worktree slot is free, the queue dispatches the highest-priority ready Do task
- Discuss tasks dispatch immediately (no worktree needed, uses conversation slot)
- The queue is visible in the Outbox — tasks show their state (queued / in progress / retrying) at summary level

### 3. Agent Pool (Claude Code Integration)

Each Do task worker spawns a Claude Code session via CLI:
- Use `claude --json` for structured output
- Use `--allowedTools` to scope permissions per task type
- Each session runs in its own git worktree
- Workers stream progress back to the backend via stdout parsing
- On completion: capture the diff, exit code, conversation summary, and session ID (for `--resume`)

Discuss tasks spawn Claude Code in **plan mode** (`--plan` or equivalent flag), which restricts the agent to read-only operations (file reading, code search, no writes). This runs in the main repo directory without a worktree.

**Isolation via git worktrees**: Each Do task agent works in its own git worktree (separate branch). Results are merged after user review/approval. This prevents file conflicts between concurrent agents and gives each task a clean branch with a reviewable diff.

**Worktree lifecycle**: Worktrees are created fresh for each Do task and destroyed after the task is approved (branch merged), rejected (branch discarded), or cancelled. Fresh creation avoids stale-state contamination from previous tasks — the overhead is seconds, not minutes, and the reliability gain outweighs the cost. When a worktree is destroyed, its slot is immediately freed for the next queued task.

**Error handling**: When an agent fails (crash, timeout, bad state):
1. Retry automatically via `--resume` with the prior session ID (agent sees what went wrong and its prior work)
2. After max retries (default 3), push the task to the inbox with the error message, logs, and partial work
3. The user can then revise (add guidance and retry) or reject (discard)

**Session resumption**: All human-in-the-loop interactions (revise, conversational mode, retries) use Claude Code's `--resume` flag with the stored session ID. This restarts the process and replays the conversation history to the model. This has cost implications — the full prior conversation is re-sent — but preserves complete context. Claude Code has automatic context compaction for long conversations.

**Server crash recovery**: On startup, Harness runs a synchronous recovery routine before accepting connections:
1. **Detect stale tasks**: Query for tasks with status `in_progress` or `retrying` — these were running when the server died.
2. **Kill orphaned processes**: Check if each stale task's CC process is still running (via PID stored in `agent_session_data`). Kill any survivors.
3. **Reconcile worktrees**: Compare `git worktree list` against `worktree_path` in `tasks`. Remove orphaned worktrees with no matching task.
4. **Transition stale tasks**: If the worktree exists with commits, push to inbox as `error` with "server restarted" message (user reviews partial work). If worktree is gone, re-queue for fresh dispatch.
5. **Log**: Write a `task_event` with `event_type = 'recovered'` for each affected task.

The PID is stored in `agent_session_data` alongside the session ID (e.g., `{"session_id": "abc123", "pid": 12345}`).

### 4. Inbox Batcher

When a task completes (or needs user input), it enters the inbox. The batcher groups items using two strategies:

**Directory-level grouping**:
- Group inbox items by the directories they modified (based on actual diff data, not predictions)
- Items touching the same directories are grouped into a single review batch
- User sees e.g. "3 tasks modified src/auth/ — review together"
- No transitive closure — grouping is based on direct directory overlap only

**Dependency-aware holding**:
- If task B depends on task A, and A is in the inbox awaiting review, B's result is held
- Once the user reviews A (approve/reject/modify), B is either released to inbox or re-queued
- Prevents the user from reviewing work that may be invalidated by an upstream decision

**Inbox item states**:
- `ready` — ready for user review
- `held` — waiting for a dependency to be reviewed first
- `deferred` — user explicitly deferred it
- `error` — agent failed after max retries, needs user attention
- `permission` — agent needs a tool permission approval (prioritized above all other items)

### 5. Merger

Handles branch merging and conflict detection. Merges are always against the project's **target branch** (configurable per-project in `config.json`, defaults to the repo's default branch).

**Dry merge**: Before any merge (single or batch), the system performs a `git merge --no-commit --no-ff` test against the current target branch. This is cheap (milliseconds for typical repos) and is re-run automatically whenever the target branch updates (e.g., after a previous task's branch is merged). For batch approves, all branches in the batch are tested both against the current target branch and against each other's cumulative changes.

If conflicts are detected, they are highlighted to the user before any merges execute. Clean items can proceed; conflicting items are flagged for individual resolution.

**Merge execution**: Merges happen sequentially. After each merge, the target branch advances and subsequent dry-merge results may change. The system re-checks remaining items after each merge.

### 6. Inbox Review Experience

Each Do task inbox item presents:
- Task summary (original prompt + type)
- Agent's work summary (what it did, key decisions it made)
- Diff view (files changed)
- The branch name (for the git worktree)
- Error details and retry history (if the task errored)

User actions per item:
- **Approve** — merge the branch into the target branch, task leaves the system
- **Reject** — discard the branch and worktree, task leaves the system. If the rejected task has dependent tasks still queued, the user is notified: they can cancel the dependents, revise them (e.g., remove the dependency), or leave them queued (the dependency becomes unsatisfiable and they'll remain blocked until addressed)
- **Revise** — user adds feedback, task returns to outbox; the prior session is resumed via `--resume`, preserving the worktree branch and all prior work
- **Defer** — push to bottom of inbox, review later
- **Chat** — open conversational mode to ask questions without formally revising (see "Conversational Mode" above)

**Batch review mode**: User can approve/reject multiple grouped items at once, with dry-merge conflict checking as described above.

**Completed tasks cannot be revised.** Once approved, a task is done.

### 7. Cancel

Cancel kills the Claude Code process, destroys the worktree (if any), and deletes the branch — all artifacts are cleaned up.

**Cascading cancellation**: If a cancelled task has dependent tasks (other tasks declared "after X completes"), those dependents are also affected. The system shows a confirmation warning listing all tasks that would cascade. The user can:
- **Confirm cascade** — cancel all dependent tasks
- **Move to inbox** — send the dependent tasks to the inbox for individual review and editing (the user can revise their prompts, remove the dependency, or cancel them individually)

### 8. Claude Code Permissions

When Claude Code encounters a tool use that requires approval, it emits a `permission_request` event in its JSON stream. Harness detects this, kills the agent process, and surfaces the task as an inbox item with status `permission`. These are **prioritized above all other inbox items** and trigger a **red notification badge** on the inbox header, since permission-blocked agents are idle and waiting.

The item shows:
- Which task triggered the request
- What tool the agent wanted to use (stored in `error_message`)

The user can **Grant** (task re-queues and resumes via `--resume` with `--permission-mode bypassPermissions`, giving the agent full tool access going forward) or **Reject** (task is discarded). The kill-and-resume approach is used because Claude Code's CLI does not support sending permission responses via stdin in headless mode.

**Why permission requests happen**: Do tasks normally run with `--permission-mode bypassPermissions` and should never trigger permission prompts. However, resumed sessions (`--resume` for retries, revises, fixes, follow-ups) must explicitly re-pass the permission mode flag. The `buildResumeArgs` method mirrors the permission logic from `buildArgs` to ensure resumed tasks retain their permission mode.

---

## Discussion Task Flow

Discussion tasks use a chat interface from the start, rather than the diff-review interface used by Do tasks. They run in Claude Code's **plan mode** (read-only — file reading and search only, no writes) in the main repo directory without a worktree.

**Concurrency**: Discuss tasks consume a conversation slot (not a worktree slot). Multiple discussions can run concurrently since plan mode is read-only and cannot interfere between sessions.

The flow is:

1. User creates a Discuss task
2. An agent is dispatched in **plan mode** to research the topic (read relevant code, gather context, identify options) — runs in main repo, no worktree
3. The agent produces a structured analysis: problem statement, relevant code references, proposed approaches with tradeoffs
4. This analysis appears in the inbox as a discussion item with a **chat UI**
5. The user responds conversationally — asking follow-ups, narrowing scope, making decisions
6. The agent may suggest **subtasks** — concrete Do tasks derived from the discussion. Subtasks are proposed via a JSON format in the agent's output (see below). If the format is invalid, Harness responds to the agent with an error message prompting retry (max 3 format retries; after that, the raw text is shown and the user creates tasks manually). Proposals appear within the chat for the user to approve (spawning them into the outbox) or dismiss
7. The user closes the discussion when done (no approve/reject — discussions don't produce diffs)

### Subtask Proposal Format

The agent proposes subtasks by including a JSON block in its output:

```json
{
  "subtasks": [
    {
      "title": "Short task title",
      "prompt": "Full task description for the agent",
      "priority": "normal",
      "depends_on": null
    }
  ]
}
```

Harness parses JSON blocks from the agent's output stream. Fields:
- `title` (required): Short label shown in the outbox
- `prompt` (required): The full prompt passed to the Do task agent
- `priority` (optional, default "normal"): "urgent", "normal", or "low"
- `depends_on` (optional): Title of another subtask in the same proposal, for ordering

If parsing fails after 3 retries, Harness shows the raw agent output and lets the user create tasks manually from the New Task modal.

This ensures the user never faces a blank-slate discussion — the agent has already done the legwork.

---

## Agent Prompting Strategy

Harness wraps the user's prompt with a task-type-specific system prompt via Claude Code's `--systemPrompt` flag. System prompts are stored as configurable templates in `config.jsonc` (see Project Configuration), not hardcoded. Users can edit prompts per task type and define custom task types with their own prompts.

### Do task system prompt (default)

```
You are working on a task in a git worktree branch. Your job is to complete the task described below.

Rules:
- Stay focused on the task. Do not make unrelated changes.
- When finished, write a brief summary of what you did and key decisions you made.
- Commit your changes with a clear commit message.

Task:
{user_prompt}
```

### Discuss task system prompt (default)

```
You are in research/plan mode. Your job is to analyze the topic below and present a structured response.

Rules:
- Do NOT modify any files. Read and search only.
- Structure your response as: (1) Problem statement, (2) Relevant code references, (3) Proposed approaches with tradeoffs.
- If you identify concrete implementation tasks, propose them as subtasks using this JSON format:

  {"subtasks": [{"title": "...", "prompt": "...", "priority": "normal", "depends_on": null}]}

- Only propose subtasks when you have a clear, actionable recommendation. Not every discussion needs subtasks.

Topic:
{user_prompt}
```

### Conversational mode

Uses `--resume` with no additional system prompt — the prior session context is sufficient. The user's follow-up message is passed as the new prompt.

### Custom task types

Users can define custom task types in `config.jsonc` with their own system prompt templates. Each custom type specifies:
- A name and system prompt template (with `{user_prompt}` placeholder)
- Whether the type needs a worktree (like Do) or runs read-only (like Discuss)
- Default priority

For example, a "Review" type could instruct the agent to review code and produce a report, or a "Test" type could focus on generating test cases. This makes the Do/Discuss split a default rather than a hard constraint.

These prompts are starting points — small wording changes significantly affect agent behavior. They will need iteration based on testing.

---

## Data Model

Mutable task rows for current state (fast queries) + an append-only events table for history (audit trail, revise history). Conversation history is not stored in Harness — it lives in the agent's own session files, referenced by `agent_session_data`.

### Schema

```sql
-- Configured projects
projects (
  id            TEXT PRIMARY KEY,       -- uuid
  name          TEXT NOT NULL,
  repo_path     TEXT NOT NULL,          -- absolute path to git repo
  target_branch TEXT DEFAULT 'main',
  worktree_limit INTEGER DEFAULT 3,
  conversation_limit INTEGER DEFAULT 5,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)

-- Core task state (mutable)
tasks (
  id            TEXT PRIMARY KEY,       -- uuid
  project_id    TEXT NOT NULL REFERENCES projects(id),
  type          TEXT NOT NULL,          -- 'do' | 'discuss' | custom type name
  status        TEXT NOT NULL,          -- 'queued' | 'in_progress' | 'retrying' | 'ready' |
                                        --   'held' | 'deferred' | 'error' | 'permission' |
                                        --   'approved' | 'rejected' | 'cancelled'
  prompt        TEXT NOT NULL,          -- user's original prompt (+ revise feedback appended)
  priority      TEXT DEFAULT 'normal',  -- 'urgent' | 'normal' | 'low'
  depends_on    TEXT REFERENCES tasks(id),  -- nullable, user-declared dependency
  parent_task_id TEXT,                      -- nullable, links follow-up tasks to their parent (lineage only, not a dependency)
  agent_type    TEXT DEFAULT 'claude-code',  -- which agent adapter to use
  agent_session_data TEXT,              -- agent-specific session state (JSON, nullable until dispatched)
  worktree_path TEXT,                   -- absolute path (nullable, worktree types only)
  branch_name   TEXT,                   -- git branch name (nullable, worktree types only)
  diff_summary  TEXT,                   -- files changed + stats (nullable, populated on completion)
  agent_summary TEXT,                   -- agent's work summary (nullable)
  error_message TEXT,                   -- last error (nullable)
  retry_count   INTEGER DEFAULT 0,
  queue_position INTEGER,               -- for display ordering
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)

-- Append-only event log (audit trail + revise history)
task_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  event_type    TEXT NOT NULL,          -- 'created' | 'dispatched' | 'completed' | 'retried' |
                                        --   'revised' | 'approved' | 'rejected' | 'cancelled' |
                                        --   'permission_requested' | 'permission_resolved' |
                                        --   'deferred' | 'error'
  data          TEXT,                   -- JSON payload (event-specific: revise feedback, error details,
                                        --   permission tool/reason, previous status, etc.)
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)

-- Subtask proposals from Discuss tasks
subtask_proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id),  -- the Discuss task that proposed it
  title         TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  priority      TEXT DEFAULT 'normal',
  depends_on_title TEXT,                -- title of another proposal in same batch (nullable)
  status        TEXT DEFAULT 'pending', -- 'pending' | 'approved' | 'dismissed'
  spawned_task_id TEXT REFERENCES tasks(id),  -- the Do task created on approval (nullable)
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

### Design choices

- **Mutable `tasks` table**: Status, error, retry count, etc. are updated in place. Fast for queue queries (`WHERE status = 'queued' ORDER BY priority, created_at`).
- **Append-only `task_events`**: Every state transition is logged. Revise history is reconstructable from events with `event_type = 'revised'` and the feedback stored in `data`. No data is lost even though the task row is mutable.
- **No conversation storage**: The agent manages its own session files. Harness only stores `agent_session_data` to resume. This avoids duplicating potentially large conversation histories. If a future agent doesn't handle its own persistence, conversation data can be stored in `task_events` as `data` payloads.
- **Agent-agnostic fields**: `agent_type` identifies which adapter to use. `agent_session_data` is a JSON blob each adapter interprets (CC stores a session ID, Codex might store a thread ID, etc.).
- **`subtask_proposals` as a separate table**: Clean separation from the task lifecycle. Links back to both the source Discuss task and the spawned Do task (if approved).
- **Diff storage**: Only the summary (files changed, line counts) is stored in SQLite. The full diff is read from the git worktree on demand.
- **`parent_task_id` for lineage**: Follow-up tasks link to their parent via `parent_task_id` (separate from `depends_on`). This is purely for provenance/UI display — not a dispatch dependency. When a parent is deleted/rejected/cancelled, `clearParentReferences()` nulls out both `depends_on` and `parent_task_id` on children.
- **Custom types**: The `type` column accepts any string, not just 'do'/'discuss'. Task type definitions (including whether a worktree is needed) live in `config.jsonc`.

---

## Project Configuration

Harness runs as a localhost web app and needs to know which repositories to operate on.

**Settings file**: `~/.harness/config.jsonc` — JSONC (JSON with comments) because this is a dev tool and config files benefit from inline documentation. Example:

```jsonc
{
  // Global defaults
  "worktree_limit": 3,
  "conversation_limit": 5,

  // Task types — "do" and "discuss" are built-in, but users can add custom types
  "task_types": {
    "do": {
      "prompt_template": "You are working on a task in a git worktree branch...",
      "needs_worktree": true,
      "default_priority": "normal"
    },
    "discuss": {
      "prompt_template": "You are in research/plan mode...",
      "needs_worktree": false,
      "default_priority": "normal"
    }
    // Custom types example:
    // "review": {
    //   "prompt_template": "Review the following code area and produce a report...",
    //   "needs_worktree": false,
    //   "default_priority": "low"
    // }
  },

  // Projects
  "projects": [
    {
      "name": "my-app",
      "repo_path": "/home/user/projects/my-app",
      "target_branch": "main"
      // Per-project overrides:
      // "worktree_limit": 5
    }
  ]
}
```

The config and SQLite database live in Harness's own directory (`~/.harness/`), **not** inside the repos. This keeps Harness's state separate from the projects it manages and supports projects that span multiple repos.

In v1, the user selects which project/repo to work with at startup or via the UI. Multi-repo tasks (spanning multiple projects) are future work.

---

## Tech Stack

### Backend (Node.js)
- **Framework**: Hono
- **Real-time**: SSE (Server-Sent Events) for task progress and inbox arrivals
- **Process management**: `child_process.spawn` for Claude Code sessions
- **Storage**: SQLite (via better-sqlite3) + Drizzle ORM in `~/.harness/` for task state, queue, and history

### Frontend (Vue 3)
- **Build**: Vite
- **State**: Pinia stores
- **UI**: Two-column layout (Outbox + Inbox), New Task modal, accordion Task Detail with expand-to-modal
- **Diff viewer**: diff2html for side-by-side diff display
- **Real-time**: EventSource SSE client with auto-reconnect and backoff

### Project Structure

```
harness/
├── package.json
├── server/
│   ├── index.ts              # Hono entry, SSE endpoint, startup wiring
│   ├── context.ts            # AppContext type — dependency injection container
│   ├── config.ts             # JSONC config loader/validator
│   ├── queue.ts              # Priority queue with dependency tracking
│   ├── dispatcher.ts         # Queue watcher, slot checking, dispatch logic
│   ├── pool.ts               # Agent pool, worktree mgmt, CC process mgmt
│   ├── git.ts                # Git operations (worktree, merge, branch naming)
│   ├── recovery.ts           # Crash recovery on startup
│   ├── sse.ts                # SSE manager with client tracking and broadcast
│   ├── log.ts                # Server-side activity logging
│   ├── streamFilters.ts      # Filters CC JSON output for displayable content
│   ├── agents/
│   │   ├── adapter.ts        # Agent adapter interface
│   │   ├── claude-code.ts    # Claude Code CLI adapter
│   │   └── index.ts          # Agent registry
│   ├── routes/
│   │   └── tasks.ts          # REST API endpoints
│   └── db/
│       ├── schema.ts         # Drizzle ORM schema
│       ├── queries.ts        # CRUD queries
│       └── index.ts          # DB initialization
├── client/
│   ├── src/
│   │   ├── App.vue
│   │   ├── api.ts            # REST client layer
│   │   ├── components/
│   │   │   ├── NewTaskModal.vue    # Task composition modal (dropdown for custom types)
│   │   │   ├── OutboxPanel.vue     # Left column — queue view
│   │   │   ├── InboxPanel.vue      # Right column — review view with multi-select
│   │   │   ├── TaskCard.vue        # Task summary with inline actions
│   │   │   ├── TaskDetail.vue      # Accordion detail + expand-to-modal
│   │   │   ├── DiffViewer.vue      # diff2html side-by-side display
│   │   │   ├── SessionStream.vue   # Live CC session output with progress buffering
│   │   │   ├── SettingsModal.vue   # JSONC config editor
│   │   │   └── ActivityLog.vue     # Server activity log viewer
│   │   ├── stores/
│   │   │   ├── useOutbox.ts        # Outbox + queue state and actions
│   │   │   ├── useInbox.ts         # Inbox state, review actions
│   │   │   ├── useEvents.ts        # SSE connection, event handlers, reconnection
│   │   │   └── useLog.ts           # Activity log state
│   │   └── composables/
│   │       └── useTaskSelection.ts # Multi-select helper for batch operations
│   └── index.html
└── shared/
    └── types.ts              # Shared TypeScript types (single source of truth)
```

---

## Implementation Phases

### Phase 1: Foundation

**Project setup**
- [x] Initialize monorepo: `package.json`, TypeScript config, Prettier
- [x] Set up Vite + Vue 3 for client (`client/`)
- [x] Set up Hono for server (`server/`) — *changed from Express/Fastify to Hono*
- [x] Set up SQLite via better-sqlite3 + Drizzle ORM (`server/db/`)
- [x] Create `~/.harness/` directory on first run
- [x] JSONC config loader — read and parse `~/.harness/config.jsonc` with defaults
- [x] Validate config on startup (repo paths exist, are git repos, target branches exist)

**Shared types**
- [x] Define core types in `shared/types.ts`: `Task`, `TaskType`, `TaskStatus`, `Priority`, `TaskEvent`, `SubtaskProposal`, `ProjectConfig`, `HarnessConfig`, `CreateTaskInput`, `UpdateTaskInput`
- [x] Define SSE event types: `task:created`, `task:updated`, `task:progress`, `inbox:new`, `inbox:updated` — *changed from WebSocket to SSE*

**Database**
- [x] Create SQLite schema: `projects`, `tasks`, `task_events`, `subtask_proposals` tables
- [x] Seed `projects` table from `config.jsonc` on startup (upsert by name)
- [x] Basic CRUD queries for tasks: create, update status, list by status, list by project

**Task queue**
- [x] Priority queue implementation (`server/queue.ts`): sort by priority > dependency order > recency
- [x] User-declared dependency tracking: `depends_on` field, dependency satisfaction check (approved only)
- [x] Queue dispatch logic: when a worktree slot frees, dispatch highest-priority ready Do task

**Frontend — layout**
- [x] Two-column layout: `OutboxPanel.vue` (left), `InboxPanel.vue` (right)
- [x] Responsive split — both panels always visible
- [x] `NewTaskModal.vue`: task type selector (dropdown, supports custom types from config), prompt textarea, priority picker (urgent/normal/low), optional dependency picker (list of active tasks)
- [x] Keyboard shortcut to open New Task modal (`Ctrl+N` / `Cmd+N`)
- [x] `TaskCard.vue`: summary display with status indicator, elapsed time, queue position
- [x] `TaskDetail.vue`: accordion expand inline with action buttons
- [x] Notification badge on inbox header (count of pending items, red when permissions pending)

**State management**
- [x] `useOutbox.ts` Pinia store: task list, queue state, create/cancel actions
- [x] `useInbox.ts` Pinia store: inbox items, review actions
- [x] `useEvents.ts` Pinia store: SSE connection, event handlers, reconnection logic — *changed from `useSocket.ts`/WebSocket to SSE*

**Real-time (SSE)** — *changed from WebSocket/Socket.io to SSE*
- [x] SSE manager (`server/sse.ts`) with client tracking and broadcast
- [x] SSE endpoint (`GET /events`) in server entry
- [x] SSE client in `useEvents.ts` with auto-reconnect and backoff
- [x] Emit events on task state changes (created, updated, inbox:new)
- [x] Client receives events and updates Pinia stores reactively

**Tests**
- [x] Vitest test infrastructure (`vitest.config.ts`, test scripts)
- [x] TaskQueue unit tests — priority sorting, dependency checking, dispatch (13 tests)
- [x] SSEManager unit tests — client tracking, broadcast formatting (4 tests)
- [x] Route handler tests — API endpoints with mocked AppContext (10 tests)
- [x] DB integration tests — CRUD with in-memory SQLite (9 tests)

**Verification**: Submit a task via the modal, see it appear in the outbox with correct type/priority. Task persists across page reload (SQLite). SSE events flow from server to client. Dependency picker shows existing tasks. 41 tests pass.

### Phase 2: Agent Integration + Basic Review

**Agent pool**
- [x] Agent pool manager (`server/pool.ts`): track worktree slots (default 3) and conversation slots (default 5)
- [x] Spawn Claude Code via `child_process.spawn` with `--json` and `--system-prompt` (from config template)
- [x] Branch naming convention: `harness/{task-id-short}-{sanitized-title}` (max 50 chars)
- [x] Git worktree creation: `git worktree add` from target branch, one per Do task
- [x] Git worktree destruction: `git worktree remove` + branch delete on approval/rejection/cancel
- [x] Store PID and session ID in `agent_session_data` JSON blob
- [x] Discuss tasks: spawn CC with read-only `--allowedTools`, run in main repo directory, no worktree
- [x] Stream CC `--json` output via stdout parsing, emit progress events over SSE — *changed from WebSocket to SSE*

**Task dispatch**
- [x] Queue watcher (`server/dispatcher.ts`): on worktree slot free, dispatch next ready Do task
- [x] Discuss tasks dispatch immediately (consume conversation slot, not worktree slot)
- [x] On agent completion: parse exit code, capture diff (`git diff target..branch`), extract agent summary from CC output, store session ID
- [x] Update task status: `in_progress` → `ready`, move to inbox
- [x] On agent failure: increment `retry_count`, `--resume` with prior session ID, up to max 3 retries
- [x] After max retries: push to inbox as `error` with error message and partial work

**Crash recovery**
- [x] On startup: query tasks with status `in_progress` or `retrying`
- [x] Kill orphaned CC processes via stored PIDs
- [x] Reconcile worktrees: `git worktree list` vs. `worktree_path` in tasks — remove orphans
- [x] Transition stale tasks: worktree with commits → inbox as `error`; no worktree → re-queue
- [x] Log `task_event` with `event_type = 'recovered'`

**Frontend — live session + basic review**
- [x] `SessionStream.vue`: render live CC `--json` output in accordion/modal (tool calls, file edits, assistant messages)
- [x] `DiffViewer.vue`: diff2html component, render `git diff` output — *used diff2html instead of Monaco*
- [x] Outbox task cards: click to expand accordion with SessionStream (in-progress) or summary (completed)
- [x] Inbox task cards: click to expand accordion with DiffViewer + agent summary
- [x] Approve action: merge branch into target branch (`git merge`), destroy worktree, update status to `approved`
- [x] Reject action: destroy worktree + branch, update status to `rejected`
- [x] Reject with dependents: show notification listing blocked tasks, options to cancel/revise/leave them
- [x] Cancel action: kill CC process, destroy worktree + branch, update status to `cancelled`

**Tests**: git.ts unit tests (branch naming), dispatcher unit tests (dispatch logic, slot limits, error handling), recovery unit tests (stale task transitions, orphaned process cleanup), updated route tests (approve/reject/cancel/diff endpoints), pool progress broadcasting tests, stream filter tests, claude-code adapter tests. 124 tests across 11 test files.

**Verification**: Submit a Do task, watch it dispatch to CC, see live session stream in accordion. Task completes, diff appears in inbox. Approve merges to target branch. Reject discards. Cancel kills process. Server restart recovers stale tasks.

### Phase 3: Conversation + Interactive Review

**Conversational mode**
- [ ] `ChatUI.vue`: chat interface component — message list, input field, send button
- [ ] Chat action on inbox Do tasks: `--resume` with stored session ID in plan mode (read-only)
- [ ] Chat consumes a conversation slot (not worktree slot), queues if limit reached
- [ ] Display plan-mode indicator in chat UI ("read-only — use Revise for changes")
- [ ] If agent detects change request in chat, suggest Revise via UI prompt

**Discussion flow**
- [ ] Discuss task dispatch: CC in plan mode with Discuss system prompt
- [ ] Research phase: agent runs autonomously, streams progress (consumes conversation slot)
- [ ] On research completion: transition task from outbox to inbox with chat UI
- [ ] Define Discuss task status transitions: `queued` → `in_progress` (research) → `ready` (in inbox, chat open)
- [ ] Ongoing conversation: user messages sent via `--resume`, agent responds in plan mode
- [ ] Close discussion: user closes chat, task status → `closed`, conversation slot freed
- [ ] Add `closed` to TaskStatus enum for non-diff-producing tasks

**Subtask proposals**
- [ ] `SubtaskProposal.vue`: render proposed subtasks inline in chat with approve/dismiss buttons
- [ ] Parse subtask JSON blocks from agent output stream (format: `{"subtasks": [...]}`)
- [ ] On parse failure: send error message back to agent, retry up to 3 times
- [ ] After 3 format failures: show raw text, user creates tasks manually
- [ ] On user approve: create Do task in outbox with proposed title, prompt, priority, depends_on
- [ ] Store proposals in `subtask_proposals` table, link to source Discuss task and spawned Do task

**Task checkout (manual testing before accept)**
- [ ] "Checkout" button on inbox Do tasks — lets the user load a task's changes into the relevant repo's working tree for manual testing before accepting
- [ ] `POST /api/tasks/:id/checkout`: determines the task's repo (from its project config), merges the task's branch into a temporary branch (`harness/checkout-{task-id}`) based on the target branch, then checks it out in that repo
- [ ] Per-repo checkout tracking: each repo can have at most one task checked out at a time — enforce server-side with a map of `repo_path → checked_out_task_id`; return 409 if the same repo already has a checkout active
- [ ] Multiple repos can have independent checkouts simultaneously (e.g., task A checked out in repo-frontend, task B checked out in repo-backend)
- [ ] UI shows a prominent "Checked Out" banner at the top of the inbox (or globally) listing all currently checked-out tasks and their repos, each with a "Return" button
- [ ] `POST /api/tasks/:id/return`: checks the task's repo back to its target branch, deletes the temporary checkout branch, clears that repo's checkout state
- [ ] Auto-return safety: if the user attempts to Accept/Reject/Checkout/Revise a task in a repo that already has a checkout active, prompt to return the existing checkout first
- [ ] After returning, the user can Accept or Reject as normal — checkout does not modify the task's actual branch or status
- [ ] SSE events `task:checked_out` and `task:returned` (include `repo_path` in payload) to keep all clients in sync

**Revise flow**
- [x] Revise action on inbox Do tasks: user adds feedback text — *`POST /tasks/:id/revise` endpoint, purple "Revise" button in `TaskDetail.vue`*
- [x] `--resume` with stored session ID in full mode (not plan mode), feedback replaces prompt — *`agent_session_data` preserved; pool.ts:92-101 detects session ID and spawns with `--resume`*
- [x] Task returns to outbox with status `queued`, preserving worktree and branch — *changed from `in_progress` to `queued` so dispatcher handles it normally*
- [x] Dispatcher reuses existing worktree for revised tasks — *`dispatchDoTask()` skips `createWorktree` when `task.worktree_path` and `task.branch_name` already exist, preserving original commits*
- [x] Auto-return checkout on revise — *`autoReturnIfCheckedOut(id)` called at start of revise endpoint, matching approve/reject pattern*
- [x] Log `task_event` with `event_type = 'revised'` and feedback in `data`

**Defer**
- [x] Defer action on inbox items: set status to `deferred`, move to bottom of inbox
- [x] Deferred items remain visible but deprioritized — *sorted to bottom in `useInbox.ts` `sortedItems` computed*
- [x] User can un-defer (restore to `ready`) — *via `PATCH /api/tasks/:id`*

**Verification**: Open chat on a completed Do task — verify plan mode (read-only, no file changes). Create a Discuss task — verify research runs, chat opens in inbox, subtask proposals render. Approve a subtask — verify Do task appears in outbox. Checkout a Do task — verify branch is loaded in main repo, banner shows, other checkouts blocked. Return — verify main repo reverts to target branch. Revise a Do task — verify it returns to outbox with feedback.

### Phase 4: Batching + Merging + Advanced Operations

**Inbox batcher**
- [ ] `server/batcher.ts`: on task completion, compute directory-level grouping from actual diff data
- [ ] Group inbox items touching the same directories into review batches (no transitive closure)
- [ ] Assign batch IDs to grouped tasks, emit grouping info over SSE
- [ ] Dependency-aware holding: if task B depends on unapproved task A, set B to `held`
- [ ] On task A approval/rejection: release or re-evaluate held dependents

**Merger**
- [ ] `server/merger.ts`: dry-merge implementation (`git merge --no-commit --no-ff` in temp area)
- [ ] Single-item dry merge: test branch against current target branch before approve
- [ ] Batch dry merge: test all branches against target + each other's cumulative changes
- [ ] Re-run dry merge automatically when target branch advances (after any approval)
- [ ] Surface conflict results to frontend via SSE event

**Frontend — batching + merge UX**
- [ ] `InboxBatch.vue`: grouped review items with shared header ("3 tasks modified src/auth/")
- [ ] Conflict indicators: visual flag on items with dry-merge conflicts
- [ ] Batch approve button: approve all clean items in a group, flag conflicting items
- [ ] Batch reject button: reject all items in a group
- [ ] Merge conflict → auto-create Do task in outbox (with conflict context in prompt)

**Cancel cascading**
- [x] On cancel/reject/delete: clear `depends_on` and `parent_task_id` on children — *`clearParentReferences()` in `queries.ts`, called from reject, cancel, and all delete paths*
- [ ] Show confirmation dialog listing all tasks in cascade chain
- [ ] Confirm cascade: cancel all dependents recursively
- [ ] Move to inbox: send dependents to inbox for individual review/editing

**Permission requests**
- [x] Detect CC permission prompts from `--json` output stream — *`ClaudeCodeAdapter.parseMessage()` detects `subtype: 'permission_request'` and returns `type: 'permission_request'` event*
- [x] Kill agent and create inbox item with status `permission`, store tool name in `error_message` — *`handleAgentEvent()` in `pool.ts` detects permission_request, calls `killAgent()`, updates status, broadcasts `inbox:new`*
- [x] Prioritize permission items above all others in inbox — *`useInbox.ts` `sortedItems` sorts `permission` status first*
- [x] Red notification badge when permissions are pending — *`hasPermissionRequests` computed in `useInbox.ts`, pulsing red badge in `statusConfig`*
- [x] Grant: re-queue task with `--resume` and `--permission-mode bypassPermissions` — *`POST /tasks/:id/grant-permission` route preserves `agent_session_data`/worktree/branch; `buildResumeArgs` now passes permission flags matching `buildArgs`*
- [x] Reject: user rejects the task (discard branch and worktree) — *reuses existing reject flow*

**Verification**: Submit 3 Do tasks touching overlapping directories. Verify they're grouped in inbox. Batch approve — confirm sequential merge with re-check after each. Introduce a conflict — verify it's flagged before merge. Approve conflicting items — verify auto-created conflict-resolution task. Cancel a task with dependents — verify cascade warning. Permission request — verify red badge, approve/deny flow.

### Additional Implemented Features (not in original phases)

These features were implemented during development but weren't tracked in the original phase plan:

- **Revise flow**: `POST /tasks/:id/revise` returns a `ready` or `error` task to the outbox with new feedback, preserving `agent_session_data`, `worktree_path`, and `branch_name`. The agent resumes via `--resume` in the same worktree with full conversation context. The dispatcher reuses the existing worktree (skipping `createWorktree`) so original commits are preserved. Auto-returns any active checkout before re-queuing. This is the primary pre-approval feedback mechanism.
- **Follow-up flow**: `POST /tasks/:id/follow-up` creates a continuation task from an `approved` parent, carrying forward the session ID for `--resume` in a fresh worktree. Uses `parent_task_id` for lineage (not `depends_on`). Guarded against concurrent follow-ups on the same parent (409).
- **Orphan cleanup**: `clearParentReferences()` nulls out `depends_on` and `parent_task_id` on children when a parent task is rejected, cancelled, or deleted — preventing orphaned tasks from being blocked forever on unsatisfiable dependencies.
- **Fix flow**: `POST /tasks/:id/fix` re-queues a task with `[MERGE CONFLICT]` context prepended to the prompt, preserving `agent_session_data`, `worktree_path`, and `branch_name`. The agent resumes via `--resume` in its existing worktree and merges `target_branch` to resolve conflicts directly, rather than redoing work from scratch. Auto-returns any active checkout. Used when merge fails on approve.
- **Bulk operations**: `POST /tasks/bulk-delete` (delete by IDs) and `DELETE /tasks?status=...` (delete by status filter) with multi-select UI in `InboxPanel.vue`.
- **Activity log**: `ActivityLog.vue` + `useLog.ts` + `server/log.ts` — server-side activity log streamed via SSE `log:entry` events, capped at 200 entries.
- **Progress buffering**: `GET /api/tasks/:id/progress` returns buffered agent output for late-joining SSE clients, so they see prior progress when expanding a running task.
- **Stream filters**: `server/streamFilters.ts` filters Claude Code `--json` output to extract displayable content (assistant messages, tool calls, results) from metadata noise.
- **Settings modal**: `SettingsModal.vue` with JSONC editor, real-time parse error detection, and hot-reload via `PUT /api/config/raw`.
- **Permission handling**: When an agent emits a `permission_request` event, `handleAgentEvent()` kills the process, sets status to `permission` (with tool name in `error_message`), and pushes to inbox. `POST /tasks/:id/grant-permission` re-queues preserving session/worktree so the agent resumes with `--permission-mode bypassPermissions`. `buildResumeArgs` now mirrors the permission logic from `buildArgs`, ensuring resumed tasks (retries, revises, fixes, follow-ups) retain their permission mode — this was the root cause of permission requests appearing in the first place.

---

## Resolved Design Decisions

- **Concurrency model**: Two independent limits — worktree slots (default 3) for concurrent Do tasks, and conversation slots (default 5) for `--resume` sessions. Discuss tasks consume conversation slots, not worktree slots. This decouples code-modification isolation from lightweight interactions.
- **Merge conflicts**: When two approved branches conflict, the conflict is automatically created as a new Do task that enters the outbox. This keeps the system self-consistent — everything flows through the same inbox/outbox loop.
- **Task types**: Collapsed from four (Implement, Fix, Discussion, Schedule) to two functional types (Do, Discuss). Each maps to genuinely different system behavior.
- **Dependencies**: User-declared only in v1. No LLM inference — too unreliable and no mechanism to correct mistakes.
- **Dependency completion**: Dependencies are satisfied only when a task is approved, not when the agent finishes. Dependent tasks won't start executing until the prerequisite is approved.
- **UI layout**: Two-column (Outbox + Inbox) always visible. New Task opens as a modal. Task Detail uses accordion inline with expand-to-modal for full-screen viewing.
- **Notification badge**: Inbox count badge turns red for permission requests. Permissions are prioritized above all other inbox items.
- **Batcher algorithm**: Directory-level grouping based on actual diff data, no transitive closure. Simple and predictable.
- **Discussion UX**: Chat interface within the task detail, not the diff-review interface. Discussions don't produce diffs — they produce conversation and may suggest subtasks.
- **Discuss task isolation**: Uses Claude Code plan mode (read-only) in main repo directory. Safe for concurrent execution since no writes occur. General read-only enforcement for non-CC agents is future work.
- **Conversational mode**: Any task (not just Discuss) can transition into a conversation via `--resume`. Capped at 5 concurrent sessions to bound API cost. Allows quick Q&A on Do task results without formal revision.
- **Error handling**: Retry via `--resume` with history preservation, max 3 retries, then push to inbox with error for user decision.
- **Worktree lifecycle**: Fresh worktrees created per Do task, destroyed after approval/rejection/cancellation. Worktrees are reused on revision and merge-conflict fix (preserving original commits); fresh creation only for new tasks. Discuss tasks don't use worktrees.
- **Revise behavior**: Two mechanisms depending on task state. **Pre-approval** (Revise): `POST /tasks/:id/revise` returns the same task to the outbox with `queued` status, preserving worktree, branch, and session data. The agent resumes via `--resume` in the same worktree. **Post-approval** (Follow-up): `POST /tasks/:id/follow-up` creates a new task with the parent's session ID and a `parent_task_id` link, dispatching immediately with a fresh worktree from the updated target branch. Only one active follow-up per parent task is allowed.
- **Session resumption**: All human-in-the-loop interactions (revise, conversational mode, retries) use `--resume`. Full conversation is replayed to the model. Claude Code has automatic context compaction for long conversations.
- **Context accumulation**: Deferred to future work. Claude Code handles automatic compaction internally. If this proves insufficient, Harness can add explicit summarization later.
- **Batch approve**: Dry-merge all branches against target branch first. Re-check after each sequential merge. Highlight conflicts before executing. Clean items proceed; conflicting items flagged.
- **Dry merge timing**: Cheap operation (milliseconds). Re-run automatically whenever target branch updates.
- **Target branch**: Configurable per-project in `config.json`. Defaults to the repo's default branch. All worktree branches are created from and merged back into this branch.
- **No classifier in v1**: User selects task type (Do/Discuss) and priority manually. Removes the only external API dependency from the critical path, enabling fully offline operation.
- **Cancel behavior**: Kills CC process, destroys worktree, deletes branch. Children's `depends_on` and `parent_task_id` are nulled out via `clearParentReferences()`, unblocking them. Full cascade UI (confirmation dialog, recursive cancel) is not yet implemented.
- **Reject with dependents**: User is notified of blocked dependents in the response. Children's `depends_on` and `parent_task_id` are nulled out automatically. Options: cancel them, revise them, or leave them queued (now unblocked).
- **Live progress**: Outbox shows task status at summary level (state indicator, elapsed time). Clicking a task opens accordion detail with live CC session stream; expand button opens modal for more space.
- **Subtask spawning**: JSON format with `title`, `prompt`, `priority`, `depends_on` fields. Max 3 format retries; fallback to raw text with manual task creation. User approves or dismisses each proposal.
- **Claude Code permissions**: Tool permission requests surface as priority inbox items with red badge. User approves or denies. Agent continues or adapts accordingly.
- **Project config**: JSONC settings file (`~/.harness/config.jsonc`) with project list, per-project settings (target branch, limits), and task type definitions. DB and config live in `~/.harness/`, separate from repos. Single-project focus in v1.
- **Custom task types**: Users can define custom task types with their own system prompt templates. Each type specifies whether it needs a worktree and its default priority. Do and Discuss are built-in defaults, not hard constraints.
- **Agent prompting**: System prompts are stored as configurable templates in `config.jsonc`, passed via `--systemPrompt`. Do tasks get worktree-aware instructions; Discuss tasks get read-only research instructions with subtask JSON format.
- **Data model**: Mutable `tasks` table for current state + append-only `task_events` for audit trail. Agent-specific session data stored as a JSON blob (`agent_session_data`) with an `agent_type` field, keeping the schema adaptable for future agents. Conversation history managed by the agent (not duplicated in Harness).
- **Server crash recovery**: On startup, detect stale tasks via SQLite, kill orphaned processes via stored PIDs, reconcile worktrees with filesystem, and transition tasks to `error` (partial work reviewable) or `queued` (re-dispatch). Runs synchronously before accepting connections.
- **Chat vs. Revise boundary**: Conversational mode on Do tasks uses plan mode (read-only). Chat never changes code; revise always does. If the user requests changes during chat, the agent explains what it would do and the UI prompts a formal Revise.
- **External repo changes**: Out of scope for v1. Future work will add periodic sync/re-validation.
- **Agent-agnostic abstraction**: Deferred to future work, but v1 implementation should use a clean agent manager interface so Claude Code integration is swappable.

## Open Issues

### P1 — Must resolve during implementation

**~~`projects` table duplicates `config.jsonc`~~** — RESOLVED
Option (a) was implemented: `config.jsonc` is the source of truth. `seedProjects()` upserts into SQLite on startup and on config save via `PUT /api/config/raw`. The `projects` table serves as a foreign key target for `tasks`; runtime settings are always read from the config.

**Discuss task research phase consumes conversation slots unnecessarily**
The initial research phase (steps 1-3 in Discussion Flow) is autonomous — the agent works without user interaction. But it's counted against the conversation limit because Discuss tasks use conversation slots. If a user creates 5 Discuss tasks simultaneously, they fill all 5 conversation slots with non-interactive research, blocking any actual conversations. The research phase behaves more like a Do task (one-shot autonomous work) than a conversation. Consider: research phase consumes a separate "agent slot" (or even a worktree slot with read-only access), and the conversation slot is only consumed once the user begins interacting.

**Discuss task lifecycle in the outbox is unclear**
A Discuss task is created, appears in the outbox, the agent researches, then the result "appears in the inbox as a discussion item with a chat UI." But what happens to the outbox entry? Current implementation: Discuss tasks follow the same status transitions as Do tasks (`queued` → `in_progress` → `ready`), moving from outbox to inbox on completion. No special handling exists yet. The outbox shows "in progress" during research, which is acceptable for short research phases but unclear for long-running discussions.

**Discussion close state is undefined**
The doc says "the user closes the discussion when done" but doesn't specify the resulting state. Current implementation: Discuss tasks use the same terminal states as Do tasks (`approved`/`rejected`/`cancelled`). No `closed` status exists. This works but is semantically awkward — "approving" a discussion that produced no diff.

**~~No branch naming strategy~~** — RESOLVED
Convention: `harness/{8-char-task-id}-{sanitized-prompt}` (max 40 chars for prompt portion). Implemented in `server/git.ts:makeBranchName()`. Example: task `abc123de` with prompt "Fix login bug" → `harness/abc123de-fix-login-bug`.

**~~Custom task types and the New Task modal~~** — RESOLVED
The `NewTaskModal.vue` uses a `<select>` dropdown populated from config task types, not a Do/Discuss toggle. Scales to any number of custom types defined in `config.jsonc`.

### P2 — Known tradeoff, acceptable for v1

**Merge-order problem with worktrees**
Approving multiple tasks that touched different files can still produce conflicts: task A and B merge cleanly individually, but together they change the context around task C's changes. The "conflicts become Do tasks" decision could create a conflict loop in high-coupling repos. Dry-merge checks mitigate this for batch approves, but sequential individual approves still have the problem.

**No way to edit task metadata after submission** — PARTIALLY RESOLVED
`PATCH /api/tasks/:id` allows editing status, prompt, priority, and other fields via API. However, the frontend has no edit UI — the modal only allows creation, not subsequent editing. Editing is available via the REST API but not in the Vue interface. The cancel/re-create workaround still applies for UI users.

**No graceful shutdown**
Crash recovery handles ungraceful shutdown, but there's no specification for graceful shutdown (Ctrl+C). No `SIGTERM`/`SIGINT` handlers exist in `server/index.ts`. Should running agents be killed immediately, waited on to finish, or paused for later resume? A graceful shutdown that saves state cleanly would prevent unnecessary crash recovery on normal restarts.

---

## Future Work

- **LLM classifier**: Auto-classify task type, priority, and scope hints. Could also infer dependencies between tasks. Deferred because v1 only has two task types (a binary choice the user can make themselves) and removing the classifier keeps the tool fully offline with no API key needed.
- **Schedule task type**: Recurring tasks (weekly tests, daily checks) requiring a persistent daemon, cron integration, and schedule management UI. Fundamentally different from the core inbox/outbox flow.
- **Task history and analytics**: Track completed tasks, success/failure rates, agent performance over time.
- **Agent roles**: Initialize different agent roles (e.g. engineer, QA, designer, UI copywriter). Different task types might require reviews by groups of different roles.
- **Multiplayer**: Support for teams beyond solo developers - multiple developers working together, or teams with multiple roles, replacing or complementary to agent roles.
- **Conflict detection**: Proactively warn when concurrent tasks are likely to overlap in scope, before they conflict at merge time.
- ~~**Settings UI**~~: Implemented — `SettingsModal.vue` provides a JSONC config editor with real-time validation, backed by `GET/PUT /api/config/raw`.
- **External repo sync**: Watch for external changes to the target branch (direct commits, pulls) and re-validate in-progress worktrees and dry-merge results.
- **Multi-repo tasks**: Tasks that span multiple repositories in the project config.
- **Agent-agnostic abstraction**: Define the interface for plugging in agents beyond Claude Code. V1 should use a clean agent manager interface to make this feasible.
- **Permission quick actions**: V2 inbox badge click shows a list of pending permission requests for rapid approve/deny without opening full inbox items.
- **General read-only enforcement**: Plan mode is CC-specific. For other agents, a general mechanism to enforce read-only research (e.g., filesystem permissions, container isolation) would be needed.
- **Context compaction controls**: If CC's automatic compaction proves insufficient for long-lived tasks, add explicit summarize-and-compact controls in the UI.
