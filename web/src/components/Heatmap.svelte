<script lang="ts">
  import type { ActivityDay } from '../lib/types.ts'

  // Study days as a calendar: weeks are columns, Monday on top. Intensity
  // in the accent, four steps relative to the busiest day.
  let { days }: { days: ActivityDay[] } = $props()

  const weekday = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7
  const offset = $derived(days.length ? weekday(days[0].day) : 0)
  const cols = $derived(Math.ceil((offset + days.length) / 7))
  const max = $derived(Math.max(1, ...days.map((d) => d.reviews)))
  const level = (n: number) => (n <= 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)))
  // 26 weeks × 7: 10px cells, 2px gaps.
  const C = 10
  const G = 2
  const W = $derived(cols * (C + G) - G)
  const H = 7 * (C + G) - G
  const label = (d: ActivityDay) =>
    `${new Date(`${d.day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}: ${d.reviews} ${d.reviews === 1 ? 'review' : 'reviews'}`
</script>

<svg viewBox="0 0 {W} {H}" role="img" aria-label="Reviews per day, last {days.length} days">
  {#each days as d, i (d.day)}
    {@const k = offset + i}
    <rect x={Math.floor(k / 7) * (C + G)} y={(k % 7) * (C + G)} width={C} height={C} rx="2" class="l{level(d.reviews)}" class:today={i === days.length - 1}>
      <title>{label(d)}</title>
    </rect>
  {/each}
</svg>

<style>
  svg {
    width: 100%;
    max-width: 420px;
    height: auto;
    display: block;
  }
  rect {
    fill: var(--surface-2);
  }
  .l1 {
    fill: color-mix(in srgb, var(--accent) 30%, var(--surface-2));
  }
  .l2 {
    fill: color-mix(in srgb, var(--accent) 55%, var(--surface-2));
  }
  .l3 {
    fill: color-mix(in srgb, var(--accent) 78%, var(--surface-2));
  }
  .l4 {
    fill: var(--accent);
  }
  .today {
    stroke: var(--text);
    stroke-width: 1;
  }
</style>
