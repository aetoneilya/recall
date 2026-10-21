import { defineConfig } from 'vitest/config'

// Kept apart from vite.config.ts: tests cover plain TS modules only and
// don't need the Svelte plugin.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
