<script lang="ts">
  import { cleanReviewFilter, type Facet, type ReviewFilter } from '@recall/core'
  import { untrack } from 'svelte'
  import { api } from '../lib/app.svelte.ts'
  import { choiceOn, directionName, emptyChoices, posPlural, reviewTagState, setChoiceGroup, toggleChoice, toggleReviewTag, toggleUntagged, untaggedOn, TYPE_NAMES } from '../lib/reviewFilter.ts'
  import { errorText } from '../lib/toast.svelte.ts'
  import type { ReviewOptions } from '../lib/types.ts'
  import Sheet from './Sheet.svelte'
  import TagTree from './TagTree.svelte'

  // "What to review" for one deck: card types, tags, and for words part of
  // speech, level and direction. Unrestricted rows show every value on;
  // a tap turns one off. Tag checkboxes exclude cards carrying a disabled
  // tag; child choices override their parent.
  // Today's count follows the draft; Done saves it on the deck.
  let {
    deckId,
    deckName,
    langs,
    initial,
    onsave,
    onclose,
  }: {
    deckId: string
    deckName: string
    langs: [string | null, string | null]
    initial: ReviewFilter | null
    onsave: (f: ReviewFilter | null) => Promise<boolean>
    onclose: () => void
  } = $props()

  let draft = $state<ReviewFilter | null>((() => initial)())
  let options = $state.raw<ReviewOptions | null>(null)
  let error = $state('')
  let saving = $state(false)
  let catalog = $state.raw<ReviewOptions | null>(null)
  const empty = $derived(emptyChoices(draft))

  // Options and the live count, refetched (debounced) as the draft changes.
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    const f = cleanReviewFilter($state.snapshot(draft) as ReviewFilter | null)
    const none = empty
    clearTimeout(timer)
    const mine = ++seq
    if (none) return
    timer = setTimeout(async () => {
      try {
        const base = untrack(() => catalog)
        const [o, all] = !base && f
          ? await Promise.all([api.reviewOptions(deckId, f), api.reviewOptions(deckId, null)])
          : await api.reviewOptions(deckId, f).then((o) => [o, base ?? o])
        if (mine === seq) {
          catalog = all!
          options = o
          error = ''
        }
      } catch (e) {
        if (mine === seq) error = errorText(e)
      }
    }, untrack(() => options) ? 150 : 0)
    return () => clearTimeout(timer)
  })

  const today = $derived(empty ? 0 : options ? options.counts.new + options.counts.learning + options.counts.review : null)
  const on = (key: Exclude<Facet, 'tags'>, v: string) => choiceOn(draft, key, v)
  function choices<K extends Facet>(key: K): ReviewOptions[K] {
    const counts = new Map((options?.[key] ?? []).map((v) => [v.value, v.n]))
    const all = new Map([...(catalog?.[key] ?? []), ...(options?.[key] ?? [])].map((v) => [v.value, v]))
    return [...all.values()].map((v) => ({ ...v, n: counts.get(v.value) ?? 0 })) as ReviewOptions[K]
  }
  const tagPaths = $derived(choices('tags').map((t) => t.value))
  const hasWords = $derived(!!catalog?.types.some((t) => t.value === 'word') && on('types', 'word'))
  function toggle(key: Exclude<Facet, 'tags'>, value: string) {
    draft = toggleChoice(draft, key, value, choices(key).map((v) => v.value))
  }
  const allOn = (key: Exclude<Facet, 'tags'>) => choices(key).every((v) => on(key, v.value))

  async function done() {
    saving = true
    const ok = await onsave(cleanReviewFilter($state.snapshot(draft) as ReviewFilter | null))
    saving = false
    if (ok) onclose()
  }
</script>

