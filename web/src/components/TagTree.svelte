<script lang="ts">
  import { filterTree, tagState, tagTree, toggleTag, type TagNode, type TagState } from '../lib/tagTree.ts'
  import { haptic } from '../lib/telegram.ts'
  import Icon from './Icon.svelte'

  // Tags as a tree: top-level tags with counts, a chevron to open their
  // children. A tap picks a tag (cards with it, or with any tag under it),
  // narrowing what's already picked; a parent with something picked under it
  // shows mixed. A search field narrows the tree once there are more than a
  // handful. `count`: exact subtree counts.
  let {
    tags,
    selected = [],
    onchange,
    count,
    stateOf,
    ontoggle,
  }: { tags: { value: string; n: number }[]; selected?: string[]; onchange?: (next: string[]) => void; count?: (path: string) => number; stateOf?: (path: string) => TagState; ontoggle?: (path: string) => void } = $props()

  const tree = $derived(tagTree(tags, count))
  let q = $state('')
  let open = $state<Record<string, boolean>>({})
  const shown = $derived(filterTree(tree, q))
  const searching = $derived(!!q.trim())
  const many = $derived(tags.length > 8)

  function toggle(path: string) {
    haptic.select()
    if (ontoggle) ontoggle(path)
    else onchange?.(toggleTag(selected, path))
  }
</script>

{#snippet rows(nodes: TagNode[], depth: number)}
  {#each nodes as t (t.path)}
    {@const st = stateOf ? stateOf(t.path) : tagState(selected, t.path)}
    {@const expanded = searching || !!open[t.path]}
    <div class="node" style="--depth: {depth}">
      {#if t.children.length}
        <button class="chev" class:on={expanded} onclick={() => (open = { ...open, [t.path]: !open[t.path] })} aria-label="{expanded ? 'Hide' : 'Show'} the tags under {t.name}" aria-expanded={expanded}>
          <Icon name="chevron" size={14} stroke={2.2} />
        </button>
      {:else}
        <span class="chev-space"></span>
      {/if}
      <button class="tag" role="checkbox" aria-checked={st === 'on' ? 'true' : st === 'mixed' ? 'mixed' : 'false'} onclick={() => toggle(t.path)}>
        <span class="box {st}" aria-hidden="true">{#if st === 'on'}<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>{:else if st === 'mixed'}<i></i>{/if}</span>
        <span class="name">{t.name}</span>
        <b>{t.n}</b>
      </button>
    </div>
    {#if t.children.length && expanded}{@render rows(t.children, depth + 1)}{/if}
  {/each}
{/snippet}

{#if many}
  <div class="search">
    <Icon name="search" size={16} />
    <input type="search" bind:value={q} placeholder="Find a tag" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Find a tag" />
  </div>
{/if}
<div class="tree" role="group" aria-label="Tags">
  {@render rows(shown, 0)}
  {#if searching && !shown.length}<p class="none">No tag has “{q.trim()}”.</p>{/if}
</div>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 12px;
    margin-bottom: 6px;
    border-radius: 12px;
    background: var(--surface);
    color: var(--faint);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    padding: 0;
    background: none;
    box-shadow: none;
    font-size: 15px;
  }
  .tree {
    display: flex;
    flex-direction: column;
    border-radius: 14px;
    background: var(--surface);
    padding: 4px 0;
  }
  .node {
    display: flex;
    align-items: center;
    padding-left: calc(4px + var(--depth) * 22px);
  }
  .chev,
  .chev-space {
    flex: none;
    width: 36px;
    height: 44px;
  }
  .chev {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--faint);
  }
  .chev :global(svg) {
    transition: transform var(--t-fast) var(--ease-out);
  }
  .chev.on :global(svg) {
    transform: rotate(90deg);
  }
  .tag {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 0 14px 0 0;
    text-align: left;
    font-size: 15px;
    color: var(--text);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag b {
    flex: none;
    font-weight: 600;
    font-size: 13px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .box {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1.5px var(--hairline);
    transition: background-color var(--t-fast) ease;
  }
  .box.on {
    background: var(--accent);
    box-shadow: none;
  }
  .box.on svg {
    fill: none;
    stroke: var(--accent-text);
    stroke-width: 2.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .box.mixed {
    background: var(--accent-soft);
    box-shadow: none;
  }
  .box.mixed i {
    width: 10px;
    height: 2.5px;
    border-radius: 2px;
    background: var(--accent);
  }
  .none {
    margin: 8px 16px;
    font-size: 14px;
    color: var(--muted);
  }
</style>
