import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  HarnessConfig,
  Project,
  SSEEventType,
  SubtaskProposal,
  Task,
} from '../shared/types'
import { transition } from '../shared/transitions'
import type { AgentProgressEvent } from './agents/index'
import type { AgentRegistry } from './agents/index'
import * as git from './git'
import { serverLog } from './log'
import { appendSessionMessages, saveSessionMessages } from './sessions'

export interface AgentSessionData {
  session_id: string | null
  pid: number
  granted_tools?: string[]
  pending_tool?: string | null
  pending_tool_input?: Record<string, unknown> | null
}

interface ActiveAgent {
  taskId: string
  projectId: string
  process: ChildProcess
  sessionId: string | null
  usesWorktree: boolean
}

/** Shape of a raw Claude Code stream-json message with assistant content. */
interface RawAssistantMessage {
  type: string
  message?: {
    content?: Array<{
      type: string
      name?: string
      text?: string
      input?: Record<string, unknown>
    }>
  }
}

function asRawMessage(raw: unknown): RawAssistantMessage | null {
  const msg = raw as RawAssistantMessage
  if (msg && typeof msg.type === 'string') return msg
  return null
}

interface PoolDeps {
  config: HarnessConfig
  agentRegistry: AgentRegistry
  getProjectById: (id: string) => Project | undefined
  updateTask: (id: string, updates: Record<string, unknown>) => Task | undefined
  createTaskEvent: (
    taskId: string,
    eventType: string,
    data: string | null,
  ) => void
  broadcast: (event: SSEEventType, data: unknown) => void
  getTaskById: (id: string) => Task | undefined
  getSubtaskProposals: (taskId: string) => SubtaskProposal[]
  onTaskCompleted: (taskId: string) => void
}

/** Combine a task's title and prompt into a single string for the agent. */
function buildTaskPrompt(task: Task): string {
  if (task.title && task.prompt) return `${task.title}\n\n${task.prompt}`
  return task.title ?? task.prompt ?? ''
}

/**
 * Build a fix-specific resume prompt based on task tags.
 * Returns null if no fix tags are present (use the normal task prompt).
 */
function buildFixPrompt(task: Task, project: Project): string | null {
  if (task.tags.includes('merge-conflict')) {
    return `Your branch failed to merge into ${project.target_branch} due to conflicts. Merge ${project.target_branch} into your branch and resolve all conflicts, then verify the code still works.\n\nOriginal task:\n${buildTaskPrompt(task)}`
  }
  if (task.tags.includes('checkout-failed')) {
    return `The checkout of your branch failed. Please investigate and fix any issues with your branch so it can be checked out cleanly.\n\nOriginal task:\n${buildTaskPrompt(task)}`
  }
  if (task.tags.includes('needs-commit')) {
    return 'Please commit all your changes.'
  }
  return null
}

export class AgentPool {
  private agents = new Map<string, ActiveAgent>()
  private chatAgents = new Map<string, ActiveAgent>()
  private deps: PoolDeps
  /** Per-task buffer of recent progress messages for late-joining clients. */
  private progressBuffers = new Map<string, unknown[]>()
  private static readonly MAX_BUFFER_SIZE = 200

  constructor(deps: PoolDeps) {
    this.deps = deps
  }

  /** Get buffered progress messages for a task (for clients that connect mid-stream). */
  getProgressBuffer(taskId: string): unknown[] {
    return this.progressBuffers.get(taskId) ?? []
  }

  get activeWorktreeCount(): number {
    return [...this.agents.values()].filter((a) => a.usesWorktree).length
  }

  get activeConversationCount(): number {
    return (
      [...this.agents.values()].filter((a) => !a.usesWorktree).length +
      this.chatAgents.size
    )
  }

  hasAgent(taskId: string): boolean {
    return this.agents.has(taskId)
  }

  hasChatAgent(taskId: string): boolean {
    return this.chatAgents.has(taskId)
  }

