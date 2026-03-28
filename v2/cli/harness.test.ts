import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_PATH = path.join(__dirname, 'harness.mjs')

// --- Mock HTTP server ---

interface RecordedRequest {
  method: string
  url: string
  body: string
}

let lastRequest: RecordedRequest | null = null
let mockResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } }
let server: ReturnType<typeof createServer>
let serverUrl: string

function setMockResponse(status: number, body: unknown) {
  mockResponse = { status, body }
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        req.on('end', () => {
          lastRequest = { method: req.method!, url: req.url!, body }
          res.writeHead(mockResponse.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(mockResponse.body))
        })
      })
      server.listen(0, () => {
        const addr = server.address()
        if (typeof addr === 'object' && addr) {
          serverUrl = `http://localhost:${addr.port}`
        }
        resolve()
      })
    }),
)

afterAll(() => {
  server?.close()
})

beforeEach(() => {
  lastRequest = null
  mockResponse = { status: 200, body: { ok: true } }
})

// --- Helper to run the CLI ---

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'node',
      [CLI_PATH, ...args],
      {
        env: {
          ...process.env,
          HARNESS_TASK_ID: 'test-task-123',
          HARNESS_API_URL: serverUrl,
          ...env,
        },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error as any).code ?? 1 : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        })
      },
    )
  })
}

// --- Tests ---

