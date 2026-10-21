<script lang="ts">
  // One series over time: a line with a soft area under it, the latest
  // value marked. Plain SVG; colours from tokens.
  let { data, label }: { data: { date: string; value: number }[]; label: string } = $props()

  const W = 340
  const H = 110
  const TOP = 10
  const BOTTOM = 18
  const max = $derived(Math.max(1, ...data.map((d) => d.value)))
  const x = (i: number) => (data.length > 1 ? (i / (data.length - 1)) * (W - 8) + 4 : W / 2)
  const y = (v: number) => TOP + (1 - v / max) * (H - TOP)
  const line = $derived(data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(''))
  const area = $derived(data.length ? `${line}L${x(data.length - 1).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z` : '')
  const last = $derived(data.at(-1))
  const month = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
</script>

<svg viewBox="0 0 {W} {H + BOTTOM}" role="img" aria-label={label}>
  <line x1="0" x2={W} y1={H + 0.5} y2={H + 0.5} stroke="var(--border)" />
  <line x1="0" x2={W} y1={TOP + 0.5} y2={TOP + 0.5} stroke="var(--border)" stroke-dasharray="2 4" />
  {#if data.length}
    <path d={area} fill="var(--accent)" opacity="0.12" />
    <path d={line} fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    {#if last}<circle cx={x(data.length - 1)} cy={y(last.value)} r="3.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" />{/if}
    <text x="2" y={H + BOTTOM - 3} class="ax">{month(data[0].date)}</text>
    <text x={W - 2} y={H + BOTTOM - 3} class="ax" text-anchor="end">{month(data[data.length - 1].date)}</text>
  {/if}
  <text x="2" y={TOP - 2} class="ax">{max.toLocaleString('en-US')}</text>
</svg>

<style>
  svg {
    width: 100%;
    height: auto;
    display: block;
    overflow: visible;
  }
  .ax {
    font-size: 11px;
    fill: var(--faint);
    font-variant-numeric: tabular-nums;
  }
</style>
