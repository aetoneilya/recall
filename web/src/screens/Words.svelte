<script lang="ts">
  import { posLabel, tagMatches, type CardType, type Direction } from '@recall/core'
  import Sheet from '../components/Sheet.svelte'
  import TagTree from '../components/TagTree.svelte'
  import { tagLabel } from '../lib/tagTree.ts'
  import { onMount } from 'svelte'
  import { openAdd } from '../lib/add.ts'
  import DeckSwitcher from '../components/DeckSwitcher.svelte'
  import Icon from '../components/Icon.svelte'
  import { status } from '../lib/app.svelte.ts'
  import { facts } from '../lib/facts.svelte.ts'
  import { deckContents, deckTotal, libraryFacets, libraryRows, type LibrarySort } from '../lib/library.ts'
  import { renderInline } from '../lib/markdown.ts'
  import { session } from '../lib/review.svelte.ts'
  import { TYPE_NAMES } from '../lib/reviewFilter.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { dirState, type DirState } from '../lib/wordFilter.ts'
  import { POS_NAMES } from '../lib/wordForm.ts'
  import { wordsView } from '../lib/wordsView.svelte.ts'
  import { words } from '../lib/words.svelte.ts'

  // The Cards tab: one deck's cards of every type — words, questions,
  // grammar rules — cached on the device, searched and filtered as you type.
  // The deck is the one under review (the same switcher).
  const f = wordsView.filter

  onMount(() => {
    void words.ensure()
    void facts.ensure()
    requestAnimationFrame(() => wordsView.scroller?.scrollTo({ top: wordsView.scrollTop }))
  })
  // Offline adds that just synced, approvals elsewhere.
  $effect(() => {
    void status.wordsVersion
    void words.ensure()
  })
  $effect(() => {
    void status.factsVersion
    void facts.ensure()
  })

  const deckList = $derived(Object.values(session.decks))
  const deckId = $derived(session.deckId || deckList[0]?.id || '')
  const deck = $derived(session.decks[deckId])
  const loaded = $derived(!!words.all && !!facts.all)
  const rows = $derived(loaded ? libraryRows(words.all!, facts.all!, deckId, f) : null)
  const contents = $derived(deckContents(words.all ?? [], facts.all ?? [], deckId))
  const total = $derived(loaded ? deckTotal(words.all!, facts.all!, deckId, f.status) : 0)
  const presentTypes = $derived((['word', 'fact', 'rule'] as CardType[]).filter((t) => contents.types[t] > 0))
  // Switcher: what each deck holds.
  const choices = $derived(
    deckList.map((d) => ({
      id: d.id,
      name: d.name,
      n: (words.all ?? []).filter((w) => w.deckId === d.id && w.status !== 'rejected').length + (facts.all ?? []).filter((x) => x.deckId === d.id && x.status !== 'rejected').length,
    })),
  )

  let shown = $state(Math.max(80, Math.ceil(wordsView.scrollTop / 60) + 40))
  let first = true
  $effect(() => {
    void [f.q, f.type, f.tags, f.status, f.pos, f.cefr, f.state, f.sort, deckId]
    if (first) first = false
    else {
      shown = 80
      wordsView.scroller?.scrollTo({ top: 0 })
    }
  })
  // A tag or type the new deck doesn't have is dropped on a switch.
  $effect(() => {
    if (!loaded) return
    if (f.tags.length && !f.tags.every((s) => contents.tags.some((t) => tagMatches(s, t.tag)))) f.tags = f.tags.filter((s) => contents.tags.some((t) => tagMatches(s, t.tag)))
    if (f.type && !presentTypes.includes(f.type)) f.type = ''
    // Hidden word pickers don't keep filtering the words.
    if (!wordsOnly && (f.pos || f.cefr)) {
      f.pos = ''
      f.cefr = ''
    }
  })
  const hasGrammar = $derived(contents.types.rule > 0 || contents.tags.some((t) => t.tag.startsWith('Grammar/') || t.tag === 'Grammar' || t.tag === 'Grammar theory'))
  const filtered = $derived(!!(f.status || f.pos || f.cefr || f.state || f.tags.length || f.type))
  let filtersOpen = $state(false)
  const filterCount = $derived(f.tags.length + Number(!!f.state) + Number(!!f.status) + Number(!!f.pos) + Number(!!f.cefr) + Number(f.sort !== 'recent'))
  // Like the review filter (library.libraryFacets): a type, part of speech,
  // level or state is counted under the other picks, so the rest of its row
  // stays on offer (the type chips switch modes); tags drill down. Picked
  // options always stay listed so they can be taken off.
  const facets = $derived(loaded ? libraryFacets(words.all!, facts.all!, deckId, f) : null)
  const typeCounts = $derived<Partial<Record<CardType, number>>>(facets?.types ?? {})
  const tagOptions = $derived(facets?.tags ?? [])
  const posOptions = $derived(facets?.pos ?? [])
  const cefrOptions = $derived(facets?.cefr ?? [])
  const stateOptions = $derived(facets?.states ?? [])
  const wordsOnly = $derived(f.type === 'word' || (presentTypes.length === 1 && presentTypes[0] === 'word'))

  const STATE_NAMES: Record<DirState, string> = { new: 'New', learning: 'Learning', known: 'Known', fading: 'Fading', suspended: 'Suspended', off: 'Off' }
  const SORT_NAMES = $derived<Partial<Record<LibrarySort, string>>>(
    wordsOnly ? { recent: 'Recent', alpha: 'A–Z', freq: 'Most common', difficulty: 'Hardest' } : { recent: 'Recent', alpha: 'A–Z', difficulty: 'Hardest' },
  )
  // Dropped cards are hidden unless asked for; open one to restore it.
  const STATUS_NAMES: Record<'' | 'rejected' | 'all', string> = { '': 'Active', rejected: 'Dropped', all: 'Active & dropped' }
  const dirs: Direction[] = ['forward', 'reverse']
  const dirName: Record<Direction, string> = { forward: 'EN→RU', reverse: 'RU→EN' }

  function more(node: HTMLElement) {
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) shown += 120
    })
    io.observe(node)
    return { destroy: () => io.disconnect() }
  }

  function clearFilters(all = false) {
    if (all) f.type = ''
    f.sort = 'recent'
    f.tags = []
    f.status = ''
    f.pos = ''
    f.cefr = ''
    f.state = ''
  }

  const from = encodeURIComponent('/words')
  const openWord = (id: string) => navigate(`/word/${id}?from=${from}`)
  const openFact = (id: string) => navigate(`/fact/${id}?from=${from}`)
