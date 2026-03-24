import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { serverLog } from './log.ts';

/**
 * Git operations for worktree management, diff capture, and branch merging.
 * All functions are synchronous (using execSync) since git operations are fast
 * and we want atomic behavior.
 */

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
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
  );
}

/** Remove a git worktree and prune. */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  if (!fs.existsSync(worktreePath)) return;
  try {
    execSync(`git worktree remove ${JSON.stringify(worktreePath)} --force`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch {
    // If worktree remove fails, try manual cleanup
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      execSync('git worktree prune', { cwd: repoPath, stdio: 'pipe' });
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
    });
  } catch {
    // Branch may already be deleted
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
    });
  } catch {
    return '';
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
    }).trim();
  } catch {
    return '';
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
  const tmpDir = path.join(os.tmpdir(), `harness-merge-${Date.now()}`);
  try {
    // Use --detach so this works even when targetBranch is already checked out
    execSync(
      `git worktree add --detach ${JSON.stringify(tmpDir)} ${targetBranch}`,
      { cwd: repoPath, stdio: 'pipe' },
    );
    // Sync with remote before merging
    try {
      execSync(`git fetch origin ${targetBranch}`, { cwd: tmpDir, stdio: 'pipe' });
      execSync(`git merge origin/${targetBranch} --ff-only`, { cwd: tmpDir, stdio: 'pipe' });
    } catch {
      // No remote configured or diverged — proceed with local state
    }
    execSync(
      `git merge ${branchName} --no-ff -m "Merge ${branchName}"`,
      { cwd: tmpDir, stdio: 'pipe' },
    );
    // Capture the merge commit hash and update the target branch ref in the main repo
    const mergeCommit = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    execSync(
      `git update-ref refs/heads/${targetBranch} ${mergeCommit}`,
      { cwd: repoPath, stdio: 'pipe' },
    );
    if (opts?.push) {
      execSync(`git push origin ${targetBranch}`, { cwd: repoPath, stdio: 'pipe' });
    }
  } finally {
    try {
      execSync(`git worktree remove ${JSON.stringify(tmpDir)} --force`, {
        cwd: repoPath,
        stdio: 'pipe',
      });
    } catch {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      execSync('git worktree prune', { cwd: repoPath, stdio: 'pipe' });
    }
  }
}

/** List all worktrees for a repo. */
export function listWorktrees(repoPath: string): WorktreeInfo[] {
  const output = execSync('git worktree list --porcelain', {
    cwd: repoPath,
    encoding: 'utf-8',
  });

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      // branch refs/heads/foo → foo
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    }
  }
  if (current.path) worktrees.push(current as WorktreeInfo);

  return worktrees;
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
    );
    return parseInt(output.trim(), 10) > 0;
  } catch {
    return false;
  }
}

/** Generate a branch name from task ID and prompt. */
export function makeBranchName(taskId: string, prompt: string): string {
  const shortId = taskId.slice(0, 8);
  const sanitized = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `harness/${shortId}-${sanitized}`;
}

/** Get the worktree base directory for a project. */
export function worktreeBasePath(repoPath: string): string {
  return path.join(repoPath, '.harness-worktrees');
}

/** Get the full worktree path for a task. */
export function worktreePath(repoPath: string, branchName: string): string {
  const base = worktreeBasePath(repoPath);
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, branchName.replace(/\//g, '-'));
}
