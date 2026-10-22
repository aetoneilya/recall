<script lang="ts">
  // One deck at a time: the user's decks as pills with what each has
  // (`n`), the selected one in the accent. With a single deck, just its name.
  let {
    options,
    selected,
    onselect,
    label = 'Deck',
  }: { options: { id: string; name: string; n?: number }[]; selected: string; onselect: (id: string) => void; label?: string } = $props()
</script>

{#if options.length > 1}
  <div class="decks" role="radiogroup" aria-label={label}>
    {#each options as d (d.id)}
      <button class="deck" role="radio" aria-checked={d.id === selected} class:on={d.id === selected} onclick={() => onselect(d.id)}>
        {d.name}{#if d.n !== undefined}<b>{d.n}</b>{/if}
      </button>
    {/each}
  </div>
{:else if options.length === 1}
  <p class="one">{options[0]!.name}</p>
{/if}

<style>
  .decks {
    display: flex;
    gap: 6px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .decks::-webkit-scrollbar {
    display: none;
  }
  .deck {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 13px;
    border-radius: 16px;
    font-size: 15px;
    font-weight: 500;
    white-space: nowrap;
    color: var(--muted);
    background: var(--surface);
    font-variant-numeric: tabular-nums;
    transition:
      background-color var(--t-fast) ease,
      color var(--t-fast) ease,
      transform var(--t-press) var(--ease-out);
  }
  .deck b {
    font-weight: 650;
    color: var(--faint);
  }
  .deck.on {
    color: var(--accent-text);
    background: var(--accent);
  }
  .deck.on b {
    color: inherit;
    opacity: 0.85;
  }
  .deck:active {
    transform: scale(0.96);
  }
  .one {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
