import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getErrorMessage } from '../shared/types'
import { serverLog } from './log'

/**
 * Git operations for worktree management, diff capture, and branch merging.
 * All functions are synchronous (using execSync) since git operations are fast
 * and we want atomic behavior.
 */

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
}

/** Create a git worktree with a new branch from the target branch. */
export function createWorktree(
  repoPath: string,
  targetBranch: string,
  branchName: string,
  worktreePath: string,
): void {
  execSync(
    `git worktree add -b ${branchName} ${JSON.stringify(worktreePath)} ${targetBranch}`,
    { cwd: repoPath, stdio: 'pipe' },
  )
}

/** Remove a git worktree and prune. */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  if (!fs.existsSync(worktreePath)) return
  try {
    execSync(`git worktree remove ${JSON.stringify(worktreePath)} --force`, {
      cwd: repoPath,
      stdio: 'pipe',
    })
  } catch {
    // If worktree remove fails, try manual cleanup
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true })
      execSync('git worktree prune', { cwd: repoPath, stdio: 'pipe' })
    } catch {
      // Best effort cleanup
    }
  }
}

/** Delete a local git branch. */
export function deleteBranch(repoPath: string, branchName: string): void {
  try {
    execSync(`git branch -D ${branchName}`, {
      cwd: repoPath,
      stdio: 'pipe',
    })
  } catch {
    // Branch may already be deleted
  }
}

