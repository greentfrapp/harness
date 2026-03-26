# Dogfood Issues — Implementation Plan

Derived from [dogfood_notes_20260326.md](./dogfood_notes_20260326.md) and [interaction-modes.md](./interaction-modes.md).

## 1. Plan Mode (New Task Type)

**Goal:** Add a first-class "Plan" task type whose purpose is to analyze a request and propose subtasks via the existing subtask CLI.

**Approach:**
- Add a `plan` task type in config: `needs_worktree: false`, read-only tools (like discuss)
- Inject a system prompt telling the agent its job is to propose subtasks via `harness propose-subtasks`
- The existing `subtasks_proposed` → review → approve flow handles the rest
- Reuse the subtask CLI (`harness propose-subtasks`) as the output mechanism

**Decision:** Plan tasks require subtask proposals — if the agent finishes without proposing any, the task is moved to error status.

## 2. Mode Transitions (Discuss → Do / Plan)

**Goal:** Allow a completed Discuss task to spawn a Do or Plan task that shares the conversation context.

**Approach:**
- Add "Start Do task" / "Start Plan task" buttons on completed Discuss tasks in the UI
- Extend the existing follow-up endpoint to allow specifying a different task type (currently forces same type as parent)
- Copy the session ID so the new task resumes the conversation via `--resume`
- Pre-fill the prompt with user-editable text

**Note:** This is a small extension of the existing Follow-up flow with a type override.

## 3. State Preservation Across Inbox/Outbox Bouncing

**Goal:** Ensure original context and full history are preserved and visible as tasks bounce between inbox and outbox (revise, fix, permission grant, follow-up, subtask review).

### Current State

| Data | Stored in DB? | Visible after completion? |
|------|---------------|--------------------------|
| Original prompt | Overwritten on revise | No (replaced by feedback) |
| Agent summary | Yes | Yes (only this) |
| Full session history | No (session_id only) | No — lost when progress buffer clears |
| Full diff (`diff_full`) | Yes | No — diff viewer only shown for `ready` tasks |
| Diff summary | Yes | Yes |

### Gaps to Address

1. **Original prompt lost on revise** — store `original_prompt` separately or stop overwriting the prompt field. The original prompt should always be visible in the UI regardless of how many revise cycles occur.

2. **Session history not persisted** — the in-memory progress buffer (200 messages max) is the only record of the conversation. Once the server restarts or the buffer rotates, it's gone. Need to persist messages to DB or disk so they survive restarts and remain viewable on completed tasks.

3. **Completed/rejected tasks don't show full session or diffs** — the SessionStream and DiffViewer components exist but aren't rendered for terminal statuses (`approved`, `rejected`). These should be shown read-only for completed tasks.

## 4. Collapsible Tool Calls in Live Session

**Goal:** Make tool call details collapsible so the session stream isn't overwhelming.

**Current behavior:**
- Tool *results* already collapse when long (>500 chars or >10 lines)
- Tool *use* blocks (input/command) are always fully expanded

**Approach:**
- Make the entire tool call (use + result) collapsible as a unit
- Collapsed state shows just the tool name + summary line (e.g., `Read server/pool.ts`)
- Click to expand and see full input and result
- Default to collapsed for completed tool calls, expanded for the most recent one

**Scope:** UI-only change in `SessionStream.vue`.

## Implementation Order

1. Plan mode — new task type + prompt injection (contained)
2. Mode transitions — extend follow-up to allow type changes (small)
3. State preservation — persist session history, preserve original prompt, show full details on completed tasks (largest)
4. Collapsible tool calls — UI change (small)
