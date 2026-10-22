<script lang="ts">
  import Header from '../components/Header.svelte'
  import Icon from '../components/Icon.svelte'
  import Markdown from '../components/Markdown.svelte'
  import { api, kv } from '../lib/app.svelte.ts'
  import { facts } from '../lib/facts.svelte.ts'
  import { renderInline } from '../lib/markdown.ts'
  import { session } from '../lib/review.svelte.ts'
  import { navigate, router } from '../lib/router.svelte.ts'
  import { errorText } from '../lib/toast.svelte.ts'
  import type { Handbook } from '../lib/types.ts'

  // The grammar handbook of a deck: a reading view for the theory. `topic`
  // null → the list (by group, level chips, search); a pack topic id → its
  // cheat sheet, "Practice this" and its theory cards; `mine:<fact id>` →
  // one of the owner's own rules.
  let { topic }: { topic: string | null } = $props()
  const deckId = router.route.query.get('deck') || session.deckId

  let data = $state.raw<Handbook | null>(null)
  let error = $state('')
  let q = $state('')

  async function load() {
    try {
      const cached = await kv.get<Record<string, Handbook>>('handbook')
      if (cached?.[deckId] && !data) data = cached[deckId]!
      const fresh = await api.handbook(deckId)
      data = fresh
      error = ''
      void kv.set('handbook', { ...(cached ?? {}), [deckId]: fresh })
    } catch (e) {
      if (!data) error = errorText(e)
    }
  }
  void load()
  void facts.ensure()

  const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')
  const groups = $derived.by(() => {
    const out = new Map<string, Handbook['topics']>()
    const needle = fold(q.trim())
    for (const t of data?.topics ?? []) {
      if (needle && !fold(`${t.title}\n${t.group}\n${t.summary}`).includes(needle)) continue
      out.set(t.group, [...(out.get(t.group) ?? []), t])
    }
    return [...out]
  })
  const mine = $derived((data?.mine ?? []).filter((m) => !q.trim() || fold(`${m.title}\n${m.rule}`).includes(fold(q.trim()))))

  const page = $derived.by(() => {
    if (!topic || !data) return null
    // From a card: the topic it belongs to.
    if (topic.startsWith('fact:')) {
      const id = topic.slice(5)
      const t = data.topics.find((x) => x.ruleFactId === id || x.cardFactIds.includes(id))
      if (t) return t
    }
    if (topic.startsWith('mine:') || topic.startsWith('fact:')) {
      const m = data.mine.find((x) => x.factId === topic.slice(5))
      return m ? { title: m.title, level: '', group: 'My rules', summary: m.rule, ruleFactId: m.factId, cardFactIds: [] as string[], exercises: m.exercises } : null
    }
    return data.topics.find((t) => t.id === topic) ?? null
  })
  const cards = $derived((page?.cardFactIds ?? []).map((id) => facts.get(id)).filter((f) => !!f))
  let open = $state<Record<string, boolean>>({})

  const here = $derived(`/handbook${topic ? `/${topic}` : ''}?deck=${deckId}`)
  const openTopic = (id: string) => navigate(`/handbook/${encodeURIComponent(id)}?deck=${deckId}`)
  function practise() {
    if (!page?.ruleFactId) return
    navigate(`/practice?fact=${page.ruleFactId}&title=${encodeURIComponent(page.title)}&from=${encodeURIComponent(here)}`)
  }
</script>

