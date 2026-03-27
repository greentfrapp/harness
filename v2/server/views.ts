import { parse as parseJsonc } from 'jsonc-parser'
import fs from 'node:fs'
import path from 'node:path'
import type { ViewConfig } from '../shared/types'
import { DEFAULT_VIEWS } from '../shared/types'
import { HARNESS_DIR } from './config'

export const VIEWS_PATH = path.join(HARNESS_DIR, 'views.jsonc')

const DEFAULT_VIEWS_TEMPLATE = `{
  // Views define the columns shown in the Harness UI.
  // Each view filters tasks by status + substatus pairs.
  // You can add, remove, or reorder views. Use "Reset to Defaults" in the UI to restore.
  "views": [
    {
      "id": "outbox",
      "name": "Outbox",
      "filter": {
        "statuses": ["draft", "queued", "in_progress"]
      }
    },
    {
      "id": "inbox",
      "name": "Inbox",
      "filter": {
        "statuses": ["pending", "done", "cancelled"]
      }
    }
  ]
}
`

export function ensureViewsFile(): void {
  if (!fs.existsSync(VIEWS_PATH)) {
    fs.writeFileSync(VIEWS_PATH, DEFAULT_VIEWS_TEMPLATE, 'utf-8')
  }
}

export function loadViews(): ViewConfig[] {
  if (!fs.existsSync(VIEWS_PATH)) {
    return [...DEFAULT_VIEWS]
  }
  const raw = fs.readFileSync(VIEWS_PATH, 'utf-8')
  const parsed = parseJsonc(raw)
  if (!parsed || !Array.isArray(parsed.views)) {
    return [...DEFAULT_VIEWS]
  }
  return parsed.views
}

export function saveViews(
  views: ViewConfig[],
): { ok: true; views: ViewConfig[] } | { ok: false; error: string } {
  // Validate each view
  for (const view of views) {
    if (!view.id || typeof view.id !== 'string') {
      return { ok: false, error: 'Each view must have a string "id"' }
    }
    if (!view.name || typeof view.name !== 'string') {
      return { ok: false, error: `View "${view.id}" must have a string "name"` }
    }
    if (!view.filter || typeof view.filter !== 'object') {
      return {
        ok: false,
        error: `View "${view.id}" must have a "filter" object`,
      }
    }
  }

  // Check for duplicate IDs
  const ids = new Set<string>()
  for (const view of views) {
    if (ids.has(view.id)) {
      return { ok: false, error: `Duplicate view ID: "${view.id}"` }
    }
    ids.add(view.id)
  }

  const content = JSON.stringify({ views }, null, 2)
  fs.writeFileSync(VIEWS_PATH, content, 'utf-8')
  return { ok: true, views }
}

export function resetViews(): ViewConfig[] {
  fs.writeFileSync(VIEWS_PATH, DEFAULT_VIEWS_TEMPLATE, 'utf-8')
  return [...DEFAULT_VIEWS]
}