  /** Dispatch a Do task: create worktree, spawn agent, handle lifecycle. */
  async dispatchDoTask(task: Task, project: Project): Promise<void> {
    let wtPath: string

    if (task.worktree_path && task.branch_name) {
      // Revision: reuse existing worktree and branch (preserves original commits)
      wtPath = task.worktree_path
    } else {
      // New task: create fresh worktree from target branch
      const branchName = git.makeBranchName(task.id, task.title ?? task.prompt ?? '')
      wtPath = git.worktreePath(project.repo_path, branchName)

      git.createWorktree(
        project.repo_path,
        project.target_branch,
        branchName,
        wtPath,
      )

      this.deps.updateTask(task.id, {
        worktree_path: wtPath,
        branch_name: branchName,
      })
    }

    // Resolve task type config for system prompt and permission mode
    const taskTypeConfig =
      this.deps.config.task_types[task.type] ??
      this.deps.config.task_types['do']
    const configPermissionMode = taskTypeConfig?.permission_mode

    // Check if this task has a pre-populated session ID (e.g. follow-up task)
    const existingSession = getSessionData(task)
    const grantedTools = existingSession?.granted_tools
    const permissionMode = configPermissionMode

    if (existingSession?.session_id) {
      // Resume the previous conversation in the existing worktree
      this.spawnAgent(task, project, {
        cwd: wtPath,
        systemPrompt: null,
        usesWorktree: true,
        resumeSessionId: existingSession.session_id,
        permissionMode,
        allowedTools: grantedTools,
        resumePromptOverride: buildFixPrompt(task, project),
      })
      return
    }

    // Build system prompt from config template
    const taskPrompt = buildTaskPrompt(task)
    const systemPrompt = taskTypeConfig
      ? taskTypeConfig.prompt_template
          .replace('{user_prompt}', taskPrompt)
          .replace('{title}', task.title ?? '')
      : taskPrompt

    // Spawn agent
    this.spawnAgent(task, project, {
      cwd: wtPath,
      systemPrompt,
      usesWorktree: true,
      resumeSessionId: null,
      permissionMode,
      allowedTools: grantedTools,
    })
  }

  /** Dispatch a Discuss task: plan mode, no worktree. */
  async dispatchDiscussTask(task: Task, project: Project): Promise<void> {
    const taskTypeConfig =
      this.deps.config.task_types[task.type] ??
      this.deps.config.task_types['discuss']
    const permissionMode = taskTypeConfig?.permission_mode
    const sessionData = getSessionData(task)
    const discussPrompt = buildTaskPrompt(task)
    const systemPrompt = taskTypeConfig
      ? taskTypeConfig.prompt_template
          .replace('{user_prompt}', discussPrompt)
          .replace('{title}', task.title ?? '')
      : discussPrompt

    this.spawnAgent(task, project, {
      cwd: project.repo_path,
      systemPrompt,
      usesWorktree: false,
      resumeSessionId: sessionData?.session_id ?? null,
      permissionMode,
      allowedTools: sessionData?.granted_tools,
      resumePromptOverride: sessionData?.session_id
        ? buildFixPrompt(task, project)
        : null,
    })
  }