<div class="screen">
  {#if !topic}
    <Header title="Grammar handbook" />
    <div class="search">
      <Icon name="search" size={18} />
      <input type="search" bind:value={q} placeholder="Search the handbook" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search" />
    </div>
    {#if error}
      <div class="empty"><Icon name="offline" size={40} stroke={1.4} /><p><strong>Couldn't open the handbook</strong>{error}</p><button class="btn" onclick={load}>Try again</button></div>
    {:else if !data}
      <div class="group"><div class="row"><span class="skel" style="width: 60%"></span></div><div class="row"><span class="skel" style="width: 45%"></span></div></div>
    {:else if !groups.length && !mine.length}
      <div class="empty">
        <Icon name="words" size={40} stroke={1.4} />
        <p><strong>{q.trim() ? 'No matches' : 'No grammar here yet'}</strong>{q.trim() ? `Nothing mentions “${q.trim()}”.` : 'Add the Grammar handbook pack in Settings → Packs.'}</p>
      </div>
    {:else}
      {#each groups as [group, topics] (group)}
        <div class="section-label">{group}</div>
        <div class="group">
          {#each topics as t (t.id)}
            <button class="row topic" onclick={() => openTopic(t.id)}>
              <span class="grow">{t.title}</span>
              {#if t.level}<span class="chip level">{t.level}</span>{/if}
              <Icon name="chevron" size={16} />
            </button>
          {/each}
        </div>
      {/each}
      {#if mine.length}
        <div class="section-label">My rules</div>
        <div class="group">
          {#each mine as m (m.factId)}
            <button class="row topic" onclick={() => openTopic(`mine:${m.factId}`)}>
              <!-- renderInline escapes before adding its own tags. -->
              <span class="grow">{@html renderInline(m.title)}</span>
              <Icon name="chevron" size={16} />
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  {:else if page}
    <Header title={page.title} />
    <p class="meta">{page.group}{#if page.level}<span class="chip level">{page.level}</span>{/if}</p>
    <article class="sheet-md"><Markdown source={page.summary} /></article>
    {#if page.ruleFactId && page.exercises > 0}
      <button class="btn primary block practise" onclick={practise}><Icon name="play" size={18} stroke={2} /> Practice this <span class="faint-n">· {page.exercises} exercises</span></button>
      <p class="note">Doesn't change the schedule.</p>
    {/if}
    {#if cards.length}
      <div class="section-label">Theory cards</div>
      <div class="group">
        {#each cards as c (c.id)}
          <div class="row col qa">
            <button class="q" onclick={() => (open = { ...open, [c.id]: !open[c.id] })} aria-expanded={!!open[c.id]}>
              <span class="grow">{@html renderInline(c.front)}</span>
              <span class="chev" class:on={open[c.id]}><Icon name="chevron" size={16} /></span>
            </button>
            {#if open[c.id]}<div class="a"><Markdown source={c.back} /></div>{/if}
          </div>
        {/each}
      </div>
    {/if}
  {:else if data}
    <Header title="Handbook" />
    <div class="empty"><p><strong>Not in this deck</strong>This topic isn't in {session.decks[deckId]?.name ?? 'this deck'}.</p></div>
  {:else}
    <Header title="Handbook" />
    {#if error}<div class="empty"><p><strong>Couldn't open the handbook</strong>{error}</p></div>{/if}
  {/if}
</div>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 12px;
    margin-bottom: 12px;
    border-radius: 12px;
    background: var(--surface);
    color: var(--faint);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    padding: 0;
    background: none;
    box-shadow: none;
  }
  .topic {
    gap: 10px;
  }
  .level {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: -6px 4px 14px;
    font-size: 13px;
    color: var(--muted);
  }
  .sheet-md {
    padding: 16px 18px;
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    font-size: 16px;
    line-height: 1.5;
    overflow-x: hidden;
  }
  .practise {
    margin-top: 18px;
  }
  .faint-n {
    font-weight: 400;
    opacity: 0.8;
  }
  .note {
    margin: 6px 4px 0;
    text-align: center;
    font-size: 12.5px;
    color: var(--faint);
  }
  .qa {
    align-items: stretch;
    padding: 0;
  }
  .q {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 52px;
    padding: 10px 16px;
    text-align: left;
    font: inherit;
    font-weight: 600;
    color: inherit;
  }
  .chev {
    color: var(--faint);
    transition: transform var(--t-fast) var(--ease-out);
  }
  .chev.on {
    transform: rotate(90deg);
  }
  .a {
    padding: 0 16px 14px;
    font-size: 15.5px;
    line-height: 1.5;
    animation: rise-sm var(--t-fast) var(--ease-out) both;
  }
</style>
