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
  });

  describe('buildResumeArgs', () => {
    it('includes --resume with session id', () => {
      const args = adapter.buildResumeArgs({
        prompt: 'test',
        sessionId: 'sess-123',
      });
      const idx = args.indexOf('--resume');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('sess-123');
    });

    it('includes base flags and prompt', () => {
      const args = adapter.buildResumeArgs({
        prompt: 'continue',
        sessionId: 'sess-123',
      });
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--verbose');
      const pIdx = args.indexOf('-p');
      expect(pIdx).toBeGreaterThan(-1);
      expect(args[pIdx + 1]).toBe('continue');
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

    it('parses a permission_request message', () => {
      const msg = JSON.stringify({
        type: 'assistant',
        subtype: 'permission_request',
        session_id: 'sess-1',
        tool: 'Write',
      });
      const event = adapter.parseMessage(msg);
      expect(event).not.toBeNull();
      expect(event!.type).toBe('permission_request');
      expect(event!.toolName).toBe('Write');
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
  });
});
