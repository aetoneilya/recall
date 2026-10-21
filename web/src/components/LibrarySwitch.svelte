<script lang="ts">
  import { setLibraryKind, wordsView } from '../lib/wordsView.svelte.ts'

  // Words · Topics: the two collections of the Words tab, an iOS segmented
  // control under the large title. Shown only once a topic deck exists.
</script>

<div class="seg" role="tablist" aria-label="Collection">
  <button role="tab" aria-selected={wordsView.kind === 'words'} class:on={wordsView.kind === 'words'} onclick={() => setLibraryKind('words')}>Words</button>
  <button role="tab" aria-selected={wordsView.kind === 'facts'} class:on={wordsView.kind === 'facts'} onclick={() => setLibraryKind('facts')}>Topics</button>
</div>

<style>
  .seg {
    display: grid;
    grid-template-columns: 1fr 1fr;
    margin: -2px 0 10px;
    padding: 3px;
    border-radius: 12px;
    background: var(--surface-2);
  }
  .seg button {
    height: 32px;
    border-radius: 9px;
    font-size: 15px;
    font-weight: 500;
    color: var(--muted);
    transition:
      background-color var(--t-fast) ease,
      color var(--t-fast) ease;
  }
  .seg button.on {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.08),
      0 2px 8px -2px rgba(0, 0, 0, 0.1);
  }
</style>
