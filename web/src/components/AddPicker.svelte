<script lang="ts">
  import { hasDeckLanguages } from '../lib/decks.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import type { DeckSettings } from '../lib/types.ts'
  import Icon from './Icon.svelte'
  import Sheet from './Sheet.svelte'

  // "+": what to add to a deck — a word (only with the deck's languages), a
  // question, or a grammar rule (a question reviewed through exercises).
  let { deck, from, onclose }: { deck: DeckSettings | undefined; from: string; onclose: () => void } = $props()

  const q = (extra = '') => `?from=${encodeURIComponent(from)}${deck ? `&deck=${encodeURIComponent(deck.id)}` : ''}${extra}`
  function go(path: string) {
    onclose()
    navigate(path)
  }
</script>

<Sheet title="Add to {deck?.name ?? 'deck'}">
  <div class="group">
    {#if !deck || hasDeckLanguages(deck)}
      <button class="row" onclick={() => go(`/add${q()}`)}>
        <span class="grow">Word<span class="sub">A translation, both directions; ✨ fills it in</span></span>
        <Icon name="chevron" size={18} />
      </button>
    {/if}
    <button class="row" onclick={() => go(`/fact/new${q()}`)}>
      <span class="grow">Question<span class="sub">A question and its answer, Markdown</span></span>
      <Icon name="chevron" size={18} />
    </button>
    <button class="row" onclick={() => go(`/fact/new${q('&rule=1')}`)}>
      <span class="grow">Grammar rule<span class="sub">A rule reviewed through tap exercises (three or more)</span></span>
      <Icon name="chevron" size={18} />
    </button>
  </div>
  <div class="actions"><button class="btn block" onclick={onclose}>Cancel</button></div>
</Sheet>

<style>
  .group {
    margin-top: 10px;
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-weight: 600;
  }
  .sub {
    font-size: 13.5px;
    font-weight: 400;
    color: var(--muted);
  }
  .row :global(svg) {
    color: var(--faint);
  }
  .actions {
    margin-top: 14px;
  }
</style>