</script>

<div class="words-screen">
  <div class="screen" bind:this={wordsView.scroller} onscroll={(e) => (wordsView.scrollTop = e.currentTarget.scrollTop)}>
    <div class="screen-title">
      <h1>Cards {#if rows}<small>{rows.length === total ? total : `${rows.length} of ${total}`}</small>{/if}</h1>
      <button class="packs-link" onclick={() => navigate('/packs')}>Packs <Icon name="plus" size={16} /></button>
    </div>
    <div class="switcher">
      <DeckSwitcher countLabel="cards" options={choices} selected={deckId} onselect={(id) => session.selectDeck(id)} />
      <button class="deck-settings" onclick={() => navigate(deckId ? `/deck/${deckId}?from=%2Fwords` : '/decks')} aria-label={deck ? `Settings for ${deck.name}` : 'Manage decks'}><Icon name="settings" size={19} /></button>
    </div>

    <div class="search-row">
      <div class="search">
        <Icon name="search" size={18} />
        <input type="search" bind:value={f.q} placeholder="Search cards" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Search" />
      </div>
      <button class="filters-toggle" class:on={filterCount > 0} onclick={() => (filtersOpen = true)} aria-label="Filter and sort cards" aria-haspopup="dialog">
        <Icon name="filter" size={20} />{#if filterCount}<span>{filterCount}</span>{/if}
      </button>
    </div>

    {#if presentTypes.length > 1}
      <div class="types" role="radiogroup" aria-label="Card type">
        <button role="radio" aria-checked={!f.type} class:on={!f.type} onclick={() => (f.type = '')}>All</button>
        {#each presentTypes as t (t)}
          <button role="radio" aria-checked={f.type === t} class:on={f.type === t} onclick={() => (f.type = t)} disabled={!typeCounts[t] && f.type !== t}>{TYPE_NAMES[t]} <b>{typeCounts[t] ?? 0}</b></button>
        {/each}
      </div>
    {/if}

    {#if hasGrammar && (f.type === 'rule' || !presentTypes.includes('rule'))}
      <button class="handbook" onclick={() => navigate(`/handbook?deck=${deckId}&from=${from}`)}>
        <Icon name="words" size={18} />
        <span class="grow">Grammar handbook<span class="sub">The theory behind the rules</span></span>
        <Icon name="chevron" size={16} />
      </button>
    {/if}


    {#if !rows}
      {#if words.error || facts.error}
        <div class="empty">
          <Icon name="offline" size={40} stroke={1.4} />
          <p><strong>Couldn't load your cards</strong>{words.error || facts.error}</p>
          <button class="btn" onclick={() => (words.ensure(true), facts.ensure(true))}><Icon name="refresh" size={18} /> Try again</button>
        </div>
      {:else}
        <div class="group skel-group" aria-label="Loading">
          {#each [62, 48, 70, 54, 66, 44] as w, i (i)}
            <div class="row"><span class="skel" style="width: {w}%; height: 14px"></span><span class="skel" style="width: {w - 22}%"></span></div>
          {/each}
        </div>
      {/if}
    {:else if !rows.length}
      <div class="empty">
        <Icon name={f.q ? 'search' : 'words'} size={40} stroke={1.4} />
        {#if f.q || filtered}
          <p><strong>No matches</strong>{f.q ? `Nothing contains “${f.q.trim()}”${filtered ? ' with these filters' : ''}.` : 'No card fits these filters.'}</p>
          {#if filtered}<button class="btn" onclick={() => clearFilters(true)}>Clear filters</button>{/if}
        {:else}
          <p><strong>No cards in {deck?.name ?? 'this deck'} yet</strong>Add words you meet, questions to remember, or grammar rules to practise.</p>
        {/if}
        <button class="btn primary" onclick={() => openAdd(deck, '/words', f.q.trim() ? { term: f.q.trim() } : {})}><Icon name="plus" size={18} /> {f.q.trim() ? `Add “${f.q.trim()}”` : 'Add a card'}</button>
      </div>
    {:else}
      <div class="group">
        {#each rows.slice(0, shown) as r (r.id)}
          {#if r.kind === 'word'}
            {@const w = r.item}
            <button class="row word" onclick={() => openWord(w.id)}>
              <span class="main">
                <span class="line1">
                  <span class="term" lang="en">{w.term}</span>
                  {#if posLabel(w.pos)}<span class="pos">{posLabel(w.pos)}</span>{/if}
                  {#if w.status === 'rejected'}<span class="chip status rejected">dropped</span>{/if}
                </span>
                <span class="tr" lang="ru">{w.translations.join(', ')}</span>
              </span>
              <span class="dots" aria-label={dirs.map((d) => `${dirName[d]} ${STATE_NAMES[dirState(w.cards[d]) ?? 'new']}`).join(', ')}>
                {#each dirs as d (d)}
                  {@const s = dirState(w.cards[d])}
                  <i class="dot {s ?? 'none'}" title="{dirName[d]}: {s ? STATE_NAMES[s] : '—'}"></i>
                {/each}
              </span>
            </button>
          {:else}
            {@const x = r.item}
            {@const s = dirState(x.card)}
            <button class="row fact" onclick={() => openFact(x.id)}>
              <span class="main">
                <!-- renderInline escapes before adding its own tags. -->
                <span class="q">{@html renderInline(x.front)}</span>
                <span class="sub">
                  {#if r.kind === 'rule'}<span class="kind">Grammar · {x.exercises?.active ?? 0} exercises</span>{/if}
                  <span class="state {s ?? 'none'}">{s ? STATE_NAMES[s] : 'No card'}</span>
                  {#if x.status === 'rejected'}<span class="chip status rejected">dropped</span>{/if}
                  {#each x.tags as t (t)}{@const l = tagLabel(t)}<span class="tag">{#if l.parent}<i>{`${l.parent} › `}</i>{/if}{l.leaf}</span>{/each}
                </span>
              </span>
              <i class="dot {s ?? 'none'}" aria-hidden="true"></i>
            </button>
          {/if}
        {/each}
      </div>
      {#if rows.length > shown}<div class="sentinel" use:more></div>{/if}
    {/if}
  </div>

  {#if filtersOpen}
    <Sheet title="Filter & sort" onclose={() => (filtersOpen = false)}>
      <p class="filter-result">{rows?.length ?? 0} matching cards in {deck?.name ?? 'this deck'}</p>
      <div class="filter-fields">
        <label class="filter-field">
          <span>Sort by</span>
          <select bind:value={f.sort} aria-label="Sort">
            {#each Object.entries(SORT_NAMES) as [k, v] (k)}<option value={k}>{v}</option>{/each}
          </select>
        </label>
        <label class="filter-field">
          <span>Card state</span>
          <select bind:value={f.state} aria-label="State">
            <option value="">Any state</option>
            {#each stateOptions as s (s.value)}<option value={s.value}>{STATE_NAMES[s.value]} ({s.n})</option>{/each}
          </select>
        </label>
        <label class="filter-field">
          <span>Include</span>
          <select bind:value={f.status} aria-label="Status">
            {#each Object.entries(STATUS_NAMES) as [k, v] (k)}<option value={k}>{v}</option>{/each}
          </select>
        </label>
        {#if wordsOnly}
          <label class="filter-field">
            <span>Part of speech</span>
            <select bind:value={f.pos} aria-label="Part of speech">
              <option value="">Any part of speech</option>
              {#each posOptions as p (p.value)}<option value={p.value}>{POS_NAMES[p.value]} ({p.n})</option>{/each}
            </select>
          </label>
          <label class="filter-field">
            <span>Level</span>
            <select bind:value={f.cefr} aria-label="CEFR level">
              <option value="">Any level</option>
              {#each cefrOptions as c (c.value)}<option value={c.value}>{c.value} ({c.n})</option>{/each}
            </select>
          </label>
        {/if}
      </div>

      {#if contents.tags.length}
        <div class="section-label">Tags</div>
        <TagTree tags={tagOptions} selected={f.tags} onchange={(t) => (f.tags = t)} />
      {/if}
      <div class="sheet-actions">
        <button class="btn" onclick={() => clearFilters()} disabled={!filterCount}>Reset</button>
        <button class="btn primary grow" onclick={() => (filtersOpen = false)}>Show {rows?.length ?? 0} cards</button>
      </div>
    </Sheet>
  {/if}

  <button class="fab" onclick={() => openAdd(deck, '/words')} aria-label="Add a card"><Icon name="plus" size={26} stroke={2.2} /></button>
</div>

<style>
  .words-screen {
    position: relative;
    height: 100%;
  }
  .screen {
    padding-bottom: 96px;
  }
  h1 small {
    font-size: 15px;
    color: var(--muted);
    font-weight: 400;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  .search {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    background: var(--bg);
    padding: 0;
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
  .filter-fields {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .filter-field {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    font-size: 15px;
  }
  .filter-field span {
    flex: 1;
  }
  .filter-field select {
    width: 58%;
    min-height: 44px;
    padding: 8px 28px 8px 12px;
  }
  .filter-result {
    color: var(--muted);
    font-size: 14px;
    margin: 4px 0 20px;
  }
  .search-row {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--bg);
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .filters-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-width: 44px;
    height: 44px;
    border-radius: 12px;
    color: var(--muted);
    background: var(--surface);
  }
  .filters-toggle.on {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .filters-toggle span {
    font-size: 13px;
    font-weight: 600;
    padding-right: 8px;
  }
  .filters-toggle.on :global(svg) {
    margin-left: 8px;
  }
  .packs-link {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
    color: var(--accent);
    font-size: 15px;
    font-weight: 600;
  }
  .deck-settings {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    color: var(--muted);
  }
  .word {
    gap: 10px;
    min-height: 60px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .line1 {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .term {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .pos {
    flex: none;
    font-size: 13px;
    font-style: italic;
    color: var(--faint);
  }
  .status {
    flex: none;
    align-self: center;
  }
  .status.rejected {
    color: var(--again);
  }
  .tr {
    font-size: 15px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dots {
    flex: none;
    display: flex;
    gap: 5px;
  }
  .dot {
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
  /* Known once, recall now below 90%: the review colour, hollow. */
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
  .faint {
    color: var(--faint);
  }
  .fab {
    position: absolute;
    /* Clear of the tab bar (24px) and in from its last tab. */
    right: calc(20px + var(--sar));
    bottom: 24px;
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
  .switcher {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: -4px 0 8px;
  }
  /* Padded vertically (and pulled back by the margin) so the chips' 44px hit
     areas fit inside the scroller, which clips. */
  .types {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    margin: -7px -16px 3px;
    padding: 7px 16px;
    scrollbar-width: none;
  }
  .types::-webkit-scrollbar {
    display: none;
  }
  .types button {
    position: relative;
    flex: none;
    height: 30px;
    padding: 0 12px;
    border-radius: 15px;
    font-size: 14px;
    font-weight: 500;
    color: var(--muted);
    box-shadow: inset 0 0 0 1px var(--hairline);
    font-variant-numeric: tabular-nums;
  }
  .types button::after {
    content: '';
    position: absolute;
    inset: -7px -3px;
  }
  .types button b {
    font-weight: 600;
    color: var(--faint);
  }
  .types button.on {
    color: var(--accent);
    background: var(--accent-soft);
    box-shadow: none;
  }
  .types button.on b {
    color: inherit;
  }
  .fact {
    gap: 10px;
    min-height: 60px;
  }
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
  .kind {
    color: var(--accent);
    font-weight: 500;
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
  .fact .dot {
    flex: none;
  }
  .handbook {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    padding: 8px 14px;
    margin: 0 0 10px;
    border-radius: 14px;
    text-align: left;
    color: var(--accent);
    background: var(--surface);
  }
  .handbook .grow {
    flex: 1;
    color: var(--text);
    font-weight: 600;
  }
  .handbook .sub {
    display: block;
    font-size: 13px;
    font-weight: 400;
    color: var(--muted);
  }
  /* The pill keeps its size; the tap area is 44px tall. */
  .types button {
    position: relative;
  }
  .types button::after {
    content: '';
    position: absolute;
    inset: -6px -2px;
  }
  .tag i {
    font-style: normal;
    color: var(--faint);
  }
  .sheet-actions {
    position: sticky;
    bottom: -16px;
    background: var(--bg);
    padding: 12px 0 16px;
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
  .sheet-actions .grow {
    flex: 1;
  }
</style>
