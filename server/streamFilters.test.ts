import { describe, it, expect } from 'vitest';
import { hasDisplayableContent, extractText, getAssistantText } from '../shared/streamFilters.ts';

describe('extractText', () => {
  it('returns string content as-is', () => {
    expect(extractText('hello')).toBe('hello');
  });

  it('extracts text from array content blocks', () => {
    const content = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ];
    expect(extractText(content)).toBe('Hello world');
  });

  it('filters out non-text blocks', () => {
    const content = [
      { type: 'thinking', thinking: 'Let me think...' },
      { type: 'text', text: 'Here is my answer.' },
    ];
    expect(extractText(content)).toBe('Here is my answer.');
  });

  it('returns empty string for thinking-only content', () => {
    const content = [
      { type: 'thinking', thinking: 'pondering...' },
    ];
    expect(extractText(content)).toBe('');
  });

  it('returns empty string for object content (tool input)', () => {
    expect(extractText({ file_path: '/src/index.ts' })).toBe('');
  });

  it('returns empty string for null/undefined', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
  });

  it('handles blocks with text field but no type', () => {
    const content = [{ text: 'raw text' }];
    expect(extractText(content)).toBe('raw text');
  });
});

describe('getAssistantText', () => {
  it('extracts text from real Claude Code assistant message format', () => {
    // Real format: message field is the full API message object, not a string
    const msg = {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'I will help you with that.' }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      session_id: 'sess-1',
    };
    const text = getAssistantText(msg);
    expect(text).toBe('I will help you with that.');
    expect(typeof text).toBe('string');
  });

  it('handles legacy format where message is a string', () => {
    const msg = {
      type: 'assistant',
      message: 'Hello world',
    };
    expect(getAssistantText(msg)).toBe('Hello world');
  });

  it('falls back to content field when message is absent', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'text', text: 'from content' }],
    };
    expect(getAssistantText(msg)).toBe('from content');
  });

  it('handles string content field', () => {
    const msg = {
      type: 'assistant',
      content: 'plain string content',
    };
    expect(getAssistantText(msg)).toBe('plain string content');
  });
});

describe('hasDisplayableContent', () => {
  describe('real Claude Code message formats', () => {
    it('shows assistant with nested API message object', () => {
      expect(hasDisplayableContent({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'test' }],
          role: 'assistant',
        },
        session_id: 'sess-1',
      })).toBe(true);
    });

    it('filters system init (no displayable content)', () => {
      expect(hasDisplayableContent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/home/user',
        model: 'claude-opus-4-6',
        tools: ['Read', 'Write'],
      })).toBe(false);
    });

    it('filters rate_limit_event', () => {
      expect(hasDisplayableContent({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed' },
        session_id: 'sess-1',
      })).toBe(false);
    });
  });

  describe('assistant messages', () => {
    it('shows assistant with string message field', () => {
      expect(hasDisplayableContent({
        type: 'assistant',
        message: 'I will help you.',
      })).toBe(true);
    });

    it('shows assistant with string content', () => {
      expect(hasDisplayableContent({
        type: 'assistant',
        content: 'thinking about this...',
      })).toBe(true);
    });

    it('shows assistant with array text content blocks', () => {
      expect(hasDisplayableContent({
        type: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      })).toBe(true);
    });

    it('filters assistant with only thinking content blocks', () => {
      expect(hasDisplayableContent({
        type: 'assistant',
        content: [{ type: 'thinking', thinking: 'pondering...' }],
      })).toBe(false);
    });

    it('filters metadata-only assistant message', () => {
      expect(hasDisplayableContent({
        type: 'assistant',
        cost_usd: 0.01,
        duration_ms: 500,
        model: 'claude-sonnet-4-20250514',
      })).toBe(false);
    });

    it('filters assistant with empty content array', () => {
      expect(hasDisplayableContent({
        type: 'assistant',
        content: [],
      })).toBe(false);
    });
  });

  describe('tool messages', () => {
    it('shows tool_use', () => {
      expect(hasDisplayableContent({
        type: 'tool_use',
        tool: 'Read',
        content: { file_path: '/src/index.ts' },
      })).toBe(true);
    });

    it('shows tool_use even without content', () => {
      expect(hasDisplayableContent({
        type: 'tool_use',
        tool: 'Bash',
      })).toBe(true);
    });

    it('shows tool_result with content', () => {
      expect(hasDisplayableContent({
        type: 'tool_result',
        content: 'file contents here',
      })).toBe(true);
    });

    it('filters tool_result without content', () => {
      expect(hasDisplayableContent({
        type: 'tool_result',
      })).toBe(false);
    });
  });

  describe('system messages', () => {
    it('shows system with message', () => {
      expect(hasDisplayableContent({
        type: 'system',
        message: 'Session started',
      })).toBe(true);
    });

    it('filters system init (no message field)', () => {
      expect(hasDisplayableContent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/home/user',
        model: 'claude-sonnet-4-20250514',
      })).toBe(false);
    });
  });

  describe('result and error', () => {
    it('shows result with result field', () => {
      expect(hasDisplayableContent({
        type: 'result',
        result: 'Task completed successfully.',
      })).toBe(true);
    });

    it('filters result without result field', () => {
      expect(hasDisplayableContent({
        type: 'result',
      })).toBe(false);
    });

    it('shows error messages', () => {
      expect(hasDisplayableContent({
        type: 'error',
        message: 'Something went wrong',
      })).toBe(true);
    });
  });

  describe('unknown types (fallback)', () => {
    it('shows unknown type with non-metadata fields', () => {
      expect(hasDisplayableContent({
        type: 'custom_event',
        data: 'some data',
      })).toBe(true);
    });

    it('filters unknown type with only metadata fields', () => {
      expect(hasDisplayableContent({
        type: 'usage',
        cost_usd: 0.05,
        duration_ms: 1000,
      })).toBe(false);
    });
  });
});
