import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { serviceWorker } from './scripts/sw-plugin.ts'

const api = 'http://localhost:8080'

export default defineConfig({
  plugins: [svelte(), serviceWorker()],
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  server: {
    host: true,
    proxy: {
      '/api': api,
      '/mcp': api,
    },
  },
  preview: {
    host: true,
    proxy: {
      '/api': api,
      '/mcp': api,
    },
  },
  build: {
    target: 'es2022',
  },
})
