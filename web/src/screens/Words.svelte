<script lang="ts">
  import { CEFR_LEVELS, PARTS_OF_SPEECH, posLabel, type Direction } from '@recall/core'
  import { onMount } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import { status } from '../lib/app.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { DIR_STATES, dirState, filterWords, type DirState, type WordSort } from '../lib/wordFilter.ts'
  import { POS_NAMES } from '../lib/wordForm.ts'
  import { wordsView } from '../lib/wordsView.svelte.ts'
  import { words } from '../lib/words.svelte.ts'

  // Kept in a module, so coming back from a word restores search and filters.
  const f = wordsView.filter

  onMount(() => {
    void words.ensure()
    // Back from a word: where the list was left.
    requestAnimationFrame(() => wordsView.scroller?.scrollTo({ top: wordsView.scrollTop }))
  })
  // Offline adds that just synced, approvals elsewhere.
  $effect(() => {
    void status.wordsVersion
    void words.ensure()
  })

  const list = $derived(words.all ? filterWords(words.all, f) : null)
  let shown = $state(Math.max(80, Math.ceil(wordsView.scrollTop / 60) + 40))
  let first = true
  $effect(() => {
    void [f.q, f.status, f.pos, f.cefr, f.state, f.sort]
    if (first) first = false
    else {
      shown = 80
      wordsView.scroller?.scrollTo({ top: 0 })
    }
  })
  const filtered = $derived(!!(f.status || f.pos || f.cefr || f.state))

  const STATE_NAMES: Record<DirState, string> = { new: 'New', learning: 'Learning', known: 'Known', fading: 'Fading', suspended: 'Suspended', off: 'Off' }
  const SORT_NAMES: Record<WordSort, string> = { recent: 'Recent', alpha: 'A–Z', freq: 'Most common', difficulty: 'Hardest' }
  const dirs: Direction[] = ['forward', 'reverse']
  const dirName: Record<Direction, string> = { forward: 'EN→RU', reverse: 'RU→EN' }

  function more(node: HTMLElement) {
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) shown += 120
    })
    io.observe(node)
    return { destroy: () => io.disconnect() }
  }

  function clearFilters() {
    f.status = ''
    f.pos = ''
    f.cefr = ''
    f.state = ''
  }

  const open = (id: string) => navigate(`/word/${id}?from=${encodeURIComponent('/words')}`)
</script>

