<script lang="ts">
  import { status } from '../lib/app.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { hasDeckLanguages } from '../lib/decks.ts'
  import { session } from '../lib/review.svelte.ts'
  import { openTelegramLink } from '../lib/telegram.ts'
  import { checkpoint } from '../lib/update.ts'
  import { openAdd } from '../lib/add.ts'
  import type { DeckWithCounts } from '../lib/types.ts'
  import Icon from './Icon.svelte'

  const s = $derived(session.stats)
  const minutes = $derived(Math.max(1, Math.round(s.ms / 60000)))
  const w = $derived.by(() => {
    void session.now
    return session.waiting()
  })
  const inMin = $derived(w.next ? Math.max(1, Math.round((w.next.getTime() - session.now) / 60000)) : 0)

  // A deck with nothing in it yet (a new account): the next step is adding
  // words, not waiting for reviews.
  const firstRun = $derived(session.loaded && session.wordCount === 0 && !s.reviewed)
  const bot = $derived(status.me?.botUsername ?? null)
  const deckId = $derived(session.deckId)
  const takesWords = $derived(!session.decks[deckId] || hasDeckLanguages(session.decks[deckId]))

  // "What's next" once the queue is empty: tomorrow's reviews, so the end of
  // a session says when to come back.
  let tomorrow = $state<number | null>(null)
  $effect(() => {
    if (!session.loaded || firstRun) return
    let live = true
    void session.tomorrow().then((n) => {
      if (live) tomorrow = n
    })
    return () => {
      live = false
    }
  })

  // The session is over: a good moment for a waiting app update.
  $effect(() => {
    if (session.loaded && !session.current) checkpoint('summary')
  })

  // What's left to do elsewhere, and what this session missed.
  const others = $derived(session.choices.filter((d) => d.id !== deckId && d.left > 0))
  const missed = $derived(session.missed)
  let showAll = $state(false)
  const extra = $derived(session.decks[deckId]?.extraNewToday ?? 0)
  // Cards not started yet in this deck (unknown on older caches: offer it).
  const unseen = $derived((session.decks[deckId] as Partial<DeckWithCounts> | undefined)?.counts?.newTotal ?? 1)
  let adding = $state(false)
  async function moreNew() {
    adding = true
    await session.moreNew(5)
    adding = false
  }
  let week = $state<boolean[] | null>(null)
  $effect(() => {
    if (!session.loaded || firstRun) return
    let live = true
    void session.week().then((d) => {
      if (live) week = d
    })
    return () => {
      live = false
    }
  })

  function openBot(e: MouseEvent) {
    if (bot && openTelegramLink(`https://t.me/${bot}`)) e.preventDefault()
  }
</script>