{#snippet heading(title: string, key: Exclude<Facet, 'tags'>, label: string)}
  <div class="label">
    <span>{title}</span>
    <button class="bulk" onclick={() => (draft = setChoiceGroup(draft, key, !allOn(key)))} aria-label="{allOn(key) ? 'Deselect all' : 'Select all'} {label}">{allOn(key) ? 'Deselect all' : 'Select all'}</button>
  </div>
{/snippet}

<Sheet title="What to review" label="What to review in {deckName}" {onclose}>
  <p class="sub">{deckName} · {today === null ? (error ? 'counts need a connection' : '…') : `${today} ${today === 1 ? 'card' : 'cards'} today`}</p>
  {#if error && !options}
    <p class="note">{error}</p>
  {/if}
  {#if options}
    {#if choices('types').length > 1 || draft?.types?.length}
      {@render heading('Cards', 'types', 'card types')}
      <div class="chips">
        {#each choices('types') as t (t.value)}
          <button class="chip-btn" class:on={on('types', t.value)} aria-pressed={on('types', t.value)} onclick={() => (toggle('types', t.value))}>{TYPE_NAMES[t.value]} <b>{t.n}</b></button>
        {/each}
      </div>
    {/if}
    {#if tagPaths.length}
      <div class="label">Tags</div>
      <TagTree tags={choices('tags')} stateOf={(path) => reviewTagState(draft, path, tagPaths)} ontoggle={(path) => (draft = toggleReviewTag(draft, path, tagPaths))} />
      <button class="untagged" role="checkbox" aria-checked={untaggedOn(draft)} onclick={() => (draft = toggleUntagged(draft, tagPaths))}>
        <span class="box" class:on={untaggedOn(draft)} aria-hidden="true">{#if untaggedOn(draft)}✓{/if}</span>
        Cards without tags
      </button>
    {/if}
    {#if hasWords && (choices('pos').length > 1 || draft?.pos?.length)}
      {@render heading('Words: part of speech', 'pos', 'parts of speech')}
      <div class="chips">
        {#each choices('pos') as p (p.value)}
          <button class="chip-btn" class:on={on('pos', p.value)} aria-pressed={on('pos', p.value)} onclick={() => (toggle('pos', p.value))}>{posPlural(p.value)} <b>{p.n}</b></button>
        {/each}
      </div>
    {/if}
    {#if hasWords && (choices('cefr').length || draft?.cefr?.length)}
      {@render heading('Words: level', 'cefr', 'levels')}
      <div class="chips">
        {#each choices('cefr').toSorted((a, b) => a.value.localeCompare(b.value)) as option (option.value)}
          {@const c = option.value}
          <button class="chip-btn" class:on={on('cefr', c)} aria-pressed={on('cefr', c)} onclick={() => (toggle('cefr', c))}>{c}</button>
        {/each}
      </div>
    {/if}
    {#if hasWords && (choices('directions').length > 1 || draft?.directions?.length)}
      {@render heading('Words: direction', 'directions', 'directions')}
      <div class="chips">
        {#each choices('directions') as d (d.value)}
          <button class="chip-btn" class:on={on('directions', d.value)} aria-pressed={on('directions', d.value)} onclick={() => (toggle('directions', d.value))}>{directionName(d.value, langs)}</button>
        {/each}
      </div>
    {/if}
    <p class="note">Everything starts selected. Turn off values to leave them out of review. A disabled tag excludes cards carrying it; child tag choices override their parent.</p>
  {/if}
  {#if empty}<p class="note">Select at least one value in each row.</p>{/if}
  <div class="actions">
    <button class="btn" onclick={() => (draft = null)} disabled={!draft}>Reset</button>
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="btn primary grow" onclick={done} disabled={saving || empty}>{saving ? 'Saving…' : 'Done'}</button>
  </div>
</Sheet>

<style>
  .sub {
    margin: 0 0 6px;
    font-size: 15px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 28px;
    margin: 8px 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }
  .bulk {
    position: relative;
    min-height: 28px;
    flex: none;
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
  }
  .bulk::after {
    content: '';
    position: absolute;
    inset: -8px -4px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 13px;
    border-radius: 18px;
    font-size: 15px;
    font-weight: 500;
    color: var(--text);
    background: var(--surface);
    font-variant-numeric: tabular-nums;
    transition:
      background-color var(--t-fast) ease,
      color var(--t-fast) ease;
  }
  .chip-btn b {
    font-weight: 600;
    color: var(--faint);
  }
  .chip-btn.on {
    color: var(--accent-text);
    background: var(--accent);
  }
  .chip-btn.on b {
    color: inherit;
    opacity: 0.85;
  }
  .note {
    margin: 16px 2px 0;
    font-size: 13px;
    color: var(--faint);
  }
  .untagged {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    width: 100%;
    margin-top: 6px;
    padding: 0 14px 0 40px;
    border-radius: 14px;
    background: var(--surface);
    text-align: left;
    font-size: 15px;
  }
  .box {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 7px;
    box-shadow: inset 0 0 0 1.5px var(--hairline);
  }
  .box.on {
    background: var(--accent);
    color: var(--accent-text);
    box-shadow: none;
  }
  .actions {
    position: sticky;
    bottom: -16px;
    padding: 12px 0 16px;
    background: var(--bg);
    display: flex;
    gap: 8px;
    margin-top: 20px;
  }
  .grow {
    flex: 1;
  }
</style>
