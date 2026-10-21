import { blankTerm } from '@recall/core'

export interface Piece {
  text: string
  // The term (in any simple inflected form) inside an example.
  hit: boolean
}

// Splits an example around the occurrences of its term, using the same
// matcher that blanks the term on the reverse card: "She frowned at him." →
// She | frowned (hit) | at him.
export function markTerm(example: string, term: string): Piece[] {
  const blanked = blankTerm(example, term)
  if (!blanked) return [{ text: example, hit: false }]
  const literals = blanked.split('___')
  const out: Piece[] = []
  let pos = 0
  literals.forEach((lit, i) => {
    if (i > 0) {
      // The hit runs up to where the next literal starts.
      const next = lit ? example.indexOf(lit, pos + 1) : example.length
      const end = next < 0 ? example.length : next
      if (end > pos) out.push({ text: example.slice(pos, end), hit: true })
      pos = end
    }
    if (lit) {
      out.push({ text: example.slice(pos, pos + lit.length), hit: false })
      pos += lit.length
    }
  })
  return out
}
