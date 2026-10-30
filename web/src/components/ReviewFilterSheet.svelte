<script lang="ts">
  import { CEFR_LEVELS, cleanReviewFilter, type ReviewFilter } from '@recall/core'
  import { untrack } from 'svelte'
  import { api } from '../lib/app.svelte.ts'
  import { allIn, directionName, posPlural, toggleIn, TYPE_NAMES } from '../lib/reviewFilter.ts'
  import { errorText } from '../lib/toast.svelte.ts'
  import type { ReviewOptions } from '../lib/types.ts'
  import Sheet from './Sheet.svelte'
  import TagTree from './TagTree.svelte'

  // "What to review" for one deck: card types, tags, and for words part of
  // speech, level and direction; empty = everything. Within a row the picks
  // add up (any of them: B2 and C1), except tags, which narrow (cards with
  // all of them); the rows narrow each other. The server offers only options
  // that have cards under the rest of the draft, plus the picked ones.
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
  let choosingTags = $state(untrack(() => !!initial?.tags?.length))
  const tagsPending = $derived(choosingTags && !!options?.tags.length && !draft?.tags?.length)

  // Options and the live count, refetched (debounced) as the draft changes.
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    const f = cleanReviewFilter($state.snapshot(draft) as ReviewFilter | null)
    clearTimeout(timer)
    const mine = ++seq
    timer = setTimeout(async () => {
      try {
        const o = await api.reviewOptions(deckId, f)
        if (mine === seq) {
          options = o
          error = ''
        }
      } catch (e) {
        if (mine === seq) error = errorText(e)
      }
    }, untrack(() => options) ? 150 : 0)
    return () => clearTimeout(timer)
  })

  const today = $derived(options ? options.counts.new + options.counts.learning + options.counts.review : null)
  const on = (key: keyof ReviewFilter, v: string) => ((draft?.[key] ?? []) as string[]).includes(v)
  // The word rows go when the picked types leave no words.
  const hasWords = $derived(!!options?.types.some((t) => t.value === 'word') && (!draft?.types?.length || draft.types.includes('word')))

  async function done() {
    saving = true
    const ok = await onsave(cleanReviewFilter($state.snapshot(draft) as ReviewFilter | null))
    saving = false
    if (ok) onclose()
  }
</script>

<Sheet title="What to review" label="What to review in {deckName}" {onclose}>
  <p class="sub">{deckName} · {tagsPending ? 'choose one or more tags' : today === null ? (error ? 'counts need a connection' : '…') : `${today} ${today === 1 ? 'card' : 'cards'} today`}</p>
  {#if error && !options}
    <p class="note">{error}</p>
  {/if}
  {#if options}
    {#if options.types.length > 1 || draft?.types?.length}
      <div class="label">Cards</div>
      <div class="chips">
        <button class="chip-btn" class:on={!draft?.types?.length} aria-pressed={!draft?.types?.length} onclick={() => (draft = allIn(draft, 'types'))}>All cards</button>
        {#each options.types as t (t.value)}
          <button class="chip-btn" class:on={on('types', t.value)} aria-pressed={on('types', t.value)} onclick={() => (draft = toggleIn(draft, 'types', t.value))}>{TYPE_NAMES[t.value]} <b>{t.n}</b></button>
        {/each}
      </div>
    {/if}
    {#if options.tags.length}
      <div class="label">Tags</div>
      <div class="chips tag-mode" role="radiogroup" aria-label="Tag filter">
        <button class="chip-btn" role="radio" class:on={!choosingTags} aria-checked={!choosingTags} onclick={() => { choosingTags = false; draft = allIn(draft, 'tags') }}>All tags</button>
        <button class="chip-btn" role="radio" class:on={choosingTags} aria-checked={choosingTags} onclick={() => (choosingTags = true)}>Choose tags</button>
      </div>
      {#if choosingTags}
        <TagTree tags={options.tags} selected={draft?.tags ?? []} onchange={(tags) => (draft = cleanReviewFilter({ ...(draft ?? {}), tags }))} />
      {:else}
        <p class="tag-hint">Includes cards without tags.</p>
      {/if}
    {/if}
    {#if hasWords && (options.pos.length > 1 || draft?.pos?.length)}
      <div class="label">Words: part of speech</div>
      <div class="chips">
        <button class="chip-btn" class:on={!draft?.pos?.length} aria-pressed={!draft?.pos?.length} onclick={() => (draft = allIn(draft, 'pos'))}>All parts</button>
        {#each options.pos as p (p.value)}
          <button class="chip-btn" class:on={on('pos', p.value)} aria-pressed={on('pos', p.value)} onclick={() => (draft = toggleIn(draft, 'pos', p.value))}>{posPlural(p.value)} <b>{p.n}</b></button>
        {/each}
      </div>
    {/if}
    {#if hasWords && (options.cefr.length || draft?.cefr?.length)}
      <div class="label">Words: level</div>
      <div class="chips">
        <button class="chip-btn" class:on={!draft?.cefr?.length} aria-pressed={!draft?.cefr?.length} onclick={() => (draft = allIn(draft, 'cefr'))}>All levels</button>
        {#each CEFR_LEVELS.filter((c) => options!.cefr.some((x) => x.value === c) || on('cefr', c)) as c (c)}
          <button class="chip-btn" class:on={on('cefr', c)} aria-pressed={on('cefr', c)} onclick={() => (draft = toggleIn(draft, 'cefr', c))}>{c}</button>
        {/each}
      </div>
    {/if}
    {#if hasWords && (options.directions.length > 1 || draft?.directions?.length)}
      <div class="label">Words: direction</div>
      <div class="chips">
        <button class="chip-btn" class:on={!draft?.directions?.length} aria-pressed={!draft?.directions?.length} onclick={() => (draft = allIn(draft, 'directions'))}>All directions</button>
        {#each options.directions as d (d.value)}
          <button class="chip-btn" class:on={on('directions', d.value)} aria-pressed={on('directions', d.value)} onclick={() => (draft = toggleIn(draft, 'directions', d.value))}>{directionName(d.value, langs)}</button>
        {/each}
      </div>
    {/if}
    <p class="note">All means no restriction. Pick specific values to narrow the review; selected tags must all match. Cards outside the filter wait for later.</p>
  {/if}
  <div class="actions">
    <button class="btn" onclick={() => { draft = null; choosingTags = false }} disabled={!draft && !choosingTags}>Reset</button>
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="btn primary grow" onclick={done} disabled={saving || tagsPending}>{saving ? 'Saving…' : 'Done'}</button>
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
    margin: 16px 2px 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
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
  .tag-mode {
    margin-bottom: 8px;
  }
  .tag-hint {
    margin: 0 2px;
    color: var(--muted);
    font-size: 13px;
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
