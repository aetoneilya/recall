<script lang="ts">
  import Icon from '../components/Icon.svelte'
  import Markdown from '../components/Markdown.svelte'
  import WordPreview from '../components/WordPreview.svelte'
  import { api, status } from '../lib/app.svelte.ts'
  import { facts } from '../lib/facts.svelte.ts'
  import { remaining } from '../lib/queue.ts'
  import { session } from '../lib/review.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { swipe, type SwipeDir } from '../lib/swipe.ts'
  import { haptic } from '../lib/telegram.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'
  import type { FactItem, WordItem } from '../lib/types.ts'
  import { words } from '../lib/words.svelte.ts'

  // A proposal: a word for a language deck or a fact for a topic deck.
  type Proposal = { id: string; deckId: string; deckName: string; createdAt: string; createdBy: string; tags: string[] } & (
    | { kind: 'word'; word: WordItem }
    | { kind: 'fact'; fact: FactItem }
  )
  const ofWord = (w: WordItem): Proposal => ({ kind: 'word', word: w, id: w.id, deckId: w.deckId, deckName: w.deckName, createdAt: w.createdAt, createdBy: w.createdBy, tags: w.tags })
  const ofFact = (f: FactItem): Proposal => ({ kind: 'fact', fact: f, id: f.id, deckId: f.deckId, deckName: f.deckName, createdAt: f.createdAt, createdBy: f.createdBy, tags: f.tags })
  const byAge = (xs: Proposal[]) => xs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const label = (p: Proposal) => (p.kind === 'word' ? `“${p.word.term}”` : p.fact.front.length > 40 ? `“${p.fact.front.slice(0, 38)}…”` : `“${p.fact.front}”`)

  let notes = $state<Proposal[]>([])
  let loading = $state(true)
  let error = $state('')
  let deck = $state<string | null>(null)
  let dx = $state(0)
  let dragging = $state(false)
  let leaving = $state(false)

  const decks = $derived.by(() => {
    const m = new Map<string, { id: string; name: string; n: number }>()
    for (const n of notes) {
      const d = m.get(n.deckId) ?? { id: n.deckId, name: n.deckName, n: 0 }
      d.n++
      m.set(n.deckId, d)
    }
    return [...m.values()]
  })
  const visible = $derived(deck ? notes.filter((n) => n.deckId === deck) : notes)
  const top = $derived(visible[0])

  // Paint at once from the device's copy of the collection (offline too),
  // then take the server's list.
  void Promise.all([words.restore(), facts.restore()]).then(() => {
    if (!loading || notes.length || (!words.all && !facts.all)) return
    notes = byAge([...(words.all ?? []).filter((w) => w.status === 'inbox').map(ofWord), ...(facts.all ?? []).filter((f) => f.status === 'inbox').map(ofFact)])
  })

  async function load() {
    loading = true
    try {
      const r = await api.inbox()
      notes = byAge([...r.words.map(ofWord), ...r.facts.map(ofFact)])
      status.inbox = notes.length
      error = ''
    } catch (e) {
      error = errorText(e)
    } finally {
      loading = false
    }
  }
  void load()

  // Vetted everything: today's queue picks up what was approved, so the
  // empty state can offer to review it.
  $effect(() => {
    if (!loading && !notes.length && !error) void session.refreshIfStale()
  })

  function drop(ids: string[]) {
    notes = notes.filter((n) => !ids.includes(n.id))
    status.inbox = notes.length
    if (deck && !notes.some((n) => n.deckId === deck)) deck = null
  }

  // Puts proposals back into the inbox (undo of approve / reject).
  async function restore(back: Proposal[]) {
    notes = byAge([...back, ...notes.filter((n) => !back.some((b) => b.id === n.id))])
    status.inbox = notes.length
    try {
      for (const p of back) {
        if (p.kind === 'word') words.upsert(await api.updateWord(p.id, { status: 'inbox' }))
        else facts.upsert(await api.updateFact(p.id, { status: 'inbox' }))
      }
      session.markStale()
    } catch (e) {
      showToast(`Not undone: ${errorText(e)}`)
      void load()
    }
  }

  async function decide(note: Proposal, approve: boolean) {
    const index = notes.indexOf(note)
    drop([note.id])
    haptic.impact(approve ? 'light' : 'medium')
    try {
      if (note.kind === 'word') words.upsert(await (approve ? api.approve(note.id) : api.reject(note.id)))
      else facts.upsert(await (approve ? api.approveFact(note.id) : api.rejectFact(note.id)))
      if (approve) session.markStale()
      showToast(`${approve ? 'Approved' : 'Rejected'} ${label(note)}`, { action: { label: 'Undo', run: () => void restore([note]) } })
    } catch (e) {
      notes = [...notes.slice(0, index), note, ...notes.slice(index)]
      status.inbox = notes.length
      showToast(errorText(e))
    }
  }

  async function approveAll() {
    const batch = visible.slice()
    const before = notes
    drop(batch.map((n) => n.id))
    try {
      await api.approveAll(deck ?? undefined)
      session.markStale()
      status.wordsVersion++
      status.factsVersion++
      haptic.notify('success')
      const kinds = new Set(batch.map((b) => b.kind))
      const noun = kinds.size > 1 ? 'proposal' : kinds.has('fact') ? 'card' : 'word'
      showToast(`Approved ${batch.length} ${batch.length === 1 ? noun : `${noun}s`}`, { action: { label: 'Undo', run: () => void restore(batch) } })
    } catch (e) {
      notes = before
      status.inbox = notes.length
      showToast(errorText(e))
    }
  }

  function onEnd(dir: SwipeDir | null) {
    dragging = false
    const note = top
    if (!dir || !note) {
      dx = 0
      return
    }
    leaving = true
    dx = (dir === 'right' ? 1 : -1) * (innerWidth + 80)
    setTimeout(() => {
      leaving = false
      dx = 0
      void decide(note, dir === 'right')
    }, 200)
  }

  const pull = $derived(Math.min(1, Math.abs(dx) / 110))
