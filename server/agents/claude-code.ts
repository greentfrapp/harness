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
    allowedTools?: string[];
  }): string[] {
    const args: string[] = ['--output-format', 'stream-json', '--verbose'];

    if (opts.systemPrompt) {
      args.push('--system-prompt', opts.systemPrompt);
    }

    this.applyPermissionArgs(args, opts.usesWorktree, opts.permissionMode, opts.allowedTools);

    // The prompt is passed via -p for non-interactive mode
    args.push('-p', opts.prompt);

    return args;
  }

  buildResumeArgs(opts: { prompt: string; sessionId: string; usesWorktree: boolean; permissionMode?: string; allowedTools?: string[] }): string[] {
    const args: string[] = ['--output-format', 'stream-json', '--verbose'];

    this.applyPermissionArgs(args, opts.usesWorktree, opts.permissionMode, opts.allowedTools);

    args.push('--resume', opts.sessionId);
    args.push('-p', opts.prompt);
    return args;
  }

  /** Apply permission flags based on config override or default behavior. */
  private applyPermissionArgs(args: string[], usesWorktree: boolean, permissionMode?: string, allowedTools?: string[]): void {
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

    // Pre-approve specific granted tools (works alongside permission mode).
    // Skip if bypassPermissions since everything is already allowed.
    const effectiveMode = permissionMode ?? (usesWorktree ? 'bypassPermissions' : undefined);
    if (allowedTools?.length && effectiveMode !== 'bypassPermissions') {
      args.push('--allowedTools', allowedTools.join(','));
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

    // Detect ExitPlanMode tool use: the agent is requesting plan approval.
    // The CLI blocks waiting for user input, so we intercept and handle it.
    if (msg.type === 'assistant' && Array.isArray((msg as any).message?.content)) {
      for (const block of (msg as any).message.content) {
        if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
          return {
            ...base,
            type: 'plan_approval_request',
            summary: typeof block.input?.plan === 'string' ? block.input.plan : undefined,
          };
        }
      }
    }

    // Detect permission denial: in -p mode, the CLI returns a user message with
    // a tool_result error when a tool needs permission. Known formats:
    //   Bash:      "Error: This command requires approval"
    //   WebSearch: "Error: Claude requested permissions to use WebSearch, but you haven't granted it yet."
    if (
      msg.type === 'user' &&
      typeof msg.tool_use_result === 'string' &&
      (msg.tool_use_result.includes('requires approval') ||
       msg.tool_use_result.includes("haven't granted"))
    ) {
      // Extract tool name from "to use <Tool>," pattern when present
      const toolMatch = (msg.tool_use_result as string).match(/to use (\w+)/);
      return { ...base, type: 'permission_request', toolName: toolMatch?.[1] ?? base.toolName };
    }

    if (msg.is_error) {
      return { ...base, type: 'error' };
    }

    return base;
  }
}
