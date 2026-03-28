#!/usr/bin/env node

// Harness CLI — called by agents to interact with the Harness task system.
// Env: HARNESS_TASK_ID, HARNESS_API_URL

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '--help' || command === '-h') {
  printHelp()
  process.exit(0)
}

// --- Common setup ---

function parseTaskId(commandArgs) {
  for (let i = 0; i < commandArgs.length; i++) {
    if (commandArgs[i] === '--task-id' && commandArgs[i + 1]) {
      return commandArgs[i + 1]
    }
  }
  return process.env.HARNESS_TASK_ID
}

const apiUrl = process.env.HARNESS_API_URL
if (!apiUrl) {
  console.error('Error: HARNESS_API_URL is not set.')
  process.exit(1)
}

async function apiCall(method, path, body = null) {
  const url = `${apiUrl}${path}`
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(url, opts)
  const data = await res.json()
  if (!res.ok) {
    console.error(
      `Error from Harness API (${res.status}): ${data.error || JSON.stringify(data)}`,
    )
    process.exit(1)
  }
  return data
}

function requireTaskId(commandArgs) {
  const taskId = parseTaskId(commandArgs)
  if (!taskId) {
    console.error(
      'Error: No task ID provided. Set HARNESS_TASK_ID or use --task-id.',
    )
    process.exit(1)
  }
  return taskId
}

// --- Command dispatch ---

const commandArgs = args.slice(1)

switch (command) {
  case 'set-result':
    await cmdSetResult(commandArgs)
    break
  case 'request-permission':
    await cmdRequestPermission(commandArgs)
    break
  case 'request-transition':
    await cmdRequestTransition(commandArgs)
    break
  case 'propose-subtasks':
    await cmdProposeSubtasks(commandArgs)
    break
  case 'get-task':
    await cmdGetTask(commandArgs)
    break
  case 'list-tasks':
    await cmdListTasks(commandArgs)
    break
  default:
    console.error(`Unknown command: ${command}`)
    console.error('Run "harness --help" for usage.')
    process.exit(1)
}

// --- Commands ---

async function cmdSetResult(cmdArgs) {
  const taskId = requireTaskId(cmdArgs)

  // Accept --text flag or remaining positional args
  let text = null
  const filtered = []
  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === '--task-id') {
      i++ // skip value
    } else if (cmdArgs[i] === '--text' && cmdArgs[i + 1]) {
      text = cmdArgs[++i]
    } else {
      filtered.push(cmdArgs[i])
    }
  }
  if (!text) text = filtered.join(' ')

  if (!text.trim()) {
    console.error('Error: Result text is required.')
    console.error('Usage: harness set-result <text>')
    process.exit(1)
  }

  await apiCall('PATCH', `/api/tasks/${taskId}`, { result: text })
  console.log('Result set.')
}

async function cmdRequestPermission(cmdArgs) {
  const taskId = requireTaskId(cmdArgs)

  // First positional arg is the tool name
  const filtered = []
  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === '--task-id') {
      i++
    } else {
      filtered.push(cmdArgs[i])
    }
  }
  const tool = filtered[0]

  if (!tool?.trim()) {
    console.error('Error: Tool name is required.')
    console.error('Usage: harness request-permission <tool-name>')
    process.exit(1)
  }

  await apiCall('POST', `/api/tasks/${taskId}/request-permission`, { tool })
  console.log(
    `Permission requested for tool: ${tool}. This agent will now be paused.`,
  )
  process.exit(0)
}

async function cmdRequestTransition(cmdArgs) {
  const taskId = requireTaskId(cmdArgs)

  const filtered = []
  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === '--task-id') {
      i++
    } else {
      filtered.push(cmdArgs[i])
    }
  }
  const targetType = filtered[0]

  if (!targetType?.trim()) {
    console.error('Error: Target type is required.')
    console.error('Usage: harness request-transition <target-type>')
    process.exit(1)
  }

  await apiCall('POST', `/api/tasks/${taskId}/request-transition`, {
    target_type: targetType,
  })
  console.log(
    `Transition to '${targetType}' requested. This agent will now be paused.`,
  )
  process.exit(0)
}

async function cmdProposeSubtasks(cmdArgs) {
  const taskId = requireTaskId(cmdArgs)

  let subtasksJson = null
  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === '--task-id') {
      i++
    } else if (cmdArgs[i] === '--subtasks' && cmdArgs[i + 1]) {
      subtasksJson = cmdArgs[++i]
    }
  }

  if (!subtasksJson) {
    console.error('Error: --subtasks is required.')
    console.error(
      'Usage: harness propose-subtasks --subtasks \'[{"title":"...","prompt":"..."}]\'',
    )
    process.exit(1)
  }

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
      console.error(
        `Error: Subtask ${i} is missing required "title" or "prompt" field.`,
      )
      process.exit(1)
    }
  }

  const data = await apiCall(
    'POST',
    `/api/tasks/${taskId}/propose-subtasks`,
    { subtasks },
  )
  console.log(
    `Proposed ${data.proposal_count} subtask(s). This agent will now be paused.`,
  )
  process.exit(0)
}

async function cmdGetTask(cmdArgs) {
  // First positional arg is the task ID to fetch (not the current task)
  const filtered = []
  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === '--task-id') {
      i++
    } else {
      filtered.push(cmdArgs[i])
    }
  }
  const targetId = filtered[0]

  if (!targetId?.trim()) {
    console.error('Error: Task ID is required.')
    console.error('Usage: harness get-task <task-id>')
    process.exit(1)
  }

  const data = await apiCall('GET', `/api/tasks/${targetId}`)
  console.log(JSON.stringify(data, null, 2))
}

async function cmdListTasks(cmdArgs) {
  const params = new URLSearchParams()

  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === '--status' && cmdArgs[i + 1]) {
      params.set('status', cmdArgs[++i])
    } else if (cmdArgs[i] === '--project' && cmdArgs[i + 1]) {
      params.set('project_id', cmdArgs[++i])
    }
  }

  const query = params.toString()
  const path = query ? `/api/tasks?${query}` : '/api/tasks'
  const data = await apiCall('GET', path)
  console.log(JSON.stringify(data, null, 2))
}

// --- Help ---

function printHelp() {
  console.log(`Usage: harness <command> [options]

Commands:
  set-result <text>                  Set the task's result text
  request-permission <tool>          Request permission for a tool (pauses agent)
  request-transition <target-type>   Request mode escalation (pauses agent)
  propose-subtasks --subtasks <json> Propose subtasks for parallel execution (pauses agent)
  get-task <task-id>                 Read another task's data
  list-tasks [--status X] [--project Y]  Query tasks

Global options:
  --task-id <id>    Override task ID (default: $HARNESS_TASK_ID)
  --help, -h        Show this help message

Environment:
  HARNESS_TASK_ID   Task ID (set automatically by Harness)
  HARNESS_API_URL   API base URL (set automatically by Harness)`)
}