/** Check whether a local branch ref exists. */
export function branchExists(repoPath: string, branchName: string): boolean {
  try {
    execSync(`git rev-parse --verify refs/heads/${branchName}`, {
      cwd: repoPath,
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

/** Get the full diff between target branch and the task branch. */
export function getDiff(
  repoPath: string,
  targetBranch: string,
  branchName: string,
): string {
  try {
    return execSync(`git diff ${targetBranch}...${branchName}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    })
  } catch (err) {
    serverLog.warn(`getDiff failed for ${branchName}: ${getErrorMessage(err)}`)
    return ''
  }
}

/** Get a short diff summary (files changed, insertions, deletions). */
export function getDiffStats(
  repoPath: string,
  targetBranch: string,
  branchName: string,
): string {
  try {
    return execSync(`git diff --stat ${targetBranch}...${branchName}`, {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
  } catch (err) {
    serverLog.warn(
      `getDiffStats failed for ${branchName}: ${getErrorMessage(err)}`,
    )
    return ''
  }
}

/** Check if a repo has uncommitted changes. Returns dirty flag and changed file count. */
export function getRepoStatus(repoPath: string): {
  dirty: boolean
  fileCount: number
} {
  try {
    const output = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
    })
    const lines = output
      .split('\n')
      .filter((l) => l.trim().length > 0 && !l.startsWith('?? '))
    return { dirty: lines.length > 0, fileCount: lines.length }
  } catch {
    return { dirty: false, fileCount: 0 }
  }
}

/** Get the full diff of uncommitted changes in a worktree (staged + unstaged vs HEAD). */
export function getUncommittedDiff(worktreePath: string): string {
  if (!fs.existsSync(worktreePath)) return ''
  try {
    return execSync('git diff HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch (err) {
    serverLog.warn(
      `getUncommittedDiff failed for ${worktreePath}: ${getErrorMessage(err)}`,
    )
    return ''
  }
}

/** Get a short diff summary of uncommitted changes in a worktree. */
export function getUncommittedDiffStats(worktreePath: string): string {
  if (!fs.existsSync(worktreePath)) return ''
  try {
    return execSync('git diff --stat HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim()
  } catch (err) {
    serverLog.warn(
      `getUncommittedDiffStats failed for ${worktreePath}: ${getErrorMessage(err)}`,
    )
    return ''
  }
}

/** Merge a branch into the target branch using a temporary worktree.
 *  This avoids touching the main repo's working tree, so uncommitted
 *  changes in the user's checkout won't block the merge. */
export function mergeBranch(
  repoPath: string,
  targetBranch: string,
  branchName: string,
  opts?: { push?: boolean },
): void {
  const tmpDir = path.join(os.tmpdir(), `harness-merge-${Date.now()}`)
  try {
    // Use --detach so this works even when targetBranch is already checked out
    execSync(
      `git worktree add --detach ${JSON.stringify(tmpDir)} ${targetBranch}`,
      { cwd: repoPath, stdio: 'pipe' },
    )
    // Sync with remote before merging
    try {
      execSync(`git fetch origin ${targetBranch}`, {
        cwd: tmpDir,
        stdio: 'pipe',
      })
      execSync(`git merge origin/${targetBranch} --ff-only`, {
        cwd: tmpDir,
        stdio: 'pipe',
      })
    } catch {
      // No remote configured or diverged — proceed with local state
    }
    execSync(`git merge ${branchName} --no-ff -m "Merge ${branchName}"`, {
      cwd: tmpDir,
      stdio: 'pipe',
    })
    // Capture the merge commit hash and update the target branch ref in the main repo
    const mergeCommit = execSync('git rev-parse HEAD', {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim()
    execSync(`git update-ref refs/heads/${targetBranch} ${mergeCommit}`, {
      cwd: repoPath,
      stdio: 'pipe',
    })
    // If the target branch is currently checked out, sync the working directory
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim()
      if (currentBranch === targetBranch) {
        execSync('git read-tree -um HEAD', { cwd: repoPath, stdio: 'pipe' })
      }
    } catch {
      // Non-critical — working tree sync is best-effort
    }
    if (opts?.push) {
      execSync(`git push origin ${targetBranch}`, {
        cwd: repoPath,
        stdio: 'pipe',
      })
    }
  } finally {
    try {
      execSync(`git worktree remove ${JSON.stringify(tmpDir)} --force`, {
        cwd: repoPath,
        stdio: 'pipe',
      })
    } catch {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      execSync('git worktree prune', { cwd: repoPath, stdio: 'pipe' })
    }
  }
}

/** List all worktrees for a repo. */
export function listWorktrees(repoPath: string): WorktreeInfo[] {
  const output = execSync('git worktree list --porcelain', {
    cwd: repoPath,
    encoding: 'utf-8',
  })

  const worktrees: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> = {}

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current as WorktreeInfo)
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      // branch refs/heads/foo → foo
      current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    }
  }
  if (current.path) worktrees.push(current as WorktreeInfo)

  return worktrees
}

/** Check if a branch has commits ahead of the target branch. */
export function hasCommits(
  repoPath: string,
  targetBranch: string,
  branchName: string,
): boolean {
  try {
    const output = execSync(
      `git rev-list --count ${targetBranch}..${branchName}`,
      { cwd: repoPath, encoding: 'utf-8' },
    )
    return parseInt(output.trim(), 10) > 0
  } catch {
    return false
  }
}

/** Checkout a task's branch into the main repo for manual testing.
 *  Creates a temporary branch from the target, merges the task branch into it,
 *  and checks it out in the main repo working tree. */
export function checkoutTask(
  repoPath: string,
  targetBranch: string,
  taskBranch: string,
  checkoutBranch: string,
): void {
  try {
    // Create checkout branch from target
    execSync(`git checkout ${targetBranch}`, { cwd: repoPath, stdio: 'pipe' })
    execSync(`git checkout -b ${checkoutBranch}`, {
      cwd: repoPath,
      stdio: 'pipe',
    })
    // Merge task branch into it
    execSync(
      `git merge ${taskBranch} --no-ff -m "Checkout ${taskBranch} for testing"`,
      { cwd: repoPath, stdio: 'pipe' },
    )
  } catch (err) {
    // Clean up on failure: abort merge if in progress, delete branch, restore target
    try {
      execSync('git merge --abort', { cwd: repoPath, stdio: 'pipe' })
    } catch {
      /* no merge in progress */
    }
    try {
      execSync(`git checkout ${targetBranch}`, { cwd: repoPath, stdio: 'pipe' })
    } catch {
      /* best effort */
    }
    try {
      execSync(`git branch -D ${checkoutBranch}`, {
        cwd: repoPath,
        stdio: 'pipe',
      })
    } catch {
      /* may not exist */
    }
    throw err
  }
}

/** Return a checked-out repo to its target branch and clean up the checkout branch. */
export function returnCheckout(
  repoPath: string,
  targetBranch: string,
  checkoutBranch: string,
): void {
  execSync(`git checkout ${targetBranch}`, { cwd: repoPath, stdio: 'pipe' })
  try {
    execSync(`git branch -D ${checkoutBranch}`, {
      cwd: repoPath,
      stdio: 'pipe',
    })
  } catch {
    // Branch may already be deleted
  }
}

/** Get the current branch name for a repo (or null if detached HEAD). */
export function getCurrentBranch(repoPath: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
    return branch === 'HEAD' ? null : branch
  } catch {
    return null
  }
}

/** Delete all harness/checkout-* branches in a repo (startup cleanup). */
export function cleanupCheckoutBranches(repoPath: string): void {
  try {
    const output = execSync('git branch --list "harness/checkout-*"', {
      cwd: repoPath,
      encoding: 'utf-8',
    })
    for (const line of output.split('\n')) {
      const branch = line.trim().replace(/^\*\s*/, '')
      if (branch) {
        try {
          execSync(`git branch -D ${branch}`, { cwd: repoPath, stdio: 'pipe' })
          serverLog.info(`Cleaned up stale checkout branch: ${branch}`)
        } catch {
          // Best effort
        }
      }
    }
  } catch {
    // No matching branches or git error
  }
}

/** Generate a branch name from task ID and prompt. */
export function makeBranchName(taskId: string, prompt: string): string {
  const shortId = taskId.slice(0, 8)
  const sanitized = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return `harness/${shortId}-${sanitized}`
}

/** Get the worktree base directory for a project. */
export function worktreeBasePath(repoPath: string): string {
  return path.join(repoPath, '.harness-worktrees')
}

/** Get the full worktree path for a task. */
export function worktreePath(repoPath: string, branchName: string): string {
  const base = worktreeBasePath(repoPath)
  fs.mkdirSync(base, { recursive: true })
  return path.join(base, branchName.replace(/\//g, '-'))
}
