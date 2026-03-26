import { beforeEach, describe, expect, it } from 'vitest'
import type { HarnessConfig } from '../../shared/types'
import { initTestDatabase } from './index'
import {
  clearParentReferences,
  createSubtaskProposals,
  createTask,
  createTaskEvent,
  deleteTasksByIds,
  getAllProjects,
  getChildTasks,
  getSubtaskProposals,
  getTaskById,
  getTaskEvents,
  getTasksByStatus,
  seedProjects,
  updateSubtaskProposal,
  updateTask,
} from './queries'

const testConfig: HarnessConfig = {
  worktree_limit: 3,
  conversation_limit: 5,
  task_types: {},
  tags: {},
  projects: [
    { name: 'test-project', repo_path: '/tmp/test', target_branch: 'main' },
  ],
}

describe('DB Queries', () => {
  beforeEach(() => {
    initTestDatabase()
    seedProjects(testConfig)
  })

  describe('seedProjects', () => {
    it('inserts projects from config', () => {
      const projects = getAllProjects()
      expect(projects).toHaveLength(1)
      expect(projects[0].name).toBe('test-project')
      expect(projects[0].repo_path).toBe('/tmp/test')
    })

    it('updates existing project on re-seed', () => {
      const updated: HarnessConfig = {
        ...testConfig,
        projects: [
          {
            name: 'test-project',
            repo_path: '/tmp/updated',
            target_branch: 'dev',
          },
        ],
      }
      seedProjects(updated)
      const projects = getAllProjects()
      expect(projects).toHaveLength(1)
      expect(projects[0].repo_path).toBe('/tmp/updated')
      expect(projects[0].target_branch).toBe('dev')
    })
  })

  describe('createTask', () => {
    it('creates a task with defaults', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'build a feature',
      })

      expect(task.id).toBeDefined()
      expect(task.status).toBe('queued')
      expect(task.priority).toBe('P2')
      expect(task.retry_count).toBe(0)
      expect(task.agent_type).toBe('claude-code')
    })

    it('creates a "created" event', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'test',
      })

      const events = getTaskEvents(task.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('created')
    })

    it('respects provided priority', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'urgent work',
        priority: 'P0',
      })
      expect(task.priority).toBe('P0')
    })
  })

  describe('getTasksByStatus', () => {
    it('filters by single status', () => {
      const projectId = getAllProjects()[0].id
      createTask({ project_id: projectId, type: 'do', prompt: 'a' })
      createTask({ project_id: projectId, type: 'do', prompt: 'b' })

      const queued = getTasksByStatus(['queued'])
      expect(queued).toHaveLength(2)

      const inProgress = getTasksByStatus(['in_progress'])
      expect(inProgress).toHaveLength(0)
    })

    it('filters by multiple statuses', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'a',
      })
      updateTask(task.id, { status: 'ready' })

      createTask({ project_id: projectId, type: 'do', prompt: 'b' })

      const result = getTasksByStatus(['queued', 'ready'])
      expect(result).toHaveLength(2)
    })
  })

  describe('updateTask', () => {
    it('updates fields and sets updated_at', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'a',
      })
      const originalUpdatedAt = task.updated_at

      // Small delay to ensure updated_at changes
      const updated = updateTask(task.id, { status: 'in_progress' })

      expect(updated?.status).toBe('in_progress')
      expect(updated!.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt)
    })
  })

  describe('clearParentReferences', () => {
    it('nulls depends_on on child tasks when parent is removed', () => {
      const projectId = getAllProjects()[0].id
      const parent = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      const child = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'child',
        depends_on: parent.id,
      })

      expect(getTaskById(child.id)!.depends_on).toBe(parent.id)

      clearParentReferences(parent.id)

      expect(getTaskById(child.id)!.depends_on).toBeNull()
    })

    it('nulls parent_task_id on follow-up tasks when parent is removed', () => {
      const projectId = getAllProjects()[0].id
      const parent = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      const followUp = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'follow-up',
      })
      updateTask(followUp.id, { parent_task_id: parent.id })

      expect(getTaskById(followUp.id)!.parent_task_id).toBe(parent.id)

      clearParentReferences(parent.id)

      expect(getTaskById(followUp.id)!.parent_task_id).toBeNull()
    })

    it('is called automatically by deleteTasksByIds', () => {
      const projectId = getAllProjects()[0].id
      const parent = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      const child = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'child',
        depends_on: parent.id,
      })

      deleteTasksByIds([parent.id])

      // Child should have depends_on nulled out
      expect(getTaskById(child.id)!.depends_on).toBeNull()
    })
  })

  describe('createSubtaskProposals', () => {
    it('bulk inserts proposals with defaults', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent task',
      })

      const proposals = createSubtaskProposals(task.id, [
        { title: 'Fix auth', prompt: 'Fix the auth bug' },
        { title: 'Add tests', prompt: 'Add unit tests', priority: 'P0' },
      ])

      expect(proposals).toHaveLength(2)
      expect(proposals[0].title).toBe('Fix auth')
      expect(proposals[0].prompt).toBe('Fix the auth bug')
      expect(proposals[0].priority).toBe('P2') // default
      expect(proposals[0].status).toBe('pending')
      expect(proposals[0].task_id).toBe(task.id)
      expect(proposals[0].id).toBeDefined()

      expect(proposals[1].priority).toBe('P0') // explicit
    })

    it('returns correct shape with all fields', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })

      const [proposal] = createSubtaskProposals(task.id, [
        { title: 'Test', prompt: 'Do it' },
      ])

      expect(proposal).toHaveProperty('id')
      expect(proposal).toHaveProperty('task_id')
      expect(proposal).toHaveProperty('title')
      expect(proposal).toHaveProperty('prompt')
      expect(proposal).toHaveProperty('priority')
      expect(proposal).toHaveProperty('status')
      expect(proposal).toHaveProperty('created_at')
      expect(proposal.spawned_task_id).toBeNull()
    })
  })

  describe('getSubtaskProposals', () => {
    it('retrieves proposals by task ID', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      createSubtaskProposals(task.id, [
        { title: 'A', prompt: 'Do A' },
        { title: 'B', prompt: 'Do B' },
      ])

      const results = getSubtaskProposals(task.id)
      expect(results).toHaveLength(2)
      expect(results.map((r) => r.title)).toEqual(['A', 'B'])
    })

    it('returns empty array for nonexistent task', () => {
      expect(getSubtaskProposals('nonexistent-id')).toEqual([])
    })
  })

  describe('updateSubtaskProposal', () => {
    it('updates status, feedback, and spawned_task_id', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      const [proposal] = createSubtaskProposals(task.id, [
        { title: 'Test', prompt: 'Do it' },
      ])

      updateSubtaskProposal(proposal.id, {
        status: 'dismissed',
        feedback: 'Not needed',
      })

      const [updated] = getSubtaskProposals(task.id)
      expect(updated.status).toBe('dismissed')
      expect(updated.feedback).toBe('Not needed')
    })

    it('updates spawned_task_id on approval', () => {
      const projectId = getAllProjects()[0].id
      const parent = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      const child = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'child',
      })
      const [proposal] = createSubtaskProposals(parent.id, [
        { title: 'Test', prompt: 'Do it' },
      ])

      updateSubtaskProposal(proposal.id, {
        status: 'approved',
        spawned_task_id: child.id,
      })

      const [updated] = getSubtaskProposals(parent.id)
      expect(updated.status).toBe('approved')
      expect(updated.spawned_task_id).toBe(child.id)
    })
  })

  describe('getChildTasks', () => {
    it('returns tasks with matching parent_task_id', () => {
      const projectId = getAllProjects()[0].id
      const parent = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      const child1 = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'child 1',
      })
      const child2 = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'child 2',
      })
      updateTask(child1.id, { parent_task_id: parent.id })
      updateTask(child2.id, { parent_task_id: parent.id })

      const children = getChildTasks(parent.id)
      expect(children).toHaveLength(2)
      expect(children.map((c) => c.id).sort()).toEqual(
        [child1.id, child2.id].sort(),
      )
    })

    it('returns empty array when no children exist', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'lonely task',
      })

      expect(getChildTasks(task.id)).toEqual([])
    })
  })

  describe('createTaskEvent / getTaskEvents', () => {
    it('round-trips event storage', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'a',
      })

      createTaskEvent(task.id, 'dispatched', null)
      createTaskEvent(task.id, 'completed', JSON.stringify({ summary: 'done' }))

      const events = getTaskEvents(task.id)
      // 1 from createTask ('created') + 2 manually created
      expect(events).toHaveLength(3)
      expect(events.map((e) => e.event_type)).toEqual([
        'created',
        'dispatched',
        'completed',
      ])
      expect(events[2].data).toBe(JSON.stringify({ summary: 'done' }))
    })
  })
})
