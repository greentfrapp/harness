import { spawn, type ChildProcess } from 'node:child_process';
import type {
  Task,
  Project,
  HarnessConfig,
  SSEEventType,
} from '../shared/types.ts';
import type { AgentAdapter, AgentProgressEvent } from './agents/index.ts';
import type { AgentRegistry } from './agents/index.ts';
import * as git from './git.ts';
import { serverLog } from './log.ts';

export interface AgentSessionData {
  session_id: string | null;
  pid: number;
}

interface ActiveAgent {
  taskId: string;
  projectId: string;
  process: ChildProcess;
  sessionId: string | null;
  usesWorktree: boolean;
}

interface PoolDeps {
  config: HarnessConfig;
  agentRegistry: AgentRegistry;
  getProjectById: (id: string) => Project | undefined;
  updateTask: (
    id: string,
    updates: Record<string, unknown>,
  ) => Task | undefined;
  createTaskEvent: (
    taskId: string,
    eventType: string,
    data: string | null,
  ) => void;
  broadcast: (event: SSEEventType, data: unknown) => void;
  getTaskById: (id: string) => Task | undefined;
  onTaskCompleted: (taskId: string) => void;
}

export class AgentPool {
  private agents = new Map<string, ActiveAgent>();
  private deps: PoolDeps;
  /** Per-task buffer of recent progress messages for late-joining clients. */
  private progressBuffers = new Map<string, unknown[]>();
  private static readonly MAX_BUFFER_SIZE = 200;

  constructor(deps: PoolDeps) {
    this.deps = deps;
  }

  /** Get buffered progress messages for a task (for clients that connect mid-stream). */
  getProgressBuffer(taskId: string): unknown[] {
    return this.progressBuffers.get(taskId) ?? [];
  }

  get activeWorktreeCount(): number {
    return [...this.agents.values()].filter((a) => a.usesWorktree).length;
  }

  get activeConversationCount(): number {
    return [...this.agents.values()].filter((a) => !a.usesWorktree).length;
  }

  hasAgent(taskId: string): boolean {
    return this.agents.has(taskId);
  }

  /** Dispatch a Do task: create worktree, spawn agent, handle lifecycle. */
  async dispatchDoTask(task: Task, project: Project): Promise<void> {
    let branchName: string;
    let wtPath: string;

    if (task.worktree_path && task.branch_name) {
      // Revision: reuse existing worktree and branch (preserves original commits)
      branchName = task.branch_name;
      wtPath = task.worktree_path;
    } else {
      // New task: create fresh worktree from target branch
      branchName = git.makeBranchName(task.id, task.prompt);
      wtPath = git.worktreePath(project.repo_path, branchName);

      git.createWorktree(
        project.repo_path,
        project.target_branch,
        branchName,
        wtPath,
      );

      this.deps.updateTask(task.id, {
        worktree_path: wtPath,
        branch_name: branchName,
      });
    }

    // Check if this task has a pre-populated session ID (e.g. follow-up task)
    const existingSession = parseSessionData(task.agent_session_data);
    if (existingSession?.session_id) {
      // Resume the previous conversation in the existing worktree
      this.spawnAgent(task, project, {
        cwd: wtPath,
        systemPrompt: null,
        usesWorktree: true,
        resumeSessionId: existingSession.session_id,
      });
      return;
    }

    // Build system prompt from config template
    const taskTypeConfig = this.deps.config.task_types[task.type] ??
      this.deps.config.task_types['do'];
    const systemPrompt = taskTypeConfig
      ? taskTypeConfig.prompt_template.replace('{user_prompt}', task.prompt)
      : task.prompt;

    // Spawn agent
    this.spawnAgent(task, project, {
      cwd: wtPath,
      systemPrompt,
      usesWorktree: true,
      resumeSessionId: null,
    });
  }

  /** Dispatch a Discuss task: plan mode, no worktree. */
  async dispatchDiscussTask(task: Task, project: Project): Promise<void> {
    const taskTypeConfig = this.deps.config.task_types[task.type] ??
      this.deps.config.task_types['discuss'];
    const systemPrompt = taskTypeConfig
      ? taskTypeConfig.prompt_template.replace('{user_prompt}', task.prompt)
      : task.prompt;

    this.spawnAgent(task, project, {
      cwd: project.repo_path,
      systemPrompt,
      usesWorktree: false,
      resumeSessionId: null,
    });
  }

