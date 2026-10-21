<script lang="ts">
  // Frequency coverage: per rank band, words in the app (light) and known
  // (solid), scaled to the fullest band.
  let { bands }: { bands: { from: number; to: number; words: number; known: number }[] } = $props()

  const max = $derived(Math.max(1, ...bands.map((b) => b.words)))
  const k = (n: number) => `${Math.round(n / 1000)}k`
</script>

<div class="bands" role="table" aria-label="Words in the app and known, by frequency band">
  {#each bands as b (b.from)}
    <div class="band" role="row">
      <span class="name" role="rowheader" title="Ranks {b.from.toLocaleString('en-US')}–{b.to.toLocaleString('en-US')}">{k(b.to)}</span>
      <span class="track" role="cell">
        <span class="app" style="width: {(b.words / max) * 100}%"></span>
        <span class="known" style="width: {(b.known / max) * 100}%"></span>
      </span>
      <span class="nums" role="cell"><b>{b.known}</b> / {b.words}</span>
    </div>
  {/each}
</div>

<style>
  .bands {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .band {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .name {
    width: 30px;
    color: var(--muted);
    font-weight: 500;
  }
  .track {
    position: relative;
    flex: 1;
    height: 10px;
    border-radius: 5px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .track span {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 5px;
  }
  .app {
    background: color-mix(in srgb, var(--accent) 30%, var(--surface-2));
  }
  .known {
    background: var(--accent);
  }
  .nums {
    min-width: 72px;
    text-align: right;
    color: var(--muted);
  }
  .nums b {
    color: var(--text);
    font-weight: 600;
  }
</style>
