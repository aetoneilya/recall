<script lang="ts">
  import { exerciseRating, formatInterval, isTapType, preview, spotTokens, type ExerciseAttempt, type Rating } from '@recall/core'
  import { onMount, untrack } from 'svelte'
  import DeckSwitcher from '../components/DeckSwitcher.svelte'
  import ExerciseCard from '../components/ExerciseCard.svelte'
  import ReviewFilterSheet from '../components/ReviewFilterSheet.svelte'
  import { filterChips } from '../lib/reviewFilter.ts'
  import FactCard from '../components/FactCard.svelte'
  import Icon from '../components/Icon.svelte'
  import RatingBar from '../components/RatingBar.svelte'
  import Summary from '../components/Summary.svelte'
  import SyncPill from '../components/SyncPill.svelte'
  import WordCard from '../components/WordCard.svelte'
  import { dropCard } from '../lib/drop.ts'
  import { fsrs } from '../lib/fsrs.ts'
  import { counts, remaining } from '../lib/queue.ts'
  import { coach } from '../lib/coach.svelte.ts'
  import { session, type ExerciseProgress } from '../lib/review.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { defaultThreshold, dirOf, dominantAxis, swipe, type SwipeDir } from '../lib/swipe.ts'
  import { BUTTON_SPEED, canArm, dragRise, dragScale, nextArmedDir, nextPose, PEEK_HOLD_MS, PEEK_SAFE_MS, peekReveals, plan, reducedMotion, releaseDir, releaseOutcome, snapMs, THROW_EASE, tilt, tiltOrigin } from '../lib/throw.ts'
  import { shortcutsOff } from '../lib/keys.ts'
  import { haptic } from '../lib/telegram.ts'

  const c = $derived(counts(session.queue))
  // The deck's own progress: ratings in other decks aren't part of this queue.
  const done = $derived(session.doneHere)
  // Stack edges: two with three or more cards left, one with two, none on the last.
  const layers = $derived(Math.min(2, Math.max(0, remaining(session.queue) - 1)))
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
  // The deck under review, its filter sheet, the "+" picker.
  const currentDeck = $derived(session.decks[session.deckId])
  let filterOpen = $state(false)
  const chips = $derived(filterChips(session.filter, [currentDeck?.targetLang ?? null, currentDeck?.nativeLang ?? null]))
  // Cached queues can still contain older text exercises; study stays tap-only.
  const exercises = $derived.by(() => {
    if (item?.kind !== 'fact' || !item.exercises?.length) return null
    const list = item.exercises.filter((e) => isTapType(e.type))
    return list.length ? list : null
  })
  let exIndex = $state(0)
  let exResults = $state<ExerciseAttempt[]>([])
  const exercising = $derived(!!exercises && !session.revealed)
  // The current item, and for tap items (choose, spot) their state: the
  // option picked, the token tapped, done.
  const exItem = $derived(exercises?.[exIndex] ?? null)
  let tap = $state<{ pick: string | null; token: number | null; done: boolean }>({ pick: null, token: null, done: false })
  // The rating suggested by the exercise results.
  const suggested = $derived<Rating | null>(exResults.length ? exerciseRating(exResults) : null)

  // A new card starts fresh; Undo restores the exercise results.
  $effect.pre(() => {
    void cardKey
    exIndex = 0
    tap = { pick: null, token: null, done: false }
    // Back from the theory (or any screen) to a rule half answered: where it
    // was; on its summary, with the results it was answered with.
    untrack(() => {
      const cur = session.current
      const p = cur?.kind === 'fact' && progressFits(session.exerciseProgress[cur.card.id], exercises ?? undefined) ? session.exerciseProgress[cur.card.id] : undefined
      exResults = cur && session.revealed ? [...(session.exerciseResults[cur.card.id] ?? p?.results ?? [])] : []
      if (!p || session.revealed) return
      exIndex = p.index
      exResults = [...p.results]
      tap = { ...p.tap }
    })
  })

  // Whether saved progress is of the items the card shows now.
  function progressFits(p: ExerciseProgress | undefined, list: { id: string }[] | undefined): p is ExerciseProgress {
    return !!p && p.ids.join() === (list ?? []).map((e) => e.id).join()
  }

  // Kept in the session as it goes, so leaving the card doesn't lose it.
  $effect(() => {
    const cur = item
    if (cur?.kind !== 'fact' || !exercises) return
    const started = exIndex > 0 || exResults.length > 0 || tap.token !== null
    const p = { ids: exercises.map((e) => e.id), index: exIndex, results: $state.snapshot(exResults), tap: $state.snapshot(tap) }
    untrack(() => {
      if (started) session.exerciseProgress[cur.card.id] = p as ExerciseProgress
    })
  })

  // Next item, or the summary after the last one.
  function nextItem() {
    clearTimeout(autoNext)
    if (!exercises || !tap.done) return
    if (exIndex + 1 < exercises.length) {
      exIndex++
      tap = { pick: null, token: null, done: false }
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
    // Right: on to the next one by itself (a tap meanwhile goes at once).
    if (o === ex.answer) autoNext = setTimeout(nextItem, 450)
  }
  let autoNext: ReturnType<typeof setTimeout> | undefined

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
  }

  // "Bad item": out of the pool, not graded.
  function badItem() {
    const r = exResults[exIndex]
    if (!r) return
    exResults = exResults.map((x, i) => (i === exIndex ? { ...x, bad: true } : x))
    haptic.select()
  }

  const commit = (r: Rating) => session.rate(r, exercises && exResults.length ? { exercises: exResults } : {})

  const intervals = $derived.by(() => {
    if (!item) return null
    const now = new Date()
    const p = preview(item.card.schedule, now, fsrs())
    return { 1: formatInterval(now, p[1]), 2: formatInterval(now, p[2]), 3: formatInterval(now, p[3]), 4: formatInterval(now, p[4]) } as Record<Rating, string>
  })

  // The drag's offset: free in 2D, no axis lock (lib/swipe.ts).
  let dx = $state(0)
  let dy = $state(0)
  let dragging = $state(false)
  // Released short of the threshold: settling back over this many ms.
  let snapping = $state(0)
  // Grabbed in the lower half: the card pivots around the thumb.
  let grabbedLow = $state(true)
  // The direction armed past its threshold (the pill lit), or null.
  let armed = $state<SwipeDir | null>(null)
  // Where a drag starting mid snap-back continues from.
  let base = { x: 0, y: 0 }
  // The pose the next card steps up from once it is on top: the stacked
  // pose, or wherever the drag had already eased it to.
  let stepFrom = $state({ y: 5, scale: 0.97 })
  const reduced = reducedMotion()
  // Held down: the card lifts (and its deeper shadow fades in).
  let pressed = $state(false)
  // Peek and throw: a plain word or fact card can be picked up before its
  // reveal; exercises keep their own flow.
  const peekable = $derived(!!item && !exercises)
  // Revealed by a press: the reveal plays fast.
  let peeked = $state(false)
  // When the answer became visible; swipes arm only PEEK_SAFE_MS later.
  let revealedAt: number | null = null
  let armReady = $state(false)
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let armTimer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    void cardKey
    const shown = session.revealed
    untrack(() => {
      clearTimeout(armTimer)
      if (!shown) {
        revealedAt = null
        armReady = false
        peeked = false
        return
      }
      revealedAt = Date.now()
      armReady = false
      armTimer = setTimeout(() => (armReady = canArm(revealedAt, Date.now())), PEEK_SAFE_MS)
    })
    return () => clearTimeout(armTimer)
  })

  // The card a rating brings next, drawn under the top one.
  const next = $derived(item ? session.peek : null)
  const nextExercises = $derived.by(() => {
    if (next?.kind !== 'fact' || !next.exercises?.length) return null
    const list = next.exercises.filter((e) => isTapType(e.type))
    return list.length ? list : null
  })
  let stageEl: HTMLElement | undefined = $state()
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

  // A grammar rule or theory card: its handbook page.
  // Grammar and everything under it (and the flat tags of before).
  const isGrammar = (f: { tags: string[] }) => f.tags.some((t) => t.startsWith('Grammar/') || t === 'Grammar' || t === 'Grammar theory')
  function readTheory(f: { id: string; deckId: string }) {
    navigate(`/handbook/fact:${f.id}?deck=${f.deckId}&from=/`)
  }

  // A rating button throws the card the way its swipe would.
  function rate(r: Rating) {
    if (!session.revealed || !item) return
    coach.dismiss()
    const d = (Object.keys(byDir) as SwipeDir[]).find((k) => byDir[k] === r)!
    throwCard(d, BUTTON_SPEED, { x: 0, y: 0, rotate: 0 }, r, true)
  }

  // The card leaves as a static copy (a ghost) flying off the stage while
  // the rating is recorded at once, so the next card is ready (and Undo
  // means this card) from the first frame of the throw.
  function throwCard(d: SwipeDir, v: number, at: { x: number; y: number; rotate: number }, r: Rating, button: boolean) {
    const el = wrap
    if (el && stageEl) {
      const ghost = el.cloneNode(true) as HTMLElement
      ghost.classList.remove('dragging', 'snapping', 'pressed')
      ghost.classList.add('ghost')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.removeAttribute('role')
      ghost.inert = true
      ghost.style.transformOrigin = origin
      stageEl.appendChild(ghost)
      el.style.visibility = 'hidden'
      const start = `translate3d(${at.x}px, ${at.y}px, 0) rotate(${at.rotate}deg) scale(${scale})`
      let anim: Animation
      if (reducedMotion()) {
        anim = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' })
      } else {
        const p = plan(d, button ? { x: 0, y: 0, rotate: d === 'right' ? 4.3 : d === 'left' ? -4.3 : 0 } : at, v, { width: stageWidth, height: stageHeight })
        anim = ghost.animate(
          [{ transform: start }, { transform: `translate3d(${p.x}px, ${p.y}px, 0) rotate(${p.rotate}deg) scale(${p.scale})` }],
          { duration: p.ms, easing: THROW_EASE, fill: 'forwards' },
        )
        // The next card is already drawn underneath: it steps up from where
        // the drag left it, at once (from its place: no motion at all).
        stepFrom = nextPose(button ? 0 : pull)
        setTimeout(() => (stepFrom = nextPose(0)), p.ms + 300)
        if (button) {
          const flash = document.createElement('div')
          flash.style.cssText = `position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:var(--${tone[r]});opacity:0`
          ghost.appendChild(flash)
          flash.animate([{ opacity: 0 }, { opacity: 0.1, offset: 0.4 }, { opacity: 0 }], { duration: 200, fill: 'forwards' })
        }
      }
      anim.finished.then(() => ghost.remove(), () => ghost.remove())
    }
    resetDrag()
    requestAnimationFrame(() => {
      if (!commit(r)) restore()
    })
    function restore() {
      if (el) el.style.visibility = ''
    }
  }

  function reveal() {
    if (!item || session.revealed) return
    session.reveal()
  }

  // A press on a hidden card revealed it (past the slop, or held).
  function peekNow() {
    clearTimeout(holdTimer)
    if (!item || session.revealed || !peekable) return
    peeked = true
    reveal()
    if (session.revealed) haptic.select()
  }

  function tapCard() {
    coach.dismiss()
    if (exercising) {
      if (tap.done) nextItem()
    } else reveal()
  }

  // The wash, the pill and arming follow the dominant direction right now.
  const axis = $derived(dominantAxis(dx, dy))
  const dist = $derived(axis === 'y' ? dy : dx)
  const dir = $derived<SwipeDir | null>(Math.abs(dist) < 16 ? null : dirOf(dx, dy))
  const lean = $derived<Rating | null>(dir ? byDir[dir] : null)
  // Same distances swipe.ts commits at, per axis; crossing one ticks once.
  const threshold = $derived(defaultThreshold(axis, stageWidth, stageHeight))
  const pull = $derived(Math.min(1, Math.abs(dist) / threshold))
  // Tilt from the horizontal offset, lift from the vertical progress: a
  // diagonal drag does both.
  const vertical = $derived(Math.min(1, Math.abs(dy) / defaultThreshold('y', stageWidth, stageHeight)))
  const rotation = $derived(tilt(dx, grabbedLow))
  const origin = $derived(tiltOrigin(grabbedLow))
  // The drag pose grows out of the press lift (lib/throw.ts dragScale / dragRise).
  const scale = $derived(reduced ? 1 : dragScale(pressed, pull, vertical))
  const rise = $derived(reduced ? 0 : dragRise(pressed, pull))
  const transform = $derived(`translate3d(${dx}px, ${dy + rise}px, 0) rotate(${rotation}deg) scale(${scale})`)
  // The next card eases up with the drag; one style on one element.
  const np = $derived(nextPose(dragging ? pull : 0, reduced))

  function onSwipeStart(_fx: number, fy: number) {
    // The coach goes with the first touch; the gesture carries on (it never blocks it).
    coach.dismiss()
    grabbedLow = fy >= 0.5
    pressed = true
    // The preview underneath is worked out for this moment.
    session.tick()
    clearTimeout(holdTimer)
    if (peekable && !session.revealed) holdTimer = setTimeout(peekNow, PEEK_HOLD_MS)
    // Caught mid snap-back: continue from where the card is.
    if (snapping && wrap) {
      const m = new DOMMatrix(getComputedStyle(wrap).transform)
      base = { x: m.m41, y: m.m42 }
    } else base = { x: 0, y: 0 }
  }

  function onSwipeMove(x: number, y: number) {
    dragging = true
    snapping = 0
    dx = base.x + x
    dy = base.y + y
    // Arms only once the answer has been visible long enough, on the
    // dominant axis against its threshold.
    const a = dominantAxis(dx, dy)
    const on = armReady ? nextArmedDir(armed, dirOf(dx, dy), a === 'y' ? dy : dx, defaultThreshold(a, stageWidth, stageHeight)) : null
    if (on && on !== armed) haptic.select()
    armed = on
  }

  // Every move from the press counts for the peek's slop, inside the swipe's.
  function onSwipeRaw(x: number, y: number) {
    if (!session.revealed && peekable && peekReveals(Math.hypot(x, y), 0)) peekNow()
  }

  // Let go without a drag: the lift settles back.
  function onSwipeRelease(wasDrag: boolean) {
    clearTimeout(holdTimer)
    if (wasDrag) return
    pressed = false
    snapping = 160
  }

  function resetDrag() {
    dragging = false
    pressed = false
    armed = null
    dx = dy = 0
  }

  function onSwipeEnd(tracked: SwipeDir | null, _x: number, _y: number, v: number) {
    const d = releaseDir(tracked, armed)
    // Short of the threshold, or too soon after the answer appeared: back
    // in place, still revealed.
    if (!session.revealed || releaseOutcome(d, revealedAt, Date.now()) === 'spring' || !d) {
      snapping = snapMs(Math.hypot(dx, dy))
      dragging = false
      pressed = false
      armed = null
      dx = dy = 0
      return
    }
    usedSwipe()
    throwCard(d, v, { x: dx, y: dy + rise, rotate: rotation }, byDir[d], false)
  }

  function onKey(e: KeyboardEvent) {
    if (shortcutsOff(e)) return
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (exercising) {
        if (tap.done) nextItem()
      } else if (!session.revealed) reveal()
      else rate(suggested ?? 3)
    } else if (exercising && ['1', '2', '3', '4'].includes(e.key)) {
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
  {#if session.queueDecks.length}
    <!-- The deck, then what its review is narrowed to: chips to drop one by
         one (a tap on a chip opens the filter), Clear, and Filter. -->
    <div class="deckbar">
      <div class="switch-wrap">
        <DeckSwitcher options={session.choices.map((d) => ({ id: d.id, name: d.name, counts: d.counts }))} selected={session.deckId} onselect={(id) => session.selectDeck(id)} />
      </div>
      <div class="fchips" role="group" aria-label="What is reviewed">
        {#each chips as c (c.key)}
          <span class="fchip">
            <button class="body" onclick={() => (filterOpen = true)}>{c.label}</button>
            <button class="x" onclick={() => session.setFilter(c.without)} aria-label="Remove {c.label}"><Icon name="x" size={13} stroke={2.4} /></button>
          </span>
        {/each}
        {#if chips.length > 1}<button class="fchip clear" onclick={() => session.setFilter(null)}>Clear</button>{/if}
        <button class="filter-btn" class:on={chips.length > 0} onclick={() => (filterOpen = true)} aria-label="Filter what to review">
          <Icon name="filter" size={16} stroke={2} />{#if !chips.length}<span>Filter</span>{/if}
        </button>
      </div>
      <button class="deck-settings" onclick={() => navigate(`/deck/${session.deckId}?from=/`)} aria-label={`Settings for ${currentDeck?.name ?? 'deck'}`}><Icon name="settings" size={18} /></button>
    </div>
  {/if}
  <header>
    <div class="counts" aria-label="{c.new} new, {c.learning} learning, {c.review} to review">
      <span class:zero={!c.new}><b class="n">{c.new}</b> new</span>
      <span class:zero={!c.learning}><b class="l">{c.learning}</b> learning</span>
      <span class:zero={!c.review}><b class="r">{c.review}</b> due</span>
    </div>
    <div class="completion"><span>{done} / {done + remaining(session.queue)}</span><SyncPill /></div>
  </header>
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
  <div class="progress" aria-hidden="true"><div style="transform: scaleX({progress})"></div></div>

  <div class="stage" bind:this={stageEl} bind:clientWidth={stageWidth} bind:clientHeight={stageHeight}>
    {#if item}
      <!-- What's left under the top card: the next card itself, readable,
           when it is known (then a faint edge for the one after), else
           card edges. -->
      {#if next}
        {#if layers >= 2}<div class="layer l2" aria-hidden="true"></div>{/if}
        <div class="next-card" aria-hidden="true" inert style="transform: translate3d(0, {np.y}px, 0) scale({np.scale})">
          {#if next.kind === 'fact' && nextExercises}
            <ExerciseCard item={{ ...next, exercises: nextExercises }} index={0} results={[]} check={null} given="" revealed={false} />
          {:else if next.kind === 'fact'}
            <FactCard item={next} revealed={false} />
          {:else}
            <WordCard item={next} revealed={false} {langs} />
          {/if}
        </div>
      {:else}
        {#each { length: layers } as _, i (i)}<div class="layer l{layers - i}" aria-hidden="true"></div>{/each}
      {/if}
      {#key cardKey}
        <div
          class="card-wrap"
          class:dragging
          class:snapping={!!snapping}
          class:pressed
          class:peeked
          class:legend-on={session.revealed && hintsLeft > 0}
          bind:this={wrap}
          style="transform: {transform}; transform-origin: {origin}; --ctx-left: {session.canUndo ? '52px' : '20px'}; --snap: {snapping || 320}ms; --from-y: {stepFrom.y}px; --from-scale: {stepFrom.scale}"
          role="button"
          tabindex="-1"
          aria-label={session.revealed ? 'Card' : exercising ? 'Card, tap an answer' : 'Show answer'}
          onclick={tapCard}
          onkeydown={() => {}}
          use:swipe={{
            axes: 'xy',
            enabled: () => session.revealed || peekable,
            scroller: () => wrap?.querySelector<HTMLElement>('.card .body'),
            onstart: onSwipeStart,
            onmove: onSwipeMove,
            onraw: onSwipeRaw,
            onrelease: onSwipeRelease,
            onend: onSwipeEnd,
          }}
        >
          <div class="lift-shadow" aria-hidden="true"></div>
          {#if session.canUndo}
            <!-- Back: the last rating undone, the card it was on returns. -->
            <button class="card-undo" onclick={(e) => (e.stopPropagation(), session.undo())} onmousedown={(e) => e.preventDefault()} aria-label="Undo last rating" title="Undo (Z)">
              <Icon name="undo" size={17} stroke={2} />
            </button>
          {/if}
          {#if item.kind === 'fact' && exercises}
            <ExerciseCard
              item={{ ...item, exercises }}
              index={exIndex}
              results={exResults}
              check={null}
              given=""
              {tap}
              revealed={session.revealed}
              onchoose={chooseOption}
              ontoken={tapToken}
              onbad={badItem}
              onedit={() => navigate(`/fact/${item.fact.id}?from=/`)}
              ondrop={() => void dropCard('fact', item.fact.id, item.fact.front)}
              onread={() => readTheory(item.fact)}
            />
          {:else if item.kind === 'fact'}
            <FactCard {item} revealed={session.revealed} onedit={() => navigate(`/fact/${item.fact.id}?from=/`)} ondrop={() => void dropCard('fact', item.fact.id, item.fact.front)} onread={isGrammar(item.fact) ? () => readTheory(item.fact) : undefined} />
          {:else}
            <WordCard {item} revealed={session.revealed} {langs} onedit={() => navigate(`/word/${item.word.id}?from=/`)} ondrop={() => void dropCard('word', item.word.id, item.word.term)} />
          {/if}
          {#if dir && lean && intervals && armReady}
            <div class="wash {dir} {tone[lean]}" style="opacity: {pull * 0.6}"></div>
            <div class="swipe-hint {dir} {tone[lean]}" class:armed={!!armed} style="opacity: {0.35 + pull * 0.65}; --pull: {pull}">
              <span class="what"><b>{names[lean]}</b> {intervals[lean]}</span>
              <span class="track"><span></span></span>
            </div>
          {/if}
          {#if session.revealed && hintsLeft > 0 && !dragging}
            <div class="legend" aria-hidden="true">
              <span><Icon name="arrow" size={13} stroke={2.2} /> Hard</span>
              <span class="to-r"><Icon name="arrow" size={13} stroke={2.2} /> Good</span>
              <span class="to-d"><Icon name="arrow" size={13} stroke={2.2} /> Again</span>
              <span class="to-u"><Icon name="arrow" size={13} stroke={2.2} /> Easy</span>
            </div>
          {/if}
        </div>
      {/key}
      {#if coach.visible}
        <!-- Once, on the first card after the wizard. It takes no touches:
             the first tap or swipe goes to the card and dismisses it. -->
        <div class="coach" aria-live="polite">
          <p class="tap">Tap the card to flip it</p>
          <div class="ways">
            <span class="to-r"><Icon name="arrow" size={18} stroke={2.2} /> Good</span>
            <span><Icon name="arrow" size={18} stroke={2.2} /> Hard</span>
            <span class="to-d"><Icon name="arrow" size={18} stroke={2.2} /> Again</span>
            <span class="to-u"><Icon name="arrow" size={18} stroke={2.2} /> Easy</span>
          </div>
          <p class="then">then swipe it to rate how well you knew it</p>
        </div>
      {/if}
    {:else}
      <Summary />
    {/if}
  </div>

  {#if item}
    <div class="actions">
      {#if exercising}
        <!-- Tap items are answered on the card; here: undo before, Next after. -->
        <div class="pre">
          {#if tap.done}
            {#if !exResults[exIndex]?.correct}
              <button class="soft right-btn" onclick={overrule}>I was right</button>
            {/if}
            <button class="show next" onclick={nextItem}>{!exResults[exIndex]?.correct || exResults[exIndex]?.overridden ? 'Continue' : exIndex + 1 < (exercises?.length ?? 0) ? 'Next' : 'Done'}</button>
          {:else}
            <p class="tap-hint">{exItem?.type === 'spot' ? (tap.token === null ? 'Tap the wrong word' : 'Pick the right form') : 'Tap the right option'}</p>
          {/if}
        </div>
      {:else if session.revealed}
        <RatingBar state={item.card.schedule} onrate={rate} lean={lean ?? (exercises ? suggested : null)} {suggested} {intervals} />
      {:else}
        <div class="pre">
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
    min-height: 30px;
    flex-wrap: wrap;
    padding: 0 8px;
  }
  .completion {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--faint);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    flex: none;
    margin-left: auto;
  }
  .deck-settings {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    color: var(--muted);
    margin-right: -4px;
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
  /* The deck and its filter chips: one line; the chips scroll sideways. */
  .deckbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 4px 0 0;
    min-height: 40px;
  }
  .switch-wrap {
    flex: none;
    max-width: 45%;
  }
  .fchips {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior: contain;
    touch-action: pan-x;
    scrollbar-width: none;
    /* Room for the 44px hit areas below (the scroller clips them), taken
       back by the margin so the row keeps its height. */
    padding: 6px 8px 6px 2px;
    margin: -4px 0;
  }
  .fchips::-webkit-scrollbar {
    display: none;
  }
  .fchip {
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 32px;
    border-radius: 16px;
    color: var(--accent);
    background: var(--accent-soft);
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
  }
  .fchip .body {
    height: 100%;
    padding: 0 4px 0 12px;
    color: inherit;
    font: inherit;
  }
  .fchip .x {
    position: relative;
    height: 100%;
    padding: 0 11px 0 5px;
    display: flex;
    align-items: center;
    color: inherit;
    opacity: 0.75;
  }
  /* 40px tall to the thumb, 32px to the eye. */
  .fchip .x::after,
  .fchip .body::after {
    content: '';
    position: absolute;
    inset: -6px 0;
  }
  /* ✕ reaches into the gap and over the label's edge: about 41px wide. */
  .fchip .x::after {
    inset: -6px -6px -6px -6px;
  }
  .fchip .body {
    position: relative;
  }
  .fchip.clear {
    padding: 0 12px;
    color: var(--muted);
    background: var(--surface);
  }
  .filter-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 32px;
    padding: 0 10px;
    border-radius: 16px;
    font-size: 14px;
    font-weight: 500;
    color: var(--muted);
    background: var(--surface);
    position: relative;
  }
  .filter-btn::after {
    content: '';
    position: absolute;
    inset: -6px -4px;
  }
  .filter-btn.on {
    color: var(--accent);
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
    z-index: 1;
    border-radius: var(--radius);
    touch-action: pan-y;
    /* Let go short of the threshold: settles back like a drawer. */
    transition: transform var(--snap, 320ms) var(--ease-drawer);
    /* The next card steps up from where it sat under the thrown one (its
       preview), at once; from its place there is nothing to animate. */
    animation: step-up var(--t-base) var(--ease-out) backwards;
    -webkit-user-select: text;
    user-select: text;
    cursor: default;
  }
  .card-wrap.dragging {
    transition: none;
    will-change: transform;
    /* A claimed drag is the card's in 2D until release: no browser pan of
       its own (swipe.ts also cancels every touchmove of it). */
    touch-action: none;
  }
  /* The thrown card's copy, above the next one. */
  .stage :global(.ghost) {
    z-index: 2;
    pointer-events: none;
    animation: none;
    transition: none;
    will-change: transform;
  }
  @keyframes step-up {
    from {
      transform: translate3d(0, var(--from-y, 5px), 0) scale(var(--from-scale, 0.97));
    }
  }
  /* Held: lifts 2% and 2px in 120ms; let go, it settles in 160ms (--snap). */
  .card-wrap.pressed:not(.dragging) {
    transition: transform 120ms var(--ease-out);
  }
  /* Revealed by a press: the same reveal, faster. */
  .card-wrap.peeked {
    --t-fast: 110ms;
    --t-slow: 200ms;
  }
  /* The deeper shadow of a lifted card: pre-rendered, only its opacity moves. */
  .lift-shadow {
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
    box-shadow: var(--shadow-lift);
    opacity: 0;
    transition: opacity 160ms ease;
    pointer-events: none;
  }
  .card-wrap.pressed .lift-shadow,
  .card-wrap.dragging .lift-shadow {
    opacity: 1;
    transition-duration: 120ms;
  }
  /* The next card, readable under the top one; only its transform changes
     while the top card is dragged. */
  .next-card {
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
    pointer-events: none;
    will-change: transform;
  }
  /* Let go short of the threshold: back to its stacked pose with the top card. */
  .stage:not(:has(.card-wrap.dragging)) .next-card {
    transition: transform 240ms var(--ease-drawer);
  }
  /* Card edges under the top card: card-coloured, a hairline, no shadow. */
  .layer {
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: inset 0 0 0 0.5px var(--hairline);
    pointer-events: none;
  }
  .layer.l1 {
    transform: translate3d(0, 5px, 0) scale(0.97);
  }
  .layer.l2 {
    transform: translate3d(0, 10px, 0) scale(0.94);
    animation: fade-in var(--t-fast) ease;
  }
  .wash,
  .swipe-hint {
    transition: opacity 120ms ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .card-wrap {
      animation: fade-in 150ms ease;
    }
    .card-wrap.snapping {
      transition: transform 120ms linear;
    }
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

  /* The gesture coach: a quiet scrim over the card, no touches taken. */
  .coach {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 24px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    text-align: center;
    animation: coach-in var(--t-base) var(--ease-out);
  }
  @keyframes coach-in {
    from {
      opacity: 0;
    }
  }
  .coach p {
    margin: 0;
  }
  .coach .tap {
    font-size: 19px;
    font-weight: 600;
    color: var(--text);
  }
  .coach .then {
    font-size: 15px;
    color: var(--muted);
  }
  .coach .ways {
    display: grid;
    grid-template-columns: repeat(2, auto);
    gap: 10px 22px;
    font-size: 17px;
    font-weight: 500;
    color: var(--text);
  }
  .coach .ways span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .coach .ways :global(svg) {
    color: var(--accent);
    transform: rotate(-90deg);
  }
  .coach .to-r :global(svg) {
    transform: rotate(90deg);
  }
  .coach .to-d :global(svg) {
    transform: rotate(180deg);
  }
  .coach .to-u :global(svg) {
    transform: none;
  }

  /* The legend gets its own strip under the card's content: the content
     scrolls above it instead of under it. */
  .card-wrap.legend-on :global(.card > .body) {
    margin-bottom: 34px;
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
    width: 46px;
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
    background: var(--accent);
    color: var(--accent-text);
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
  /* Small on the card's top-left, opposite ⋯ and ✎; a 44px target. */
  .card-undo {
    position: absolute;
    top: 3px;
    left: 3px;
    z-index: 2;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 14px;
    color: var(--faint);
    animation: fade-in var(--t-fast) ease;
    transition:
      color var(--t-fast) ease,
      background-color var(--t-fast) ease;
  }
  .card-undo:active {
    color: var(--accent);
    background: var(--accent-soft);
  }
</style>
