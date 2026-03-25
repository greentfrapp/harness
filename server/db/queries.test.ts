import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from './index.ts';
import {
  seedProjects,
  getAllProjects,
  createTask,
  getTaskById,
  getTasksByStatus,
  updateTask,
  createTaskEvent,
  getTaskEvents,
  clearParentReferences,
  deleteTaskById,
} from './queries.ts';
import type { HarnessConfig } from '../../shared/types.ts';

const testConfig: HarnessConfig = {
  worktree_limit: 3,
  conversation_limit: 5,
  task_types: {},
  tags: {},
  projects: [
    { name: 'test-project', repo_path: '/tmp/test', target_branch: 'main' },
  ],
};

describe('DB Queries', () => {
  beforeEach(() => {
    initTestDatabase();
    seedProjects(testConfig);
  });

  describe('seedProjects', () => {
    it('inserts projects from config', () => {
      const projects = getAllProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('test-project');
      expect(projects[0].repo_path).toBe('/tmp/test');
    });

    it('updates existing project on re-seed', () => {
      const updated: HarnessConfig = {
        ...testConfig,
        projects: [
          { name: 'test-project', repo_path: '/tmp/updated', target_branch: 'dev' },
        ],
      };
      seedProjects(updated);
      const projects = getAllProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].repo_path).toBe('/tmp/updated');
      expect(projects[0].target_branch).toBe('dev');
    });
  });

  describe('createTask', () => {
    it('creates a task with defaults', () => {
      const projectId = getAllProjects()[0].id;
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'build a feature',
      });

      expect(task.id).toBeDefined();
      expect(task.status).toBe('queued');
      expect(task.priority).toBe('P2');
      expect(task.retry_count).toBe(0);
      expect(task.agent_type).toBe('claude-code');
    });

    it('creates a "created" event', () => {
      const projectId = getAllProjects()[0].id;
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'test',
      });

      const events = getTaskEvents(task.id);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('created');
    });

    it('respects provided priority', () => {
      const projectId = getAllProjects()[0].id;
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'urgent work',
        priority: 'P0',
      });
      expect(task.priority).toBe('P0');
    });
  });

  describe('getTasksByStatus', () => {
    it('filters by single status', () => {
      const projectId = getAllProjects()[0].id;
      createTask({ project_id: projectId, type: 'do', prompt: 'a' });
      createTask({ project_id: projectId, type: 'do', prompt: 'b' });

      const queued = getTasksByStatus(['queued']);
      expect(queued).toHaveLength(2);

      const inProgress = getTasksByStatus(['in_progress']);
      expect(inProgress).toHaveLength(0);
    });

    it('filters by multiple statuses', () => {
      const projectId = getAllProjects()[0].id;
      const task = createTask({ project_id: projectId, type: 'do', prompt: 'a' });
      updateTask(task.id, { status: 'ready' });

      createTask({ project_id: projectId, type: 'do', prompt: 'b' });

      const result = getTasksByStatus(['queued', 'ready']);
      expect(result).toHaveLength(2);
    });
  });

  describe('updateTask', () => {
    it('updates fields and sets updated_at', () => {
      const projectId = getAllProjects()[0].id;
      const task = createTask({ project_id: projectId, type: 'do', prompt: 'a' });
      const originalUpdatedAt = task.updated_at;

      // Small delay to ensure updated_at changes
      const updated = updateTask(task.id, { status: 'in_progress' });

      expect(updated?.status).toBe('in_progress');
      expect(updated!.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
    });
  });

  describe('clearParentReferences', () => {
    it('nulls depends_on on child tasks when parent is removed', () => {
      const projectId = getAllProjects()[0].id;
      const parent = createTask({ project_id: projectId, type: 'do', prompt: 'parent' });
      const child = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'child',
        depends_on: parent.id,
      });

      expect(getTaskById(child.id)!.depends_on).toBe(parent.id);

      clearParentReferences(parent.id);

      expect(getTaskById(child.id)!.depends_on).toBeNull();
    });

    it('nulls parent_task_id on follow-up tasks when parent is removed', () => {
      const projectId = getAllProjects()[0].id;
      const parent = createTask({ project_id: projectId, type: 'do', prompt: 'parent' });
      const followUp = createTask({ project_id: projectId, type: 'do', prompt: 'follow-up' });
      updateTask(followUp.id, { parent_task_id: parent.id });

      expect(getTaskById(followUp.id)!.parent_task_id).toBe(parent.id);

      clearParentReferences(parent.id);

      expect(getTaskById(followUp.id)!.parent_task_id).toBeNull();
    });

    it('is called automatically by deleteTaskById', () => {
      const projectId = getAllProjects()[0].id;
      const parent = createTask({ project_id: projectId, type: 'do', prompt: 'parent' });
      const child = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'child',
        depends_on: parent.id,
      });

      deleteTaskById(parent.id);

      // Child should have depends_on nulled out
      expect(getTaskById(child.id)!.depends_on).toBeNull();
    });
  });

  describe('createTaskEvent / getTaskEvents', () => {
    it('round-trips event storage', () => {
      const projectId = getAllProjects()[0].id;
      const task = createTask({ project_id: projectId, type: 'do', prompt: 'a' });

      createTaskEvent(task.id, 'dispatched', null);
      createTaskEvent(task.id, 'completed', JSON.stringify({ summary: 'done' }));

      const events = getTaskEvents(task.id);
      // 1 from createTask ('created') + 2 manually created
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.event_type)).toEqual([
        'created',
        'dispatched',
        'completed',
      ]);
      expect(events[2].data).toBe(JSON.stringify({ summary: 'done' }));
    });
  });
});
