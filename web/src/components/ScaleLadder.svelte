<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { flip } from 'svelte/animate'
  import { cubicInOut, cubicOut } from 'svelte/easing'
  import { prefersReducedMotion, Tween } from 'svelte/motion'
  import type { ScalePoint, VocabScale } from '../lib/types.ts'

  // Every scale point on one axis (lemmas within the frequency list, the
  // unit of `value`), highest on top, with a "You" marker between the
  // nearest points. Learner points compare as they are; native and fun ones
  // are converted through the calibration, so they're always approximate.
  // `from`: animate the marker from this number (the previous estimate) to `value`.
  let {
    scale,
    value,
    from = null,
    collapsible = true,
  }: { scale: VocabScale; value: number; from?: number | null; collapsible?: boolean } = $props()

  const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
  const groupHint: Record<string, string> = { learner: 'learner', native: 'native speaker', fun: 'for fun' }

  const cal = $derived(scale.calibration)
  const axis = (p: ScalePoint) => (p.group === 'learner' ? p.size : (p.size * cal.expectedInList) / cal.adultSize)
  const approx = (p: ScalePoint) => p.approximate || p.group !== 'learner'

  // Decided once, on mount: later changes of `value` move the marker at once.
  const initial = untrack(() => ({ from, value }))
  const animate = initial.from !== null && initial.from !== initial.value
  const start = animate ? initial.from! : initial.value
  // Where the marker sits in the list; the label counts up on its own.
  let at = $state(start)
  const counter = new Tween(start, { duration: 900, easing: cubicOut })
  let started = !animate

  onMount(() => {
    if (!animate) return
    const t = setTimeout(() => {
      started = true
      at = untrack(() => value)
      counter.target = at
    }, 450)
    return () => clearTimeout(t)
  })

  $effect(() => {
    const v = value
    if (!started) return
    at = v
    counter.set(v, { duration: 0 })
  })

  type Row = { kind: 'point'; key: string; p: ScalePoint; pos: number } | { kind: 'you'; key: string }

  const rows = $derived.by(() => {
    const pts = [...scale.points].map((p) => ({ p, pos: axis(p) })).sort((a, b) => b.pos - a.pos)
    const out: Row[] = []
    let placed = false
    for (const x of pts) {
      if (!placed && x.pos <= at) {
        out.push({ kind: 'you', key: 'you' })
        placed = true
      }
      out.push({ kind: 'point', key: x.p.id, p: x.p, pos: x.pos })
    }
    if (!placed) out.push({ kind: 'you', key: 'you' })
    return out
  })

  let all = $state(false)
  const youIndex = $derived(rows.findIndex((r) => r.kind === 'you'))
  const visible = $derived(!collapsible || all ? rows : rows.filter((_, i) => Math.abs(i - youIndex) <= 2))
  const hidden = $derived(rows.length - visible.length)

  let open = $state<string | null>(null)
  const ms = $derived(prefersReducedMotion.current ? 0 : 900)
</script>

<div class="ladder" role="list" aria-label="Vocabulary scale">
  {#each visible as r, i (r.key)}
    <div class="row" class:first={i === 0} class:last={i === visible.length - 1} role="listitem" animate:flip={{ duration: ms, easing: cubicInOut }}>
      {#if r.kind === 'you'}
        <div class="you">
          <span class="dot me"></span>
          <span class="pill">You <b>≈ {fmt(counter.current)}</b></span>
        </div>
      {:else}
        {@const reached = r.pos <= at}
        <button class="point" aria-expanded={open === r.p.id} onclick={() => (open = open === r.p.id ? null : r.p.id)}>
          <span class="dot" class:reached></span>
          <span class="emoji" aria-hidden="true">{r.p.emoji ?? ''}</span>
          <span class="label">
            {r.p.label}
            <span class="hint">{groupHint[r.p.group] ?? r.p.group}</span>
          </span>
          <span class="size">{approx(r.p) ? '≈ ' : ''}{fmt(r.pos)}</span>
        </button>
        {#if open === r.p.id}
          <div class="note">
            {#if r.p.group !== 'learner'}<p>{fmt(r.p.size)} words as natives count, ≈ {fmt(r.pos)} on this app's list.</p>{/if}
            {#if r.p.range}<p>Range {fmt(r.p.range[0])}–{fmt(r.p.range[1])}.</p>{/if}
            {#if r.p.source}<p>{r.p.source}</p>{/if}
            {#if r.p.url}<a href={r.p.url} target="_blank" rel="noopener noreferrer">Source</a>{/if}
          </div>
        {/if}
      {/if}
    </div>
  {/each}
</div>
{#if collapsible && (hidden > 0 || all)}
  <button class="more" onclick={() => (all = !all)}>{all ? 'Show fewer' : `Show all ${scale.points.length}`}</button>
{/if}

<style>
  .ladder {
    display: flex;
    flex-direction: column;
  }
  .row {
    position: relative;
  }
  /* The track: a hairline through every dot. */
  .row::before {
    content: '';
    position: absolute;
    left: 11px;
    top: 0;
    bottom: 0;
    width: 2px;
    border-radius: 1px;
    background: var(--surface-2);
  }
  .row.first::before {
    top: 22px;
  }
  .row.last::before {
    bottom: calc(100% - 22px);
  }
  .row.first.last::before {
    display: none;
  }
  .point,
  .you {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 44px;
    text-align: left;
  }
  .point:active {
    opacity: 0.6;
  }
  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    margin: 0 7px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: inset 0 0 0 2px var(--faint);
  }
  .dot.reached {
    background: var(--accent);
    box-shadow: none;
  }
  .dot.me {
    width: 16px;
    height: 16px;
    margin: 0 4px;
    background: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  .emoji {
    width: 22px;
    text-align: center;
    font-size: 17px;
    flex: none;
  }
  .label {
    flex: 1;
    min-width: 0;
    font-size: 15px;
    line-height: 1.3;
  }
  .hint {
    display: block;
    font-size: 12.5px;
    color: var(--faint);
  }
  .size {
    font-size: 14px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .pill {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 14px;
    font-weight: 600;
  }
  .pill b {
    font-variant-numeric: tabular-nums;
  }
  .note {
    margin: 0 0 8px 56px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--muted);
    animation: rise-sm var(--t-fast) var(--ease-out);
  }
  .note p {
    margin: 0 0 4px;
  }
  .more {
    margin: 4px 0 0 46px;
    min-height: 36px;
    font-size: 14px;
    font-weight: 500;
    color: var(--accent);
  }
</style>
