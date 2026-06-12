import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'e2e/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
