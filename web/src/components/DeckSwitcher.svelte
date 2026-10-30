<script lang="ts">
  import { haptic } from '../lib/telegram.ts'

  // One deck at a time: a compact "English 23 ▾" that opens a small menu of
  // the decks with what each has today, the current one checked. A single
  // deck: just its name.
  type Option = { id: string; name: string; n?: number; counts?: { new: number; learning: number; review: number } }
  let { options, selected, onselect, label = 'Deck', countLabel = 'today' }: { options: Option[]; selected: string; onselect: (id: string) => void; label?: string; countLabel?: string } = $props()

  let open = $state(false)
  let root: HTMLElement | undefined = $state()
  const current = $derived(options.find((d) => d.id === selected) ?? options[0])

  function pick(id: string) {
    open = false
    if (id !== selected) {
      haptic.select()
      onselect(id)
    }
  }
  function toggle() {
    open = !open
    if (open) haptic.select()
  }
  // A tap anywhere else, or Escape, closes the menu.
  function outside(e: Event) {
    if (open && root && !root.contains(e.target as Node)) open = false
  }
  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      open = false
    }
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={onKey} />

{#if options.length > 1}
  <div class="dd" bind:this={root}>
    <button class="btn-dd" class:open onclick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label="{label}: {current?.name}{current?.n !== undefined ? `, ${current.n} ${countLabel}` : ''}">
      <span class="name">{current?.name}</span>
      {#if current?.n !== undefined}<b>{current.n}</b>{/if}
      <svg class="chev" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {#if open}
      <div class="menu" role="menu" aria-label={label}>
        {#each options as d (d.id)}
          <button role="menuitemradio" aria-checked={d.id === selected} class:sel={d.id === selected} onclick={() => pick(d.id)}>
            <span class="check" aria-hidden="true">{#if d.id === selected}<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>{/if}</span>
            <span class="mname">{d.name}</span>
            {#if d.counts}
              <span class="cnt"><i class="n" class:z={!d.counts.new}>{d.counts.new}</i><i class="l" class:z={!d.counts.learning}>{d.counts.learning}</i><i class="r" class:z={!d.counts.review}>{d.counts.review}</i></span>
            {:else if d.n !== undefined}<span class="cnt">{d.n}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{:else if options.length === 1}
  <p class="one">{options[0]!.name}</p>
{/if}

<style>
  .dd {
    position: relative;
    display: inline-block;
    max-width: 100%;
  }
  .btn-dd {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: 40px;
    padding: 0 10px 0 6px;
    border-radius: 12px;
    font-size: 17px;
    font-weight: 650;
    color: var(--text);
    -webkit-user-select: none;
    user-select: none;
    transition: background-color var(--t-fast) ease;
  }
  .btn-dd:active,
  .btn-dd.open {
    background: var(--surface);
  }
  .btn-dd .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn-dd b {
    font-size: 14px;
    font-weight: 600;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .chev {
    flex: none;
    fill: none;
    stroke: var(--muted);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform var(--t-fast) var(--ease-out);
  }
  .btn-dd.open .chev {
    transform: rotate(180deg);
  }
  /* A small popover under the control, not a sheet. */
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 30;
    min-width: 220px;
    max-width: min(320px, calc(100vw - 32px));
    padding: 4px;
    border-radius: 14px;
    background: var(--surface);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 10px 28px rgba(0, 0, 0, 0.18);
    transform-origin: top left;
    animation: pop 160ms var(--ease-out);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(-4px) scale(0.98);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .menu {
      animation: fade-in 120ms ease;
    }
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 0 12px 0 8px;
    border-radius: 10px;
    text-align: left;
    font-size: 15px;
    color: var(--text);
  }
  .menu button:active {
    background: var(--surface-2);
  }
  .menu .sel .mname {
    font-weight: 600;
  }
  .check {
    flex: none;
    width: 18px;
    display: flex;
  }
  .check svg {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .mname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cnt {
    flex: none;
    display: inline-flex;
    gap: 8px;
    font-size: 13px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .cnt i {
    font-style: normal;
    font-weight: 600;
  }
  .cnt .n {
    color: var(--c-new);
  }
  .cnt .l {
    color: var(--c-learn);
  }
  .cnt .r {
    color: var(--c-review);
  }
  .cnt .z {
    color: var(--faint);
    font-weight: 500;
  }
  .one {
    margin: 0;
    padding: 0 6px;
    font-size: 17px;
    font-weight: 650;
    line-height: 40px;
  }
</style>