{#if !session.loaded && !session.error}
  <div class="loading" aria-label="Loading cards">
    <span class="skel" style="width: 40%"></span>
    <span class="skel big" style="width: 62%"></span>
    <span class="skel" style="width: 48%"></span>
  </div>
{:else}
  <div class="summary">
    {#if !session.loaded}
      <Icon name="offline" size={40} stroke={1.4} />
      {#if session.error === 'offline'}
        <h2>You're offline</h2>
        <p class="muted">No cards are cached on this device yet. Open Mnemosyne once while online and they'll be here next time.</p>
        <button class="btn" onclick={() => session.refresh()} disabled={session.refreshing}>
          <Icon name="refresh" size={18} /> Try again
        </button>
      {:else}
        <h2>Couldn't load cards</h2>
        <p class="muted">{session.error}</p>
        <button class="btn" onclick={() => session.refresh()} disabled={session.refreshing}>
          <Icon name="refresh" size={18} /> Try again
        </button>
      {/if}
    {:else if firstRun}
      <span class="first"><Icon name="sparkle" size={30} stroke={1.6} /></span>
      <h2>Add your first words</h2>
      <p class="muted">Type a word you met and Claude fills in the translation, pronunciation and an example. It's ready to review right away.</p>
      <div class="next-steps">
        <button class="btn primary block" onclick={() => navigate('/add?from=/')}><Icon name="plus" size={18} stroke={2.2} /> Add a word</button>
        {#if bot}
          <a class="row bot" href="https://t.me/{bot}" target="_blank" rel="noopener" onclick={openBot}>
            <Icon name="send" size={20} />
            <span>Or send words to <b>@{bot}</b> in Telegram</span>
            <Icon name="chevron" size={18} />
          </a>
        {/if}
      </div>
    {:else}
      <svg class="mark" class:done={s.reviewed} width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle cx="28" cy="28" r="27" />
        <path d="M17 29l7.5 7.5L39.5 21" />
      </svg>
      <h2>{s.reviewed ? 'Done for now' : 'All caught up'}</h2>
      {#if s.reviewed}
        <div class="tally" aria-label="{s.reviewed} reviewed, {s.again} again, {s.fresh ?? 0} new, {minutes} minutes">
          <span><b>{s.reviewed}</b><small>reviewed</small></span>
          <span><b>{s.again}</b><small>again</small></span>
          <span><b>{s.fresh ?? 0}</b><small>new</small></span>
          <span><b>{minutes}</b><small>min</small></span>
        </div>
      {:else}
        <p class="muted">Reviews and new cards appear here as they come due.</p>
      {/if}
      {#if w.count}
        <p class="next"><Icon name="clock" size={16} /> {w.count} learning {w.count === 1 ? 'card' : 'cards'} back in {inMin} min</p>
      {:else if tomorrow !== null}
        <p class="next"><Icon name="clock" size={16} /> {tomorrow ? `Tomorrow: ${tomorrow} ${tomorrow === 1 ? 'review' : 'reviews'}` : 'No reviews due tomorrow'}</p>
      {/if}
      {#if week}
        <div class="week" aria-label="Studied {week.filter(Boolean).length} of the last 7 days">
          {#each week as on, i (i)}<i class:on></i>{/each}
        </div>
      {/if}

      {#if missed.length}
        <div class="missed">
          <p class="label">{missed.length} you missed</p>
          <div class="group">
            {#each showAll ? missed : missed.slice(0, 3) as m (m.cardId)}
              <button class="row" onclick={() => navigate(m.kind === 'word' ? `/word/${m.id}?from=/` : `/fact/${m.id}?from=/`)}>
                <span class="term">{m.title}</span>{#if m.sub}<span class="sub-tr">{m.sub}</span>{/if}
              </button>
            {/each}
            {#if missed.length > 3 && !showAll}<button class="row all" onclick={() => (showAll = true)}>Show all {missed.length}</button>{/if}
          </div>
        </div>
      {/if}

      <div class="next-steps group">
        <button class="row" onclick={() => navigate(`/practice?deck=${deckId}&from=/`)}>
          <Icon name="refresh" size={20} />
          <span>{missed.length ? 'Go over them once more' : 'Practice hard cards'}<small>Doesn't change the schedule</small></span>
          <Icon name="chevron" size={18} />
        </button>
        {#if unseen > 0}
        <button class="row" onclick={moreNew} disabled={adding}>
          <Icon name="plus" size={20} stroke={2} />
          <span>{adding ? 'Adding…' : '+5 new cards today'}{#if extra}<small>{extra} extra today</small>{/if}</span>
        </button>
        {/if}
        {#each others as d (d.id)}
          <button class="row" onclick={() => session.selectDeck(d.id)}>
            <Icon name="review" size={20} />
            <span>{d.name} · {d.left} {d.left === 1 ? 'card' : 'cards'}</span>
            <Icon name="chevron" size={18} />
          </button>
        {/each}
        <button class="row" onclick={() => openAdd(session.decks[deckId], '/')}>
          <Icon name="plus" size={20} stroke={2} />
          <span>{takesWords ? 'Add words' : 'Add cards'}</span>
          <Icon name="chevron" size={18} />
        </button>
      </div>
      <div class="actions">
        {#if session.canUndo}
          <button class="btn" onclick={() => session.undo()}><Icon name="undo" size={18} /> Undo</button>
        {/if}
        <button class="btn" onclick={() => session.refresh()} disabled={session.refreshing}>
          <Icon name="refresh" size={18} /> {session.refreshing ? 'Checking…' : 'Check for more'}
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Centred when it fits; scrolls when the lists make it long. */
  .summary {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 10px;
    padding: 24px 12px 32px;
    overflow-y: auto;
    overscroll-behavior: contain;
    animation: rise var(--t-base) var(--ease-out);
  }
  .summary > :global(*) {
    flex: none;
  }
  .summary > :global(:first-child) {
    margin-top: auto;
  }
  .summary > :global(:last-child) {
    margin-bottom: auto;
  }
  .summary > :global(svg:first-child) {
    color: var(--faint);
    margin-bottom: 4px;
  }
  h2 {
    font-size: 28px;
    line-height: 1.15;
    font-weight: 700;
    letter-spacing: -0.025em;
    margin: 0;
  }
  p {
    margin: 0;
    max-width: 300px;
    text-wrap: balance;
  }
  /* Four numbers in a row, captions under them, no tiles. */
  .tally {
    display: flex;
    gap: 22px;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .tally span {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .tally b {
    font-size: 22px;
    font-weight: 650;
    line-height: 1.2;
  }
  .tally small {
    font-size: 12px;
    color: var(--muted);
  }
  /* Studied days this week: quiet dots, no streak counter. */
  .week {
    display: flex;
    gap: 6px;
  }
  .week i {
    width: 8px;
    height: 8px;
    border-radius: 4px;
    background: var(--surface-2);
  }
  .week i.on {
    background: var(--accent);
  }
  .missed {
    width: 100%;
    max-width: 340px;
    margin-top: 10px;
    text-align: left;
  }
  .missed .label {
    margin: 0 4px 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }
  .missed .row {
    gap: 10px;
    min-height: 44px;
    font-size: 15px;
  }
  .missed .term {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .missed .sub-tr {
    flex: 1;
    min-width: 0;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .missed .all {
    justify-content: center;
    color: var(--accent);
    font-weight: 500;
  }
  .next-steps .row small {
    display: block;
    font-size: 12.5px;
    color: var(--faint);
  }
  .next {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 15px;
    color: var(--muted);
  }

  /* The session-end check: drawn once, the one celebratory moment. */
  .mark {
    margin-bottom: 6px;
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .mark circle {
    stroke: var(--surface-2);
    stroke-width: 2;
    fill: var(--surface);
  }
  .mark path {
    stroke: var(--faint);
    stroke-width: 3;
  }
  .mark.done circle {
    fill: var(--good-bg);
    stroke: transparent;
  }
  .mark.done path {
    stroke: var(--good);
    stroke-dasharray: 34;
    animation: tick 420ms var(--ease-out) 120ms both;
  }
  @keyframes tick {
    from {
      stroke-dashoffset: 34;
    }
    to {
      stroke-dashoffset: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mark.done path {
      animation: none;
    }
  }

  .next-steps {
    width: 100%;
    max-width: 340px;
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .next-steps.group {
    gap: 0;
  }
  .next-steps .row {
    color: var(--text);
    font-size: 15px;
    text-decoration: none;
  }
  .next-steps .row :global(svg) {
    color: var(--accent);
    flex: none;
  }
  .next-steps .row :global(svg:last-child) {
    color: var(--faint);
  }
  .next-steps .row span {
    flex: 1;
  }
  .next-steps .btn.primary {
    min-height: 52px;
    font-size: 17px;
  }
  .bot {
    border-radius: var(--radius-m);
    background: var(--surface);
    line-height: 1.35;
  }
  .bot b {
    font-weight: 600;
  }
  .first {
    width: 56px;
    height: 56px;
    margin-bottom: 6px;
    border-radius: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    background: var(--accent-soft);
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }

  .loading {
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 20px;
    animation: fade-in var(--t-base) ease 150ms both;
  }
  .loading .big {
    height: 22px;
    margin-top: 18%;
    align-self: center;
  }
  .loading .big + .skel {
    align-self: center;
  }
</style>
