<script lang="ts">
  import ConfirmButton from '../components/ConfirmButton.svelte'
  import Header from '../components/Header.svelte'
  import Icon from '../components/Icon.svelte'
  import TagManager from '../components/TagManager.svelte'
  import { api, status } from '../lib/app.svelte.ts'
  import { getDecks, hasDeckLanguages, saveDeck } from '../lib/decks.ts'
  import { session } from '../lib/review.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'
  import type { DeckPatch, DeckWithCounts, TypeAnswer } from '../lib/types.ts'

  let { id }: { id?: string } = $props()
  // The review screen's cached copy paints the study settings at once (and
  // offline); the fetch below brings fresh counts.
  let decks = $state<DeckWithCounts[]>(
    (Object.values(session.decks) as Partial<DeckWithCounts>[]).every((d) => d.counts) ? ($state.snapshot(Object.values(session.decks)) as DeckWithCounts[]) : [],
  )
  let loading = $state(true)
  let error = $state('')
  async function load() {
    loading = true
    error = ''
    try {
      decks = await getDecks(true)
    } catch (e) {
      error = errorText(e)
    } finally {
      loading = false
    }
  }
  void load()
  const selected = $derived(decks.find((d) => d.id === id))

  const hasLangs = (d: DeckWithCounts) => hasDeckLanguages(d)

  // Renaming a deck in place: tap its name, type, Enter (or leave the field).
  let renaming = $state<string | null>(null)
  let newName = $state('')
  function startRename(d: DeckWithCounts) {
    renaming = d.id
    newName = d.name
  }
  async function rename(d: DeckWithCounts) {
    if (renaming !== d.id) return
    renaming = null
    const name = newName.replace(/\s+/g, ' ').trim()
    if (!name || name === d.name) return
    await patchDeck(d, { name })
  }

  // A deck and, after the second tap, every card in it with its history.
  async function removeDeck(d: DeckWithCounts) {
    const before = decks
    decks = decks.filter((x) => x.id !== d.id)
    try {
      const r = await api.deleteDeck(d.id, true)
      const n = r.words + r.facts
      showToast(n ? `Deleted “${d.name}” and ${n} ${n === 1 ? 'card' : 'cards'}` : `Deleted “${d.name}”`)
      status.factsVersion++
      status.wordsVersion++
      void getDecks(true).catch(() => {})
      void session.refresh()
      navigate('/decks', { replace: true })
    } catch (e) {
      decks = before
      showToast(`Not deleted: ${errorText(e)}`)
    }
  }

  // The deck whose tags are being managed (a sheet).
  let tagsDeck = $state<DeckWithCounts | null>(null)

  // A deck into another: its cards move with its name as a tag; the emptied
  // deck goes. Cards the target already has stay behind (and are listed).
  async function merge(d: DeckWithCounts, intoId: string, el: HTMLSelectElement) {
    el.value = ''
    const into = decks.find((x) => x.id === intoId)
    if (!into) return
    try {
      const r = await api.mergeDeck(d.id, into.id)
      const n = r.moved.words + r.moved.facts
      const left = r.skipped.length ? ` · ${r.skipped.length} already there, left in “${d.name}”` : ''
      showToast(`Moved ${n} ${n === 1 ? 'card' : 'cards'} into “${into.name}”, tagged “${d.name}”${left}`)
      status.factsVersion++
      status.wordsVersion++
      decks = await getDecks(true)
      void session.refresh()
      navigate(`/deck/${into.id}?from=%2Fdecks`, { replace: true })
    } catch (e) {
      showToast(`Not merged: ${errorText(e)}`)
    }
  }

  // A new deck: a name, and languages only for one that takes words.
  let deckName = $state('')
  let withLangs = $state(false)
  let targetLang = $state('')
  let nativeLang = $state('ru')
  let addingDeck = $state(false)
  const langOk = (s: string) => /^[a-z]{2,3}$/.test(s.trim().toLowerCase())
  async function addDeck() {
    const name = deckName.trim()
    if (!name || addingDeck || (withLangs && !(langOk(targetLang) && langOk(nativeLang)))) return
    addingDeck = true
    try {
      const d = await api.createDeck({ name, ...(withLangs ? { targetLang: targetLang.trim().toLowerCase(), nativeLang: nativeLang.trim().toLowerCase() } : {}) })
      decks = [...decks, d]
      deckName = ''
      withLangs = false
      targetLang = ''
      session.applyDeck(d)
      navigate(`/deck/${d.id}?from=%2Fdecks`)
      void getDecks(true).then((x) => (decks = x)).catch(() => {})
      void session.refresh()
    } catch (e) {
      showToast(`Not added: ${errorText(e)}`)
    } finally {
      addingDeck = false
    }
  }

  // Deck settings: shown at once (and the review queue follows at once),
  // sent in the background, put back with a note if the server refuses.
  async function patchDeck(d: DeckWithCounts, p: DeckPatch) {
    const before = Object.fromEntries(Object.keys(p).map((k) => [k, d[k as keyof DeckPatch]])) as DeckPatch
    Object.assign(d, p)
    session.applyDeck($state.snapshot(d) as DeckWithCounts)
    try {
      await saveDeck(d.id, p)
      // The queue reflects the change by the time Review is back on screen.
      void session.refresh()
    } catch (e) {
      Object.assign(d, before)
      session.applyDeck($state.snapshot(d) as DeckWithCounts)
      showToast(`Not saved: ${errorText(e)}`)
    }
  }

  function setDirection(d: DeckWithCounts, dir: 'forwardEnabled' | 'reverseEnabled', on: boolean, el: HTMLInputElement) {
    const other = dir === 'forwardEnabled' ? d.reverseEnabled : d.forwardEnabled
    // One direction always stays on.
    if (!on && !other) {
      el.checked = true
      showToast('Keep at least one direction on')
      return
    }
    void patchDeck(d, { [dir]: on })
  }

  const GATES: { label: string; value: number | null }[] = [
    { label: 'Off', value: null },
    { label: '3 d', value: 3 },
    { label: '7 d', value: 7 },
    { label: '14 d', value: 14 },
    { label: '30 d', value: 30 },
  ]
  const TYPE_ANSWERS: { label: string; value: TypeAnswer }[] = [
    { label: 'Off', value: 'off' },
    { label: 'RU → EN', value: 'reverse' },
    { label: 'Both', value: 'both' },
  ]
  const code = (l: string) => l.toUpperCase()

  function setNew(d: DeckWithCounts, delta: number) {
    const v = Math.max(0, Math.min(999, d.newPerDay + delta))
    if (v === d.newPerDay) return
    void patchDeck(d, { newPerDay: v })
  }
