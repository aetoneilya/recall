<script lang="ts">
  import type { BandResult } from '../lib/types.ts'

  // Per 1000-rank band: the share the test says you know (bar) and the
  // share known in the app (tick).
  let { bands }: { bands: BandResult[] } = $props()

  const W = 340
  const H = 90
  const B = 16
  const bw = $derived(bands.length ? W / bands.length : 0)
  const y = (share: number) => H - Math.max(0, Math.min(1, share)) * H
  const k = (n: number) => `${Math.round(n / 1000)}k`
</script>

<svg viewBox="0 0 {W} {H + B}" role="img" aria-label="Share known per frequency band">
  <line x1="0" x2={W} y1={H + 0.5} y2={H + 0.5} stroke="var(--border)" />
  <line x1="0" x2={W} y1="0.5" y2="0.5" stroke="var(--border)" stroke-dasharray="2 4" />
  {#each bands as b, i (b.from)}
    {@const h = H - y(b.known)}
    {#if h > 0}<rect x={i * bw + bw * 0.15} y={y(b.known)} width={bw * 0.7} height={h} rx="1.5" fill="var(--accent)" opacity="0.85"><title>{k(b.from - 1)}–{k(b.to)}: {Math.round(b.known * 100)}% by the test</title></rect>{/if}
    {#if b.srs > 0}<line x1={i * bw + bw * 0.05} x2={i * bw + bw * 0.95} y1={y(b.srs)} y2={y(b.srs)} stroke="var(--text)" stroke-width="2" stroke-linecap="round" />{/if}
  {/each}
  {#each bands as b, i (b.from)}
    {#if i === 0 || (i + 1) % 10 === 0}<text x={i === 0 ? 0 : (i + 1) * bw} y={H + B - 3} class="ax" text-anchor={i === 0 ? 'start' : 'end'}>{k(b.to)}</text>{/if}
  {/each}
</svg>
<div class="legend">
  <span><i class="bar"></i>known by the test</span>
  <span><i class="tick"></i>known in the app</span>
</div>

<style>
  svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .ax {
    font-size: 11px;
    fill: var(--faint);
  }
  .legend {
    display: flex;
    gap: 16px;
    margin-top: 8px;
    font-size: 13px;
    color: var(--muted);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .bar {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--accent);
  }
  .tick {
    width: 12px;
    height: 2px;
    border-radius: 1px;
    background: var(--text);
  }
</style>
