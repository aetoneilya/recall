// Facts (topic decks): validation and the dedupe key. Server and web use the
// same functions so a fact is cleaned the same way everywhere.

export interface FactInput {
  // Markdown.
  front: string
  back: string
  tags?: string[]
}

export type CleanFact = Required<FactInput>

export const FACT_LIMITS = { front: 2000, back: 20000, tags: 30, tag: 100 }

// "What is  a Deadlock?" → "what is a deadlock". Facts are unique per deck by
// their question: case, spacing and trailing punctuation don't count.
export function factKey(front: string): string {
  return front.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s?!.:;]+$/, '')
}

// Line endings normalised, trailing spaces and blank lines at the ends dropped;
// the Markdown inside (indentation, blank lines between paragraphs) is kept.
function cleanText(s: string | null | undefined): string {
  return (s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')
}

// Trims and validates a fact; returns the cleaned fact or a human-readable problem.
export function cleanFact(input: FactInput): { fact: CleanFact } | { error: string } {
  const front = cleanText(input.front).trim()
  const back = cleanText(input.back)
  if (!front) return { error: 'front is empty' }
  if (!back.trim()) return { error: 'back is empty' }
  if (front.length > FACT_LIMITS.front) return { error: `front is longer than ${FACT_LIMITS.front} characters` }
  if (back.length > FACT_LIMITS.back) return { error: `back is longer than ${FACT_LIMITS.back} characters` }
  const tags: string[] = []
  for (const t of input.tags ?? []) {
    const s = (t ?? '').replace(/\s+/g, ' ').trim().slice(0, FACT_LIMITS.tag)
    if (s && !tags.includes(s)) tags.push(s)
  }
  if (tags.length > FACT_LIMITS.tags) return { error: `at most ${FACT_LIMITS.tags} tags` }
  return { fact: { front, back, tags } }
}
