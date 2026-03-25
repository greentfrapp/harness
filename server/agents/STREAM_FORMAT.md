# Claude Code CLI `--output-format stream-json --verbose` Format

Reference for the JSON output emitted by `claude --output-format stream-json --verbose`.
Each line on stdout is a single JSON object. All messages include `session_id` and `uuid` fields.

## Message Types

### `system` (subtype: `init`)

First message emitted. Contains session metadata.

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/path/to/project",
  "session_id": "759e1fda-ab54-434d-a9a9-c64fa722e171",
  "tools": ["Read", "Write", "Bash", "Glob", "Grep", ...],
  "model": "claude-opus-4-6[1m]",
  "permissionMode": "default",
  "claude_code_version": "2.1.81",
  "uuid": "..."
}
```

### `assistant`

Wraps the full API message object. The `message.content` array contains the actual content blocks.

**Content block types inside `message.content`:**

#### Text block
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "I will help you with that." }
    ],
    "stop_reason": null,
    "usage": { "input_tokens": 3, "output_tokens": 50, ... }
  },
  "session_id": "...",
  "uuid": "..."
}
```

#### Tool use block
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_015h1nk7rdo6wQUQzHGyVhnm",
        "name": "Read",
        "input": { "file_path": "/src/index.ts", "limit": 5 },
        "caller": { "type": "direct" }
      }
    ],
    "usage": { ... }
  },
  "session_id": "...",
  "uuid": "..."
}
```

#### Thinking block (extended thinking)
```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "thinking",
        "thinking": "Let me consider...",
        "signature": "..."
      }
    ]
  },
  "session_id": "...",
  "uuid": "..."
}
```

A single assistant message can contain **multiple** content blocks (e.g., thinking + text, or text + tool_use).

### `user`

Wraps tool results and synthetic messages. **Important:** There are no top-level `tool_result` messages — they are always inside `user` messages.

#### Tool result
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_015h1nk7rdo6wQUQzHGyVhnm",
        "type": "tool_result",
        "content": "     1→{\n     2→  \"name\": \"harness\",\n..."
      }
    ]
  },
  "tool_use_result": {
    "type": "text",
    "file": {
      "filePath": "/path/to/file",
      "content": "...",
      "numLines": 5,
      "startLine": 1,
      "totalLines": 51
    }
  },
  "session_id": "...",
  "uuid": "...",
  "timestamp": "2026-03-25T05:37:40.311Z"
}
```

The `tool_use_result` top-level field contains rich structured data (e.g., file metadata) beyond the plain content string.

#### Synthetic user messages (hooks)

Hook feedback arrives as `user` messages with `isSynthetic: true`:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "Stop hook feedback:\n..." }]
  },
  "isSynthetic": true,
  "session_id": "...",
  "uuid": "..."
}
```

### `rate_limit_event`

Rate limiting metadata. Not displayed in UI.

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1774418400,
    "rateLimitType": "five_hour"
  },
  "session_id": "...",
  "uuid": "..."
}
```

### `result`

Final message when the session completes. Contains summary, cost, and duration.

```json
{
  "type": "result",
  "result": "The project name is harness.",
  "cost_usd": 0.05,
  "duration_ms": 12345,
  "duration_api_ms": 8000,
  "session_id": "...",
  "num_turns": 3
}
```

### Permission request (tool blocked)

When `--permission-mode default` is active and a tool requires approval, the CLI does **not** emit a special permission event. Instead, the tool result is returned as an error. The wording varies by tool:

**Format 1 — Bash and similar tools:**
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "content": "This command requires approval",
        "is_error": true,
        "tool_use_id": "toolu_01VEtj6LusjYDzCWYq7CnALj"
      }
    ]
  },
  "tool_use_result": "Error: This command requires approval",
  "session_id": "...",
  "uuid": "...",
  "timestamp": "..."
}
```

**Format 2 — WebSearch, WebFetch, and deferred tools:**
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "content": "Claude requested permissions to use WebSearch, but you haven't granted it yet.",
        "is_error": true,
        "tool_use_id": "toolu_014DxoQmHMKg4AUBY6eJAmZp"
      }
    ]
  },
  "tool_use_result": "Error: Claude requested permissions to use WebSearch, but you haven't granted it yet.",
  "session_id": "...",
  "uuid": "...",
  "timestamp": "..."
}
```

Harness detects both by checking `msg.type === 'user'` and `msg.tool_use_result` containing `"requires approval"` or `"haven't granted"`. The tool name can be extracted from the `"to use <Tool>"` pattern in format 2.

## Key Facts

- **No top-level `tool_use` or `tool_result` messages** — these are always content blocks inside `assistant` and `user` messages respectively.
- The `--verbose` flag is required for tool-related messages to appear.
- Common fields on all messages: `session_id`, `uuid`.
- Assistant messages may have `parent_tool_use_id` when responding within a subagent context.
- Multiple content blocks can appear in a single message (e.g., thinking + tool_use, or text + tool_use).
