import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  test: {
    pool: 'threads',
    include: ['server/**/*.test.ts'],
    fileParallelism: false,
    teardownTimeout: 3000,
  },
})
