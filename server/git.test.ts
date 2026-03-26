import { describe, expect, it } from 'vitest'
import { makeBranchName } from './git'

describe('git', () => {
  describe('makeBranchName', () => {
    it('creates a branch name from task ID and prompt', () => {
      const name = makeBranchName('abcdef12-3456-7890', 'Add login page')
      expect(name).toBe('harness/abcdef12-add-login-page')
    })

    it('sanitizes special characters', () => {
      const name = makeBranchName('abcdef12', 'Fix bug #123 (urgent!)')
      expect(name).toBe('harness/abcdef12-fix-bug-123-urgent')
    })

    it('truncates long prompts to 40 chars', () => {
      const longPrompt = 'a'.repeat(100)
      const name = makeBranchName('abcdef12-3456-7890', longPrompt)
      // harness/ (8) + short id (8) + - (1) + sanitized (up to 40)
      const sanitizedPart = name.slice('harness/abcdef12-'.length)
      expect(sanitizedPart.length).toBeLessThanOrEqual(40)
    })

    it('handles empty prompt', () => {
      const name = makeBranchName('abcdef12', '')
      expect(name).toBe('harness/abcdef12-')
    })
  })
})
