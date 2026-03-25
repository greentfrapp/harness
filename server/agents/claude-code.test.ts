import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from './claude-code.ts';

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter();

  it('has correct id and executable', () => {
    expect(adapter.id).toBe('claude-code');
    expect(adapter.executable).toBe('claude');
  });

  describe('buildArgs', () => {
    it('includes base flags', () => {
      const args = adapter.buildArgs({
        prompt: 'test',
        systemPrompt: null,
        usesWorktree: false,
      });
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--verbose');
    });

    it('passes prompt via -p', () => {
      const args = adapter.buildArgs({
        prompt: 'do something',
        systemPrompt: null,
        usesWorktree: false,
      });
      const pIdx = args.indexOf('-p');
      expect(pIdx).toBeGreaterThan(-1);
      expect(args[pIdx + 1]).toBe('do something');
    });

    it('includes --system-prompt when provided', () => {
      const args = adapter.buildArgs({
        prompt: 'test',
        systemPrompt: 'be helpful',
        usesWorktree: false,
      });
      const idx = args.indexOf('--system-prompt');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('be helpful');
    });

    it('omits --system-prompt when null', () => {
      const args = adapter.buildArgs({
        prompt: 'test',
        systemPrompt: null,
        usesWorktree: false,
      });
      expect(args).not.toContain('--system-prompt');
    });

    it('adds --permission-mode bypassPermissions for worktree tasks', () => {
      const args = adapter.buildArgs({
        prompt: 'test',
        systemPrompt: null,
        usesWorktree: true,
      });
      const idx = args.indexOf('--permission-mode');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('bypassPermissions');
      expect(args).not.toContain('--allowedTools');
    });

    it('adds --allowedTools for non-worktree (discuss) tasks', () => {
      const args = adapter.buildArgs({
        prompt: 'test',
        systemPrompt: null,
        usesWorktree: false,
      });
      const idx = args.indexOf('--allowedTools');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('Read,Glob,Grep,WebSearch,WebFetch');
      expect(args).not.toContain('--permission-mode');
    });

    it('uses permissionMode from config when provided', () => {
      const args = adapter.buildArgs({
        prompt: 'test',
        systemPrompt: null,
        usesWorktree: true,
        permissionMode: 'plan',
      });
      const idx = args.indexOf('--permission-mode');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('plan');
    });

    it('permissionMode overrides default for non-worktree tasks', () => {
      const args = adapter.buildArgs({
        prompt: 'test',
        systemPrompt: null,
        usesWorktree: false,
        permissionMode: 'bypassPermissions',
      });
      const idx = args.indexOf('--permission-mode');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('bypassPermissions');
      expect(args).not.toContain('--allowedTools');
    });

    it('appends --allowedTools for granted tools with non-bypass permission mode', () => {
      const args = adapter.buildArgs({
        prompt: 'test',
        systemPrompt: null,
        usesWorktree: true,
        permissionMode: 'default',
        allowedTools: ['Bash', 'Write'],
      });
      expect(args).toContain('--allowedTools');
      const idx = args.lastIndexOf('--allowedTools');
      expect(args[idx + 1]).toBe('Bash,Write');
    });

    it('skips --allowedTools when bypassPermissions is active', () => {
      const args = adapter.buildArgs({
        prompt: 'test',
        systemPrompt: null,
        usesWorktree: true,
        allowedTools: ['Bash'],
      });
      // Default for worktree is bypassPermissions — allowedTools should be skipped
      expect(args).not.toContain('--allowedTools');
    });
  });

  describe('buildResumeArgs', () => {
    it('includes --resume with session id', () => {
      const args = adapter.buildResumeArgs({
        prompt: 'test',
        sessionId: 'sess-123',
        usesWorktree: true,
      });
      const idx = args.indexOf('--resume');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('sess-123');
    });

    it('includes base flags and prompt', () => {
      const args = adapter.buildResumeArgs({
        prompt: 'continue',
        sessionId: 'sess-123',
        usesWorktree: true,
      });
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--verbose');
      const pIdx = args.indexOf('-p');
      expect(pIdx).toBeGreaterThan(-1);
      expect(args[pIdx + 1]).toBe('continue');
    });

    it('adds --permission-mode bypassPermissions for worktree resume', () => {
      const args = adapter.buildResumeArgs({
        prompt: 'continue',
        sessionId: 'sess-123',
        usesWorktree: true,
      });
      const idx = args.indexOf('--permission-mode');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('bypassPermissions');
      expect(args).not.toContain('--allowedTools');
    });

    it('adds --allowedTools for non-worktree resume', () => {
      const args = adapter.buildResumeArgs({
        prompt: 'continue',
        sessionId: 'sess-123',
        usesWorktree: false,
      });
      expect(args).toContain('--allowedTools');
      expect(args).not.toContain('--permission-mode');
    });

    it('uses permissionMode from config when provided on resume', () => {
      const args = adapter.buildResumeArgs({
        prompt: 'continue',
        sessionId: 'sess-123',
        usesWorktree: true,
        permissionMode: 'plan',
      });
      const idx = args.indexOf('--permission-mode');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('plan');
    });

    it('appends --allowedTools for granted tools on resume', () => {
      const args = adapter.buildResumeArgs({
        prompt: 'continue',
        sessionId: 'sess-123',
        usesWorktree: true,
        permissionMode: 'default',
        allowedTools: ['Bash(curl:*)', 'WebSearch'],
      });
      const idx = args.lastIndexOf('--allowedTools');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('Bash(curl:*),WebSearch');
    });
  });

  describe('parseMessage', () => {
    it('returns null for invalid JSON', () => {
      expect(adapter.parseMessage('not json')).toBeNull();
      expect(adapter.parseMessage('')).toBeNull();
    });

    it('parses a result message', () => {
      const msg = JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        result: 'Done, updated the README.',
        cost_usd: 0.05,
      });
      const event = adapter.parseMessage(msg);
      expect(event).not.toBeNull();
      expect(event!.type).toBe('result');
      expect(event!.summary).toBe('Done, updated the README.');
      expect(event!.sessionId).toBe('sess-1');
      expect(event!.costUsd).toBe(0.05);
    });

    it('parses a permission request from "requires approval" format', () => {
      const msg = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            content: 'This command requires approval',
            is_error: true,
            tool_use_id: 'toolu_01VEtj6LusjYDzCWYq7CnALj',
          }],
        },
        tool_use_result: 'Error: This command requires approval',
        session_id: 'sess-1',
      });
      const event = adapter.parseMessage(msg);
      expect(event).not.toBeNull();
      expect(event!.type).toBe('permission_request');
    });

    it('parses a permission request from "haven\'t granted" format and extracts tool name', () => {
      const msg = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            content: "Claude requested permissions to use WebSearch, but you haven't granted it yet.",
            is_error: true,
            tool_use_id: 'toolu_014DxoQmHMKg4AUBY6eJAmZp',
          }],
        },
        tool_use_result: "Error: Claude requested permissions to use WebSearch, but you haven't granted it yet.",
        session_id: 'sess-1',
      });
      const event = adapter.parseMessage(msg);
      expect(event).not.toBeNull();
      expect(event!.type).toBe('permission_request');
      expect(event!.toolName).toBe('WebSearch');
    });

    it('parses an error message', () => {
      const msg = JSON.stringify({
        type: 'system',
        is_error: true,
        content: 'something went wrong',
      });
      const event = adapter.parseMessage(msg);
      expect(event).not.toBeNull();
      expect(event!.type).toBe('error');
    });

    it('parses a progress message', () => {
      const msg = JSON.stringify({
        type: 'assistant',
        session_id: 'sess-1',
        content: 'thinking...',
      });
      const event = adapter.parseMessage(msg);
      expect(event).not.toBeNull();
      expect(event!.type).toBe('progress');
      expect(event!.sessionId).toBe('sess-1');
    });

    it('preserves raw message', () => {
      const original = { type: 'tool_use', tool: 'Read', session_id: 'x' };
      const event = adapter.parseMessage(JSON.stringify(original));
      expect(event!.raw).toEqual(original);
    });

    it('parses real Claude Code assistant format (message is API object)', () => {
      const original = {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'I will help you.' }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: 'sess-1',
      };
      const event = adapter.parseMessage(JSON.stringify(original));
      expect(event).not.toBeNull();
      expect(event!.type).toBe('progress');
      expect(event!.raw).toEqual(original);
    });

    it('parses assistant with array content blocks', () => {
      const original = {
        type: 'assistant',
        session_id: 'sess-1',
        content: [{ type: 'text', text: 'I will help you.' }],
      };
      const event = adapter.parseMessage(JSON.stringify(original));
      expect(event).not.toBeNull();
      expect(event!.type).toBe('progress');
      expect(event!.raw).toEqual(original);
    });

    it('parses assistant with thinking-only content', () => {
      const original = {
        type: 'assistant',
        session_id: 'sess-1',
        content: [{ type: 'thinking', thinking: 'Let me consider...' }],
      };
      const event = adapter.parseMessage(JSON.stringify(original));
      expect(event).not.toBeNull();
      expect(event!.raw).toEqual(original);
    });

    it('parses system init message (metadata-only)', () => {
      const original = {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/home/user/project',
        model: 'claude-sonnet-4-20250514',
        tools: ['Read', 'Write', 'Bash'],
      };
      const event = adapter.parseMessage(JSON.stringify(original));
      expect(event).not.toBeNull();
      expect(event!.type).toBe('progress');
      expect(event!.sessionId).toBe('sess-1');
      expect(event!.raw).toEqual(original);
    });

    it('parses tool_use with object content', () => {
      const original = {
        type: 'tool_use',
        tool: 'Read',
        session_id: 'sess-1',
        content: { file_path: '/src/index.ts' },
      };
      const event = adapter.parseMessage(JSON.stringify(original));
      expect(event).not.toBeNull();
      expect(event!.type).toBe('progress');
      expect(event!.toolName).toBe('Read');
      expect(event!.raw).toEqual(original);
    });

    it('parses tool_result with string content', () => {
      const original = {
        type: 'tool_result',
        tool: 'Read',
        session_id: 'sess-1',
        content: 'const x = 1;\n',
      };
      const event = adapter.parseMessage(JSON.stringify(original));
      expect(event).not.toBeNull();
      expect(event!.raw).toEqual(original);
    });

    it('parses metadata-only assistant message', () => {
      const original = {
        type: 'assistant',
        cost_usd: 0.01,
        duration_ms: 500,
        model: 'claude-sonnet-4-20250514',
      };
      const event = adapter.parseMessage(JSON.stringify(original));
      expect(event).not.toBeNull();
      expect(event!.raw).toEqual(original);
    });
  });
});
