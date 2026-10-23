// Hierarchical tags ("Grammar/Articles & nouns") as a tree for the filter
// UIs. Filters drill down: every selected tag narrows the cards (AND), a
// parent tag standing for "any tag under it".
import { tagAncestors, tagLeaf, tagMatches } from '@recall/core'

export interface TagNode {
  path: string
  name: string
  // Cards with this tag or one under it.
  n: number
  children: TagNode[]
}

// From flat counts per tag. An entry for a path itself (a parent included)
// is its exact count; a parent without one gets its children's sum (a card
// with two of them counts twice). `count(path)` overrides both when the
// caller has the cards.
export function tagTree(tags: { value: string; n: number }[], count?: (path: string) => number): TagNode[] {
  const nodes = new Map<string, TagNode>()
  const exact = new Set(tags.map((t) => t.value))
  const roots: TagNode[] = []
  const node = (path: string): TagNode => {
    let x = nodes.get(path)
    if (x) return x
    x = { path, name: tagLeaf(path), n: 0, children: [] }
    nodes.set(path, x)
    const parent = tagAncestors(path).at(-1)
    if (parent) node(parent).children.push(x)
    else roots.push(x)
    return x
  }
  for (const t of tags) {
    node(t.value).n += t.n
    for (const p of tagAncestors(t.value)) if (!exact.has(p)) nodes.get(p)!.n += t.n
  }
  if (count) for (const x of nodes.values()) x.n = count(x.path)
  const sort = (xs: TagNode[]) => {
    xs.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    for (const x of xs) sort(x.children)
  }
  sort(roots)
  return roots
}

export type TagState = 'on' | 'mixed' | 'off'

// 'on': selected itself; 'mixed': something under it is.
export function tagState(selected: readonly string[], path: string): TagState {
  if (selected.includes(path)) return 'on'
  if (selected.some((s) => s.startsWith(`${path}/`))) return 'mixed'
  return 'off'
}

// Tap: off → on, on → off. A selected ancestor says nothing more once a tag
// under it is picked (AND), so it gives way; tapping a mixed parent widens
// to all of it, so the picks under it give way too.
export function toggleTag(selected: readonly string[], path: string): string[] {
  if (selected.includes(path)) return selected.filter((s) => s !== path)
  return [...selected.filter((s) => !tagMatches(s, path) && !tagMatches(path, s)), path]
}

// The tree narrowed to tags whose name or path contains the query (and their
// ancestors), case- and ё-insensitive.
export function filterTree(roots: TagNode[], q: string): TagNode[] {
  const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')
  const needle = fold(q.trim())
  if (!needle) return roots
  const keep = (x: TagNode): TagNode | null => {
    if (fold(x.path).includes(needle)) return x
    const children = x.children.map(keep).filter((c): c is TagNode => !!c)
    return children.length ? { ...x, children } : null
  }
  return roots.map(keep).filter((x): x is TagNode => !!x)
}

// For a card: the leaf, with its parent path quieter ("Grammar › Articles & nouns").
export function tagLabel(tag: string): { parent: string | null; leaf: string } {
  const parents = tagAncestors(tag)
  return { parent: parents.length ? parents.at(-1)!.split('/').join(' › ') : null, leaf: tagLeaf(tag) }
}