  /** Retry a failed task using --resume. */
  async retryTask(task: Task, project: Project): Promise<void> {
    const sessionData = parseSessionData(task.agent_session_data);
    if (!sessionData?.session_id) {
      throw new Error(`Cannot retry task ${task.id}: no session ID`);
    }

    const cwd = task.worktree_path ?? project.repo_path;
    this.spawnAgent(task, project, {
      cwd,
      systemPrompt: null,
      usesWorktree: !!task.worktree_path,
      resumeSessionId: sessionData.session_id,
    });
  }

  /** Kill a running agent process. */
  killAgent(taskId: string): boolean {
    const agent = this.agents.get(taskId);
    if (!agent) return false;

    try {
      agent.process.kill('SIGTERM');
      // Give it 5s, then SIGKILL
      setTimeout(() => {
        try {
          agent.process.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }, 5000);
    } catch {
      // Process may already be dead
    }

    this.agents.delete(taskId);
    return true;
  }

  /** Kill an agent by PID (for crash recovery). */
  killByPid(pid: number): void {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process doesn't exist
    }
  }

  private spawnAgent(
    task: Task,
    project: Project,
    opts: {
      cwd: string;
      systemPrompt: string | null;
      usesWorktree: boolean;
      resumeSessionId: string | null;
    },
  ): void {
    const adapter = this.deps.agentRegistry.getOrDefault(task.agent_type);

    const args = opts.resumeSessionId
      ? adapter.buildResumeArgs({
          prompt: task.prompt,
          sessionId: opts.resumeSessionId,
          usesWorktree: opts.usesWorktree,
        })
      : adapter.buildArgs({
          prompt: task.prompt,
          systemPrompt: opts.systemPrompt,
          usesWorktree: opts.usesWorktree,
        });

    // Append extra_args from config if defined
    const agentConfig = this.deps.config.agents?.[task.agent_type];
    if (agentConfig?.extra_args) {
      args.push(...agentConfig.extra_args);
    }

    serverLog.info(`Spawning ${adapter.executable} agent in ${opts.cwd}`, task.id);

    const proc = spawn(adapter.executable, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const agent: ActiveAgent = {
      taskId: task.id,
      projectId: project.id,
      process: proc,
      sessionId: opts.resumeSessionId,
      usesWorktree: opts.usesWorktree,
    };
    this.agents.set(task.id, agent);

    // Handle spawn errors (e.g. CLI not found in PATH)
    proc.on('error', (err) => {
      this.agents.delete(task.id);
      serverLog.error(`Failed to spawn ${adapter.executable}: ${err.message}`, task.id);
      this.pushToError(
        task.id,
        `Failed to spawn ${adapter.executable}: ${err.message}. Is the ${adapter.executable} CLI installed and in PATH?`,
      );
    });

    // Store PID immediately (pid is undefined if spawn fails)
    if (proc.pid) {
      const sessionData: AgentSessionData = {
        session_id: opts.resumeSessionId,
        pid: proc.pid,
      };
      this.deps.updateTask(task.id, {
        agent_session_data: JSON.stringify(sessionData),
      });
    }

    // Collect stdout for parsing
    let buffer = '';
    let lastSummary = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        const event = adapter.parseMessage(line);
        if (!event) continue;

        this.handleAgentEvent(task.id, agent, event);

        // Capture session_id
        if (event.sessionId && !agent.sessionId) {
          agent.sessionId = event.sessionId;
          const updated: AgentSessionData = {
            session_id: event.sessionId,
            pid: proc.pid!,
          };
          this.deps.updateTask(task.id, {
            agent_session_data: JSON.stringify(updated),
          });
        }

        // Capture agent summary from result event
        if (event.type === 'result' && event.summary) {
          lastSummary = event.summary;
        }
      }
    });

    // Log stderr for debugging
    let stderrBuffer = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    // Handle process exit
    proc.on('close', (code) => {
      this.agents.delete(task.id);
      this.progressBuffers.delete(task.id);

      const currentTask = this.deps.getTaskById(task.id);
      if (!currentTask || currentTask.status === 'cancelled' || currentTask.status === 'permission') return;

      if (code === 0) {
        this.handleAgentSuccess(task.id, project, lastSummary);
      } else {
        this.handleAgentFailure(
          task.id,
          project,
          code,
          stderrBuffer,
          agent.sessionId,
        );
      }
    });
  }

  private handleAgentEvent(
    taskId: string,
    _agent: ActiveAgent,
    event: AgentProgressEvent,
  ): void {
    // Handle permission_request: kill agent, move task to inbox
    if (event.type === 'permission_request') {
      serverLog.warn(
        `Permission requested for tool: ${event.toolName ?? 'unknown'}`,
        taskId,
      );

      this.killAgent(taskId);

      const toolInfo = event.toolName
        ? `Tool requiring permission: ${event.toolName}`
        : 'Agent requested permission for a tool';
      this.deps.updateTask(taskId, {
        status: 'permission',
        error_message: toolInfo,
      });
      this.deps.createTaskEvent(
        taskId,
        'permission_requested',
        JSON.stringify({ tool: event.toolName ?? null }),
      );
      const updated = this.deps.getTaskById(taskId);
      this.deps.broadcast('inbox:new', updated);
      this.deps.onTaskCompleted(taskId);
      return;
    }

    // Buffer the message for late-joining clients
    let buffer = this.progressBuffers.get(taskId);
    if (!buffer) {
      serverLog.info(`First progress event for task (type=${(event.raw as any)?.type ?? event.type})`, taskId);
    }
    if (!buffer) {
      buffer = [];
      this.progressBuffers.set(taskId, buffer);
    }
    buffer.push(event.raw);
    if (buffer.length > AgentPool.MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - AgentPool.MAX_BUFFER_SIZE);
    }

    // Forward as progress event
    this.deps.broadcast('task:progress', {
      task_id: taskId,
      message: event.raw,
    });
  }

  private handleAgentSuccess(
    taskId: string,
    project: Project,
    summary: string,
  ): void {
    serverLog.info(`Agent completed successfully`, taskId);
    const task = this.deps.getTaskById(taskId);
    if (!task) return;

    // Capture diff stats and full diff for Do tasks
    let diffSummary: string | null = null;
    let diffFull: string | null = null;
    if (task.branch_name) {
      diffSummary = git.getDiffStats(
        project.repo_path,
        project.target_branch,
        task.branch_name,
      );
      diffFull = git.getDiff(
        project.repo_path,
        project.target_branch,
        task.branch_name,
      ) || null;
    }

    this.deps.updateTask(taskId, {
      status: 'ready',
      agent_summary: summary || null,
      diff_summary: diffSummary,
      diff_full: diffFull,
      error_message: null,
    });
    this.deps.createTaskEvent(taskId, 'completed', null);
    const updated = this.deps.getTaskById(taskId);
    this.deps.broadcast('inbox:new', updated);
    this.deps.onTaskCompleted(taskId);
  }

  private handleAgentFailure(
    taskId: string,
    project: Project,
    exitCode: number | null,
    stderr: string,
    sessionId: string | null,
  ): void {
    const task = this.deps.getTaskById(taskId);
    if (!task) return;

    const maxRetries = 3;
    const errorMsg = stderr.trim().slice(0, 2000) ||
      `Agent exited with code ${exitCode}`;

    serverLog.error(`Agent exited with code ${exitCode}`, taskId);

    if (task.retry_count < maxRetries && sessionId) {
      serverLog.info(`Retrying (attempt ${task.retry_count + 1}/${maxRetries})`, taskId);
      // Retry with --resume
      this.deps.updateTask(taskId, {
        status: 'retrying',
        retry_count: task.retry_count + 1,
        error_message: errorMsg,
      });
      this.deps.createTaskEvent(
        taskId,
        'retried',
        JSON.stringify({ exit_code: exitCode, attempt: task.retry_count + 1 }),
      );
      const updated = this.deps.getTaskById(taskId);
      this.deps.broadcast('task:updated', updated);

      // Retry after a short delay
      setTimeout(() => {
        const current = this.deps.getTaskById(taskId);
        if (current && current.status === 'retrying') {
          this.retryTask(current, project).catch(() => {
            // If retry spawn fails, push to inbox as error
            this.pushToError(taskId, 'Failed to spawn retry');
          });
        }
      }, 2000);
    } else {
      // Max retries exceeded, push to inbox as error
      this.pushToError(taskId, errorMsg);
    }
  }

  private pushToError(taskId: string, errorMsg: string): void {
    this.deps.updateTask(taskId, {
      status: 'error',
      error_message: errorMsg,
    });
    this.deps.createTaskEvent(
      taskId,
      'error',
      JSON.stringify({ error: errorMsg }),
    );
    const updated = this.deps.getTaskById(taskId);
    this.deps.broadcast('inbox:new', updated);
    this.deps.onTaskCompleted(taskId);
  }
}

function parseSessionData(raw: string | null): AgentSessionData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export { parseSessionData };
