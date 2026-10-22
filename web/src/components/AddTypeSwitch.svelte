<script lang="ts">
  import { addPath, rememberAddType, type AddType } from '../lib/add.ts'
  import { hasDeckLanguages } from '../lib/decks.ts'
  import { navigate, router } from '../lib/router.svelte.ts'
  import { haptic } from '../lib/telegram.ts'
  import type { DeckSettings } from '../lib/types.ts'

  // At the top of the add screens: Word · Question · Rule, switching in
  // place (the screen is replaced, the deck and "from" stay). Remembered.
  let { current, deck }: { current: AddType; deck: DeckSettings | undefined } = $props()
  const types = $derived<{ t: AddType; label: string }[]>([
    ...(!deck || hasDeckLanguages(deck) ? [{ t: 'word' as const, label: 'Word' }] : []),
    { t: 'question', label: 'Question' },
    { t: 'rule', label: 'Grammar rule' },
  ])
  $effect(() => rememberAddType(current))
  function go(t: AddType) {
    if (t === current) return
    haptic.select()
    rememberAddType(t)
    const from = router.route.query.get('from') ?? '/'
    navigate(addPath(t, deck, from), { replace: true })
  }
</script>

<div class="seg" role="tablist" aria-label="What to add">
  {#each types as x (x.t)}
    <button role="tab" aria-selected={x.t === current} class:on={x.t === current} onclick={() => go(x.t)}>{x.label}</button>
  {/each}
</div>

<style>
  .seg {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    padding: 2px;
    margin: 0 0 14px;
    border-radius: 10px;
    background: var(--surface-2);
  }
  .seg button {
    height: 40px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    color: var(--muted);
    transition: background-color var(--t-fast) ease, color var(--t-fast) ease;
  }
  .seg button.on {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
</style>
