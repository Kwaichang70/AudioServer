import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['node_modules/**', 'dist/**'],
    // Every suite opens its own SQLite file and several start a server. With
    // one worker per core a laptop short on memory lost workers ("Worker
    // exited unexpectedly") and reported fewer files than it ran (T03). CI
    // has the memory and keeps the default.
    maxWorkers: process.env.CI ? undefined : 2,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/scripts/**', 'src/db/migrations/**'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
