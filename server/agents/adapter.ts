/**
 * Agent adapter interface — abstracts CLI-specific details so the pool
 * can work with any coding agent (Claude Code, Codex, etc.).
 */

/** Structured progress event emitted by an adapter's message parser. */
export interface AgentProgressEvent {
  type:
    | 'progress'
    | 'result'
    | 'permission_request'
    | 'plan_approval_request'
    | 'error'
  sessionId?: string
  summary?: string
  costUsd?: number
  toolName?: string
  content?: unknown
  raw: unknown // original parsed message, forwarded via SSE
}

/** What every CLI adapter must implement. */
export interface AgentAdapter {
  /** Unique identifier matching config keys and DB agent_type column. */
  readonly id: string

  /** The CLI binary to spawn (e.g. 'claude', 'codex'). */
  readonly executable: string

  /** Build CLI args for a fresh task. */
  buildArgs(opts: {
    prompt: string
    systemPrompt: string | null
    usesWorktree: boolean
    permissionMode?: string
    allowedTools?: string[]
  }): string[]

  /** Build CLI args for resuming a previously failed task. */
  buildResumeArgs(opts: {
    prompt: string
    sessionId: string
    usesWorktree: boolean
    permissionMode?: string
    allowedTools?: string[]
  }): string[]

  /** Parse a single stdout line into a structured event, or null to skip. */
  parseMessage(line: string): AgentProgressEvent | null
}
