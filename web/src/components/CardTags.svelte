<script lang="ts">
  import { tagLabel } from '../lib/tagTree.ts'

  // A card's tags, small and muted in its context row: nested ones as
  // "Grammar › Articles & nouns", the first three then "+N". `claude` is for
  // filtering only, so it isn't shown.
  // `lead`: a dot before the first one too (something precedes it in the row).
  let { tags, max = 3, lead = true }: { tags: string[]; max?: number; lead?: boolean } = $props()
  const shown = $derived(tags.filter((t) => t !== 'claude'))
</script>

{#each shown.slice(0, max) as t (t)}
  {@const l = tagLabel(t)}
  <span class="tag" class:dot={lead}>{#if l.parent}<i>{`${l.parent} › `}</i>{/if}{l.leaf}</span>
{/each}
{#if shown.length > max}<span class="tag more" class:dot={lead || max > 0}>+{shown.length - max}</span>{/if}

<style>
  .tag {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag.dot::before,
  .tag + .tag::before {
    content: '·';
    margin-right: 6px;
    color: var(--faint);
  }
  .tag i {
    font-style: normal;
    opacity: 0.65;
  }
  .more {
    flex: none;
  }
</style>
