import fs from 'node:fs'
import path from 'node:path'
import { SESSIONS_DIR } from './config'

export function saveSessionMessages(
  taskId: string,
  messages: unknown[],
): void {
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${taskId}.json`),
    JSON.stringify(messages),
  )
}

export function loadSessionMessages(taskId: string): unknown[] {
  const filePath = path.join(SESSIONS_DIR, `${taskId}.json`)
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return []
  }
}

export function appendSessionMessages(
  taskId: string,
  messages: unknown[],
): void {
  const existing = loadSessionMessages(taskId)
  // Only add separator if there isn't one already (avoid duplicates on consecutive chats)
  const hasChat = existing.some(
    (m: any) =>
      m?.type === '__chat_separator' || m?.type === '__chat_user_message',
  )
  if (!hasChat) {
    existing.push({ type: '__chat_separator', timestamp: Date.now() })
  }
  existing.push(...messages)
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${taskId}.json`),
    JSON.stringify(existing),
  )
}

export function deleteSessionMessages(taskId: string): void {
  try {
    fs.unlinkSync(path.join(SESSIONS_DIR, `${taskId}.json`))
  } catch {
    // File doesn't exist or already deleted
  }
}
