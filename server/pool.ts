import { spawn, type ChildProcess } from 'node:child_process';
import type {
  Task,
  Project,
  HarnessConfig,
  SSEEventType,
} from '../shared/types.ts';
import * as git from './git.ts';

/**
 * Claude Code JSON output message types (subset we care about).
 * CC --json emits one JSON object per line on stdout.
 */
interface CCMessage {
  type: string; // 'assistant', 'tool_use', 'tool_result', 'result', 'system', etc.
  session_id?: string;
  message?: string;
  content?: unknown;
  tool?: string;
  subtype?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  result?: string;
  [key: string]: unknown;
}

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

  constructor(deps: PoolDeps) {
    this.deps = deps;
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

  /** Dispatch a Do task: create worktree, spawn CC, handle lifecycle. */
  async dispatchDoTask(task: Task, project: Project): Promise<void> {
    const branchName = git.makeBranchName(task.id, task.prompt);
    const wtPath = git.worktreePath(project.repo_path, branchName);

    // Create worktree from target branch
    git.createWorktree(
      project.repo_path,
      project.target_branch,
      branchName,
      wtPath,
    );

    // Update task with worktree info
    this.deps.updateTask(task.id, {
      worktree_path: wtPath,
      branch_name: branchName,
    });

    // Build system prompt from config template
    const taskTypeConfig = this.deps.config.task_types[task.type] ??
      this.deps.config.task_types['do'];
    const systemPrompt = taskTypeConfig
      ? taskTypeConfig.prompt_template.replace('{user_prompt}', task.prompt)
      : task.prompt;

    // Spawn Claude Code
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
    const args = buildCCArgs({
      prompt: task.prompt,
      systemPrompt: opts.systemPrompt,
      resumeSessionId: opts.resumeSessionId,
      usesWorktree: opts.usesWorktree,
    });

    const proc = spawn('claude', args, {
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

    // Handle spawn errors (e.g. claude not found in PATH)
    proc.on('error', (err) => {
      this.agents.delete(task.id);
      this.pushToError(
        task.id,
        `Failed to spawn claude: ${err.message}. Is the claude CLI installed and in PATH?`,
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
        try {
          const msg: CCMessage = JSON.parse(line);
          this.handleCCMessage(task.id, agent, msg);

          // Capture session_id
          if (msg.session_id && !agent.sessionId) {
            agent.sessionId = msg.session_id;
            const updated: AgentSessionData = {
              session_id: msg.session_id,
              pid: proc.pid!,
            };
            this.deps.updateTask(task.id, {
              agent_session_data: JSON.stringify(updated),
            });
          }

          // Capture agent summary from result message
          if (msg.type === 'result' && typeof msg.result === 'string') {
            lastSummary = msg.result;
          }
        } catch {
          // Not valid JSON, skip
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

      const currentTask = this.deps.getTaskById(task.id);
      if (!currentTask || currentTask.status === 'cancelled') return;

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

  private handleCCMessage(
    taskId: string,
    agent: ActiveAgent,
    msg: CCMessage,
  ): void {
    // Forward as progress event
    this.deps.broadcast('task:progress', {
      task_id: taskId,
      message: msg,
    });
  }

  private handleAgentSuccess(
    taskId: string,
    project: Project,
    summary: string,
  ): void {
    const task = this.deps.getTaskById(taskId);
    if (!task) return;

    // Capture diff stats for Do tasks
    let diffSummary: string | null = null;
    if (task.branch_name) {
      diffSummary = git.getDiffStats(
        project.repo_path,
        project.target_branch,
        task.branch_name,
      );
    }

    this.deps.updateTask(taskId, {
      status: 'ready',
      agent_summary: summary || null,
      diff_summary: diffSummary,
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

    if (task.retry_count < maxRetries && sessionId) {
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

/** Build Claude Code CLI arguments. */
function buildCCArgs(opts: {
  prompt: string;
  systemPrompt: string | null;
  resumeSessionId: string | null;
  usesWorktree: boolean;
}): string[] {
  const args: string[] = ['--json'];

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (!opts.usesWorktree) {
    // Discuss tasks / plan mode — read-only
    args.push('--allowedTools', 'Read,Glob,Grep,WebSearch,WebFetch');
  }

  // The prompt is passed via -p for non-interactive mode
  args.push('-p', opts.prompt);

  return args;
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
