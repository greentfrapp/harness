import { Hono } from 'hono'
import { getErrorMessage } from '../../shared/types'
import type { AppContext } from '../context'
import * as git from '../git'
import { serverLog } from '../log'
import { getTaskWithProjectOr404 } from './helpers'

export function createCheckoutRoutes(ctx: AppContext) {
  const app = new Hono()
  const { queries, sseManager, checkoutState } = ctx

  /** List all active checkouts (for initial page load). */
  app.get('/checkouts', (c) => {
    const result: Array<{
      taskId: string
      taskTitle: string
      repoPath: string
      projectName: string
      projectId: string
    }> = []
    for (const [repoPath, entry] of checkoutState) {
      const task = queries.getTaskById(entry.taskId)
      const project = task ? queries.getProjectById(task.project_id) : undefined
      if (task && project) {
        result.push({
          taskId: entry.taskId,
          taskTitle: (task.title ?? task.prompt ?? '').slice(0, 100),
          repoPath,
          projectName: project.name,
          projectId: project.id,
        })
      }
    }
    return c.json(result)
  })

  /** Checkout: merge task branch into a temp branch and check it out in the repo. */
  app.post('/tasks/:id/checkout', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(queries, c, id)
    if (result instanceof Response) return result
    const { task, project } = result
    // Only pending:review tasks can be checked out
    if (task.status !== 'pending' || task.substatus !== 'review') {
      return c.json(
        { error: 'Only pending:review tasks can be checked out' },
        400,
      )
    }
    if (!task.branch_name) {
      return c.json({ error: 'Task has no branch to checkout' }, 400)
    }

    // Check if this repo already has a checkout active
    const existing = checkoutState.get(project.repo_path)
    if (existing) {
      const existingTask = queries.getTaskById(existing.taskId)
      return c.json(
        {
          error: `Another task is already checked out in this repo`,
          checked_out_task_id: existing.taskId,
          checked_out_task_title: existingTask?.title?.slice(0, 100) ?? '',
        },
        409,
      )
    }

    const checkoutBranch = `harness/checkout-${id.slice(0, 8)}`

    try {
      git.checkoutTask(
        project.repo_path,
        project.target_branch,
        task.branch_name,
        checkoutBranch,
      )
    } catch (err) {
      const msg = getErrorMessage(err)
      serverLog.error(`Checkout failed: ${msg}`, id)
      return c.json({ error: `Checkout failed: ${msg}` }, 500)
    }

    checkoutState.set(project.repo_path, { taskId: id, checkoutBranch })
    queries.createTaskEvent(id, 'checked_out', null)
    serverLog.info(`Task checked out to ${checkoutBranch}`, id)

    const payload = {
      taskId: id,
      taskTitle: (task.title ?? task.prompt ?? '').slice(0, 100),
      repoPath: project.repo_path,
      projectName: project.name,
      projectId: project.id,
    }
    sseManager.broadcast('task:checked_out', payload)

    return c.json({ ok: true, checkout_branch: checkoutBranch })
  })

  /** Return: switch repo back to target branch, delete checkout branch, clear state. */
  app.post('/tasks/:id/return', (c) => {
    const id = c.req.param('id')
    const result = getTaskWithProjectOr404(queries, c, id)
    if (result instanceof Response) return result
    const { project } = result

    const existing = checkoutState.get(project.repo_path)
    if (!existing || existing.taskId !== id) {
      return c.json({ error: 'This task is not currently checked out' }, 400)
    }

    try {
      git.returnCheckout(
        project.repo_path,
        project.target_branch,
        existing.checkoutBranch,
      )
    } catch (err) {
      const msg = getErrorMessage(err)
      serverLog.error(`Return failed: ${msg}`, id)
      return c.json({ error: `Return failed: ${msg}` }, 500)
    }

    checkoutState.delete(project.repo_path)
    queries.createTaskEvent(id, 'returned', null)
    serverLog.info(
      `Task returned, repo restored to ${project.target_branch}`,
      id,
    )
    sseManager.broadcast('task:returned', {
      taskId: id,
      repoPath: project.repo_path,
    })

    return c.json({ ok: true })
  })

  return app
}

/** Auto-return a checkout if the given task is currently checked out. */
export function autoReturnIfCheckedOut(ctx: AppContext, taskId: string): void {
  const { queries, sseManager, checkoutState } = ctx
  for (const [repoPath, entry] of checkoutState) {
    if (entry.taskId === taskId) {
      const task = queries.getTaskById(taskId)
      const project = task
        ? queries.getProjectById(task.project_id)
        : undefined
      if (project) {
        try {
          git.returnCheckout(
            repoPath,
            project.target_branch,
            entry.checkoutBranch,
          )
          serverLog.info(`Auto-returned checkout before action`, taskId)
        } catch (err) {
          serverLog.warn(
            `Auto-return failed: ${getErrorMessage(err)}`,
            taskId,
          )
        }
      }
      checkoutState.delete(repoPath)
      queries.createTaskEvent(taskId, 'returned', null)
      sseManager.broadcast('task:returned', { taskId, repoPath })
      break
    }
  }
}