describe('harness CLI', () => {
  describe('help and errors', () => {
    it('prints help with --help', async () => {
      const { code, stdout } = await runCli(['--help'])
      expect(code).toBe(0)
      expect(stdout).toContain('Usage: harness <command>')
      expect(stdout).toContain('set-result')
      expect(stdout).toContain('request-permission')
      expect(stdout).toContain('request-transition')
      expect(stdout).toContain('propose-subtasks')
      expect(stdout).toContain('get-task')
      expect(stdout).toContain('list-tasks')
    })

    it('prints help with no args', async () => {
      const { code, stdout } = await runCli([])
      expect(code).toBe(0)
      expect(stdout).toContain('Usage: harness <command>')
    })

    it('exits 1 for unknown command', async () => {
      const { code, stderr } = await runCli(['unknown-cmd'])
      expect(code).not.toBe(0)
      expect(stderr).toContain('Unknown command: unknown-cmd')
    })

    it('exits 1 when HARNESS_API_URL is not set', async () => {
      const { code, stderr } = await runCli(['set-result', 'hello'], {
        HARNESS_API_URL: '',
      })
      expect(code).not.toBe(0)
      expect(stderr).toContain('HARNESS_API_URL')
    })

    it('exits 1 when HARNESS_TASK_ID is not set for task commands', async () => {
      const { code, stderr } = await runCli(['set-result', 'hello'], {
        HARNESS_TASK_ID: '',
      })
      expect(code).not.toBe(0)
      expect(stderr).toContain('task ID')
    })
  })

  describe('set-result', () => {
    it('sends PATCH with result text from positional args', async () => {
      const { code } = await runCli(['set-result', 'hello', 'world'])
      expect(code).toBe(0)
      expect(lastRequest!.method).toBe('PATCH')
      expect(lastRequest!.url).toBe('/api/tasks/test-task-123')
      expect(JSON.parse(lastRequest!.body)).toEqual({ result: 'hello world' })
    })

    it('sends PATCH with result text from --text flag', async () => {
      const { code } = await runCli(['set-result', '--text', 'my result'])
      expect(code).toBe(0)
      expect(JSON.parse(lastRequest!.body)).toEqual({ result: 'my result' })
    })

    it('exits 1 with no text', async () => {
      const { code, stderr } = await runCli(['set-result'])
      expect(code).not.toBe(0)
      expect(stderr).toContain('Result text is required')
    })

    it('handles API error', async () => {
      setMockResponse(400, { error: 'Bad request' })
      const { code, stderr } = await runCli(['set-result', 'test'])
      expect(code).not.toBe(0)
      expect(stderr).toContain('Bad request')
    })
  })

  describe('request-permission', () => {
    it('sends POST with tool name', async () => {
      const { code, stdout } = await runCli(['request-permission', 'Bash'])
      expect(code).toBe(0)
      expect(lastRequest!.method).toBe('POST')
      expect(lastRequest!.url).toBe('/api/tasks/test-task-123/request-permission')
      expect(JSON.parse(lastRequest!.body)).toEqual({ tool: 'Bash' })
      expect(stdout).toContain('Permission requested')
    })

    it('exits 1 with no tool name', async () => {
      const { code, stderr } = await runCli(['request-permission'])
      expect(code).not.toBe(0)
      expect(stderr).toContain('Tool name is required')
    })
  })

  describe('request-transition', () => {
    it('sends POST with target type', async () => {
      const { code, stdout } = await runCli(['request-transition', 'plan'])
      expect(code).toBe(0)
      expect(lastRequest!.method).toBe('POST')
      expect(lastRequest!.url).toBe('/api/tasks/test-task-123/request-transition')
      expect(JSON.parse(lastRequest!.body)).toEqual({ target_type: 'plan' })
      expect(stdout).toContain("Transition to 'plan' requested")
    })

    it('exits 1 with no target type', async () => {
      const { code, stderr } = await runCli(['request-transition'])
      expect(code).not.toBe(0)
      expect(stderr).toContain('Target type is required')
    })
  })

  describe('propose-subtasks', () => {
    it('sends POST with subtask proposals', async () => {
      setMockResponse(200, { ok: true, proposal_count: 2 })
      const subtasks = JSON.stringify([
        { title: 'Task A', prompt: 'Do A' },
        { title: 'Task B', prompt: 'Do B' },
      ])
      const { code, stdout } = await runCli([
        'propose-subtasks',
        '--subtasks',
        subtasks,
      ])
      expect(code).toBe(0)
      expect(lastRequest!.method).toBe('POST')
      expect(lastRequest!.url).toBe('/api/tasks/test-task-123/propose-subtasks')
      expect(JSON.parse(lastRequest!.body)).toEqual({
        subtasks: [
          { title: 'Task A', prompt: 'Do A' },
          { title: 'Task B', prompt: 'Do B' },
        ],
      })
      expect(stdout).toContain('Proposed 2 subtask(s)')
    })

    it('exits 1 without --subtasks', async () => {
      const { code, stderr } = await runCli(['propose-subtasks'])
      expect(code).not.toBe(0)
      expect(stderr).toContain('--subtasks is required')
    })

    it('exits 1 with invalid JSON', async () => {
      const { code, stderr } = await runCli([
        'propose-subtasks',
        '--subtasks',
        'not-json',
      ])
      expect(code).not.toBe(0)
      expect(stderr).toContain('Invalid JSON')
    })

    it('exits 1 with empty array', async () => {
      const { code, stderr } = await runCli([
        'propose-subtasks',
        '--subtasks',
        '[]',
      ])
      expect(code).not.toBe(0)
      expect(stderr).toContain('non-empty')
    })

    it('exits 1 when subtask missing title', async () => {
      const { code, stderr } = await runCli([
        'propose-subtasks',
        '--subtasks',
        '[{"prompt":"do stuff"}]',
      ])
      expect(code).not.toBe(0)
      expect(stderr).toContain('missing required')
    })
  })

  describe('get-task', () => {
    it('sends GET and prints JSON', async () => {
      const mockTask = { id: 'other-task', status: 'done', title: 'Test' }
      setMockResponse(200, mockTask)
      const { code, stdout } = await runCli(['get-task', 'other-task'])
      expect(code).toBe(0)
      expect(lastRequest!.method).toBe('GET')
      expect(lastRequest!.url).toBe('/api/tasks/other-task')
      expect(JSON.parse(stdout)).toEqual(mockTask)
    })

    it('exits 1 with no task ID', async () => {
      const { code, stderr } = await runCli(['get-task'])
      expect(code).not.toBe(0)
      expect(stderr).toContain('Task ID is required')
    })
  })

  describe('list-tasks', () => {
    it('sends GET without filters', async () => {
      setMockResponse(200, [])
      const { code } = await runCli(['list-tasks'])
      expect(code).toBe(0)
      expect(lastRequest!.method).toBe('GET')
      expect(lastRequest!.url).toBe('/api/tasks')
    })

    it('sends GET with --status filter', async () => {
      setMockResponse(200, [])
      const { code } = await runCli(['list-tasks', '--status', 'queued'])
      expect(code).toBe(0)
      expect(lastRequest!.url).toContain('status=queued')
    })

    it('sends GET with --project filter', async () => {
      setMockResponse(200, [])
      const { code } = await runCli(['list-tasks', '--project', 'proj-1'])
      expect(code).toBe(0)
      expect(lastRequest!.url).toContain('project_id=proj-1')
    })

    it('sends GET with both filters', async () => {
      setMockResponse(200, [])
      const { code } = await runCli([
        'list-tasks',
        '--status',
        'done',
        '--project',
        'proj-1',
      ])
      expect(code).toBe(0)
      expect(lastRequest!.url).toContain('status=done')
      expect(lastRequest!.url).toContain('project_id=proj-1')
    })
  })

  describe('--task-id override', () => {
    it('uses --task-id instead of env var', async () => {
      const { code } = await runCli([
        'set-result',
        '--task-id',
        'custom-id',
        'hello',
      ])
      expect(code).toBe(0)
      expect(lastRequest!.url).toBe('/api/tasks/custom-id')
    })
  })
})
