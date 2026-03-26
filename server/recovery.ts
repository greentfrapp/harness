import fs from 'node:fs'
import type { Project, Task } from '../shared/types'
import * as git from './git'
import { getSessionData } from './pool'

interface RecoveryDeps {
  getTasksByStatus: (statusList: string[]) => Task[]
  getProjectById: (id: string) => Project | undefined
  updateTask: (id: string, updates: Record<string, unknown>) => Task | undefined
  createTaskEvent: (
    taskId: string,
    eventType: string,
    data: string | null,
  ) => void
  getAllProjects: () => Project[]
}

/**
 * Crash recovery: runs synchronously on startup before accepting connections.
 * 1. Detect stale tasks (in_progress or retrying)
 * 2. Kill orphaned CC processes via stored PIDs
 * 3. Reconcile worktrees
 * 4. Transition stale tasks appropriately
 * 5. Log recovery events
 */
export function recoverStaleTasks(deps: RecoveryDeps): number {
  const staleTasks = deps.getTasksByStatus(['in_progress', 'retrying'])
  if (staleTasks.length === 0) return 0

  console.log(`Recovery: found ${staleTasks.length} stale task(s)`)

  for (const task of staleTasks) {
    recoverTask(deps, task)
  }

  // Reconcile orphaned worktrees not linked to any task
  reconcileOrphanedWorktrees(deps, staleTasks)

  return staleTasks.length
}

function recoverTask(deps: RecoveryDeps, task: Task): void {
  // 1. Kill orphaned process
  killOrphanedProcess(task)

  // 2. Determine recovery action based on worktree state
  const project = deps.getProjectById(task.project_id)
  if (!project) {
    deps.updateTask(task.id, {
      status: 'error',
      error_message: 'Server restarted; project not found',
    })
    deps.createTaskEvent(
      task.id,
      'recovered',
      JSON.stringify({
        action: 'error',
        reason: 'project_not_found',
      }),
    )
    return
  }

  if (task.worktree_path && task.branch_name) {
    // Do task with worktree
    const worktreeExists = (() => {
      try {
        return fs.statSync(task.worktree_path!).isDirectory()
      } catch {
        return false
      }
    })()

    if (
      worktreeExists &&
      git.hasCommits(project.repo_path, project.target_branch, task.branch_name)
    ) {
      // Has partial work — push to inbox as error so user can review
      deps.updateTask(task.id, {
        status: 'error',
        error_message:
          'Server restarted during execution. Partial work available for review.',
        diff_summary: git.getDiffStats(
          project.repo_path,
          project.target_branch,
          task.branch_name,
        ),
      })
      deps.createTaskEvent(
        task.id,
        'recovered',
        JSON.stringify({
          action: 'error_with_work',
          reason: 'server_restart',
        }),
      )
      console.log(
        `Recovery: task ${task.id.slice(0, 8)} → inbox (partial work)`,
      )
    } else if (!worktreeExists) {
      // Worktree gone — re-queue for fresh dispatch
      deps.updateTask(task.id, {
        status: 'queued',
        worktree_path: null,
        branch_name: null,
        agent_session_data: null,
        error_message: null,
      })
      deps.createTaskEvent(
        task.id,
        'recovered',
        JSON.stringify({
          action: 'requeued',
          reason: 'worktree_missing',
        }),
      )
      console.log(`Recovery: task ${task.id.slice(0, 8)} → re-queued`)
    } else {
      // Worktree exists but no commits — re-queue, clean up worktree
      git.removeWorktree(project.repo_path, task.worktree_path)
      git.deleteBranch(project.repo_path, task.branch_name)
      deps.updateTask(task.id, {
        status: 'queued',
        worktree_path: null,
        branch_name: null,
        agent_session_data: null,
        error_message: null,
      })
      deps.createTaskEvent(
        task.id,
        'recovered',
        JSON.stringify({
          action: 'requeued',
          reason: 'no_commits',
        }),
      )
      console.log(
        `Recovery: task ${task.id.slice(0, 8)} → re-queued (no commits)`,
      )
    }
  } else {
    // Discuss task (no worktree) — re-queue
    deps.updateTask(task.id, {
      status: 'queued',
      agent_session_data: null,
      error_message: null,
    })
    deps.createTaskEvent(
      task.id,
      'recovered',
      JSON.stringify({
        action: 'requeued',
        reason: 'no_worktree',
      }),
    )
    console.log(`Recovery: task ${task.id.slice(0, 8)} → re-queued (discuss)`)
  }
}

function killOrphanedProcess(task: Task): void {
  const data = getSessionData(task)
  if (!data?.pid) return
  try {
    process.kill(data.pid, 'SIGTERM')
    console.log(`Recovery: killed orphaned process PID ${data.pid}`)
  } catch {
    // Process doesn't exist — expected
  }
}

function reconcileOrphanedWorktrees(
  deps: RecoveryDeps,
  staleTasks: Task[],
): void {
  const knownWorktrees = new Set(
    staleTasks.filter((t) => t.worktree_path).map((t) => t.worktree_path!),
  )

  for (const project of deps.getAllProjects()) {
    try {
      const worktrees = git.listWorktrees(project.repo_path)
      for (const wt of worktrees) {
        // Only clean up harness-managed worktrees
        if (wt.branch?.startsWith('harness/') && !knownWorktrees.has(wt.path)) {
          console.log(`Recovery: removing orphaned worktree ${wt.path}`)
          git.removeWorktree(project.repo_path, wt.path)
          git.deleteBranch(project.repo_path, wt.branch)
        }
      }
    } catch {
      // Skip repos that fail
    }
  }
}
