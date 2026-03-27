import type { Context } from 'hono'
import type {
  Project,
  Task,
  TaskStatus,
  TaskSubstatus,
} from '../../shared/types'
import {
  transition,
  type TransitionAction,
} from '../../shared/transitions'
import type * as queries from '../db/queries'

/** Look up a task by ID or return a 404 response. */
export function getTaskOr404(
  q: typeof queries,
  c: Context,
  id: string,
): Task | Response {
  const task = q.getTaskById(id)
  if (!task) return c.json({ error: 'Task not found' }, 404)
  return task
}

/** Look up a task and its project, or return a 404 response. */
export function getTaskWithProjectOr404(
  q: typeof queries,
  c: Context,
  id: string,
): { task: Task; project: Project } | Response {
  const task = q.getTaskById(id)
  if (!task) return c.json({ error: 'Task not found' }, 404)
  const project = q.getProjectById(task.project_id)
  if (!project) return c.json({ error: 'Project not found' }, 404)
  return { task, project }
}

/** Validate a status transition, returning the target or a 400 response. */
export function guardTransition(
  c: Context,
  status: TaskStatus,
  substatus: TaskSubstatus,
  action: TransitionAction,
): { status: TaskStatus; substatus: TaskSubstatus } | Response {
  try {
    return transition(status, substatus, action)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
}
