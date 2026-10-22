<script lang="ts">
  // Under a comma-separated tags field: the deck's tags that start (or
  // contain) what is being typed after the last comma; a tap completes it.
  // Paths ("Grammar/Tenses") complete like any tag.
  let { value = $bindable(), tags }: { value: string; tags: string[] } = $props()

  const parts = $derived(value.split(','))
  const typing = $derived((parts.at(-1) ?? '').trim().toLowerCase())
  const have = $derived(new Set(parts.slice(0, -1).map((p) => p.trim())))
  const shown = $derived.by(() => {
    if (!typing) return []
    const starts = tags.filter((t) => !have.has(t) && t.toLowerCase().startsWith(typing))
    const inside = tags.filter((t) => !have.has(t) && !t.toLowerCase().startsWith(typing) && t.toLowerCase().includes(typing))
    return [...starts, ...inside].filter((t) => t.toLowerCase() !== typing).slice(0, 6)
  })

  function pick(t: string) {
    value = [...parts.slice(0, -1).map((p) => p.trim()).filter(Boolean), t].join(', ') + ', '
  }
</script>

{#if shown.length}
  <div class="suggest" role="listbox" aria-label="Tags in this deck">
    {#each shown as t (t)}
      <button type="button" role="option" aria-selected="false" onmousedown={(e) => e.preventDefault()} onclick={() => pick(t)}>{t}</button>
    {/each}
  </div>
{/if}

<style>
  .suggest {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 2px;
  }
  .suggest button {
    min-height: 36px;
    padding: 0 12px;
    border-radius: 18px;
    font-size: 14px;
    color: var(--accent);
    background: var(--accent-soft);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
