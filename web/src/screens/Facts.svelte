<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import LibrarySwitch from '../components/LibrarySwitch.svelte'
  import { status } from '../lib/app.svelte.ts'
  import { filterFacts, groupByDeck } from '../lib/factFilter.ts'
  import { renderInline } from '../lib/markdown.ts'
  import { facts } from '../lib/facts.svelte.ts'
  import { session } from '../lib/review.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { DIR_STATES, dirState, type DirState } from '../lib/wordFilter.ts'
  import { wordsView } from '../lib/wordsView.svelte.ts'

  // The Topics half of the Words tab: every fact, cached on the device,
  // searched and filtered as you type, grouped by topic.
  const f = wordsView.factFilter

  onMount(() => {
    void facts.ensure()
    requestAnimationFrame(() => wordsView.factScroller?.scrollTo({ top: wordsView.factScrollTop }))
  })
  $effect(() => {
    void status.factsVersion
    void facts.ensure()
  })

  // Topic decks in the server's order; from the review session's copy, so
  // they paint offline too.
  const topics = $derived(Object.values(session.decks).filter((d) => d.kind === 'topic'))
  const list = $derived(facts.all ? filterFacts(facts.all, f, topics.map((d) => d.id)) : null)
  let shown = $state(Math.max(80, Math.ceil(wordsView.factScrollTop / 60) + 40))
  let first = true
  $effect(() => {
    void [f.q, f.deck, f.state, f.status]
    if (first) first = false
    else {
      shown = 80
      wordsView.factScroller?.scrollTo({ top: 0 })
    }
  })
  const groups = $derived(list ? groupByDeck(list.slice(0, shown)) : [])
  const filtered = $derived(!!(f.deck || f.state || f.status))
  // A topic filter on a deck that's gone (deleted elsewhere) is dropped.
  $effect(() => {
    if (f.deck && topics.length && !topics.some((d) => d.id === f.deck)) f.deck = ''
  })

  const STATE_NAMES: Record<DirState, string> = { new: 'New', learning: 'Learning', known: 'Known', fading: 'Fading', suspended: 'Suspended', off: 'Off' }
  const STATUS_NAMES = { '': 'Studied & inbox', active: 'Studied', inbox: 'Inbox', rejected: 'Rejected', all: 'All, incl. rejected' } as const

  function more(node: HTMLElement) {
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) shown += 120
    })
    io.observe(node)
    return { destroy: () => io.disconnect() }
  }

  function clearFilters() {
    f.deck = ''
    f.state = ''
    f.status = ''
  }

  const from = encodeURIComponent('/words')
  const open = (id: string) => navigate(`/fact/${id}?from=${from}`)
  const add = () => navigate(`/fact/new?from=${from}${f.deck ? `&deck=${encodeURIComponent(f.deck)}` : ''}`)
</script>