  /**
   * Spawn a chat agent for inline Q&A on a task.
   * Uses read-only tools, does not change task status.
   * Bypasses the dispatcher — called directly from the chat route.
   */
  spawnChatAgent(
    task: Task,
    project: Project,
    opts: { message: string; sessionId: string | null },
  ): void {
    const adapter = this.deps.agentRegistry.getOrDefault(task.agent_type)
    const cwd = task.worktree_path ?? project.repo_path
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']

    const args = opts.sessionId
      ? adapter.buildResumeArgs({
          prompt: opts.message,
          sessionId: opts.sessionId,
          usesWorktree: false,
          allowedTools: readOnlyTools,
        })
      : adapter.buildArgs({
          prompt: opts.message,
          systemPrompt: null,
          usesWorktree: false,
          allowedTools: readOnlyTools,
        })

    const agentConfig = this.deps.config.agents?.[task.agent_type]
    if (agentConfig?.extra_args) {
      args.push(...agentConfig.extra_args)
    }

    serverLog.info(`Spawning chat agent in ${cwd}`, task.id)

    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const proc = spawn(adapter.executable, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HARNESS_TASK_ID: task.id,
        HARNESS_API_URL: `http://localhost:${process.env.PORT ?? '3001'}`,
        HARNESS_CLI: path.resolve(__dirname, '../../cli/harness.mjs'),
      },
    })

    const agent: ActiveAgent = {
      taskId: task.id,
      projectId: project.id,
      process: proc,
      sessionId: opts.sessionId,
      usesWorktree: false,
    }
    this.chatAgents.set(task.id, agent)

    // Seed progress buffer with user message so all clients (including modal) can see it
    const existingBuffer = this.progressBuffers.get(task.id)
    const hasChat = existingBuffer?.some(
      (m: any) =>
        m?.type === '__chat_separator' || m?.type === '__chat_user_message',
    )
    const seedMessages: unknown[] = []
    if (!hasChat) {
      seedMessages.push({ type: '__chat_separator', timestamp: Date.now() })
    }
    seedMessages.push({
      type: '__chat_user_message',
      text: opts.message,
      timestamp: Date.now(),
    })
    if (existingBuffer) {
      existingBuffer.push(...seedMessages)
    } else {
      this.progressBuffers.set(task.id, [...seedMessages])
    }
    for (const msg of seedMessages) {
      this.deps.broadcast('task:progress', { task_id: task.id, message: msg })
    }

    proc.on('error', (err) => {
      this.chatAgents.delete(task.id)
      serverLog.error(
        `Failed to spawn chat agent: ${err.message}`,
        task.id,
      )
    })

    // Store PID, preserving existing session data
    if (proc.pid) {
      this.deps.updateTask(task.id, {
        agent_session_data: updateSessionData(task.agent_session_data, {
          session_id: opts.sessionId,
          pid: proc.pid,
        }),
      })
    }

    let buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        const event = adapter.parseMessage(line)
        if (!event) continue

        // Buffer and broadcast progress (reuses existing pattern)
        let progBuf = this.progressBuffers.get(task.id)
        if (!progBuf) {
          progBuf = []
          this.progressBuffers.set(task.id, progBuf)
        }
        progBuf.push(event.raw)
        if (progBuf.length > AgentPool.MAX_BUFFER_SIZE) {
          progBuf.splice(0, progBuf.length - AgentPool.MAX_BUFFER_SIZE)
        }
        this.deps.broadcast('task:progress', {
          task_id: task.id,
          message: event.raw,
        })

        // Capture session_id
        if (event.sessionId && !agent.sessionId) {
          agent.sessionId = event.sessionId
          const currentData = this.deps.getTaskById(task.id)
          this.deps.updateTask(task.id, {
            agent_session_data: updateSessionData(
              currentData?.agent_session_data ?? null,
              { session_id: event.sessionId, pid: proc.pid! },
            ),
          })
        }
      }
    })

    proc.stderr?.on('data', () => {
      // Logged but not surfaced — chat errors don't change task status
    })

    proc.on('close', () => {
      // Flush remaining buffer
      if (buffer.trim()) {
        const event = adapter.parseMessage(buffer)
        if (event) {
          let progBuf = this.progressBuffers.get(task.id)
          if (!progBuf) {
            progBuf = []
            this.progressBuffers.set(task.id, progBuf)
          }
          progBuf.push(event.raw)
          this.deps.broadcast('task:progress', {
            task_id: task.id,
            message: event.raw,
          })
        }
        buffer = ''
      }

      this.chatAgents.delete(task.id)

      // Append chat messages to session file (not overwrite)
      const progressBuffer = this.progressBuffers.get(task.id)
      if (progressBuffer && progressBuffer.length > 0) {
        appendSessionMessages(task.id, progressBuffer)
      }
      this.progressBuffers.delete(task.id)

      this.deps.broadcast('chat:complete', { task_id: task.id })
    })
  }

  /** Retry a failed task using --resume. */
  async retryTask(task: Task, project: Project): Promise<void> {
    const sessionData = getSessionData(task)
    if (!sessionData?.session_id) {
      throw new Error(`Cannot retry task ${task.id}: no session ID`)
    }

    const taskTypeConfig = this.deps.config.task_types[task.type]
    const permissionMode = taskTypeConfig?.permission_mode
    const cwd = task.worktree_path ?? project.repo_path
    this.spawnAgent(task, project, {
      cwd,
      systemPrompt: null,
      usesWorktree: !!task.worktree_path,
      resumeSessionId: sessionData.session_id,
      permissionMode,
      allowedTools: sessionData.granted_tools,
      resumePromptOverride: buildFixPrompt(task, project),
    })
  }

  /** Kill a running agent process. */
  killAgent(taskId: string): boolean {
    const agent = this.agents.get(taskId)
    if (!agent) return false

    try {
      agent.process.kill('SIGTERM')
      // Give it 5s, then SIGKILL
      setTimeout(() => {
        try {
          agent.process.kill('SIGKILL')
        } catch {
          // Already dead
        }
      }, 5000)
    } catch {
      // Process may already be dead
    }

    this.agents.delete(taskId)
    return true
  }

  killChatAgent(taskId: string): boolean {
    const agent = this.chatAgents.get(taskId)
    if (!agent) return false

    try {
      agent.process.kill('SIGTERM')
      setTimeout(() => {
        try {
          agent.process.kill('SIGKILL')
        } catch {
          // Already dead
        }
      }, 5000)
    } catch {
      // Process may already be dead
    }

    this.chatAgents.delete(taskId)
    return true
  }

  /** Kill an agent by PID (for crash recovery). */
  killByPid(pid: number): void {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Process doesn't exist
    }
  }

  private spawnAgent(
    task: Task,
    project: Project,
    opts: {
      cwd: string
      systemPrompt: string | null
      usesWorktree: boolean
      resumeSessionId: string | null
      permissionMode?: string
      allowedTools?: string[]
      resumePromptOverride?: string | null
    },
  ): void {
    const adapter = this.deps.agentRegistry.getOrDefault(task.agent_type)

    // Inject harness subtask instructions into the system prompt so the agent
    // knows how to propose subtasks via the CLI instead of using its own tools.
    const harnessInstructions = `

## Harness Task System
You are running as an agent inside Harness, a task queue system. You can use your own tools to track progress, but you also have access to the Harness CLI for proposing subtasks that will be executed by other agents in parallel.

If this task is too large or would benefit from being broken into smaller pieces, you can propose subtasks by running:
  $HARNESS_CLI propose-subtasks --subtasks '[{"title":"Short title","prompt":"Detailed instructions for the subtask"}]'

After proposing subtasks, you will be paused while the user reviews and approves them. Approved subtasks will be executed by other agents, and you will be resumed with their results.

Only propose subtasks when you have clear, actionable sub-pieces. Not every task needs subtasks.`

    const systemPrompt = opts.systemPrompt
      ? opts.systemPrompt + harnessInstructions
      : null

    const agentPrompt = opts.resumePromptOverride ?? buildTaskPrompt(task)
    const args = opts.resumeSessionId
      ? adapter.buildResumeArgs({
          prompt: agentPrompt,
          sessionId: opts.resumeSessionId,
          usesWorktree: opts.usesWorktree,
          permissionMode: opts.permissionMode,
          allowedTools: opts.allowedTools,
        })
      : adapter.buildArgs({
          prompt: agentPrompt,
          systemPrompt,
          usesWorktree: opts.usesWorktree,
          permissionMode: opts.permissionMode,
          allowedTools: opts.allowedTools,
        })

    // Append extra_args from config if defined
    const agentConfig = this.deps.config.agents?.[task.agent_type]
    if (agentConfig?.extra_args) {
      args.push(...agentConfig.extra_args)
    }

    serverLog.info(
      `Spawning ${adapter.executable} agent in ${opts.cwd}`,
      task.id,
    )

    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const proc = spawn(adapter.executable, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HARNESS_TASK_ID: task.id,
        HARNESS_API_URL: `http://localhost:${process.env.PORT ?? '3001'}`,
        HARNESS_CLI: path.resolve(__dirname, '../../cli/harness.mjs'),
      },
    })

    const agent: ActiveAgent = {
      taskId: task.id,
      projectId: project.id,
      process: proc,
      sessionId: opts.resumeSessionId,
      usesWorktree: opts.usesWorktree,
    }
    this.agents.set(task.id, agent)

    // Handle spawn errors (e.g. CLI not found in PATH)
    proc.on('error', (err) => {
      this.agents.delete(task.id)
      serverLog.error(
        `Failed to spawn ${adapter.executable}: ${err.message}`,
        task.id,
      )
      this.pushToError(
        task.id,
        `Failed to spawn ${adapter.executable}: ${err.message}. Is the ${adapter.executable} CLI installed and in PATH?`,
      )
    })

    // Store PID immediately, preserving existing session data (e.g. granted_tools)
    if (proc.pid) {
      this.deps.updateTask(task.id, {
        agent_session_data: updateSessionData(task.agent_session_data, {
          session_id: opts.resumeSessionId,
          pid: proc.pid,
        }),
      })
    }

    // Collect stdout for parsing
    let buffer = ''
    let lastSummary = ''
    let lastToolName = ''
    let lastAssistantText = ''

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue

        const event = adapter.parseMessage(line)
        if (!event) continue

        // Track the last tool name from assistant tool_use messages
        const raw = asRawMessage(event.raw)
        if (raw?.type === 'assistant' && Array.isArray(raw.message?.content)) {
          for (const block of raw.message.content) {
            if (block.type === 'tool_use' && block.name) {
              lastToolName = block.name
            }
            if (block.type === 'text' && block.text) {
              lastAssistantText = block.text
            }
          }
        }

        // Attach tracked tool name to permission_request events
        if (event.type === 'permission_request' && lastToolName) {
          event.toolName = lastToolName
        }

        this.handleAgentEvent(task.id, agent, event)

        // Capture session_id
        if (event.sessionId && !agent.sessionId) {
          agent.sessionId = event.sessionId
          const currentData = this.deps.getTaskById(task.id)
          this.deps.updateTask(task.id, {
            agent_session_data: updateSessionData(
              currentData?.agent_session_data ?? null,
              { session_id: event.sessionId, pid: proc.pid! },
            ),
          })
        }

        // Capture agent summary from result event
        if (event.type === 'result' && event.summary) {
          lastSummary = event.summary
        }
      }
    })

    // Log stderr for debugging
    let stderrBuffer = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString()
    })

    // Handle process exit
    proc.on('close', (code) => {
      // Flush remaining buffer — the result event is often the last line
      if (buffer.trim()) {
        const event = adapter.parseMessage(buffer)
        if (event) {
          if (event.type === 'result' && event.summary) {
            lastSummary = event.summary
          }
          this.handleAgentEvent(task.id, agent, event)
        }
        buffer = ''
      }

      this.agents.delete(task.id)
      const progressBuffer = this.progressBuffers.get(task.id)
      if (progressBuffer && progressBuffer.length > 0) {
        saveSessionMessages(task.id, progressBuffer)
      }
      this.progressBuffers.delete(task.id)

      const currentTask = this.deps.getTaskById(task.id)
      if (!currentTask) return

      // Early-return if task was already moved to a terminal/held state
      // by an event handler (permission, subtasks, cancel, etc.)
      if (
        currentTask.status === 'cancelled' ||
        currentTask.status === 'pending' ||
        (currentTask.status === 'in_progress' &&
          currentTask.substatus === 'waiting_on_subtasks')
      )
        return

      if (code === 0) {
        this.handleAgentSuccess(
          task.id,
          project,
          lastSummary || lastAssistantText,
        )
      } else {
        this.handleAgentFailure(
          task.id,
          project,
          code,
          stderrBuffer,
          agent.sessionId,
        )
      }
    })
  }

  private handleAgentEvent(
    taskId: string,
    _agent: ActiveAgent,
    event: AgentProgressEvent,
  ): void {
    // Handle permission_request: kill agent, move task to pending:permission
    if (event.type === 'permission_request') {
      serverLog.warn(
        `Permission requested for tool: ${event.toolName ?? 'unknown'}`,
        taskId,
      )

      // Extract tool input from the progress buffer before killing
      const progressBuf = this.progressBuffers.get(taskId) ?? []
      let pendingToolInput: Record<string, unknown> | null = null
      for (let i = progressBuf.length - 1; i >= 0; i--) {
        const raw = asRawMessage(progressBuf[i])
        if (raw?.type === 'assistant' && Array.isArray(raw.message?.content)) {
          for (const block of raw.message.content) {
            if (block.type === 'tool_use' && block.name === event.toolName) {
              pendingToolInput = block.input ?? null
              break
            }
          }
          if (pendingToolInput) break
        }
      }

      this.killAgent(taskId)

      // Build a descriptive result with tool details
      let toolDetail = ''
      if (event.toolName === 'Bash' && pendingToolInput?.command) {
        toolDetail = ` — ${pendingToolInput.command}`
      } else if (event.toolName === 'Write' && pendingToolInput?.file_path) {
        toolDetail = ` — ${pendingToolInput.file_path}`
      } else if (event.toolName === 'Edit' && pendingToolInput?.file_path) {
        toolDetail = ` — ${pendingToolInput.file_path}`
      }
      const toolInfo = event.toolName
        ? `Tool requiring permission: ${event.toolName}${toolDetail}`
        : 'Agent requested permission for a tool'

      const currentTask = this.deps.getTaskById(taskId)
      if (currentTask) {
        const target = transition(
          currentTask.status,
          currentTask.substatus,
          'request_permission',
        )
        this.deps.updateTask(taskId, {
          status: target.status,
          substatus: target.substatus,
          result: toolInfo,
          agent_session_data: updateSessionData(
            currentTask.agent_session_data,
            {
              pending_tool: event.toolName ?? null,
              pending_tool_input: pendingToolInput,
            },
          ),
        })
      }
      this.deps.createTaskEvent(
        taskId,
        'permission_requested',
        JSON.stringify({ tool: event.toolName ?? null }),
      )
      const updated = this.deps.getTaskById(taskId)
      this.deps.broadcast('inbox:new', updated)
      this.deps.onTaskCompleted(taskId)
      return
    }

    // Buffer the message for late-joining clients
    let buf = this.progressBuffers.get(taskId)
    if (!buf) {
      serverLog.info(
        `First progress event for task (type=${asRawMessage(event.raw)?.type ?? event.type})`,
        taskId,
      )
    }
    if (!buf) {
      buf = []
      this.progressBuffers.set(taskId, buf)
    }
    buf.push(event.raw)
    if (buf.length > AgentPool.MAX_BUFFER_SIZE) {
      buf.splice(0, buf.length - AgentPool.MAX_BUFFER_SIZE)
    }

    // Forward as progress event
    this.deps.broadcast('task:progress', {
      task_id: taskId,
      message: event.raw,
    })
  }

  private handleAgentSuccess(
    taskId: string,
    project: Project,
    summary: string,
  ): void {
    serverLog.info(`Agent completed successfully`, taskId)
    const task = this.deps.getTaskById(taskId)
    if (!task) return

    // Plan tasks must produce subtask proposals — error if they didn't
    if (task.type === 'plan') {
      const proposals = this.deps.getSubtaskProposals(taskId)
      if (proposals.length === 0) {
        this.pushToError(
          taskId,
          'Plan task completed without proposing any subtasks. Plan tasks must propose subtasks via the Harness CLI.',
        )
        return
      }
    }

    // Build result text
    let resultText = summary || null

    // For Do tasks, append diff stats
    if (task.branch_name) {
      const diffStats = git.getDiffStats(
        project.repo_path,
        project.target_branch,
        task.branch_name,
      )
      if (diffStats && resultText) {
        resultText = `${resultText}\n\n${diffStats}`
      } else if (diffStats) {
        resultText = diffStats
      }
    }

    // v2: Do tasks → pending:review, discuss/plan → done:null
    const isReadOnly = task.type === 'discuss' || task.type === 'plan'
    const action = isReadOnly ? 'complete_readonly' : 'complete'
    const target = transition(task.status, task.substatus, action)

    this.deps.updateTask(taskId, {
      status: target.status,
      substatus: target.substatus,
      result: resultText,
      completed_at: Date.now(),
    })
    this.deps.createTaskEvent(taskId, 'completed', null)
    const updated = this.deps.getTaskById(taskId)
    this.deps.broadcast('inbox:new', updated)
    this.deps.onTaskCompleted(taskId)
  }

  private handleAgentFailure(
    taskId: string,
    project: Project,
    exitCode: number | null,
    stderr: string,
    sessionId: string | null,
  ): void {
    const task = this.deps.getTaskById(taskId)
    if (!task) return

    const maxRetries = 3
    const errorMsg =
      stderr.trim().slice(0, 2000) || `Agent exited with code ${exitCode}`

    serverLog.error(`Agent exited with code ${exitCode}`, taskId)

    if (task.retry_count < maxRetries && sessionId) {
      serverLog.info(
        `Retrying (attempt ${task.retry_count + 1}/${maxRetries})`,
        taskId,
      )
      // v2: fail → in_progress:retrying
      const target = transition(task.status, task.substatus, 'fail')
      this.deps.updateTask(taskId, {
        status: target.status,
        substatus: target.substatus,
        retry_count: task.retry_count + 1,
        result: errorMsg,
      })
      this.deps.createTaskEvent(
        taskId,
        'retried',
        JSON.stringify({ exit_code: exitCode, attempt: task.retry_count + 1 }),
      )
      const updated = this.deps.getTaskById(taskId)
      this.deps.broadcast('task:updated', updated)

      // Retry after a short delay
      setTimeout(() => {
        const current = this.deps.getTaskById(taskId)
        if (
          current &&
          current.status === 'in_progress' &&
          current.substatus === 'retrying'
        ) {
          this.retryTask(current, project).catch(() => {
            this.pushToError(taskId, 'Failed to spawn retry')
          })
        }
      }, 2000)
    } else {
      // Max retries exceeded, push to inbox as error (pending:review)
      this.pushToError(taskId, errorMsg)
    }
  }

  private pushToError(taskId: string, errorMsg: string): void {
    const task = this.deps.getTaskById(taskId)
    if (task) {
      // v2: dispatch_error → pending:review (errors surface as review items)
      const target = transition(
        task.status,
        task.substatus,
        'dispatch_error',
      )
      this.deps.updateTask(taskId, {
        status: target.status,
        substatus: target.substatus,
        result: errorMsg,
      })
    }
    this.deps.createTaskEvent(
      taskId,
      'error',
      JSON.stringify({ error: errorMsg }),
    )
    const updated = this.deps.getTaskById(taskId)
    this.deps.broadcast('inbox:new', updated)
    this.deps.onTaskCompleted(taskId)
  }
}

function parseSessionData(raw: string | null): AgentSessionData | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Parse session data directly from a Task object. */
function getSessionData(task: {
  agent_session_data: string | null
}): AgentSessionData | null {
  return parseSessionData(task.agent_session_data)
}

/** Parse session data, merge updates, and return serialized JSON string. */
function updateSessionData(
  raw: string | null,
  updates: Partial<AgentSessionData>,
): string {
  const data = parseSessionData(raw) ?? { session_id: null, pid: 0 }
  Object.assign(data, updates)
  return JSON.stringify(data)
}

export { getSessionData, parseSessionData, updateSessionData }
