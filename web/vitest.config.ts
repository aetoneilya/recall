import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

// Kept apart from vite.config.ts: tests cover TS modules — plain ones, and
// the rune stores (`*.svelte.ts`, compiled by the Svelte plugin) with their
// services mocked.
export default defineConfig({
  // vitest bundles its own vite: the plugin's types are for the app's.
  plugins: [svelte()] as never,
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
