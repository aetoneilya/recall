<script lang="ts">
  import Header from '../components/Header.svelte'
  import Icon from '../components/Icon.svelte'
  import { api, status } from '../lib/app.svelte.ts'
  import { getDecks } from '../lib/decks.ts'
  import { session } from '../lib/review.svelte.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'
  import type { DeckWithCounts, PackInfo } from '../lib/types.ts'
  import { LEVEL_NAMES, type Level } from '../lib/onboarding.svelte.ts'

  let decks = $state<DeckWithCounts[]>([])
  let loading = $state(true)
  let error = $state('')
  async function load() {
    loading = true
    error = ''
    try {
      [decks, packs] = await Promise.all([getDecks(true), api.packs()])
    } catch (e) {
      error = errorText(e)
    } finally {
      loading = false
    }
  }
  // Content packs, added with one tap into the deck picked for each. The
  // starter word sets (one per level) get a compact list of their own.
  let packs = $state<PackInfo[]>([])
  const starters = $derived(packs.filter((p) => p.format === 'words'))
  const otherPacks = $derived(packs.filter((p) => p.format !== 'words'))
  let packDeck = $state<Record<string, string>>({})
  let addingPack = $state<string | null>(null)
  async function addPack(p: PackInfo) {
    if (addingPack) return
    addingPack = p.id
    try {
      const r = await api.addPack(p.id, packDeck[p.id] || p.deckId)
      packs = r.packs
      const deck = r.packs.find((x) => x.id === p.id)?.deckName ?? p.deckName
      const unit = p.format === 'words' ? (r.added === 1 ? 'word' : 'words') : r.added === 1 ? 'card' : 'cards'
      showToast(`Added ${r.added} ${unit} to “${deck}”${r.duplicates ? ` · ${r.duplicates} already there` : ''}`)
      status.factsVersion++
      status.wordsVersion++
      void getDecks(true).then((x) => (decks = x)).catch(() => {})
      void session.refresh()
    } catch (e) {
      showToast(`Not added: ${errorText(e)}`)
    } finally {
      addingPack = null
    }
  }

  void load()
</script>

<div class="screen">
  <Header title="Packs" />
  <p class="intro">Ready-made cards to add to your collection.</p>
  {#if error}
    <div class="group"><div class="row"><span class="grow muted">{error}</span><button class="btn" onclick={load}>Retry</button></div></div>
  {:else if loading}
    <p class="caption">Loading packs…</p>
  {:else if !packs.length}
    <p class="caption">No packs available yet.</p>
  {/if}
  {#if otherPacks.length}
    <div class="section-label">Packs</div>
    <div class="group">
      {#each otherPacks as p (p.id)}
        <div class="row pack">
          <span class="grow">{p.name} <span class="muted">· {p.count} cards</span>{#if p.description}<span class="sub">{p.description}</span>{/if}
            {#if p.added && !p.missing}
              <span class="sub">In “{p.deckName}”</span>
            {:else}
              <label class="sub into">Into
                <select bind:value={() => packDeck[p.id] ?? p.deckId ?? '', (v) => (packDeck[p.id] = v)} aria-label="Deck for {p.name}">
                  {#if !p.deckId}<option value="">New deck “{p.deckName}”</option>{/if}
                  {#each decks as x (x.id)}<option value={x.id}>{x.name}</option>{/each}
                </select>
              </label>
            {/if}
          </span>
          {#if p.added && !p.missing}
            <span class="added"><Icon name="check" size={16} stroke={2.2} /> Added</span>
          {:else}
            <button class="btn small" onclick={() => addPack(p)} disabled={addingPack === p.id}>
              {addingPack === p.id ? 'Adding…' : p.added ? `Add ${p.missing} new` : 'Add'}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if starters.length}
    <div class="section-label">Starter words</div>
    <div class="group">
      {#each starters as p (p.id)}
        <div class="row pack">
          <span class="grow"><b class="lvl">{p.level}</b> {p.level ? LEVEL_NAMES[p.level as Level] ?? '' : p.name} <span class="muted">· {p.count.toLocaleString('en-US')} words</span></span>
          {#if p.added && !p.missing}
            <span class="added"><Icon name="check" size={16} stroke={2.2} /> Added</span>
          {:else}
            <button class="btn small" onclick={() => addPack(p)} disabled={addingPack === p.id} aria-label="Add {p.name}">
              {addingPack === p.id ? 'Adding…' : p.added ? `Add ${p.missing} new` : 'Add'}
            </button>
          {/if}
        </div>
      {/each}
    </div>
    <p class="caption">Common words for each level, most useful first, into “{starters[0]!.deckName}” and tagged Starter/&lt;level&gt;. Words you already have are skipped.</p>
  {/if}
</div>
<style>
  .grow {
    flex: 1;
    min-width: 0;
  }
  .sub {
    display: block;
    font-size: 13px;
    color: var(--muted);
  }
  .caption {
    font-size: 13px;
    line-height: 1.4;
    color: var(--muted);
    margin: 8px 16px 0;
    text-wrap: pretty;
  }
  .btn.small {
    min-height: 40px;
    padding: 0 12px;
    font-size: 15px;
    flex: none;
  }
  .into select {
    margin-left: 4px;
    min-height: 40px;
    padding: 0 8px;
    font-size: 13px;
    width: auto;
    max-width: 60%;
  }
  .lvl {
    display: inline-block;
    min-width: 26px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  .pack .btn.small {
    flex: none;
    min-height: 40px;
    padding: 0 14px;
    font-size: 14px;
  }
  .added {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 14px;
    font-weight: 500;
    color: var(--accent);
  }
  .intro {
    color: var(--muted);
    margin: 0 0 20px;
    font-size: 15px;
  }
</style>