</script>

<div class="inbox">
  <div class="head">
    <div class="screen-title"><h1>Inbox</h1></div>
    {#if decks.length > 1}
      <div class="filters">
        <button class="chip" class:on={!deck} onclick={() => (deck = null)}>All {notes.length}</button>
        {#each decks as d (d.id)}
          <button class="chip" class:on={deck === d.id} onclick={() => (deck = d.id)}>{d.name} {d.n}</button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="stage">
    {#if loading && !notes.length}
      <div class="card skeleton" aria-label="Loading">
        <span class="skel" style="width: 45%"></span>
        <span class="skel" style="width: 70%; height: 18px; margin-top: 10px"></span>
        <span class="skel" style="width: 55%"></span>
      </div>
    {:else if error && !notes.length}
      <div class="empty">
        <Icon name="offline" size={40} stroke={1.4} />
        <p><strong>Couldn't load the inbox</strong>{error}</p>
        <button class="btn" onclick={load}><Icon name="refresh" size={18} /> Try again</button>
      </div>
    {:else if !top}
      <div class="empty">
        <Icon name="inbox" size={44} stroke={1.3} />
        <p><strong>Nothing to vet</strong>Words and cards Claude or the bot propose land here. Swipe right to approve, left to reject, tap to edit first.</p>
        {#if session.current}
          <button class="btn primary" onclick={() => navigate('/', { replace: true })}><Icon name="review" size={18} /> Review {remaining(session.queue)} {remaining(session.queue) === 1 ? 'card' : 'cards'}</button>
        {:else}
          <button class="btn" onclick={() => navigate('/add?from=/')}><Icon name="plus" size={18} stroke={2.2} /> Add a word</button>
        {/if}
      </div>
    {:else}
      {#each visible.slice(0, 3).reverse() as n, i (n.id)}
        {@const depth = Math.min(visible.length, 3) - 1 - i}
        {#if depth === 0}
          <div
            class="card top"
            class:dragging
            class:leaving
            style="transform: translateX({dx}px) rotate({dx / 40}deg)"
            role="button"
            tabindex="0"
            aria-label="Edit proposal"
            onclick={() => navigate(`/inbox/${n.id}`)}
            onkeydown={(e) => e.key === 'Enter' && navigate(`/inbox/${n.id}`)}
            use:swipe={{
              enabled: () => !leaving,
              onmove: (d) => {
                dragging = true
                dx = d
              },
              onend: onEnd,
            }}
          >
            <div class="meta">
              {#if n.createdBy === 'claude'}<span class="by">by Claude</span>{:else}<span>{n.deckName}</span>{/if}
              {#each n.tags as t (t)}<span class="tag">{t}</span>{/each}
            </div>
            <div class="content">
              {#if n.kind === 'word'}
                <WordPreview word={n.word} />
              {:else}
                <div class="q"><Markdown source={n.fact.front} /></div>
                <div class="a"><Markdown source={n.fact.back} /></div>
              {/if}
            </div>
            {#if dx > 24}
              <div class="wash ok" style="opacity:{pull * 0.55}"></div>
              <div class="stamp ok" style="opacity:{pull}"><Icon name="check" size={18} stroke={2.4} /> Approve</div>
            {/if}
            {#if dx < -24}
              <div class="wash no" style="opacity:{pull * 0.55}"></div>
              <div class="stamp no" style="opacity:{pull}"><Icon name="x" size={18} stroke={2.4} /> Reject</div>
            {/if}
          </div>
        {:else}
          <div class="card behind" style="transform: translateY({depth * 9}px) scale({1 - depth * 0.045}); opacity: {1 - depth * 0.25}"></div>
        {/if}
      {/each}
    {/if}
  </div>

  {#if top}
    <div class="actions">
      <button class="round no" class:lean={dx < -24} onclick={() => decide(top, false)} aria-label="Reject"><Icon name="x" size={26} stroke={2.2} /></button>
      <button class="round edit" onclick={() => navigate(`/inbox/${top.id}`)} aria-label="Edit"><Icon name="edit" size={22} /></button>
      <button class="round ok" class:lean={dx > 24} onclick={() => decide(top, true)} aria-label="Approve"><Icon name="check" size={28} stroke={2.2} /></button>
    </div>
    <div class="all">
      <button class="btn block" onclick={approveAll}>
        Approve all {visible.length}{deck ? ` in ${decks.find((d) => d.id === deck)?.name}` : ''}
      </button>
    </div>
  {/if}
</div>

<style>
  .inbox {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: calc(var(--sat) + 8px) calc(16px + var(--sar)) 12px calc(16px + var(--sal));
  }
  .head {
    flex: none;
  }
  .filters {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    margin: 0 -16px;
    padding: 0 16px 12px;
    scrollbar-width: none;
  }
  .filters .chip {
    height: 32px;
    padding: 0 13px;
    font-size: 14px;
    font-weight: 500;
    border-radius: 16px;
    background: var(--surface);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    transition:
      background-color var(--t-fast) ease,
      color var(--t-fast) ease;
  }
  .filters .chip.on {
    background: var(--accent);
    color: var(--accent-text);
  }
  .stage {
    flex: 1;
    min-height: 0;
    position: relative;
    margin-bottom: 14px;
  }
  .card {
    position: absolute;
    inset: 0 0 18px;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .card.top {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    touch-action: pan-y;
    transform-origin: 50% 100%;
    transition: transform var(--t-slow) var(--ease-drawer);
    cursor: pointer;
    /* The next proposal steps up from where it waited in the stack. */
    animation: step-up var(--t-base) var(--ease-out);
  }
  @keyframes step-up {
    from {
      transform: translateY(calc(var(--rise) * 0.9)) scale(calc(1 - (1 - var(--shrink)) * 1.8));
    }
  }
  .card.dragging {
    transition: none;
  }
  .card.leaving {
    transition: transform var(--t-base) var(--ease-out);
  }
  .card.behind {
    transform-origin: 50% 100%;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    transition:
      transform var(--t-base) var(--ease-out),
      opacity var(--t-base) ease;
  }
  .card.skeleton {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
    padding: 16px 20px 0;
    font-size: 13px;
    color: var(--faint);
  }
  .meta span:first-child {
    color: var(--muted);
    font-weight: 500;
  }
  .meta span + span::before {
    content: '·';
    margin-right: 6px;
    color: var(--faint);
  }
  .by {
    color: var(--accent);
    font-weight: 500;
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px 20px 24px;
  }
  /* A proposed fact: the question, then the answer as the card shows it. */
  .q {
    font-size: 19px;
    line-height: 1.38;
    font-weight: 600;
    letter-spacing: -0.012em;
  }
  .a {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 0.5px solid var(--hairline);
    font-size: 16px;
    line-height: 1.5;
  }
  .wash {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .wash.ok {
    background: linear-gradient(to right, var(--good-bg), transparent 75%);
  }
  .wash.no {
    background: linear-gradient(to left, var(--again-bg), transparent 75%);
  }
  .stamp {
    position: absolute;
    top: 14px;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 14px 0 11px;
    border-radius: 17px;
    font-weight: 650;
    pointer-events: none;
  }
  .stamp.ok {
    left: 16px;
    background: var(--good-bg);
    color: var(--good);
  }
  .stamp.no {
    right: 16px;
    background: var(--again-bg);
    color: var(--again);
  }
  .actions {
    flex: none;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 24px;
    margin-bottom: 12px;
  }
  .round {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface);
    box-shadow: var(--shadow);
    transition:
      transform var(--t-press) var(--ease-out),
      background-color var(--t-fast) ease;
  }
  .round.edit {
    width: 52px;
    height: 52px;
    color: var(--muted);
  }
  .round.no {
    color: var(--again);
  }
  .round.ok {
    color: var(--good);
  }
  .round:active {
    transform: scale(0.92);
  }
  .round.lean {
    transform: scale(1.1);
  }
  .round.ok.lean {
    background: var(--good-bg);
  }
  .round.no.lean {
    background: var(--again-bg);
  }
  .all {
    flex: none;
  }
</style>
