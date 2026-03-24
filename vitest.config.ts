import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  test: {
    include: ['server/**/*.test.ts'],
    fileParallelism: false,
    teardownTimeout: 3000,
  },
});
