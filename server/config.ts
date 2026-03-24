import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parse as parseJsonc } from 'jsonc-parser';
import type { HarnessConfig, ProjectConfig } from '../shared/types.ts';

export const HARNESS_DIR = path.join(os.homedir(), '.harness');
export const DB_PATH = path.join(HARNESS_DIR, 'harness.db');
export const CONFIG_PATH = path.join(HARNESS_DIR, 'config.jsonc');

const DEFAULT_DO_PROMPT = `You are working on a task in a git worktree branch. Your job is to complete the task described below.

Rules:
- Stay focused on the task. Do not make unrelated changes.
- When finished, write a brief summary of what you did and key decisions you made.
- Commit your changes with a clear commit message.

Task:
{user_prompt}`;

const DEFAULT_DISCUSS_PROMPT = `You are in research/plan mode. Your job is to analyze the topic below and present a structured response.

Rules:
- Do NOT modify any files. Read and search only.
- Structure your response as: (1) Problem statement, (2) Relevant code references, (3) Proposed approaches with tradeoffs.
- If you identify concrete implementation tasks, propose them as subtasks using this JSON format:

  {"subtasks": [{"title": "...", "prompt": "...", "priority": "normal", "depends_on": null}]}

- Only propose subtasks when you have a clear, actionable recommendation. Not every discussion needs subtasks.

Topic:
{user_prompt}`;

const DEFAULT_CONFIG: HarnessConfig = {
  worktree_limit: 3,
  conversation_limit: 5,
  task_types: {
    do: {
      prompt_template: DEFAULT_DO_PROMPT,
      needs_worktree: true,
      default_priority: 'normal',
    },
    discuss: {
      prompt_template: DEFAULT_DISCUSS_PROMPT,
      needs_worktree: false,
      default_priority: 'normal',
    },
  },
  projects: [],
};

const DEFAULT_CONFIG_TEMPLATE = `{
  // Global defaults
  "worktree_limit": 3,
  "conversation_limit": 5,

  // Task types — "do" and "discuss" are built-in, custom types can be added
  "task_types": {
    "do": {
      "prompt_template": "You are working on a task in a git worktree branch...\\n\\nTask:\\n{user_prompt}",
      "needs_worktree": true,
      "default_priority": "normal"
    },
    "discuss": {
      "prompt_template": "You are in research/plan mode...\\n\\nTopic:\\n{user_prompt}",
      "needs_worktree": false,
      "default_priority": "normal"
    }
  },

  // Projects — add your repositories here
  "projects": [
    // {
    //   "name": "my-app",
    //   "repo_path": "/home/user/projects/my-app",
    //   "target_branch": "main",
    //   "auto_push": true
    // }
  ]
}
`;

export function ensureHarnessDir(): void {
  fs.mkdirSync(HARNESS_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, DEFAULT_CONFIG_TEMPLATE, 'utf-8');
  }
}

export function loadConfig(): HarnessConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = parseJsonc(raw) ?? {};

  return {
    worktree_limit: parsed.worktree_limit ?? DEFAULT_CONFIG.worktree_limit,
    conversation_limit:
      parsed.conversation_limit ?? DEFAULT_CONFIG.conversation_limit,
    agents: parsed.agents ?? undefined,
    task_types: {
      ...DEFAULT_CONFIG.task_types,
      ...(parsed.task_types ?? {}),
    },
    projects: parsed.projects ?? [],
  };
}

export function validateConfig(config: HarnessConfig): void {
  for (const project of config.projects) {
    validateProject(project);
  }
}

/** Read the raw config file content. */
export function readConfigRaw(): string {
  if (!fs.existsSync(CONFIG_PATH)) {
    return '';
  }
  return fs.readFileSync(CONFIG_PATH, 'utf-8');
}

/** Validate and save raw JSONC content to config file. Returns parsed config on success. */
export function saveConfigRaw(
  content: string,
): { ok: true; config: HarnessConfig } | { ok: false; error: string } {
  // Parse JSONC with error collection
  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed = parseJsonc(content, errors);

  if (errors.length > 0) {
    return { ok: false, error: `Invalid JSONC syntax at offset ${errors[0].offset}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Config must be a JSON object' };
  }

  // Build a HarnessConfig from parsed content to validate
  const config: HarnessConfig = {
    worktree_limit: parsed.worktree_limit ?? DEFAULT_CONFIG.worktree_limit,
    conversation_limit: parsed.conversation_limit ?? DEFAULT_CONFIG.conversation_limit,
    agents: parsed.agents ?? undefined,
    task_types: {
      ...DEFAULT_CONFIG.task_types,
      ...(parsed.task_types ?? {}),
    },
    projects: parsed.projects ?? [],
  };

  // Validate semantics (project paths, branches)
  try {
    validateConfig(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

  // Write to disk
  fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
  return { ok: true, config };
}

function validateProject(project: ProjectConfig): void {
  if (!project.name) {
    throw new Error('Project is missing a name');
  }
  if (!project.repo_path) {
    throw new Error(`Project "${project.name}" is missing repo_path`);
  }
  if (!fs.existsSync(project.repo_path)) {
    throw new Error(
      `Project "${project.name}": repo_path does not exist: ${project.repo_path}`,
    );
  }
  const gitDir = path.join(project.repo_path, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error(
      `Project "${project.name}": not a git repository: ${project.repo_path}`,
    );
  }

  const branch = project.target_branch ?? 'main';
  try {
    execSync(`git rev-parse --verify ${branch}`, {
      cwd: project.repo_path,
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      `Project "${project.name}": target branch "${branch}" does not exist in ${project.repo_path}`,
    );
  }
}
