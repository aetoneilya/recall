<script lang="ts">
  import { onMount } from 'svelte'
  import BandShares from '../components/BandShares.svelte'
  import Icon from '../components/Icon.svelte'
  import ScaleLadder from '../components/ScaleLadder.svelte'
  import { HttpError } from '../lib/api.ts'
  import { api, kv, status } from '../lib/app.svelte.ts'
  import { back, navigate } from '../lib/router.svelte.ts'
  import { swipe, type SwipeDir } from '../lib/swipe.ts'
  import { haptic, setBackButton } from '../lib/telegram.ts'
  import { errorText } from '../lib/toast.svelte.ts'
  import type { Dashboard, TestResult, VocabScale, VocabTestStart } from '../lib/types.ts'

  type Phase = 'intro' | 'run' | 'submitting' | 'result' | 'failed' | 'unavailable'

  let phase = $state<Phase>('intro')
  let test = $state.raw<VocabTestStart | null>(null)
  let startError = $state('')
  let waiting = $state(false)
  let answers = $state.raw<{ id: string; known: boolean }[]>([])
  let result = $state.raw<TestResult | null>(null)
  let submitError = $state('')
  let scale = $state.raw<VocabScale | null>(null)
  // The estimate before this test, so the marker can travel from it.
  let previous = $state<number | null>(null)

  const items = $derived(test?.items ?? [])
  const index = $derived(answers.length)
  const word = $derived(items[index]?.word ?? '')
  const progress = $derived(items.length ? index / items.length : 0)

  const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

  // Created on arrival so "Start" is instant.
  async function begin() {
    startError = ''
    try {
      test = await api.startVocabTest()
      if (waiting) {
        waiting = false
        phase = 'run'
      }
    } catch (e) {
      waiting = false
      if (e instanceof HttpError && e.status === 503) phase = 'unavailable'
      else startError = errorText(e)
    }
  }

  onMount(() => {
    void begin()
    void kv
      .get<Dashboard>('dashboard')
      .then((d) => {
        previous = d?.vocabulary.current?.adjusted ?? null
        scale = d?.vocabulary.scale ?? null
      })
      .catch(() => {})
  })

  function start() {
    if (test) phase = 'run'
    else if (startError) {
      waiting = true
      void begin()
    } else waiting = true
  }

  function answer(known: boolean) {
    if (phase !== 'run' || !items[index]) return
    haptic.impact(known ? 'light' : 'soft')
    answers = [...answers, { id: items[index].id, known }]
    if (answers.length === items.length) void submit()
  }

  async function submit() {
    if (!test) return
    phase = 'submitting'
    submitError = ''
    try {
      const r = await api.answerVocabTest(test.testId, answers)
      result = r
      phase = 'result'
      haptic.notify('success')
      // Fresh scale and numbers for the ladder and the dashboard.
      void api
        .dashboard()
        .then((d) => {
          scale = d.vocabulary.scale ?? scale
          void kv.set('dashboard', d)
        })
        .catch(() => {})
    } catch (e) {
      submitError = errorText(e)
      phase = 'failed'
    }
  }

  function retake() {
    answers = []
    result = null
    test = null
    phase = 'intro'
    previous = null
    void begin()
  }

  function done() {
    navigate('/progress', { replace: true })
  }

  // Back undoes the last answer; on the first word (or before) it leaves.
  function onBack() {
    if (phase === 'submitting') return
    if (phase === 'result') return done()
    if ((phase === 'run' || phase === 'failed') && answers.length) {
      answers = answers.slice(0, -1)
      phase = 'run'
      haptic.select()
      return
    }
    back()
  }

  $effect(() => {
    setBackButton(onBack)
    return () => setBackButton(null)
  })

  function onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (phase === 'intro' && e.key === 'Enter') {
      e.preventDefault()
      start()
      return
    }
    if (phase !== 'run') return
    const k = e.key.toLowerCase()
    if (k === 'arrowright' || k === 'k') answer(true)
    else if (k === 'arrowleft' || k === 'j') answer(false)
    else if (k === 'backspace' || k === 'z' || k === 'u') onBack()
    else return
    e.preventDefault()
  }

  // Swipe on the word: right = know, left = don't know.
  let dx = $state(0)
  let dragging = $state(false)
  let leaving = $state(false)
  const pull = $derived(Math.min(1, Math.abs(dx) / 110))

  function onEnd(dir: SwipeDir | null) {
    dragging = false
    if (!dir) {
      dx = 0
      return
    }
    leaving = true
    dx = (dir === 'right' ? 1 : -1) * (innerWidth + 80)
    setTimeout(() => {
      leaving = false
      dx = 0
      answer(dir === 'right')
    }, 180)
  }
</script>

<svelte:window onkeydown={onKey} />

