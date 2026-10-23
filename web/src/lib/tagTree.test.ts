import { describe, expect, it } from 'vitest'
import { filterTree, tagLabel, tagState, tagTree, toggleTag } from './tagTree.ts'

const tags = [
  { value: 'Grammar/Articles & nouns', n: 4 },
  { value: 'Grammar/Tenses', n: 6 },
  { value: 'Grammar/My rules', n: 2 },
  { value: 'Irregular verbs', n: 10 },
  { value: 'claude', n: 1 },
]

describe('tag tree', () => {
  it('nests paths under their parents with subtree counts, busiest first', () => {
    const t = tagTree(tags)
    expect(t.map((x) => [x.path, x.n])).toEqual([['Grammar', 12], ['Irregular verbs', 10], ['claude', 1]])
    expect(t[0]!.children.map((x) => [x.name, x.n])).toEqual([['Tenses', 6], ['Articles & nouns', 4], ['My rules', 2]])
    // Exact counts from the caller when it has the cards.
    expect(tagTree(tags, (p) => (p === 'Grammar' ? 9 : 1))[0]!.n).toBe(9)
  })

  it('drills down: a tap adds a tag (a picked child replaces its picked parent), a second tap removes it', () => {
    let sel = toggleTag([], 'Grammar')
    expect(sel).toEqual(['Grammar'])
    expect(tagState(sel, 'Grammar/Tenses')).toBe('off')
    sel = toggleTag(sel, 'Grammar/Tenses')
    expect(sel).toEqual(['Grammar/Tenses'])
    expect(tagState(sel, 'Grammar')).toBe('mixed')
    expect(tagState(sel, 'Grammar/Tenses')).toBe('on')
    sel = toggleTag(sel, 'claude')
    expect(sel).toEqual(['Grammar/Tenses', 'claude'])
    expect(toggleTag(sel, 'Grammar/Tenses')).toEqual(['claude'])
  })

  it('widens to a mixed parent when it is tapped', () => {
    const sel = toggleTag(['Grammar/Tenses', 'claude'], 'Grammar')
    expect(sel).toEqual(['claude', 'Grammar'])
    expect(tagState(sel, 'Grammar')).toBe('on')
    expect(tagState(sel, 'Grammar/Tenses')).toBe('off')
  })

  it("takes a parent path's own count as exact", () => {
    const t = tagTree([{ value: 'Grammar', n: 7 }, { value: 'Grammar/Tenses', n: 6 }, { value: 'Grammar/Modals', n: 3 }])
    expect(t.map((x) => [x.path, x.n])).toEqual([['Grammar', 7]])
  })

  it('filters by search, keeping ancestors', () => {
    const t = tagTree(tags)
    const f = filterTree(t, 'tens')
    expect(f.map((x) => x.path)).toEqual(['Grammar'])
    expect(f[0]!.children.map((x) => x.path)).toEqual(['Grammar/Tenses'])
    expect(filterTree(t, '')).toBe(t)
  })

  it('labels a card tag by its leaf with a quiet parent', () => {
    expect(tagLabel('Grammar/Articles & nouns')).toEqual({ parent: 'Grammar', leaf: 'Articles & nouns' })
    expect(tagLabel('a/b/c')).toEqual({ parent: 'a › b', leaf: 'c' })
    expect(tagLabel('claude')).toEqual({ parent: null, leaf: 'claude' })
  })
})
