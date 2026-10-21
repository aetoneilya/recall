import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { boot, loadMe } from './lib/app.svelte.ts'
import { session } from './lib/review.svelte.ts'
import { applyTheme, loadTheme } from './lib/theme.ts'

applyTheme(loadTheme())
await boot()
mount(App, { target: document.getElementById('app')! })
void loadMe()
void session.start()

if (import.meta.env.PROD && 'serviceWorker' in navigator && !location.search.includes('mock')) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker registration failed', e))
}
