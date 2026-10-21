<script lang="ts">
  import { formatInterval, preview, type CardState, type Rating } from '@recall/core'
  import { fsrs } from '../lib/fsrs.ts'

  // `lean`: the rating a swipe in progress would give, lit up so the
  // gesture and the buttons read as one control.
  // `intervals`: labels computed by the caller, so a swipe hint and the
  // buttons show the same numbers (FSRS fuzz depends on the moment).
  // `suggested`: the rating a typed answer suggests, ringed so one tap (or
  // Enter) takes it; any other button still works.
  // `keepFocus`: pressing a button doesn't take focus from the answer field,
  // so the on-screen keyboard stays up for the next card.
  let {
    state,
    onrate,
    lean = null,
    suggested = null,
    keepFocus = false,
    intervals: given,
  }: {
    state: CardState
    onrate: (r: Rating) => void
    lean?: Rating | null
    suggested?: Rating | null
    keepFocus?: boolean
    intervals?: Record<Rating, string> | null
  } = $props()

  const labels: Record<Rating, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' }
  const cls: Record<Rating, string> = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }
  const ratings: Rating[] = [1, 2, 3, 4]

  const intervals = $derived.by(() => {
    if (given) return given
    const now = new Date()
    const p = preview(state, now, fsrs())
    return { 1: formatInterval(now, p[1]), 2: formatInterval(now, p[2]), 3: formatInterval(now, p[3]), 4: formatInterval(now, p[4]) }
  })
</script>

<div class="bar">
  {#each ratings as r (r)}
    <button
      class="rate {cls[r]}"
      class:lean={lean === r}
      class:suggested={suggested === r}
      class:kbd={keepFocus}
      onclick={() => onrate(r)}
      onmousedown={(e) => keepFocus && e.preventDefault()}
      aria-label="{labels[r]}, {intervals[r]}{suggested === r ? ', suggested' : ''}"
      aria-keyshortcuts={String(r)}
    >
      <span class="name">{labels[r]}</span>
      <span class="ivl">{intervals[r]}</span>
    </button>
  {/each}
</div>

<style>
  .bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }
  .rate {
    --c: var(--text);
    --cb: var(--surface);
    height: 66px;
    border-radius: 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    color: var(--c);
    background: var(--cb);
    transition:
      transform var(--t-press) var(--ease-out),
      background-color var(--t-fast) ease;
  }
  .rate:active {
    transform: scale(0.95);
    background: color-mix(in srgb, var(--c) 16%, var(--cb));
  }
  .rate.lean {
    transform: scale(1.04);
    background: color-mix(in srgb, var(--c) 20%, var(--cb));
  }
  .rate.suggested {
    background: color-mix(in srgb, var(--c) 14%, var(--cb));
    box-shadow: inset 0 0 0 2px var(--c);
  }
  .rate.suggested.kbd .name::after {
    content: ' ↵';
    font-weight: 500;
    opacity: 0.7;
  }
  .name {
    font-size: 16px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .ivl {
    font-size: 13px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
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
</style>
