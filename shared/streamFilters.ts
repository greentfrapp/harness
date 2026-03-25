/**
 * Stream message filtering and expansion logic used by SessionStream.
 *
 * Claude Code's `--output-format stream-json --verbose` embeds tool_use blocks
 * inside `assistant` messages and tool_result blocks inside `user` messages.
 * This module expands those compound messages into flat DisplayItem[] arrays
 * so the UI can render each piece independently.
 *
 * See server/agents/STREAM_FORMAT.md for the full CLI output format reference.
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

/** A single renderable item produced by expanding a StreamMessage. */
export interface DisplayItem {
  displayType: 'text' | 'tool_use' | 'tool_result' | 'result' | 'system' | 'error' | 'unknown';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  toolResult?: unknown;
  isError?: boolean;
  resultText?: string;
  raw?: StreamMessage;
}

/** Metadata-only fields to exclude from the prettified view. */
const METADATA_FIELDS = new Set([
  'cost_usd', 'duration_ms', 'duration_api_ms', 'session_id',
  'model', 'stop_reason', 'cwd', 'num_turns',
]);

/** Message types that are never displayable (pure metadata/internal events). */
const SKIP_TYPES = new Set([
  'rate_limit_event',
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

/** Get the content blocks array from a message's API message object. */
function getContentBlocks(msg: StreamMessage): unknown[] {
  if (typeof msg.message === 'object' && msg.message !== null) {
    const apiMsg = msg.message as Record<string, unknown>;
    if (Array.isArray(apiMsg.content)) return apiMsg.content;
  }
  if (Array.isArray(msg.content)) return msg.content;
  return [];
}

/** Determine if a message has meaningful content worth displaying. */
export function hasDisplayableContent(msg: StreamMessage): boolean {
  // Skip known non-displayable event types
  if (SKIP_TYPES.has(msg.type)) return false;

  // Assistant messages: check for text OR tool_use content blocks
  if (msg.type === 'assistant') {
    const blocks = getContentBlocks(msg);
    if (blocks.length > 0) {
      return blocks.some((b: any) => b.type === 'text' || b.type === 'tool_use');
    }
    // Legacy string formats
    if (typeof msg.message === 'string') return !!msg.message;
    if (typeof msg.content === 'string') return !!msg.content;
    return false;
  }

  // User messages: displayable if they contain tool_result blocks
  if (msg.type === 'user') {
    const blocks = getContentBlocks(msg);
    return blocks.some((b: any) => b.type === 'tool_result');
  }

  // Legacy top-level types (kept for backward compatibility)
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

/**
 * Extract tool result content as a displayable string.
 * Tool result content in the CLI format can be a string directly or
 * wrapped in the message content block's `content` field.
 */
function extractToolResultContent(block: any, msg: StreamMessage): unknown {
  // The block itself may have a string content
  if (block.content !== undefined) return block.content;
  // Check the top-level tool_use_result field for rich data
  const toolUseResult = (msg as any).tool_use_result;
  if (toolUseResult) return toolUseResult;
  return undefined;
}

/**
 * Expand a list of raw StreamMessages into flat DisplayItem arrays.
 *
 * A single assistant message may contain both text and tool_use blocks;
 * a single user message may contain tool_result blocks. Each block becomes
 * its own DisplayItem so the UI can render them individually.
 */
export function expandMessages(messages: StreamMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];

  for (const msg of messages) {
    if (!hasDisplayableContent(msg)) continue;

    // --- Assistant messages: expand content blocks ---
    if (msg.type === 'assistant') {
      const blocks = getContentBlocks(msg);
      if (blocks.length > 0) {
        for (const block of blocks) {
          const b = block as any;
          if (b.type === 'text' && b.text) {
            items.push({ displayType: 'text', text: b.text, raw: msg });
          } else if (b.type === 'tool_use') {
            items.push({
              displayType: 'tool_use',
              toolName: b.name,
              toolInput: b.input,
              toolUseId: b.id,
              raw: msg,
            });
          }
          // Skip thinking blocks, etc.
        }
        // If no items were produced (e.g. only thinking blocks), skip
        continue;
      }
      // Legacy string format
      const text = getAssistantText(msg);
      if (text) {
        items.push({ displayType: 'text', text, raw: msg });
      }
      continue;
    }

    // --- User messages: extract tool_result blocks ---
    if (msg.type === 'user') {
      const blocks = getContentBlocks(msg);
      for (const block of blocks) {
        const b = block as any;
        if (b.type === 'tool_result') {
          items.push({
            displayType: 'tool_result',
            toolResult: extractToolResultContent(b, msg),
            toolUseId: b.tool_use_id,
            isError: b.is_error === true,
            raw: msg,
          });
        }
      }
      continue;
    }

    // --- Legacy top-level tool_use ---
    if (msg.type === 'tool_use') {
      items.push({
        displayType: 'tool_use',
        toolName: msg.tool,
        toolInput: msg.content,
        raw: msg,
      });
      continue;
    }

    // --- Legacy top-level tool_result ---
    if (msg.type === 'tool_result') {
      items.push({
        displayType: 'tool_result',
        toolResult: msg.content,
        isError: msg.is_error === true,
        raw: msg,
      });
      continue;
    }

    // --- Result ---
    if (msg.type === 'result') {
      items.push({
        displayType: 'result',
        resultText: msg.result,
        raw: msg,
      });
      continue;
    }

    // --- System ---
    if (msg.type === 'system') {
      items.push({
        displayType: 'system',
        text: typeof msg.message === 'string' ? msg.message : undefined,
        raw: msg,
      });
      continue;
    }

    // --- Error ---
    if (msg.type === 'error' || msg.is_error) {
      items.push({
        displayType: 'error',
        text: typeof msg.message === 'string' ? msg.message : undefined,
        raw: msg,
      });
      continue;
    }

    // --- Fallback ---
    items.push({
      displayType: 'unknown',
      text: String(msg.message || extractText(msg.content) || ''),
      raw: msg,
    });
  }

  return items;
}