<div class="facts-screen">
  <div class="screen" bind:this={wordsView.factScroller} onscroll={(e) => (wordsView.factScrollTop = e.currentTarget.scrollTop)}>
    <div class="screen-title">
      <h1>Topics</h1>
      {#if facts.all}<span class="total">{list?.length === facts.all.length ? facts.all.length : `${list?.length} of ${facts.all.length}`}</span>{/if}
    </div>
    <LibrarySwitch />

    <div class="search">
      <Icon name="search" size={18} />
      <input type="search" bind:value={f.q} placeholder="Search questions, answers, tags" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Search" />
    </div>

    <div class="filters" role="group" aria-label="Filters">
      <label class="pick" class:on={f.deck}>
        <span>{f.deck ? topics.find((d) => d.id === f.deck)?.name ?? 'Topic' : 'All topics'}</span>
        <select bind:value={f.deck} aria-label="Topic">
          <option value="">All topics</option>
          {#each topics as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
        </select>
      </label>
      <label class="pick" class:on={f.state}>
        <span>{f.state ? STATE_NAMES[f.state] : 'Any state'}</span>
        <select bind:value={f.state} aria-label="State">
          <option value="">Any state</option>
          {#each DIR_STATES as s (s)}<option value={s}>{STATE_NAMES[s]}</option>{/each}
        </select>
      </label>
      <label class="pick" class:on={f.status}>
        <span>{STATUS_NAMES[f.status]}</span>
        <select bind:value={f.status} aria-label="Status">
          {#each Object.entries(STATUS_NAMES) as [k, v] (k)}<option value={k}>{v}</option>{/each}
        </select>
      </label>
    </div>

    {#if !list}
      {#if facts.error}
        <div class="empty">
          <Icon name="offline" size={40} stroke={1.4} />
          <p><strong>Couldn't load your cards</strong>{facts.error}</p>
          <button class="btn" onclick={() => facts.ensure(true)}><Icon name="refresh" size={18} /> Try again</button>
        </div>
      {:else}
        <div class="group skel-group" aria-label="Loading">
          {#each [72, 58, 80, 64, 70] as w, i (i)}
            <div class="row"><span class="skel" style="width: {w}%; height: 14px"></span><span class="skel" style="width: 30%"></span></div>
          {/each}
        </div>
      {/if}
    {:else if !list.length}
      <div class="empty">
        <Icon name={f.q ? 'search' : 'words'} size={40} stroke={1.4} />
        {#if f.q || filtered}
          <p><strong>No matches</strong>{f.q ? `No card contains “${f.q.trim()}”${filtered ? ' with these filters' : ''}.` : 'No card fits these filters.'}</p>
          {#if filtered}<button class="btn" onclick={clearFilters}>Clear filters</button>{/if}
        {:else}
          <p><strong>No cards yet</strong>Write a question and its answer, or ask Claude to make cards from your notes.</p>
        {/if}
        <button class="btn primary" onclick={add}><Icon name="plus" size={18} /> Add a card</button>
      </div>
    {:else}
      {#each groups as g (g.deckId)}
        <div class="section-label topic">{g.deckName}</div>
        <div class="group">
          {#each g.facts as x (x.id)}
            {@const s = dirState(x.card)}
            <button class="row fact" onclick={() => open(x.id)}>
              <span class="main">
                <!-- renderInline escapes before adding its own tags. -->
                <span class="q">{@html renderInline(x.front)}</span>
                <span class="sub">
                  <span class="state {s ?? 'none'}">{s ? STATE_NAMES[s] : 'No card'}</span>
                  {#if x.status !== 'active'}<span class="chip status {x.status}">{x.status}</span>{/if}
                  {#each x.tags as t (t)}<span class="tag">{t}</span>{/each}
                </span>
              </span>
              <i class="dot {s ?? 'none'}" aria-hidden="true"></i>
            </button>
          {/each}
        </div>
      {/each}
      {#if list.length > shown}<div class="sentinel" use:more></div>{/if}
    {/if}
  </div>

  <button class="fab" onclick={add} aria-label="Add a card"><Icon name="plus" size={26} stroke={2.2} /></button>
</div>

<style>
  .facts-screen {
    position: relative;
    height: 100%;
  }
  .screen {
    padding-bottom: 96px;
  }
  .total {
    font-size: 15px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .search {
    position: sticky;
    top: -8px;
    z-index: 2;
    display: flex;
    align-items: center;
    background: var(--bg);
    padding: 4px 0 8px;
    color: var(--faint);
  }
  .search :global(svg) {
    position: absolute;
    left: 12px;
  }
  .search input {
    padding-left: 38px;
    border-radius: 12px;
    background: var(--surface-2);
    border-color: transparent;
  }
  .search input:focus {
    background: var(--surface);
  }
  .filters {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    margin: 0 -16px 4px;
    padding: 0 16px 2px;
    scrollbar-width: none;
  }
  .filters::-webkit-scrollbar {
    display: none;
  }
  .pick {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 32px;
    max-width: 60vw;
    padding: 0 26px 0 12px;
    border-radius: 16px;
    background: var(--surface);
    color: var(--muted);
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
  }
  .pick span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pick::after {
    content: '';
    position: absolute;
    right: 11px;
    top: 13px;
    width: 6px;
    height: 6px;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(45deg);
    opacity: 0.7;
  }
  .pick.on {
    background: var(--accent);
    color: var(--accent-text);
  }
  .pick select {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    padding: 0;
    cursor: pointer;
  }
  .section-label.topic {
    margin-top: 20px;
    font-weight: 600;
  }
  .fact {
    gap: 10px;
    min-height: 60px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  /* The question, two lines at most. */
  .q {
    font-weight: 600;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .q :global(code) {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.86em;
    font-weight: 500;
  }
  .q :global(em.wl) {
    color: var(--muted);
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    color: var(--muted);
    white-space: nowrap;
  }
  .state.new {
    color: var(--c-new);
  }
  .state.learning {
    color: var(--c-learn);
  }
  .state.known,
  .state.fading {
    color: var(--c-review);
  }
  .state.suspended,
  .state.off,
  .state.none {
    color: var(--faint);
  }
  .tag {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag::before {
    content: '·';
    margin-right: 6px;
    color: var(--faint);
  }
  .status {
    flex: none;
  }
  .status.inbox {
    color: var(--accent);
  }
  .status.rejected {
    color: var(--again);
  }
  .dot {
    flex: none;
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--surface-2);
  }
  .dot.new {
    background: var(--c-new);
  }
  .dot.learning {
    background: var(--c-learn);
  }
  .dot.known {
    background: var(--c-review);
  }
  .dot.fading {
    background: transparent;
    box-shadow: inset 0 0 0 2px var(--c-review);
  }
  .dot.suspended,
  .dot.off {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--c-suspended);
  }
  .sentinel {
    height: 1px;
  }
  .fab {
    position: absolute;
    right: calc(16px + var(--sar));
    bottom: 16px;
    width: 58px;
    height: 58px;
    border-radius: 29px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-text);
    background: var(--accent);
    box-shadow: var(--shadow-lift);
    transition: transform var(--t-press) var(--ease-out);
  }
  .fab:active {
    transform: scale(0.92);
  }
</style>