{#if phase === 'run' || phase === 'failed'}
  <div class="run">
    <div class="top">
      {#if !status.telegram}
        <button class="icon-btn back" onclick={onBack} aria-label={answers.length ? 'Undo last answer' : 'Leave the test'}><Icon name={answers.length ? 'undo' : 'back'} /></button>
      {/if}
      <div class="bar" aria-hidden="true"><div style="transform: scaleX({progress})"></div></div>
      <span class="count">{Math.min(index + 1, items.length)} / {items.length}</span>
    </div>

    <div class="stage">
      {#if phase === 'failed'}
        <div class="empty">
          <Icon name="offline" size={40} stroke={1.4} />
          <p><strong>Couldn't send your answers</strong>{submitError} Your answers are kept.</p>
          <button class="btn primary" onclick={submit}><Icon name="refresh" size={18} /> Retry</button>
        </div>
      {:else}
        {#key index}
          <div
            class="card"
            class:dragging
            class:leaving
            style="transform: translateX({dx}px) rotate({dx / 40}deg)"
            use:swipe={{
              enabled: () => !leaving,
              onmove: (x) => {
                dragging = true
                dx = x
              },
              onend: onEnd,
            }}
          >
            <span class="ask">Can you explain it?</span>
            <span class="word" lang="en">{word}</span>
            {#if dx > 24}<span class="stamp yes" style="opacity: {pull}"><Icon name="check" size={18} stroke={2.4} /> Know</span>{/if}
            {#if dx < -24}<span class="stamp no" style="opacity: {pull}"><Icon name="x" size={18} stroke={2.4} /> Don't know</span>{/if}
          </div>
        {/key}
      {/if}
    </div>

    <div class="answers">
      <button class="ans no" class:lean={dx < -24} onclick={() => answer(false)} disabled={phase !== 'run'} aria-keyshortcuts="ArrowLeft">Don't know</button>
      <button class="ans yes" class:lean={dx > 24} onclick={() => answer(true)} disabled={phase !== 'run'} aria-keyshortcuts="ArrowRight">Know</button>
    </div>
  </div>
{:else}
  <div class="screen">
    <div class="screen-title">
      {#if !status.telegram}
        <button class="icon-btn back" onclick={onBack} aria-label="Back"><Icon name="back" /></button>
      {/if}
      <h1 class="small">{phase === 'result' || phase === 'submitting' ? 'Your vocabulary' : 'Vocabulary test'}</h1>
    </div>

    {#if phase === 'unavailable'}
      <div class="empty">
        <Icon name="info" size={40} stroke={1.4} />
        <p><strong>No test here yet</strong>The vocabulary test isn't installed on the server.</p>
        <button class="btn" onclick={done}>Back to progress</button>
      </div>
    {:else if phase === 'intro'}
      <div class="intro">
        <p class="lead">Mark a word as known only if you can explain its meaning — some words are made up.</p>
        <p class="muted">About 3 minutes{items.length ? ` · ${items.length} words` : ''}. Swipe right or tap Know, swipe left for Don't know; Back undoes the last answer.</p>
        {#if startError && !waiting}<p class="err">{startError}</p>{/if}
        <button class="btn primary block go" onclick={start} disabled={waiting}>{waiting ? 'Preparing…' : startError ? 'Try again' : 'Start'}</button>
      </div>
    {:else if phase === 'submitting'}
      <div class="panel" aria-label="Scoring">
        <span class="skel" style="width: 55%; height: 44px; border-radius: 10px"></span>
        <span class="skel" style="width: 40%; margin-top: 14px"></span>
        <span class="skel" style="width: 75%; margin-top: 10px"></span>
      </div>
      <div class="panel" style="margin-top: 12px"><span class="skel" style="height: 220px; border-radius: 8px"></span></div>
    {:else if phase === 'result' && result}
      {@const r = result}
      <div class="panel hero">
        <div class="big"><span class="approx">≈</span>{fmt(r.estimate ?? r.adjusted)}</div>
        {#if r.interval}<div class="interval">{fmt(r.interval[0])}–{fmt(r.interval[1])} · rough 95% range</div>{/if}
        <div class="levels">
          <span class="cefr" class:dim={!r.cefr.level}>{r.cefr.level?.id ?? 'pre-A1'}</span>
          <span class="next">{r.cefr.level?.label ?? 'Below the learner scale'}</span>
        </div>
        <p class="native">≈ {fmt(r.nativeEquivalent.value)} as natives count</p>
        {#if r.adjusted !== (r.estimate ?? r.adjusted)}<p class="muted small">≈ {fmt(r.adjusted)} with the words you know in the app.</p>{/if}
      </div>

      {#if !r.valid}
        <div class="warn">
          <Icon name="warn" size={22} />
          <div>
            <b>This result isn't used</b>
            <p>Too many made-up words were marked as known. Retake it and tick only words you could explain.</p>
            <button class="btn primary" onclick={retake}>Retake</button>
          </div>
        </div>
      {:else if r.reliability === 'low'}
        <div class="warn">
          <Icon name="warn" size={22} />
          <div>
            <b>A rough estimate</b>
            <p>Some made-up words were marked as known, so the number may be high. Next time tick only words you could explain.</p>
          </div>
        </div>
      {/if}

      {#if scale?.points.length}
        <div class="section-label">Where that puts you</div>
        <div class="panel ladder-panel">
          <ScaleLadder {scale} value={r.adjusted} from={previous ?? 0} collapsible={false} />
        </div>
      {/if}

      {#if r.perBand.length}
        <div class="section-label">By frequency</div>
        <div class="panel">
          <BandShares bands={r.perBand} />
        </div>
      {/if}

      <p class="caption">{r.answered} answers · {r.pseudowords.yes} of {r.pseudowords.items} made-up words marked as known.</p>
      <button class="btn primary block done" onclick={done}>Done</button>
    {/if}
  </div>
{/if}

<style>
  .run {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: var(--sat) calc(12px + var(--sar)) 0 calc(12px + var(--sal));
    -webkit-user-select: none;
    user-select: none;
  }
  .top {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    padding: 0 6px;
  }
  .back {
    margin-left: -10px;
    color: var(--accent);
  }
  .bar {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform var(--t-base) var(--ease-out);
  }
  .count {
    font-size: 13px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    min-width: 58px;
    text-align: right;
  }
  .stage {
    flex: 1;
    min-height: 0;
    position: relative;
    margin-top: 6px;
  }
  .card {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 18px 20px;
    touch-action: pan-y;
    transition: transform var(--t-slow) var(--ease-drawer);
    animation: rise var(--t-base) var(--ease-out);
    overflow: hidden;
  }
  .card.dragging {
    transition: none;
  }
  .card.leaving {
    transition: transform var(--t-fast) var(--ease-out);
  }
  .ask {
    font-size: 13px;
    color: var(--faint);
  }
  .word {
    margin-top: 30%;
    font-size: 34px;
    line-height: 1.15;
    font-weight: 600;
    letter-spacing: -0.022em;
    text-align: center;
    text-wrap: balance;
    overflow-wrap: anywhere;
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
  .stamp.yes {
    left: 16px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .stamp.no {
    right: 16px;
    background: var(--surface-2);
    color: var(--muted);
  }
  .answers {
    flex: none;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    padding: 12px 0 calc(14px + var(--sab));
  }
  .ans {
    height: 76px;
    border-radius: 18px;
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.01em;
    transition:
      transform var(--t-press) var(--ease-out),
      background-color var(--t-fast) ease;
  }
  .ans.no {
    background: var(--surface);
    color: var(--text);
  }
  .ans.yes {
    background: var(--accent);
    color: var(--accent-text);
  }
  .ans:active:not(:disabled) {
    transform: scale(0.96);
  }
  .ans.lean {
    transform: scale(1.04);
  }
  .ans.no.lean {
    background: var(--surface-2);
  }

  h1.small {
    font-size: 22px;
  }
  .screen-title .back {
    margin-left: -12px;
  }
  .intro {
    padding: 24px 4px 0;
  }
  .lead {
    font-size: 21px;
    line-height: 1.35;
    font-weight: 600;
    letter-spacing: -0.012em;
    margin: 0 0 12px;
    text-wrap: pretty;
  }
  .intro .muted {
    font-size: 15px;
    margin: 0;
  }
  .err {
    color: var(--again);
    font-size: 15px;
  }
  .go {
    margin-top: 28px;
    min-height: 56px;
    font-size: 17px;
  }
  .panel {
    background: var(--surface);
    border-radius: var(--radius-m);
    padding: 14px;
    display: flex;
    flex-direction: column;
  }
  .hero {
    padding: 18px 16px 16px;
  }
  .big {
    font-size: 48px;
    line-height: 1.05;
    font-weight: 700;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
    animation: rise var(--t-slow) var(--ease-out);
  }
  .approx {
    color: var(--muted);
    font-weight: 500;
    margin-right: 6px;
  }
  .interval {
    margin-top: 4px;
    font-size: 14px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .levels {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
  }
  .cefr {
    padding: 3px 10px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 700;
    font-size: 15px;
  }
  .cefr.dim {
    color: var(--muted);
    background: var(--surface-2);
  }
  .next {
    font-size: 14px;
    color: var(--muted);
  }
  .native {
    margin: 10px 0 0;
    font-size: 15px;
    font-variant-numeric: tabular-nums;
  }
  .small {
    font-size: 13px;
    margin: 4px 0 0;
  }
  .warn {
    display: flex;
    gap: 12px;
    margin-top: 12px;
    padding: 14px;
    border-radius: var(--radius-m);
    background: var(--surface-2);
    color: var(--text);
  }
  .warn :global(svg) {
    flex: none;
    color: var(--muted);
  }
  .warn p {
    margin: 4px 0 0;
    font-size: 14px;
    color: var(--muted);
  }
  .warn .btn {
    margin-top: 10px;
  }
  .ladder-panel {
    padding: 8px 14px;
  }
  .caption {
    font-size: 13px;
    color: var(--muted);
    margin: 14px 16px 0;
    font-variant-numeric: tabular-nums;
  }
  .done {
    margin-top: 20px;
    min-height: 52px;
  }
</style>
