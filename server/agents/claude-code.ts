import type { AgentAdapter, AgentProgressEvent } from './adapter.ts';

/**
 * Claude Code JSON output message types (subset we care about).
 * CC --output-format stream-json --verbose emits one JSON object per line on stdout.
 */
interface CCMessage {
  type: string; // 'assistant', 'tool_use', 'tool_result', 'result', 'system', etc.
  session_id?: string;
  message?: string;
  content?: unknown;
  tool?: string;
  subtype?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  result?: string;
  [key: string]: unknown;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly executable = 'claude';

  buildArgs(opts: {
    prompt: string;
    systemPrompt: string | null;
    usesWorktree: boolean;
    permissionMode?: string;
  }): string[] {
    const args: string[] = ['--output-format', 'stream-json', '--verbose'];

    if (opts.systemPrompt) {
      args.push('--system-prompt', opts.systemPrompt);
    }

    this.applyPermissionArgs(args, opts.usesWorktree, opts.permissionMode);

    // The prompt is passed via -p for non-interactive mode
    args.push('-p', opts.prompt);

    return args;
  }

  buildResumeArgs(opts: { prompt: string; sessionId: string; usesWorktree: boolean; permissionMode?: string }): string[] {
    const args: string[] = ['--output-format', 'stream-json', '--verbose'];

    this.applyPermissionArgs(args, opts.usesWorktree, opts.permissionMode);

    args.push('--resume', opts.sessionId);
    args.push('-p', opts.prompt);
    return args;
  }

  /** Apply permission flags based on config override or default behavior. */
  private applyPermissionArgs(args: string[], usesWorktree: boolean, permissionMode?: string): void {
    if (permissionMode) {
      // Explicit config override
      args.push('--permission-mode', permissionMode);
    } else if (usesWorktree) {
      // Default: Do tasks in isolated worktrees get full permissions
      args.push('--permission-mode', 'bypassPermissions');
    } else {
      // Default: Discuss tasks / plan mode — read-only
      args.push('--allowedTools', 'Read,Glob,Grep,WebSearch,WebFetch');
    }
  }

  parseMessage(line: string): AgentProgressEvent | null {
    let msg: CCMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return null;
    }

    const base: AgentProgressEvent = {
      type: 'progress',
      sessionId: msg.session_id,
      costUsd: msg.cost_usd,
      toolName: msg.tool,
      content: msg.content,
      raw: msg,
    };

    if (msg.type === 'result') {
      return {
        ...base,
        type: 'result',
        summary: typeof msg.result === 'string' ? msg.result : undefined,
      };
    }

    if (msg.subtype === 'permission_request') {
      return { ...base, type: 'permission_request' };
    }

    if (msg.is_error) {
      return { ...base, type: 'error' };
    }

    return base;
  }
}