</script>

<div class="screen">
  <Header title={id ? selected?.name ?? 'Deck settings' : 'Decks'}>
    {#snippet actions()}
      {#if id}<button class="all-decks" onclick={() => navigate('/decks')}>All decks</button>{/if}
    {/snippet}
  </Header>
  {#if error}
    <div class="group"><div class="row"><span class="grow muted">{error}</span><button class="btn" onclick={load}>Retry</button></div></div>
  {/if}
  {#if id}
    {#if selected}
      {@const d = selected}
      {@const t = code(d.targetLang ?? '')}
      {@const n = code(d.nativeLang ?? '')}
      {@const shown = d.counts.total - d.counts.dropped}

      <div class="group">
        <div class="row">
          {#if renaming === d.id}
            <form class="grow rename" onsubmit={(e) => { e.preventDefault(); void rename(d) }}>
              <!-- svelte-ignore a11y_autofocus -->
              <input bind:value={newName} autofocus onblur={() => void rename(d)} onkeydown={(e) => e.key === 'Escape' && (renaming = null)} aria-label="Deck name" autocomplete="off" />
            </form>
          {:else}
            <button class="grow name" onclick={() => startRename(d)} aria-label="Rename {d.name}">
              Name <span class="muted">{d.name}</span><Icon name="edit" size={14} />
              <span class="sub">{shown} {shown === 1 ? 'card' : 'cards'}{hasLangs(d) ? ` · words, ${t} → ${n}` : ''}</span>
            </button>
          {/if}
        </div>
        <div class="row">
          <span class="grow">New cards per day <span class="sub">{d.counts.newTotal ? `${d.counts.newTotal} not started yet` : 'Every card started'}</span></span>
          <div class="stepper">
            <button onclick={() => setNew(d, -1)} disabled={d.newPerDay <= 0} aria-label="Fewer new {d.name} cards"><Icon name="minus" size={18} stroke={2} /></button>
            <span>{d.newPerDay}</span>
            <button onclick={() => setNew(d, 1)} aria-label="More new {d.name} cards"><Icon name="plus" size={18} stroke={2} /></button>
          </div>
        </div>
        {#if hasLangs(d)}
          <label class="row">
            <span class="grow">{t} → {n} <span class="muted">recognise</span><span class="sub">See the word, recall what it means</span></span>
            <input type="checkbox" class="switch" checked={d.forwardEnabled} onchange={(e) => setDirection(d, 'forwardEnabled', e.currentTarget.checked, e.currentTarget)} />
          </label>
          <label class="row">
            <span class="grow">{n} → {t} <span class="muted">recall</span><span class="sub">See the meaning, produce the word</span></span>
            <input type="checkbox" class="switch" checked={d.reverseEnabled} onchange={(e) => setDirection(d, 'reverseEnabled', e.currentTarget.checked, e.currentTarget)} />
          </label>
          {#if d.forwardEnabled && d.reverseEnabled}
            <div class="row col">
              <span>Introduce {n} → {t} after {t} → {n} is stable for <span class="sub">New words start with recognition only; recall joins once it holds</span></span>
              <div class="seg five" role="radiogroup" aria-label="Introduce {n} → {t} after">
                {#each GATES as g (g.label)}
                  <button role="radio" aria-checked={d.reverseAfterDays === g.value} class:on={d.reverseAfterDays === g.value} onclick={() => patchDeck(d, { reverseAfterDays: g.value })}>{g.label}</button>
                {/each}
              </div>
            </div>
          {/if}
          <div class="row col">
            <span>Type the answer <span class="sub">Instead of just revealing it; typos count as Hard</span></span>
            <div class="seg" role="radiogroup" aria-label="Type the answer">
              {#each TYPE_ANSWERS as o (o.value)}
                <button role="radio" aria-checked={d.typeAnswer === o.value} class:on={d.typeAnswer === o.value} onclick={() => patchDeck(d, { typeAnswer: o.value })}>{o.label.replace('RU', n).replace('EN', t)}</button>
              {/each}
            </div>
          </div>
        {/if}
        {#if d.tags?.length}
          <button class="row" onclick={() => (tagsDeck = d)}>
            <span class="grow">Tags <span class="sub">{d.tags.length} · rename, nest with "/", or remove</span></span>
            <Icon name="chevron" size={16} />
          </button>
        {/if}
        <div class="row deck-actions">
          {#if decks.length > 1}
            <label class="btn small merge">
              <span>Merge into…</span>
              <select onchange={(e) => void merge(d, e.currentTarget.value, e.currentTarget)} aria-label="Merge {d.name} into">
                <option value="">Merge into…</option>
                {#each decks.filter((x) => x.id !== d.id) as x (x.id)}<option value={x.id}>{x.name}</option>{/each}
              </select>
            </label>
          {/if}
          <ConfirmButton class="btn danger small" onconfirm={() => void removeDeck(d)} confirmLabel={d.counts.total ? `Delete ${d.counts.total} ${d.counts.total === 1 ? 'card' : 'cards'} and their history` : 'Tap again to delete'}>
            <Icon name="trash" size={15} /> Delete
          </ConfirmButton>
        </div>
      </div>
      {#if hasLangs(d)}<p class="caption">A direction you turn off keeps its history and comes back as it was.</p>{/if}
    {:else}
      <p class="caption">{loading ? 'Loading…' : error ? 'Connect to load this deck.' : 'This deck is no longer available.'}</p>
    {/if}
  {:else}
    <div class="group">
      {#each decks as d (d.id)}
        <button class="row" onclick={() => navigate(`/deck/${d.id}?from=%2Fdecks`)}>
          <span class="grow">{d.name}<span class="sub">{d.counts.total - d.counts.dropped} cards · {d.newPerDay} new per day</span></span><Icon name="chevron" size={16} />
        </button>
      {/each}
    </div>
    <div class="section-label">New deck</div>
    <div class="group">
      <form class="row col new-deck" onsubmit={(e) => { e.preventDefault(); void addDeck() }}>
        <div class="new-row">
          <input bind:value={deckName} placeholder="Name, e.g. Programming" autocomplete="off" aria-label="New deck name" />
          <button class="btn" type="submit" disabled={!deckName.trim() || addingDeck || (withLangs && !(langOk(targetLang) && langOk(nativeLang)))}>Add</button>
        </div>
        <label class="new-row langs">
          <input type="checkbox" class="switch" bind:checked={withLangs} />
          <span class="grow">Takes words <span class="sub">A language to learn: words with translations, both directions</span></span>
        </label>
        {#if withLangs}
          <div class="new-row">
            <input bind:value={targetLang} placeholder="Learning, e.g. de" maxlength="3" autocomplete="off" autocapitalize="off" aria-label="Language to learn" />
            <input bind:value={nativeLang} placeholder="Yours, e.g. ru" maxlength="3" autocomplete="off" autocapitalize="off" aria-label="Your language" />
          </div>
        {/if}
      </form>
    </div>
    <p class="caption">A deck holds cards of any type; subjects inside it are tags. Merging moves a deck's cards into another, tagged with its name.</p>
  {/if}
</div>
{#if tagsDeck}
  <TagManager deckId={tagsDeck.id} deckName={tagsDeck.name} tags={tagsDeck.tags} onclose={() => ((tagsDeck = null), void load())} />
{/if}
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
  .name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
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
  .deck-actions {
    justify-content: flex-end;
    gap: 8px;
  }
  .deck-actions :global(.btn.small) {
    min-height: 40px;
    padding: 0 12px;
    font-size: 14px;
    font-weight: 500;
  }
  .merge {
    position: relative;
  }
  .merge select {
    position: absolute;
    inset: 0;
    opacity: 0;
  }
  .name {
    display: block;
    text-align: left;
    font: inherit;
    color: inherit;
    min-width: 0;
  }
  .name :global(svg) {
    margin-left: 6px;
    color: var(--faint);
    vertical-align: -1px;
  }
  .rename input {
    padding: 8px 10px;
  }
  .new-deck {
    gap: 10px;
  }
  .new-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .new-row input:not(.switch) {
    flex: 1;
    min-width: 0;
    padding: 9px 12px;
  }
  .new-row .btn {
    flex: none;
  }
  .stepper {
    display: flex;
    align-items: center;
    background: var(--surface-2);
    border-radius: 10px;
  }
  .stepper button {
    width: 44px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    border-radius: 10px;
    transition: background-color var(--t-fast) ease;
  }
  .stepper button:active:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    transition-duration: 0ms;
  }
  .stepper span {
    min-width: 32px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .row.col {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .seg.five {
    grid-template-columns: repeat(5, 1fr);
  }
  .seg.five button {
    text-transform: none;
    font-variant-numeric: tabular-nums;
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    background: var(--surface-2);
    border-radius: 12px;
    padding: 3px;
  }
  .seg button {
    height: 40px;
    border-radius: 9px;
    font-size: 15px;
    text-transform: capitalize;
    color: var(--muted);
    transition:
      background-color var(--t-fast) ease,
      color var(--t-fast) ease;
  }
  .switch {
    width: 51px;
    height: 31px;
    padding: 0;
    border-radius: 16px;
    background: var(--surface-2);
    border: 0;
    position: relative;
    flex: none;
    cursor: pointer;
    transition: background 0.2s;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform 0.2s;
  }
  .switch:checked {
    background: var(--accent);
  }
  .switch:checked::after {
    transform: translateX(20px);
  }
  .seg button.on {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
  .all-decks {
    min-height: 44px;
    color: var(--accent);
    font-size: 15px;
    font-weight: 500;
  }
</style>
