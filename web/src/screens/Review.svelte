<script lang="ts">
  import { checkAnswer, checkExercise, exerciseRating, formatInterval, isTapType, preview, spotTokens, type AnswerCheck, type ExerciseAttempt, type ExerciseCheck, type Rating } from '@recall/core'
  import { flushSync, onMount, untrack } from 'svelte'
  import AddPicker from '../components/AddPicker.svelte'
  import DeckSwitcher from '../components/DeckSwitcher.svelte'
  import ExerciseCard from '../components/ExerciseCard.svelte'
  import ReviewFilterSheet from '../components/ReviewFilterSheet.svelte'
  import { filterSummary } from '../lib/reviewFilter.ts'
  import FactCard from '../components/FactCard.svelte'
  import Icon from '../components/Icon.svelte'
  import RatingBar from '../components/RatingBar.svelte'
  import Summary from '../components/Summary.svelte'
  import SyncPill from '../components/SyncPill.svelte'
  import WordCard from '../components/WordCard.svelte'
  import { dropCard } from '../lib/drop.ts'
  import { fsrs } from '../lib/fsrs.ts'
  import { counts, remaining } from '../lib/queue.ts'
  import { session } from '../lib/review.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { defaultThreshold, swipe, type Axis, type SwipeDir } from '../lib/swipe.ts'
  import { haptic } from '../lib/telegram.ts'

  const c = $derived(counts(session.queue))
  const done = $derived(session.stats.reviewed)
  const progress = $derived(done + remaining(session.queue) ? done / (done + remaining(session.queue)) : 0)
  const item = $derived(session.current)
  // Remounts the card even when the same card comes straight back.
  const cardKey = $derived(item ? `${item.card.id}:${session.stats.reviewed}:${session.history.length}` : '')

  // Swipe → rating. Right is the everyday answer, so it gets the easiest
  // gesture; down is "drop it", up is "too easy".
  const byDir: Record<SwipeDir, Rating> = { right: 3, left: 2, down: 1, up: 4 }
  const names: Record<Rating, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' }
  const tone: Record<Rating, string> = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }

  const deck = $derived(item ? session.deckOf(item) : undefined)
  const langs = $derived<[string, string]>([deck?.targetLang ?? 'en', deck?.nativeLang ?? 'ru'])
  // Typed answers: the deck asks for them on RU→EN cards, or on both
  // (forward then means typing the main translation). Never on facts.
  const typed = $derived(
    item?.kind === 'word' && (deck?.typeAnswer === 'both' || (deck?.typeAnswer === 'reverse' && item.card.direction === 'reverse')),
  )
  // The deck under review, its filter sheet, the "+" picker.
  const currentDeck = $derived(session.decks[session.deckId])
  let filterOpen = $state(false)
  let addOpen = $state(false)
  const LANG_NAMES: Record<string, string> = { en: 'English', ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish' }
  const placeholder = $derived(
    item?.card.direction === 'reverse' ? `Type it in ${LANG_NAMES[langs[0]] ?? langs[0].toUpperCase()}` : `Type the ${LANG_NAMES[langs[1]] ?? ''} translation`,
  )
  let answer = $state('')
  let check = $state<AnswerCheck | null>(null)
  let input: HTMLInputElement | undefined = $state()
  // A rule with exercises: three items to type, checked one by one, then a
  // summary whose rating comes from the results.
  const exercises = $derived(item?.kind === 'fact' && item.exercises?.length ? item.exercises : null)
  let exIndex = $state(0)
  let exResults = $state<ExerciseAttempt[]>([])
  let exCheck = $state<ExerciseCheck | null>(null)
  let exAnswer = $state('')
  let exInput: HTMLInputElement | undefined = $state()
  const exTyping = $derived(!!exercises && !session.revealed)
  // The current item, and for tap items (choose, spot) their state: the
  // option picked, the token tapped, done.
  const exItem = $derived(exercises?.[exIndex] ?? null)
  const exTap = $derived(!!exItem && isTapType(exItem.type))
  let tap = $state<{ pick: string | null; token: number | null; done: boolean }>({ pick: null, token: null, done: false })
  const exAnswered = $derived(exTap ? tap.done : !!exCheck)
  // The rating to take on Enter / one tap: the typed answer's, or the exercises'.
  const suggested = $derived<Rating | null>(exercises ? (exResults.length ? exerciseRating(exResults) : null) : check?.suggestedRating ?? null)

  // A new card (or the same one back) starts with an empty answer. Back
  // after an undo, an exercise card shows how its items went.
  $effect.pre(() => {
    void cardKey
    answer = ''
    check = null
    exIndex = 0
    exCheck = null
    exAnswer = ''
    tap = { pick: null, token: null, done: false }
    exResults = untrack(() => {
      const cur = session.current
      return cur && session.revealed ? [...(session.exerciseResults[cur.card.id] ?? [])] : []
    })
  })

  function checkItem() {
    const ex = exercises?.[exIndex]
    if (!ex || exCheck) return
    exCheck = checkExercise(exAnswer, ex)
    exResults = [...exResults.slice(0, exIndex), { id: ex.id, given: exAnswer.trim(), correct: exCheck.correct }]
    haptic.notify(exCheck.correct ? 'success' : 'error')
  }

  // Next item, or the summary after the last one.
  function nextItem() {
    if (!exercises || !exAnswered) return
    if (exIndex + 1 < exercises.length) {
      exIndex++
      exCheck = null
      exAnswer = ''
      tap = { pick: null, token: null, done: false }
      if (!exTap) flushSync()
      if (exercises[exIndex] && !isTapType(exercises[exIndex]!.type)) exInput?.focus()
    } else session.reveal()
  }

  function record(given: string, correct: boolean) {
    const ex = exItem
    if (!ex) return
    exResults = [...exResults.slice(0, exIndex), { id: ex.id, given, correct }]
    haptic.notify(correct ? 'success' : 'error')
  }

  // choose: the option; spot: the replacement, once the mistake is found.
  function chooseOption(o: string) {
    const ex = exItem
    if (!ex || tap.done) return
    if (ex.type === 'spot' && (tap.token === null || !spotTokens(ex.prompt, ex.wrong ?? '')[tap.token]?.wrong)) return
    tap = { ...tap, pick: o, done: true }
    record(ex.type === 'spot' ? `${ex.wrong} → ${o}` : o, o === ex.answer)
  }

  // spot: a tap on the mistake asks for the replacement; anywhere else is a miss.
  function tapToken(i: number) {
    const ex = exItem
    if (!ex || ex.type !== 'spot' || tap.token !== null || tap.done) return
    const t = spotTokens(ex.prompt, ex.wrong ?? '')[i]
    if (!t) return
    if (t.wrong) {
      tap = { ...tap, token: i }
      haptic.select()
    } else {
      tap = { ...tap, token: i, done: true }
      record(t.text, false)
    }
  }

  // "I was right": counted as right, and the item is marked for a look.
  function overrule() {
    const r = exResults[exIndex]
    if (!r || r.correct) return
    exResults = exResults.map((x, i) => (i === exIndex ? { ...x, correct: true, overridden: true } : x))
    exCheck = exCheck && { ...exCheck, correct: true }
  }

  // "Bad item": out of the pool, not graded.
  function badItem() {
    const r = exResults[exIndex]
    if (!r) return
    exResults = exResults.map((x, i) => (i === exIndex ? { ...x, bad: true } : x))
    haptic.select()
  }

  function onExerciseKey(e: KeyboardEvent) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (!exCheck) checkItem()
    else nextItem()
  }

  const commit = (r: Rating) => session.rate(r, exercises && exResults.length ? { exercises: exResults } : {})

  const intervals = $derived.by(() => {
    if (!item) return null
    const now = new Date()
    const p = preview(item.card.schedule, now, fsrs())
    return { 1: formatInterval(now, p[1]), 2: formatInterval(now, p[2]), 3: formatInterval(now, p[3]), 4: formatInterval(now, p[4]) } as Record<Rating, string>
  })

  let dx = $state(0)
  let dy = $state(0)
  let axis = $state<Axis | null>(null)
  let leaving = $state<SwipeDir | null>(null)
  let dragging = $state(false)
  let stageWidth = $state(390)
  let stageHeight = $state(600)
  let wrap: HTMLElement | undefined = $state()

  // The gesture legend shows until a few swipes have landed.
  const HINT_KEY = 'swipeHintsLeft'
  let hintsLeft = $state(readHints())
  function readHints() {
    try {
      const v = localStorage.getItem(HINT_KEY)
      return v === null ? 5 : Number(v) || 0
    } catch {
      return 5
    }
  }
  function usedSwipe() {
    if (hintsLeft <= 0) return
    hintsLeft--
    try {
      localStorage.setItem(HINT_KEY, String(hintsLeft))
    } catch {
      // Storage unavailable; the legend just shows a little longer.
    }
  }

  onMount(() => {
    void session.refreshIfStale()
  })

  function rate(r: Rating) {
    if (leaving) return
    if (!commit(r)) return
    // Render the next card now, still inside the tap, so focusing its answer
    // field keeps the iOS keyboard up instead of dropping and reopening it.
    flushSync()
    if (typed) input?.focus()
    else if (exercises && !session.revealed) exInput?.focus()
  }

  function reveal() {
    if (!item || session.revealed) return
    const c = typed && item.kind === 'word' ? checkAnswer(answer, item.word, item.card.direction) : null
    session.reveal()
    if (!session.revealed) return
    check = c
    if (c) haptic.notify(c.verdict === 'exact' ? 'success' : c.verdict === 'close' ? 'warning' : 'error')
  }

  // Enter: check the answer, then take the suggested rating.
  function onAnswerKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!session.revealed) reveal()
      else rate(suggested ?? 3)
    } else if (session.revealed && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault()
      rate(Number(e.key) as Rating)
    }
  }

  function tapCard() {
    if (exTyping && exTap) {
      if (tap.done) nextItem()
    } else if (exTyping) exInput?.focus()
    else if (typed && !session.revealed) input?.focus()
    else reveal()
  }

  const dist = $derived(axis === 'y' ? dy : dx)
  const dir = $derived<SwipeDir | null>(
    !axis || Math.abs(dist) < 16 ? null : axis === 'x' ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up',
  )
  const lean = $derived<Rating | null>(dir ? byDir[dir] : null)
  // Same distance swipe.ts commits at; crossing it ticks once.
  const threshold = $derived(defaultThreshold(axis, stageWidth, stageHeight))
  const pull = $derived(Math.min(1, Math.abs(dist) / threshold))
  const armed = $derived(dragging && Math.abs(dist) > threshold)
  let wasArmed = false
  $effect(() => {
    if (armed && !wasArmed) haptic.select()
    wasArmed = armed
  })

  const transform = $derived(axis === 'y' ? `translateY(${dy}px)` : `translateX(${dx}px) rotate(${dx / 36}deg)`)

  function onSwipeEnd(d: SwipeDir | null) {
    dragging = false
    if (!d || !session.revealed) {
      dx = dy = 0
      return
    }
    leaving = d
    if (d === 'left' || d === 'right') dx = (d === 'right' ? 1 : -1) * (innerWidth + 80)
    else dy = (d === 'down' ? 1 : -1) * (innerHeight + 80)
    usedSwipe()
    setTimeout(() => {
      leaving = null
      dx = dy = 0
      axis = null
      commit(byDir[d])
    }, 200)
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (exTyping && exTap) {
        if (tap.done) nextItem()
      } else if (exTyping) {
        if (exCheck && e.key === 'Enter') nextItem()
        else exInput?.focus()
      } else if (!session.revealed) {
        if (typed) input?.focus()
        else reveal()
      } else rate(suggested ?? 3)
    } else if (exTyping && exTap && ['1', '2', '3', '4'].includes(e.key)) {
      const o = exItem?.options?.[Number(e.key) - 1]
      if (o) chooseOption(o)
    } else if (session.revealed && ['1', '2', '3', '4'].includes(e.key)) {
      rate(Number(e.key) as Rating)
    } else if (e.key === 'z' || e.key === 'u' || e.key === 'Backspace') {
      session.undo()
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="review">
  <header>
    <div class="counts" aria-label="{c.new} new, {c.learning} learning, {c.review} to review">
      <span class:zero={!c.new}><b class="n">{c.new}</b> new</span>
      <span class:zero={!c.learning}><b class="l">{c.learning}</b> learning</span>
      <span class:zero={!c.review}><b class="r">{c.review}</b> due</span>
    </div>
    <div class="right">
      <SyncPill />
      <button class="add" onclick={() => (addOpen = true)} aria-label="Add a card"><Icon name="plus" size={20} stroke={2.2} /></button>
    </div>
  </header>
  {#if session.queueDecks.length}
    <div class="deckbar">
      <div class="switch-wrap">
        <DeckSwitcher options={session.choices.map((d) => ({ id: d.id, name: d.name, n: d.left }))} selected={session.deckId} onselect={(id) => session.selectDeck(id)} />
      </div>
      <button class="filter-btn" class:on={!!session.filter} onclick={() => (filterOpen = true)} aria-label="What to review">
        <Icon name="filter" size={18} stroke={2} />
      </button>
    </div>
    {#if session.filter}
      <div class="fsum">
        <span>{filterSummary(session.filter, [currentDeck?.targetLang ?? null, currentDeck?.nativeLang ?? null])}</span>
        <button onclick={() => session.setFilter(null)}>Clear</button>
      </div>
    {/if}
  {/if}
  {#if filterOpen && session.deckId}
    <ReviewFilterSheet
      deckId={session.deckId}
      deckName={currentDeck?.name ?? ''}
      langs={[currentDeck?.targetLang ?? null, currentDeck?.nativeLang ?? null]}
      initial={session.filter}
      onsave={(f) => session.setFilter(f)}
      onclose={() => (filterOpen = false)}
    />
  {/if}
  {#if addOpen}<AddPicker deck={currentDeck} from="/" onclose={() => (addOpen = false)} />{/if}
  <div class="progress" aria-hidden="true"><div style="transform: scaleX({progress})"></div></div>

  <div class="stage" bind:clientWidth={stageWidth} bind:clientHeight={stageHeight}>
    {#if item}
      {#key cardKey}
        <div
          class="card-wrap"
          class:dragging
          class:leaving
          bind:this={wrap}
          style="transform: {transform}"
          role="button"
          tabindex="-1"
          aria-label={session.revealed ? 'Card' : typed || exTyping ? 'Card, type the answer below' : 'Show answer'}
          onclick={tapCard}
          onkeydown={() => {}}
          use:swipe={{
            axes: 'xy',
            enabled: () => session.revealed && !leaving,
            scroller: () => wrap?.querySelector<HTMLElement>('.card .body'),
            onmove: (x, y, a) => {
              dragging = true
              axis = a
              dx = x
              dy = y
            },
            onend: onSwipeEnd,
          }}
        >
          {#if item.kind === 'fact' && exercises}
            <ExerciseCard
              {item}
              index={exIndex}
              results={exResults}
              check={exCheck}
              given={exAnswer}
              {tap}
              revealed={session.revealed}
              onchoose={chooseOption}
              ontoken={tapToken}
              onbad={badItem}
              onedit={() => navigate(`/fact/${item.fact.id}?from=/`)}
              ondrop={() => void dropCard('fact', item.fact.id, item.fact.front)}
            />
          {:else if item.kind === 'fact'}
            <FactCard {item} revealed={session.revealed} onedit={() => navigate(`/fact/${item.fact.id}?from=/`)} ondrop={() => void dropCard('fact', item.fact.id, item.fact.front)} />
          {:else}
            <WordCard {item} revealed={session.revealed} typed={answer} {check} {langs} onedit={() => navigate(`/word/${item.word.id}?from=/`)} ondrop={() => void dropCard('word', item.word.id, item.word.term)} />
          {/if}
          {#if dir && lean && intervals}
            <div class="wash {dir} {tone[lean]}" style="opacity: {pull * 0.6}"></div>
            <div class="swipe-hint {dir} {tone[lean]}" class:armed style="opacity: {0.35 + pull * 0.65}; --pull: {pull}">
              <span class="what"><b>{names[lean]}</b> {intervals[lean]}</span>
              <span class="track"><span></span></span>
            </div>
          {/if}
          {#if session.revealed && hintsLeft > 0 && !dragging && !leaving}
            <div class="legend" aria-hidden="true">
              <span><Icon name="arrow" size={13} stroke={2.2} /> Hard</span>
              <span class="to-r"><Icon name="arrow" size={13} stroke={2.2} /> Good</span>
              <span class="to-d"><Icon name="arrow" size={13} stroke={2.2} /> Again</span>
              <span class="to-u"><Icon name="arrow" size={13} stroke={2.2} /> Easy</span>
            </div>
          {/if}
        </div>
      {/key}
    {:else}
      <Summary />
    {/if}
  </div>

  {#if item}
    <div class="actions">
      {#if typed}
        <!-- Stays mounted (and focused) across typed cards so the keyboard
             doesn't drop between them; after the check it steps out of view
             but keeps the focus, and Enter takes the suggested rating. -->
        <form class="type-row" class:gone={session.revealed} onsubmit={(e) => e.preventDefault()}>
          <button type="button" class="undo small" onclick={() => session.undo()} onmousedown={(e) => e.preventDefault()} disabled={!session.canUndo} aria-label="Undo last rating">
            <Icon name="undo" size={20} />
          </button>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:this={input}
            bind:value={answer}
            maxlength="500"
            onkeydown={onAnswerKey}
            {placeholder}
            lang={item.card.direction === 'reverse' ? langs[0] : langs[1]}
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            enterkeyhint="done"
            aria-label={placeholder}
            autofocus
          />
          <button type="button" class="check" onclick={reveal} onmousedown={(e) => e.preventDefault()}>{answer.trim() ? 'Check' : "Don't know"}</button>
        </form>
      {/if}
      {#if exTyping && exTap}
        <!-- Tap items are answered on the card; here: undo before, Next after. -->
        <div class="pre">
          {#if tap.done}
            <button class="show next" onclick={nextItem}>{exIndex + 1 < (exercises?.length ?? 0) ? 'Next' : 'Done'}</button>
          {:else}
            <button class="undo" onclick={() => session.undo()} disabled={!session.canUndo} aria-label="Undo last rating">
              <Icon name="undo" size={22} />
            </button>
            <p class="tap-hint">{exItem?.type === 'spot' ? (tap.token === null ? 'Tap the wrong word' : 'Pick the right form') : 'Tap the right option'}</p>
          {/if}
        </div>
      {:else if exTyping}
        <form class="type-row" onsubmit={(e) => e.preventDefault()}>
          {#if exCheck}
            {#if !exCheck.correct && !exResults[exIndex]?.overridden && exResults[exIndex]?.given}
              <button type="button" class="soft" onclick={overrule} onmousedown={(e) => e.preventDefault()}>I was right</button>
            {/if}
            <button type="button" class="check grow" onclick={nextItem} onmousedown={(e) => e.preventDefault()}>{exIndex + 1 < (exercises?.length ?? 0) ? 'Next' : 'Done'}</button>
          {:else}
            <button type="button" class="undo small" onclick={() => session.undo()} onmousedown={(e) => e.preventDefault()} disabled={!session.canUndo} aria-label="Undo last rating">
              <Icon name="undo" size={20} />
            </button>
          {/if}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class:gone={!!exCheck}
            bind:this={exInput}
            bind:value={exAnswer}
            maxlength="500"
            onkeydown={onExerciseKey}
            placeholder={exercises?.[exIndex]?.type === 'fix' ? 'Type the corrected sentence' : 'Type the answer'}
            lang="en"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            enterkeyhint={exCheck ? 'next' : 'done'}
            aria-label="Your answer"
            readonly={!!exCheck}
            autofocus
          />
          {#if !exCheck}
            <button type="button" class="check" onclick={checkItem} onmousedown={(e) => e.preventDefault()}>{exAnswer.trim() ? 'Check' : "Don't know"}</button>
          {/if}
        </form>
      {:else if session.revealed}
        <RatingBar state={item.card.schedule} onrate={rate} {lean} {suggested} keepFocus={typed} {intervals} />
      {:else if !typed}
        <div class="pre">
          <button class="undo" onclick={() => session.undo()} disabled={!session.canUndo} aria-label="Undo last rating">
            <Icon name="undo" size={22} />
          </button>
          <button class="show" onclick={reveal}>Show answer</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .review {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: var(--sat) calc(12px + var(--sar)) 0 calc(12px + var(--sal));
    -webkit-user-select: none;
    user-select: none;
  }
  header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 40px;
    padding: 0 8px;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* A 34px disc in a 44px target. */
  .add {
    width: 44px;
    height: 44px;
    padding: 5px;
    border-radius: 22px;
    background-clip: content-box;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    background-color: var(--accent-soft);
    margin: -2px -9px -2px 0;
    transition: transform var(--t-press) var(--ease-out);
  }
  .add:active {
    transform: scale(0.92);
  }
  .counts {
    display: flex;
    gap: 12px;
    font-size: 13px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .counts b {
    font-size: 15px;
    font-weight: 650;
    margin-right: 1px;
  }
  .zero,
  .zero b {
    color: var(--faint);
  }
  .n {
    color: var(--c-new);
  }
  .l {
    color: var(--c-learn);
  }
  .r {
    color: var(--c-review);
  }
  /* The deck switcher and the filter: one row under the counts. */
  .deckbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
    min-height: 36px;
  }
  .switch-wrap {
    flex: 1;
    min-width: 0;
    padding-left: 4px;
  }
  .filter-btn {
    flex: none;
    width: 40px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    color: var(--muted);
    background: var(--surface);
  }
  .filter-btn.on {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .fsum {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: -2px 8px 8px;
    font-size: 13px;
    color: var(--accent);
  }
  .fsum span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fsum button {
    flex: none;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    padding: 4px 2px;
  }
  .progress {
    flex: none;
    height: 3px;
    margin: 0 8px 10px;
    border-radius: 2px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .progress div {
    height: 100%;
    border-radius: 2px;
    background: var(--accent);
    transform-origin: left;
    transition: transform var(--t-slow) var(--ease-out);
  }
  .stage {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .card-wrap {
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
    touch-action: pan-y;
    /* Let go: settles back like a drawer. */
    transition: transform var(--t-slow) var(--ease-drawer);
    animation: rise var(--t-base) var(--ease-out);
    -webkit-user-select: text;
    user-select: text;
    cursor: default;
  }
  .card-wrap.dragging {
    transition: none;
  }
  .card-wrap.leaving {
    transition: transform var(--t-base) var(--ease-out);
  }

  /* Swipe feedback: a wash of the rating's colour from the edge the card
     leaves by, and the rating that will fire with its interval. */
  .again {
    --c: var(--again);
    --cb: var(--again-bg);
  }
  .hard {
    --c: var(--hard);
    --cb: var(--hard-bg);
  }
  .good {
    --c: var(--good);
    --cb: var(--good-bg);
  }
  .easy {
    --c: var(--easy);
    --cb: var(--easy-bg);
  }
  .wash {
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
    pointer-events: none;
  }
  .wash.right {
    background: linear-gradient(to right, var(--cb), transparent 75%);
  }
  .wash.left {
    background: linear-gradient(to left, var(--cb), transparent 75%);
  }
  .wash.down {
    background: linear-gradient(to bottom, var(--cb), transparent 70%);
  }
  .wash.up {
    background: linear-gradient(to top, var(--cb), transparent 70%);
  }
  .swipe-hint {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    padding: 8px 14px 9px;
    border-radius: 16px;
    color: var(--c);
    background: var(--cb);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    pointer-events: none;
    white-space: nowrap;
    transform: scale(calc(0.9 + var(--pull) * 0.1));
    transition: transform var(--t-fast) var(--ease-out);
  }
  .swipe-hint.armed {
    transform: scale(1.08);
  }
  .swipe-hint.right {
    top: 16px;
    left: 16px;
    transform-origin: left top;
  }
  .swipe-hint.left {
    top: 16px;
    right: 16px;
    transform-origin: right top;
  }
  .swipe-hint.down {
    top: 16px;
    left: 50%;
    translate: -50% 0;
    transform-origin: center top;
  }
  .swipe-hint.up {
    bottom: 16px;
    left: 50%;
    translate: -50% 0;
    transform-origin: center bottom;
  }
  .what {
    font-size: 14px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .what b {
    font-size: 16px;
    font-weight: 650;
    margin-right: 4px;
  }
  /* Fills to the commit threshold. */
  .track {
    width: 100%;
    height: 3px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--c) 22%, transparent);
    overflow: hidden;
  }
  .track span {
    display: block;
    height: 100%;
    background: var(--c);
    transform-origin: left;
    transform: scaleX(var(--pull));
  }

  .legend {
    position: absolute;
    left: 50%;
    bottom: 10px;
    translate: -50% 0;
    display: flex;
    gap: 12px;
    padding: 5px 12px;
    border-radius: 13px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    pointer-events: none;
    animation: fade-in var(--t-base) ease 400ms both;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .legend :global(svg) {
    transform: rotate(-90deg);
  }
  .legend .to-r :global(svg) {
    transform: rotate(90deg);
  }
  .legend .to-d :global(svg) {
    transform: rotate(180deg);
  }
  .legend .to-u :global(svg) {
    transform: none;
  }

  .actions {
    flex: none;
    position: relative;
    padding: 12px 0 14px;
  }
  /* With the keyboard up there's no tab bar: keep the bar clear of the keys. */
  :global(:root[data-keyboard]) .actions {
    padding-bottom: 8px;
  }
  .type-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 66px;
  }
  .type-row.gone {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .type-row input {
    flex: 1;
    min-width: 0;
    height: 66px;
    padding: 0 16px;
    border-radius: 18px;
    font-size: 19px;
    background: var(--surface);
    border-color: transparent;
    box-shadow: var(--shadow);
  }
  .type-row input:focus {
    border-color: var(--accent);
    box-shadow: var(--shadow), 0 0 0 3px var(--accent-ring);
  }
  .check {
    flex: none;
    height: 66px;
    min-width: 88px;
    padding: 0 16px;
    border-radius: 18px;
    font-weight: 600;
    font-size: 16px;
    color: var(--accent-text);
    background: var(--accent);
    transition: transform var(--t-press) var(--ease-out);
  }
  .check:active {
    transform: scale(0.97);
  }
  .check.grow {
    flex: 1;
  }
  .tap-hint {
    flex: 1;
    margin: 0;
    align-self: center;
    text-align: center;
    font-size: 15px;
    color: var(--faint);
  }
  .show.next {
    color: var(--accent-text);
    background: var(--accent);
  }
  /* Checked: the field steps out of view but keeps the focus (and the keyboard). */
  .type-row input.gone {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .soft {
    flex: none;
    height: 66px;
    padding: 0 16px;
    border-radius: 18px;
    font-weight: 600;
    font-size: 15px;
    color: var(--text);
    background: var(--surface);
    transition: transform var(--t-press) var(--ease-out);
  }
  .soft:active {
    transform: scale(0.97);
  }
  .undo.small {
    width: 52px;
  }
  .pre {
    display: flex;
    gap: 8px;
  }
  .undo {
    width: 66px;
    height: 66px;
    border-radius: 18px;
    background: var(--surface);
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    transition:
      transform var(--t-press) var(--ease-out),
      opacity var(--t-fast) ease;
  }
  .undo:disabled {
    opacity: 0.35;
  }
  .show {
    flex: 1;
    height: 66px;
    border-radius: 18px;
    background: var(--surface);
    font-weight: 600;
    font-size: 17px;
    letter-spacing: -0.01em;
    box-shadow: var(--shadow);
    transition: transform var(--t-press) var(--ease-out);
  }
  .show:active,
  .undo:active:not(:disabled) {
    transform: scale(0.97);
  }
</style>