<div class="words-screen">
  <div class="screen" bind:this={wordsView.scroller} onscroll={(e) => (wordsView.scrollTop = e.currentTarget.scrollTop)}>
    <div class="screen-title">
      <h1>Words</h1>
      {#if words.all}<span class="total">{list?.length === words.all.length ? words.all.length : `${list?.length} of ${words.all.length}`}</span>{/if}
    </div>

    <div class="search">
      <Icon name="search" size={18} />
      <input type="search" bind:value={f.q} placeholder="Search words, translations, examples" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Search" />
    </div>

    <div class="filters" role="group" aria-label="Filters">
      <label class="pick" class:on={f.sort !== 'recent'}>
        <span>{SORT_NAMES[f.sort]}</span>
        <select bind:value={f.sort} aria-label="Sort">
          {#each Object.entries(SORT_NAMES) as [k, v] (k)}<option value={k}>{v}</option>{/each}
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
        <span>{f.status === '' ? 'Studied & inbox' : f.status === 'all' ? 'All, incl. rejected' : f.status === 'active' ? 'Studied' : f.status === 'inbox' ? 'Inbox' : 'Rejected'}</span>
        <select bind:value={f.status} aria-label="Status">
          <option value="">Studied & inbox</option>
          <option value="active">Studied</option>
          <option value="inbox">Inbox</option>
          <option value="rejected">Rejected</option>
          <option value="all">All, incl. rejected</option>
        </select>
      </label>
      <label class="pick" class:on={f.pos}>
        <span>{f.pos ? POS_NAMES[f.pos] : 'Any part'}</span>
        <select bind:value={f.pos} aria-label="Part of speech">
          <option value="">Any part of speech</option>
          {#each PARTS_OF_SPEECH as p (p)}<option value={p}>{POS_NAMES[p]}</option>{/each}
        </select>
      </label>
      <label class="pick" class:on={f.cefr}>
        <span>{f.cefr || 'Any level'}</span>
        <select bind:value={f.cefr} aria-label="CEFR level">
          <option value="">Any level</option>
          {#each CEFR_LEVELS as c (c)}<option value={c}>{c}</option>{/each}
        </select>
      </label>
    </div>

    {#if !list}
      {#if words.error}
        <div class="empty">
          <Icon name="offline" size={40} stroke={1.4} />
          <p><strong>Couldn't load your words</strong>{words.error}</p>
          <button class="btn" onclick={() => words.ensure(true)}><Icon name="refresh" size={18} /> Try again</button>
        </div>
      {:else}
        <div class="group skel-group" aria-label="Loading">
          {#each [62, 48, 70, 54, 66, 44] as w, i (i)}
            <div class="row"><span class="skel" style="width: {w}%; height: 14px"></span><span class="skel" style="width: {w - 22}%"></span></div>
          {/each}
        </div>
      {/if}
    {:else if !list.length}
      <div class="empty">
        <Icon name={f.q ? 'search' : 'words'} size={40} stroke={1.4} />
        {#if f.q || filtered}
          <p><strong>No matches</strong>{f.q ? `Nothing contains “${f.q.trim()}”${filtered ? ' with these filters' : ''}.` : 'No word fits these filters.'}</p>
          {#if filtered}<button class="btn" onclick={clearFilters}>Clear filters</button>{/if}
          {#if f.q}<button class="btn primary" onclick={() => navigate(`/add?from=${encodeURIComponent('/words')}`)}><Icon name="plus" size={18} /> Add “{f.q.trim()}”</button>{/if}
        {:else}
          <p><strong>No words yet</strong>Add the ones you meet while reading, or ask Claude to propose some.</p>
          <button class="btn primary" onclick={() => navigate(`/add?from=${encodeURIComponent('/words')}`)}><Icon name="plus" size={18} /> Add a word</button>
        {/if}
      </div>
    {:else}
      <div class="group">
        {#each list.slice(0, shown) as w (w.id)}
          <button class="row word" onclick={() => open(w.id)}>
            <span class="main">
              <span class="line1">
                <span class="term" lang="en">{w.term}</span>
                {#if posLabel(w.pos)}<span class="pos">{posLabel(w.pos)}</span>{/if}
                {#if w.status !== 'active'}<span class="chip status {w.status}">{w.status}</span>{/if}
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
        {/each}
      </div>
      {#if list.length > shown}<div class="sentinel" use:more></div>{/if}
      <p class="legend" aria-hidden="true">
        <span><i class="dot new"></i>new</span><span><i class="dot learning"></i>learning</span><span><i class="dot known"></i>known</span><span><i class="dot fading"></i>fading</span>
        <span class="faint">left EN→RU · right RU→EN</span>
      </p>
    {/if}
  </div>

  <button class="fab" onclick={() => navigate(`/add?from=${encodeURIComponent('/words')}`)} aria-label="Add a word"><Icon name="plus" size={26} stroke={2.2} /></button>
</div>

<style>
  .words-screen {
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
    margin: 0 -16px 12px;
    padding: 0 16px 2px;
    scrollbar-width: none;
  }
  .filters::-webkit-scrollbar {
    display: none;
  }
  /* A native select under a chip: one tap opens the system picker. */
  .pick {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 32px;
    padding: 0 26px 0 12px;
    border-radius: 16px;
    background: var(--surface);
    color: var(--muted);
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
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
  .status.inbox {
    color: var(--accent);
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
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin: 12px 16px 0;
    font-size: 12.5px;
    color: var(--muted);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .faint {
    color: var(--faint);
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
