<script lang="ts">
  import { haptic } from '../lib/telegram.ts'
  import Sheet from './Sheet.svelte'

  // One deck at a time. Up to three decks: pills with what each has (`n`),
  // the selected one in the accent. More: one button that opens a sheet of
  // decks with their new · learning · due. A single deck: just its name.
  type Option = { id: string; name: string; n?: number; counts?: { new: number; learning: number; review: number } }
  let { options, selected, onselect, label = 'Deck' }: { options: Option[]; selected: string; onselect: (id: string) => void; label?: string } = $props()

  let open = $state(false)
  const current = $derived(options.find((d) => d.id === selected) ?? options[0])
  const today = $derived(options.reduce((n, d) => n + (d.n ?? 0), 0))
  function pick(id: string) {
    open = false
    if (id !== selected) {
      haptic.select()
      onselect(id)
    }
  }
</script>

{#if options.length > 3}
  <button class="deck on summary" onclick={() => (open = true)} aria-haspopup="dialog" aria-label="{label}: {current?.name}">
    {current?.name}{#if current?.n !== undefined}<b>{current.n}</b>{/if}<span class="chev" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <Sheet title="Decks" onclose={() => (open = false)}>
      <div class="group">
        {#each options as d (d.id)}
          <button class="row pick" class:sel={d.id === selected} onclick={() => pick(d.id)}>
            <span class="grow name">{d.name}</span>
            {#if d.counts}
              <span class="cnt"><i class="n">{d.counts.new}</i> · <i class="l">{d.counts.learning}</i> · <i class="r">{d.counts.review}</i></span>
            {:else if d.n !== undefined}<span class="cnt">{d.n}</span>{/if}
            <span class="check" aria-hidden="true">{d.id === selected ? '✓' : ''}</span>
          </button>
        {/each}
      </div>
      <p class="foot">{today} {today === 1 ? 'card' : 'cards'} today{today ? ` · ≈ ${Math.max(1, Math.round((today * 15) / 60))} min` : ''}</p>
      <div class="actions"><button class="btn block" onclick={() => (open = false)}>Close</button></div>
    </Sheet>
  {/if}
{:else if options.length > 1}
  <div class="decks" role="radiogroup" aria-label={label}>
    {#each options as d (d.id)}
      <button class="deck" role="radio" aria-checked={d.id === selected} class:on={d.id === selected} onclick={() => pick(d.id)}>
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
  .summary {
    max-width: 100%;
  }
  .chev {
    font-size: 11px;
    opacity: 0.7;
  }
  .pick {
    gap: 12px;
  }
  .pick .name {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cnt {
    flex: none;
    font-size: 14px;
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
  .check {
    flex: none;
    width: 18px;
    color: var(--accent);
    font-weight: 700;
  }
  .foot {
    margin: 10px 4px 0;
    font-size: 13px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .actions {
    margin-top: 16px;
  }
  /* The pill keeps its size; the tap area is 44px tall. */
  .deck {
    position: relative;
  }
  .deck::after {
    content: '';
    position: absolute;
    inset: -6px -2px;
  }
</style>
