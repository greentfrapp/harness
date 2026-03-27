import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteSessionMessages,
  loadSessionMessages,
  saveSessionMessages,
} from './sessions'

vi.mock('./config', () => ({
  SESSIONS_DIR: '/tmp/harness-test-sessions',
}))

describe('sessions', () => {
  const testDir = '/tmp/harness-test-sessions'

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('saveSessionMessages', () => {
    it('writes messages to a JSON file', () => {
      const messages = [{ type: 'assistant', message: 'hello' }]
      saveSessionMessages('task-1', messages)

      const filePath = path.join(testDir, 'task-1.json')
      expect(fs.existsSync(filePath)).toBe(true)
      expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual(messages)
    })

    it('overwrites existing file', () => {
      saveSessionMessages('task-1', [{ first: true }])
      saveSessionMessages('task-1', [{ second: true }])

      const filePath = path.join(testDir, 'task-1.json')
      expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual([
        { second: true },
      ])
    })
  })

  describe('loadSessionMessages', () => {
    it('reads messages from a JSON file', () => {
      const messages = [{ type: 'result', message: 'done' }]
      fs.writeFileSync(
        path.join(testDir, 'task-2.json'),
        JSON.stringify(messages),
      )

      expect(loadSessionMessages('task-2')).toEqual(messages)
    })

    it('returns empty array when file does not exist', () => {
      expect(loadSessionMessages('nonexistent')).toEqual([])
    })
  })

  describe('deleteSessionMessages', () => {
    it('removes the session file', () => {
      const filePath = path.join(testDir, 'task-3.json')
      fs.writeFileSync(filePath, '[]')
      expect(fs.existsSync(filePath)).toBe(true)

      deleteSessionMessages('task-3')
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('does not throw when file does not exist', () => {
      expect(() => deleteSessionMessages('nonexistent')).not.toThrow()
    })
  })
})
