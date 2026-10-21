import { describe, expect, it } from 'vitest'
import { parseRoute } from './route.ts'

const r = (h: string) => {
  const x = parseRoute(h)
  return { path: x.path, tab: x.tab, query: Object.fromEntries(x.query) }
}

describe('parseRoute', () => {
  it('parses plain routes', () => {
    expect(r('')).toEqual({ path: '/', tab: 'review', query: {} })
    expect(r('#/words')).toEqual({ path: '/words', tab: 'words', query: {} })
    expect(r('#/word/wd_1?from=%2Fwords')).toEqual({ path: '/word/wd_1', tab: 'words', query: { from: '/words' } })
    expect(r('#/add?from=/')).toEqual({ path: '/add', tab: 'review', query: { from: '/' } })
    expect(r('#/word/wd_1?from=/')).toEqual({ path: '/word/wd_1', tab: 'review', query: { from: '/' } })
    expect(r('#/test')).toMatchObject({ path: '/test', tab: 'progress' })
    // A fact's editor: the review card's, else the Topics list's.
    expect(r('#/fact/ft_1?from=/')).toMatchObject({ path: '/fact/ft_1', tab: 'review' })
    expect(r('#/fact/new?from=%2Fwords&deck=dk_t')).toEqual({ path: '/fact/new', tab: 'words', query: { from: '/words', deck: 'dk_t' } })
    expect(r('#/inbox/ft_1')).toMatchObject({ path: '/inbox/ft_1', tab: 'inbox' })
  })

  it("maps the bot's deep links", () => {
    expect(r('#/words/abc')).toEqual({ path: '/word/abc', tab: 'words', query: {} })
    expect(r('#/words/new?term=to%20frown')).toEqual({ path: '/add', tab: 'review', query: { term: 'to frown' } })
    expect(r('#/dashboard')).toMatchObject({ path: '/progress', tab: 'progress' })
    expect(r('#/inbox')).toMatchObject({ path: '/inbox', tab: 'inbox' })
  })

  it('drops the launch parameters Telegram appends', () => {
    expect(r('#/words/abc?term=x&tgWebAppData=query_id%3D1&tgWebAppVersion=8.0')).toEqual({ path: '/word/abc', tab: 'words', query: { term: 'x' } })
    expect(r('#/inbox&tgWebAppData=a%3Db&tgWebAppPlatform=ios')).toEqual({ path: '/inbox', tab: 'inbox', query: {} })
    expect(r('#/words/new?term=bleak&tgWebAppStartParam=x')).toEqual({ path: '/add', tab: 'review', query: { term: 'bleak' } })
    expect(r('#tgWebAppData=query_id%3D1&tgWebAppVersion=8.0')).toEqual({ path: '/', tab: 'review', query: {} })
    expect(r('#/tgWebAppData=x')).toEqual({ path: '/', tab: 'review', query: {} })
  })

  it('keeps old links working', () => {
    expect(r('#/browse/dk_1')).toMatchObject({ path: '/words' })
    expect(r('#/stats')).toMatchObject({ path: '/progress' })
  })
})
