<script lang="ts">
  import { api, status } from '../lib/app.svelte.ts'
  import { getDecks } from '../lib/decks.ts'
  import { session } from '../lib/review.svelte.ts'
  import { tagTree, type TagNode } from '../lib/tagTree.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'
  import ConfirmButton from './ConfirmButton.svelte'
  import Icon from './Icon.svelte'
  import Sheet from './Sheet.svelte'

  // A deck's tags as a tree with counts. Tap one: rename it (with
  // everything under it: "a/x" → "b/x"; into an existing tag it merges) or
  // take it off every card.
  let { deckId, deckName, tags, onclose }: { deckId: string; deckName: string; tags: { tag: string; n: number }[]; onclose: () => void } = $props()

  let list = $state.raw((() => tags)())
  const tree = $derived(tagTree(list.map((t) => ({ value: t.tag, n: t.n }))))
  let open = $state<Record<string, boolean>>({})
  let editing = $state<string | null>(null)
  let to = $state('')
  let busy = $state(false)

  function edit(path: string) {
    editing = editing === path ? null : path
    to = path
  }

  async function after(text: string) {
    showToast(text)
    status.wordsVersion++
    status.factsVersion++
    const ds = await getDecks(true).catch(() => null)
    const d = ds?.find((x) => x.id === deckId)
    if (d) list = d.tags
    editing = null
    void session.refresh()
  }

  async function rename(from: string) {
    const target = to.split('/').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('/')
    if (!target || target === from || busy) return
    busy = true
    try {
      const r = await api.renameTag(deckId, from, target)
      await after(`Renamed on ${r.cards} ${r.cards === 1 ? 'card' : 'cards'}`)
    } catch (e) {
      showToast(`Not renamed: ${errorText(e)}`)
    } finally {
      busy = false
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
    <div class="node" style="--depth: {depth}">
      {#if t.children.length}
        <button class="chev" class:on={open[t.path]} onclick={() => (open = { ...open, [t.path]: !open[t.path] })} aria-label="{open[t.path] ? 'Hide' : 'Show'} the tags under {t.name}" aria-expanded={!!open[t.path]}>
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
      <form class="edit" style="--depth: {depth}" onsubmit={(e) => { e.preventDefault(); void rename(t.path) }}>
        <!-- svelte-ignore a11y_autofocus -->
        <input bind:value={to} autofocus aria-label="New name for {t.path}" autocomplete="off" autocapitalize="off" maxlength="100" />
        <div class="edit-row">
          <button class="btn small primary" type="submit" disabled={busy || !to.trim() || to.trim() === t.path}>Rename</button>
          <ConfirmButton class="btn small danger" onconfirm={() => void remove(t.path)} confirmLabel="Remove from {t.n} {t.n === 1 ? 'card' : 'cards'}" disabled={busy}>
            <Icon name="trash" size={15} /> Remove
          </ConfirmButton>
        </div>
        <p class="hint">{t.children.length ? 'The tags under it follow. ' : ''}A name that exists merges into it; "a/b" nests.</p>
      </form>
    {/if}
    {#if t.children.length && open[t.path]}{@render rows(t.children, depth + 1)}{/if}
  {/each}
{/snippet}

<Sheet title="Tags in {deckName}" {onclose}>
  {#if tree.length}
    <div class="tree">{@render rows(tree, 0)}</div>
  {:else}
    <p class="hint">No tags here yet.</p>
  {/if}
  <div class="actions"><button class="btn block" onclick={onclose}>Done</button></div>
</Sheet>

<style>
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
