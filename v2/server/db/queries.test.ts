import { beforeEach, describe, expect, it } from 'vitest'
import type { HarnessConfig } from '../../shared/types'
import { initTestDatabase } from './index'
import {
  clearParentReferences,
  createTaskProposals,
  createTask,
  createTaskEvent,
  createTaskTransition,
  deleteTasksByIds,
  getAllProjects,
  getChildTasks,
  getTaskProposals,
  getTaskById,
  getTaskEvents,
  getTasksByStatus,
  getTaskTransitions,
  getTransitionChain,
  seedProjects,
  updateTaskProposal,
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
      expect(task.substatus).toBeNull()
      expect(task.priority).toBe('P2')
      expect(task.retry_count).toBe(0)
      expect(task.agent_type).toBe('claude-code')
      expect(task.result).toBeNull()
      expect(task.references).toEqual([])
      expect(task.session_id).toBeNull()
      expect(task.started_at).toBeNull()
      expect(task.completed_at).toBeNull()
    })

    it('creates a draft task', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'draft task',
        as_draft: true,
      })
      expect(task.status).toBe('draft')
      expect(task.substatus).toBeNull()
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

    it('stores references', () => {
      const projectId = getAllProjects()[0].id
      const refId = crypto.randomUUID()
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'with refs',
        references: [refId],
      })
      expect(task.references).toEqual([refId])
    })

    it('stores parent_task_id', () => {
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
        parent_task_id: parent.id,
      })
      expect(child.parent_task_id).toBe(parent.id)
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
      updateTask(task.id, { status: 'pending', substatus: 'review' })

      createTask({ project_id: projectId, type: 'do', prompt: 'b' })

      const result = getTasksByStatus(['queued', 'pending'])
      expect(result).toHaveLength(2)
    })

    it('filters by substatus', () => {
      const projectId = getAllProjects()[0].id
      const t1 = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'a',
      })
      updateTask(t1.id, { status: 'in_progress', substatus: 'running' })

      const t2 = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'b',
      })
      updateTask(t2.id, { status: 'in_progress', substatus: 'retrying' })

      const running = getTasksByStatus(['in_progress'], ['running'])
      expect(running).toHaveLength(1)
      expect(running[0].id).toBe(t1.id)

      const all = getTasksByStatus(['in_progress'], ['running', 'retrying'])
      expect(all).toHaveLength(2)
    })

    it('filters by null substatus', () => {
      const projectId = getAllProjects()[0].id
      createTask({ project_id: projectId, type: 'do', prompt: 'a' }) // queued, null substatus

      const t2 = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'b',
      })
      updateTask(t2.id, { status: 'in_progress', substatus: 'running' })

      // Get only tasks with null substatus within queued+in_progress
      const nullSub = getTasksByStatus(['queued', 'in_progress'], [null])
      expect(nullSub).toHaveLength(1)
      expect(nullSub[0].status).toBe('queued')
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

      const updated = updateTask(task.id, {
        status: 'in_progress',
        substatus: 'running',
      })

      expect(updated?.status).toBe('in_progress')
      expect(updated?.substatus).toBe('running')
      expect(updated!.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt)
    })

    it('updates result field', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'a',
      })

      const updated = updateTask(task.id, { result: 'Task completed successfully' })
      expect(updated?.result).toBe('Task completed successfully')
    })

    it('updates references', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'a',
      })

      const refId = crypto.randomUUID()
      const updated = updateTask(task.id, { references: [refId] })
      expect(updated?.references).toEqual([refId])
    })

    it('updates session_id and timestamps', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'a',
      })

      const now = Date.now()
      const updated = updateTask(task.id, {
        session_id: 'sess-123',
        started_at: now,
      })
      expect(updated?.session_id).toBe('sess-123')
      expect(updated?.started_at).toBe(now)
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

      expect(getTaskById(child.id)!.depends_on).toBeNull()
    })
  })

  describe('createTaskProposals', () => {
    it('bulk inserts proposals with defaults', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent task',
      })

      const proposals = createTaskProposals(task.id, [
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

      const [proposal] = createTaskProposals(task.id, [
        { title: 'Test', prompt: 'Do it' },
      ])

      expect(proposal).toHaveProperty('id')
      expect(proposal).toHaveProperty('task_id')
      expect(proposal).toHaveProperty('title')
      expect(proposal).toHaveProperty('prompt')
      expect(proposal).toHaveProperty('priority')
      expect(proposal).toHaveProperty('tags')
      expect(proposal).toHaveProperty('parent_task_id')
      expect(proposal).toHaveProperty('depends_on')
      expect(proposal).toHaveProperty('references')
      expect(proposal).toHaveProperty('inherit_session')
      expect(proposal).toHaveProperty('status')
      expect(proposal).toHaveProperty('created_at')
      expect(proposal.spawned_task_id).toBeNull()
    })

    it('defaults parent_task_id to proposing task ID', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })

      const [proposal] = createTaskProposals(task.id, [
        { title: 'Sub', prompt: 'Do sub' },
      ])

      expect(proposal.parent_task_id).toBe(task.id)
    })

    it('allows explicit null parent_task_id for transitions', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'discuss',
        prompt: 'discuss',
      })

      const [proposal] = createTaskProposals(task.id, [
        { title: 'Plan', prompt: 'Plan it', type: 'plan', parent_task_id: null, inherit_session: true },
      ])

      expect(proposal.parent_task_id).toBeNull()
      expect(proposal.type).toBe('plan')
      expect(proposal.inherit_session).toBe(true)
    })

    it('stores and retrieves tags and references', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })

      const [proposal] = createTaskProposals(task.id, [
        {
          title: 'Tagged',
          prompt: 'Do tagged work',
          tags: ['bug', 'urgent'],
          references: ['ref-task-1', 'ref-task-2'],
        },
      ])

      expect(proposal.tags).toEqual(['bug', 'urgent'])
      expect(proposal.references).toEqual(['ref-task-1', 'ref-task-2'])

      // Verify round-trip through getTaskProposals
      const [fetched] = getTaskProposals(task.id)
      expect(fetched.tags).toEqual(['bug', 'urgent'])
      expect(fetched.references).toEqual(['ref-task-1', 'ref-task-2'])
    })

    it('defaults tags and references to empty arrays', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })

      const [proposal] = createTaskProposals(task.id, [
        { title: 'Plain', prompt: 'Do it' },
      ])

      expect(proposal.tags).toEqual([])
      expect(proposal.references).toEqual([])
    })

    it('stores depends_on', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      const dep = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'dependency',
      })

      const [proposal] = createTaskProposals(task.id, [
        { title: 'Blocked', prompt: 'After dep', depends_on: dep.id },
      ])

      expect(proposal.depends_on).toBe(dep.id)
    })
  })

  describe('getTaskProposals', () => {
    it('retrieves proposals by task ID', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      createTaskProposals(task.id, [
        { title: 'A', prompt: 'Do A' },
        { title: 'B', prompt: 'Do B' },
      ])

      const results = getTaskProposals(task.id)
      expect(results).toHaveLength(2)
      expect(results.map((r) => r.title)).toEqual(['A', 'B'])
    })

    it('returns empty array for nonexistent task', () => {
      expect(getTaskProposals('nonexistent-id')).toEqual([])
    })
  })

  describe('updateTaskProposal', () => {
    it('updates status, feedback, and spawned_task_id', () => {
      const projectId = getAllProjects()[0].id
      const task = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'parent',
      })
      const [proposal] = createTaskProposals(task.id, [
        { title: 'Test', prompt: 'Do it' },
      ])

      updateTaskProposal(proposal.id, {
        status: 'dismissed',
        feedback: 'Not needed',
      })

      const [updated] = getTaskProposals(task.id)
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
      const [proposal] = createTaskProposals(parent.id, [
        { title: 'Test', prompt: 'Do it' },
      ])

      updateTaskProposal(proposal.id, {
        status: 'approved',
        spawned_task_id: child.id,
      })

      const [updated] = getTaskProposals(parent.id)
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
      createTaskEvent(
        task.id,
        'completed',
        JSON.stringify({ summary: 'done' }),
      )

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

  describe('task transitions', () => {
    it('creates and retrieves a transition', () => {
      const projectId = getAllProjects()[0].id
      const discuss = createTask({
        project_id: projectId,
        type: 'discuss',
        prompt: 'discuss idea',
      })
      const plan = createTask({
        project_id: projectId,
        type: 'plan',
        prompt: 'plan it',
      })

      const t = createTaskTransition(
        discuss.id,
        plan.id,
        'discuss_to_plan',
      )
      expect(t.source_task_id).toBe(discuss.id)
      expect(t.target_task_id).toBe(plan.id)
      expect(t.transition_type).toBe('discuss_to_plan')
      expect(t.id).toBeDefined()
      expect(t.created_at).toBeDefined()
    })

    it('getTaskTransitions returns transitions for source or target', () => {
      const projectId = getAllProjects()[0].id
      const discuss = createTask({
        project_id: projectId,
        type: 'discuss',
        prompt: 'discuss',
      })
      const plan = createTask({
        project_id: projectId,
        type: 'plan',
        prompt: 'plan',
      })
      createTaskTransition(discuss.id, plan.id, 'discuss_to_plan')

      const fromDiscuss = getTaskTransitions(discuss.id)
      expect(fromDiscuss).toHaveLength(1)

      const fromPlan = getTaskTransitions(plan.id)
      expect(fromPlan).toHaveLength(1)

      expect(fromDiscuss[0].id).toBe(fromPlan[0].id)
    })

    it('getTransitionChain follows the full chain', () => {
      const projectId = getAllProjects()[0].id
      const discuss = createTask({
        project_id: projectId,
        type: 'discuss',
        prompt: 'discuss',
      })
      const plan = createTask({
        project_id: projectId,
        type: 'plan',
        prompt: 'plan',
      })
      const doTask = createTask({
        project_id: projectId,
        type: 'do',
        prompt: 'implement',
      })

      createTaskTransition(discuss.id, plan.id, 'discuss_to_plan')
      createTaskTransition(plan.id, doTask.id, 'plan_to_do')

      // From any node, should get the full chain
      const chainFromDiscuss = getTransitionChain(discuss.id)
      expect(chainFromDiscuss).toHaveLength(2)
      expect(chainFromDiscuss[0].source_task_id).toBe(discuss.id)
      expect(chainFromDiscuss[0].target_task_id).toBe(plan.id)
      expect(chainFromDiscuss[1].source_task_id).toBe(plan.id)
      expect(chainFromDiscuss[1].target_task_id).toBe(doTask.id)

      const chainFromDo = getTransitionChain(doTask.id)
      expect(chainFromDo).toHaveLength(2)
    })

    it('deleteTasksByIds cleans up transitions', () => {
      const projectId = getAllProjects()[0].id
      const discuss = createTask({
        project_id: projectId,
        type: 'discuss',
        prompt: 'discuss',
      })
      const plan = createTask({
        project_id: projectId,
        type: 'plan',
        prompt: 'plan',
      })
      createTaskTransition(discuss.id, plan.id, 'discuss_to_plan')

      deleteTasksByIds([discuss.id])

      const transitions = getTaskTransitions(plan.id)
      expect(transitions).toHaveLength(0)
    })
  })
})
