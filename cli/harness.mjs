#!/usr/bin/env node

// Harness CLI — called by agents to propose subtasks.
// Usage: harness propose-subtasks --subtasks '[{"title":"...","prompt":"..."}]'
// Env: HARNESS_TASK_ID, HARNESS_API_URL

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '--help' || command === '-h') {
  console.log(`Usage: harness <command> [options]

Commands:
  propose-subtasks  Propose subtasks for the current task

Options for propose-subtasks:
  --task-id <id>     Task ID (default: $HARNESS_TASK_ID)
  --subtasks <json>  JSON array of subtask proposals
                     Each: {"title": "...", "prompt": "...", "priority?": "P0-P3"}

Environment:
  HARNESS_TASK_ID    Task ID (set automatically by Harness)
  HARNESS_API_URL    API base URL (set automatically by Harness)`)
  process.exit(0)
}

if (command !== 'propose-subtasks') {
  console.error(`Unknown command: ${command}`)
  console.error('Run "harness --help" for usage.')
  process.exit(1)
}

// Parse arguments
let taskId = process.env.HARNESS_TASK_ID
let subtasksJson = null

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--task-id' && args[i + 1]) {
    taskId = args[++i]
  } else if (args[i] === '--subtasks' && args[i + 1]) {
    subtasksJson = args[++i]
  }
}

if (!taskId) {
  console.error('Error: No task ID provided. Set HARNESS_TASK_ID or use --task-id.')
  process.exit(1)
}

const apiUrl = process.env.HARNESS_API_URL
if (!apiUrl) {
  console.error('Error: HARNESS_API_URL is not set.')
  process.exit(1)
}

if (!subtasksJson) {
  console.error('Error: --subtasks is required.')
  process.exit(1)
}

// Parse and validate JSON
let subtasks
try {
  subtasks = JSON.parse(subtasksJson)
} catch (e) {
  console.error(`Error: Invalid JSON for --subtasks: ${e.message}`)
  console.error('Expected format: [{"title":"...","prompt":"..."}]')
  process.exit(1)
}

if (!Array.isArray(subtasks) || subtasks.length === 0) {
  console.error('Error: --subtasks must be a non-empty JSON array.')
  process.exit(1)
}

for (let i = 0; i < subtasks.length; i++) {
  const s = subtasks[i]
  if (!s.title || !s.prompt) {
    console.error(`Error: Subtask ${i} is missing required "title" or "prompt" field.`)
    process.exit(1)
  }
}

// Send to API
const url = `${apiUrl}/api/tasks/${taskId}/propose-subtasks`

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subtasks }),
  })

  const body = await res.json()

  if (!res.ok) {
    console.error(`Error from Harness API (${res.status}): ${body.error || JSON.stringify(body)}`)
    process.exit(1)
  }

  console.log(`✓ Proposed ${body.proposal_count} subtask(s). This agent will now be paused.`)
  process.exit(0)
} catch (e) {
  console.error(`Error: Failed to reach Harness API at ${url}: ${e.message}`)
  process.exit(1)
}
