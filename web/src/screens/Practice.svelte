<script lang="ts">
  import { isTapType, spotTokens, type ExerciseAttempt, type FactQueueItem, type QueueItem } from '@recall/core'
  import ExerciseCard from '../components/ExerciseCard.svelte'
  import FactCard from '../components/FactCard.svelte'
  import Header from '../components/Header.svelte'
  import Icon from '../components/Icon.svelte'
  import WordCard from '../components/WordCard.svelte'
  import { api } from '../lib/app.svelte.ts'
  import { practiceStep } from '../lib/queue.ts'
  import { session } from '../lib/review.svelte.ts'
  import { back, router } from '../lib/router.svelte.ts'
  import { haptic } from '../lib/telegram.ts'
  import { errorText } from '../lib/toast.svelte.ts'

  // A practice run (`#/practice?deck=` or `?fact=`): the same cards as a
  // review, but ratings only drive this loop — Again comes back a few cards
  // later, anything else is done. Nothing reaches the schedule, the review
  // log or the outbox.
  const q = router.route.query
  const factId = q.get('fact')
  const deckId = q.get('deck') ?? session.deckId
  const title = q.get('title') ?? (factId ? 'Practice' : `Practice · ${session.decks[deckId]?.name ?? ''}`)

  let queue = $state.raw<QueueItem[]>([])
  let loaded = $state(false)
  let error = $state('')
  let revealed = $state(false)
  let done = $state(0)
  let again = $state(0)
  let round = $state(0)

  async function load() {
    error = ''
    try {
      const items = await api.practice(factId ? { fact: factId } : { deck: deckId })
      // Written items need grading: practice stays tap-only.
      queue = items.map((it) => (it.kind === 'fact' && it.exercises ? { ...it, exercises: it.exercises.filter((e) => isTapType(e.type)) } : it))
      loaded = true
    } catch (e) {
      error = errorText(e)
    }
  }
  void load()

  const item = $derived(queue[0] ?? null)
  const exercises = $derived(item?.kind === 'fact' && (item.exercises?.length ?? 0) >= 1 ? item.exercises! : null)
  const deck = $derived(item ? session.decks[item.kind === 'word' ? item.word.deckId : item.fact.deckId] : undefined)
  const langs = $derived<[string, string]>([deck?.targetLang ?? 'en', deck?.nativeLang ?? 'ru'])

  // Tap exercises, as in a review.
  let exIndex = $state(0)
  let results = $state<ExerciseAttempt[]>([])
  let tap = $state<{ pick: string | null; token: number | null; done: boolean }>({ pick: null, token: null, done: false })
  const exItem = $derived(exercises?.[exIndex] ?? null)

  function fresh() {
    revealed = false
    exIndex = 0
    results = []
    tap = { pick: null, token: null, done: false }
    round++
  }

  function record(given: string, correct: boolean) {
    if (!exItem) return
    results = [...results.slice(0, exIndex), { id: exItem.id, given, correct }]
    haptic.notify(correct ? 'success' : 'error')
  }
  function choose(o: string) {
    const ex = exItem
    if (!ex || tap.done) return
    if (ex.type === 'spot' && (tap.token === null || !spotTokens(ex.prompt, ex.wrong ?? '')[tap.token]?.wrong)) return
    tap = { ...tap, pick: o, done: true }
    record(ex.type === 'spot' ? `${ex.wrong} → ${o}` : o, o === ex.answer)
  }
  function token(i: number) {
    const ex = exItem
    if (!ex || ex.type !== 'spot' || tap.token !== null || tap.done) return
    const t = spotTokens(ex.prompt, ex.wrong ?? '')[i]
    if (!t) return
    if (t.wrong) tap = { ...tap, token: i }
    else {
      tap = { ...tap, token: i, done: true }
      record(t.text, false)
    }
  }
  function nextEx() {
    if (!exercises || !tap.done) return
    if (exIndex + 1 < exercises.length) {
      exIndex++
      tap = { pick: null, token: null, done: false }
    } else revealed = true
  }

  function reveal() {
    if (!item || revealed) return
    if (exercises) {
      if (tap.done) nextEx()
      return
    }
    revealed = true
  }

  function rate(ok: boolean) {
    if (!item || !revealed) return
    haptic.impact(ok ? 'light' : 'rigid')
    if (!ok) again++
    else done++
    queue = practiceStep(queue, ok)
    fresh()
    if (!queue.length) haptic.notify('success')
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (!revealed) reveal()
      else rate(true)
    } else if (revealed && (e.key === '1' || e.key === '3')) rate(e.key === '3')
    else if (!revealed && exItem && isTapType(exItem.type) && ['1', '2', '3', '4'].includes(e.key)) {
      const o = exItem.options?.[Number(e.key) - 1]
      if (o) choose(o)
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="practice">
  <div class="top">
    <Header {title} />
    <p class="marker"><Icon name="refresh" size={14} stroke={2} /> Practice — doesn't change the schedule</p>
  </div>

  <div class="stage">
    {#if error}
      <div class="empty">
        <Icon name="offline" size={40} stroke={1.4} />
        <p><strong>Couldn't start the practice</strong>{error}</p>
        <button class="btn" onclick={load}><Icon name="refresh" size={18} /> Try again</button>
      </div>
    {:else if !loaded}
      <div class="skel card-skel" aria-label="Loading"></div>
    {:else if item}
      {#key `${item.card.id}:${round}`}
        <div class="card-wrap" role="button" tabindex="-1" onclick={reveal} onkeydown={() => {}} aria-label={revealed ? 'Card' : 'Show answer'}>
          {#if item.kind === 'fact' && exercises}
            <ExerciseCard item={item as FactQueueItem} index={exIndex} {results} check={null} given="" {tap} {revealed} onchoose={choose} ontoken={token} />
          {:else if item.kind === 'fact'}
            <FactCard {item} {revealed} />
          {:else}
            <WordCard {item} {revealed} {langs} />
          {/if}
        </div>
      {/key}
    {:else}
      <div class="end">
        <svg class="mark" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="27" /><path d="M17 29l7.5 7.5L39.5 21" /></svg>
        <h2>{done ? 'Practice done' : 'Nothing to practise'}</h2>
        <p class="muted">{done ? `${done} ${done === 1 ? 'card' : 'cards'}${again ? ` · ${again} again` : ''}. The schedule is as it was.` : 'No hard cards here yet — they show up once you have reviewed a while.'}</p>
        <button class="btn primary" onclick={() => back()}>Done</button>
      </div>
    {/if}
  </div>

  {#if item}
    <div class="actions">
      {#if !revealed}
        {#if exercises}
          <button class="show" onclick={nextEx} disabled={!tap.done}>{tap.done ? (exIndex + 1 < exercises.length ? 'Next' : 'Done') : exItem?.type === 'spot' ? 'Tap the wrong word' : 'Tap the right option'}</button>
        {:else}
          <button class="show" onclick={reveal}>Show answer</button>
        {/if}
      {:else}
        <div class="bar">
          <button class="rate again" onclick={() => rate(false)}><span>Again</span><small>a few cards later</small></button>
          <button class="rate good" onclick={() => rate(true)}><span>Got it</span><small>done</small></button>
        </div>
      {/if}
      <p class="left">{queue.length} left{again ? ` · ${again} again` : ''}</p>
    </div>
  {/if}
</div>

<style>
  .practice {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 0 calc(12px + var(--sar)) 0 calc(12px + var(--sal));
  }
  .top {
    flex: none;
  }
  .marker {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: -6px 4px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
  }
  .stage {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .card-wrap {
    position: absolute;
    inset: 0;
    animation: step-up var(--t-base) var(--ease-out);
  }
  @keyframes step-up {
    from {
      opacity: 0;
      transform: translate3d(0, 5px, 0) scale(0.97);
    }
  }
  .card-skel {
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
  }
  .end {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    text-align: center;
    padding: 0 24px;
    animation: fade-in var(--t-base) ease;
  }
  .end h2 {
    margin: 6px 0 0;
  }
  .end .muted {
    margin: 0 0 12px;
  }
  .mark circle {
    fill: var(--accent-soft);
    stroke: none;
  }
  .mark path {
    fill: none;
    stroke: var(--accent);
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .actions {
    flex: none;
    padding: 12px 0 14px;
  }
  .show {
    width: 100%;
    height: 66px;
    border-radius: 18px;
    background: var(--surface);
    font-weight: 600;
    font-size: 17px;
    box-shadow: var(--shadow);
  }
  .show:disabled {
    color: var(--muted);
    font-weight: 500;
    font-size: 15px;
  }
  .bar {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .rate {
    height: 66px;
    border-radius: 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    font-weight: 650;
    font-size: 16px;
    transition: transform var(--t-press) var(--ease-out);
  }
  .rate:active {
    transform: scale(0.95);
  }
  .rate small {
    font-size: 12px;
    font-weight: 500;
    opacity: 0.75;
  }
  .rate.again {
    color: var(--again);
    background: var(--again-bg);
  }
  .rate.good {
    color: var(--good);
    background: var(--good-bg);
  }
  .left {
    margin: 8px 0 0;
    text-align: center;
    font-size: 12.5px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
</style>
