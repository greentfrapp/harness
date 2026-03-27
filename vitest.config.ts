import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'v2/shared'),
    },
  },
  test: {
    pool: 'threads',
    include: ['v2/**/*.test.ts'],
    fileParallelism: false,
    teardownTimeout: 3000,
  },
})
