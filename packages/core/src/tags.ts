// Hierarchical tags: a tag with "/" is a path, "Grammar/Articles & nouns".
// A filter or search tag matches the tag itself and everything under it, at
// the "/" boundary ("Grammar" matches "Grammar/Tenses", not "Grammarly").

export const TAG_SEP = '/'

export function tagMatches(filterTag: string, cardTag: string): boolean {
  return cardTag === filterTag || cardTag.startsWith(filterTag + TAG_SEP)
}

// 'a/b/c' → ['a', 'a/b']: the paths above a tag, top first.
export function tagAncestors(tag: string): string[] {
  const parts = tag.split(TAG_SEP)
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join(TAG_SEP))
}

// 'a/b' → 'b'.
export function tagLeaf(tag: string): string {
  return tag.slice(tag.lastIndexOf(TAG_SEP) + 1)
}

// 'a/b/c' → 'a/b'; null for a top-level tag.
export function tagParent(tag: string): string | null {
  const i = tag.lastIndexOf(TAG_SEP)
  return i < 0 ? null : tag.slice(0, i)
}

// Each path segment trimmed with its spaces collapsed, empty segments
// dropped: " a // b  c/ " → "a/b c". '' when nothing is left. Case kept.
export function cleanTag(tag: string | null | undefined, max = Infinity): string {
  const segs = (s: string) => s.split(TAG_SEP).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join(TAG_SEP)
  const t = segs(tag ?? '')
  // Cut at the limit, then clean again so the cut can't leave a dangling "/".
  return t.length > max ? segs(t.slice(0, max)) : t
}

// `from` and everything under it moved to `to` ("from/x" → "to/x"); null when
// the tag isn't under `from`.
export function renamedTag(tag: string, from: string, to: string): string | null {
  return tagMatches(from, tag) ? to + tag.slice(from.length) : null
}
