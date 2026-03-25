/**
 * Stream message filtering logic used by SessionStream to decide which
 * messages from the Claude Code CLI should be rendered in the live view.
 *
 * Extracted here so it can be unit-tested independently of the Vue component.
 */

export interface StreamMessage {
  type: string;
  message?: string | Record<string, unknown>;
  content?: unknown;
  tool?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  session_id?: string;
  [key: string]: unknown;
}

/** Metadata-only fields to exclude from the prettified view. */
const METADATA_FIELDS = new Set([
  'cost_usd', 'duration_ms', 'duration_api_ms', 'session_id',
  'model', 'stop_reason', 'cwd', 'num_turns',
]);

/** Message types that are never displayable (pure metadata/internal events). */
const SKIP_TYPES = new Set([
  'rate_limit_event',
  'user',     // synthetic user messages from hooks
]);

/**
 * Extract displayable text from a message's content field.
 * Claude Code may send content as:
 *   - a plain string
 *   - an array of content blocks: [{type:"text", text:"..."}]
 *   - an object (tool input)
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && (b.type === 'text' || b.text))
      .map((b: any) => b.text ?? '')
      .join('');
  }
  return '';
}

/**
 * Get displayable text for an assistant message.
 *
 * Claude Code's stream-json format sends assistant messages with a `message`
 * field that is the full API message object (not a string):
 *   { type: "assistant", message: { content: [{type:"text", text:"..."}], ... } }
 *
 * This function handles both the real format (object) and legacy format (string).
 */
export function getAssistantText(msg: StreamMessage): string {
  if (msg.message) {
    if (typeof msg.message === 'string') return msg.message;
    // Real Claude Code format: message is the API response object with a content array
    if (typeof msg.message === 'object' && msg.message !== null) {
      const apiMsg = msg.message as Record<string, unknown>;
      if (apiMsg.content) {
        return extractText(apiMsg.content);
      }
    }
  }
  return extractText(msg.content);
}

/** Determine if a message has meaningful content worth displaying. */
export function hasDisplayableContent(msg: StreamMessage): boolean {
  // Skip known non-displayable event types
  if (SKIP_TYPES.has(msg.type)) return false;

  // Always show these types if they have content
  if (msg.type === 'assistant') return !!getAssistantText(msg);
  if (msg.type === 'tool_use') return true;
  if (msg.type === 'tool_result') return msg.content !== undefined;
  if (msg.type === 'result') return !!msg.result;
  if (msg.type === 'system') return !!(typeof msg.message === 'string' && msg.message);
  if (msg.type === 'error') return true;

  // Filter out messages that only carry metadata (e.g. usage updates)
  const hasNonMetadata = Object.keys(msg).some(
    (k) => k !== 'type' && !METADATA_FIELDS.has(k),
  );
  return hasNonMetadata;
}
