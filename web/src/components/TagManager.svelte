<script lang="ts">
  import { tagMatches } from '@recall/core'
  import { api, status } from '../lib/app.svelte.ts'
  import { getDecks } from '../lib/decks.ts'
  import { session } from '../lib/review.svelte.ts'
  import { filterTree, tagTree, type TagNode } from '../lib/tagTree.ts'
  import { errorText, showToast, type ToastAction } from '../lib/toast.svelte.ts'
  import ConfirmButton from './ConfirmButton.svelte'
  import Icon from './Icon.svelte'
  import Sheet from './Sheet.svelte'

  // A deck's tags as a tree with counts. Tap one: rename it (with
  // everything under it: "a/x" → "b/x"; into an existing tag it merges) or
  // take it off every card. A plain rename has Undo (renaming back); a merge
  // can't be undone that way, so it asks first.
  let { deckId, deckName, tags, onclose }: { deckId: string; deckName: string; tags: { tag: string; n: number }[]; onclose: () => void } = $props()

  // The deck's flat tags until the filter options arrive: those also hold
  // every parent path with its exact count (a card with two Grammar/… tags
  // is one card), as the filter sheet shows them.
  let list = $state.raw((() => tags.map((t) => ({ value: t.tag, n: t.n })))())
  const tree = $derived(tagTree(list))
  let q = $state('')
  const searching = $derived(!!q.trim())
  const shown = $derived(filterTree(tree, q))
  let open = $state<Record<string, boolean>>({})
  let editing = $state<string | null>(null)
  let to = $state('')
  let busy = $state(false)

  // As the server cleans a new tag: segments trimmed, empty ones dropped.
  const target = $derived(to.split('/').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('/'))
  const intoItself = (from: string) => target !== from && tagMatches(from, target)
  const merges = (from: string) => target !== from && list.some((t) => tagMatches(target, t.value))

  async function load() {
    const o = await api.reviewOptions(deckId, null).catch(() => null)
    if (o) list = o.tags
  }
  void load()

  function edit(path: string) {
    editing = editing === path ? null : path
    to = path
  }

  async function after(text: string, action?: ToastAction) {
    showToast(text, { action })
    status.wordsVersion++
    status.factsVersion++
    void getDecks(true).catch(() => null)
    await load()
    editing = null
    void session.refresh()
  }

  const cards = (n: number) => `${n} ${n === 1 ? 'card' : 'cards'}`

  async function rename(from: string) {
    const into = target
    if (!into || into === from || intoItself(from) || busy) return
    busy = true
    try {
      const r = await api.renameTag(deckId, from, into)
      await after(`Renamed on ${cards(r.cards)}`, r.merged ? undefined : { label: 'Undo', run: () => void renameBack(into, from) })
    } catch (e) {
      showToast(`Not renamed: ${errorText(e)}`)
    } finally {
      busy = false
    }
  }

  async function renameBack(from: string, into: string) {
    try {
      await api.renameTag(deckId, from, into)
      await after(`Back to “${into}”`)
    } catch (e) {
      showToast(`Not undone: ${errorText(e)}`)
    }
  }

  async function remove(tag: string) {
    busy = true
    try {
      const r = await api.deleteTag(deckId, tag)
      await after(`Removed from ${r.cards} ${r.cards === 1 ? 'card' : 'cards'}`)
    } catch (e) {
      showToast(`Not removed: ${errorText(e)}`)
    } finally {
      busy = false
    }
  }
</script>

{#snippet rows(nodes: TagNode[], depth: number)}
  {#each nodes as t (t.path)}
    {@const expanded = searching || !!open[t.path]}
    <div class="node" style="--depth: {depth}">
      {#if t.children.length}
        <button class="chev" class:on={expanded} onclick={() => (open = { ...open, [t.path]: !open[t.path] })} aria-label="{expanded ? 'Hide' : 'Show'} the tags under {t.name}" aria-expanded={expanded}>
          <Icon name="chevron" size={14} stroke={2.2} />
        </button>
      {:else}
        <span class="chev-space"></span>
      {/if}
      <button class="tag" class:sel={editing === t.path} onclick={() => edit(t.path)}>
        <span class="name">{t.name}</span><b>{t.n}</b>
      </button>
    </div>
    {#if editing === t.path}
      <form class="edit" style="--depth: {depth}" onsubmit={(e) => { e.preventDefault(); if (!merges(t.path)) void rename(t.path) }}>
        <!-- svelte-ignore a11y_autofocus -->
        <input bind:value={to} autofocus aria-label="New name for {t.path}" autocomplete="off" autocapitalize="off" maxlength="100" />
        <div class="edit-row">
          {#if merges(t.path) && !intoItself(t.path)}
            <ConfirmButton class="btn small primary" onconfirm={() => void rename(t.path)} confirmLabel="Merge into {target}" disabled={busy}>Merge</ConfirmButton>
          {:else}
            <button class="btn small primary" type="submit" disabled={busy || !target || target === t.path || intoItself(t.path)}>Rename</button>
          {/if}
          <ConfirmButton class="btn small danger" onconfirm={() => void remove(t.path)} confirmLabel="Remove from {t.n} {t.n === 1 ? 'card' : 'cards'}" disabled={busy}>
            <Icon name="trash" size={15} /> Remove
          </ConfirmButton>
        </div>
        <p class="hint">{#if intoItself(t.path)}A tag can't move under itself.{:else}{t.children.length ? 'The tags under it follow. ' : ''}A name that exists merges into it; "a/b" nests.{/if}</p>
      </form>
    {/if}
    {#if t.children.length && expanded}{@render rows(t.children, depth + 1)}{/if}
  {/each}
{/snippet}

<Sheet title="Tags in {deckName}" {onclose}>
  {#if tree.length}
    {#if list.length > 8}
      <div class="search">
        <Icon name="search" size={16} />
        <input type="search" bind:value={q} placeholder="Find a tag" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Find a tag" />
      </div>
    {/if}
    <div class="tree">
      {@render rows(shown, 0)}
      {#if searching && !shown.length}<p class="hint none">No tag has “{q.trim()}”.</p>{/if}
    </div>
  {:else}
    <p class="hint">No tags here yet.</p>
  {/if}
  <div class="actions"><button class="btn block" onclick={onclose}>Done</button></div>
</Sheet>

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
  .none {
    padding: 12px 14px;
  }
  .tree {
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
    padding-right: 14px;
    text-align: left;
    font-size: 15px;
    color: var(--text);
  }
  .tag.sel .name {
    color: var(--accent);
    font-weight: 600;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag b {
    font-weight: 600;
    font-size: 13px;
    color: var(--faint);
  }
  .edit {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 14px 12px calc(40px + var(--depth) * 22px);
    animation: rise-sm var(--t-fast) var(--ease-out) both;
  }
  .edit input {
    padding: 9px 12px;
  }
  .edit-row {
    display: flex;
    gap: 8px;
  }
  .edit-row :global(.btn.small) {
    min-height: 40px;
    padding: 0 14px;
    font-size: 14px;
  }
  .hint {
    margin: 0;
    font-size: 12.5px;
    color: var(--faint);
  }
  .actions {
    margin-top: 16px;
  }
</style>
