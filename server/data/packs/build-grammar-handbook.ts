// Builds the grammar handbook pack from its parts:
//   node server/data/packs/build-grammar-handbook.ts <part-a.json> <part-b.json> [out]
// Each part is a list of topics or {items: topics}; out defaults to
// server/data/packs/grammar-handbook.json. The merged file is checked with
// the server's own validator (pack-data.parsePack) before it is written, so
// a file the server would refuse is never produced.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePack } from '../../src/pack-data.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

export const HANDBOOK_HEADER = {
  id: 'grammar-handbook',
  name: 'Grammar handbook',
  description: 'English grammar, topic by topic: a cheat sheet for each rule with tap exercises and a few sentences to write, plus short theory cards.',
  kind: 'topic',
  format: 'grammar-handbook',
}

function topicsOf(file: string): unknown[] {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  const items = Array.isArray(data) ? data : (data as { items?: unknown })?.items
  if (!Array.isArray(items)) throw new Error(`${file}: expected a list of topics or {items: [...]}`)
  return items
}

export function buildHandbook(parts: string[]): object {
  const pack = { ...HANDBOOK_HEADER, items: parts.flatMap(topicsOf) }
  parsePack(pack)
  return pack
}

function main(argv: string[]) {
  const [a, b, out = path.join(here, 'grammar-handbook.json')] = argv
  if (!a || !b) {
    console.error('usage: node server/data/packs/build-grammar-handbook.ts <part-a.json> <part-b.json> [out]')
    process.exit(2)
  }
  let pack: { items: unknown[] }
  try {
    pack = buildHandbook([a, b]) as { items: unknown[] }
  } catch (e) {
    console.error(`grammar handbook not built: ${(e as Error).message}`)
    process.exit(1)
  }
  fs.writeFileSync(out, JSON.stringify(pack, null, 2) + '\n')
  console.log(`wrote ${out}: ${pack.items.length} topics`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
