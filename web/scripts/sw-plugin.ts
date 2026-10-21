import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

// Emits dist/sw.js from the hand-written template, with the list of built
// files to precache and a version derived from them, so each deploy gets a
// fresh cache and the old one is dropped on activate.
export function serviceWorker(): Plugin {
  const template = fileURLToPath(new URL('../sw.js', import.meta.url))
  return {
    name: 'recall-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      // Lazily imported chunks (mock mode) are cached on first use instead.
      const files = Object.keys(bundle).filter((f) => {
        const out = bundle[f]
        return !f.endsWith('.map') && !(out.type === 'chunk' && out.isDynamicEntry)
      })
      const shell = ['./', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png']
      const precache = [...shell, ...files.filter((f) => f !== 'index.html')]
      const version = hash(files.sort().join('|'))
      const source = readFileSync(template, 'utf8')
        .replace('self.__PRECACHE__', JSON.stringify(precache))
        .replace('self.__VERSION__', JSON.stringify(version))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36)
}
