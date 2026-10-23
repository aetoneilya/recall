<script lang="ts">
  import { CEFR_LEVELS, cleanReviewFilter, type ReviewFilter } from '@recall/core'
  import { untrack } from 'svelte'
  import { api } from '../lib/app.svelte.ts'
  import { directionName, posPlural, toggleIn, TYPE_NAMES } from '../lib/reviewFilter.ts'
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
  <p class="sub">{deckName} · {today === null ? (error ? 'counts need a connection' : '…') : `${today} ${today === 1 ? 'card' : 'cards'} today`}</p>
  {#if error && !options}
    <p class="note">{error}</p>
  {/if}
  {#if options}
    {#if options.types.length > 1 || draft?.types?.length}
      <div class="label">Cards</div>
      <div class="chips">
        {#each options.types as t (t.value)}
          <button class="chip-btn" class:on={on('types', t.value)} aria-pressed={on('types', t.value)} onclick={() => (draft = toggleIn(draft, 'types', t.value))}>{TYPE_NAMES[t.value]} <b>{t.n}</b></button>
        {/each}
      </div>
    {/if}
    {#if options.tags.length}
      <div class="label">Tags</div>
      <TagTree tags={options.tags} selected={draft?.tags ?? []} onchange={(tags) => (draft = { ...(draft ?? {}), tags })} />
    {/if}
    {#if hasWords && (options.pos.length > 1 || draft?.pos?.length)}
      <div class="label">Words: part of speech</div>
      <div class="chips">
        {#each options.pos as p (p.value)}
          <button class="chip-btn" class:on={on('pos', p.value)} aria-pressed={on('pos', p.value)} onclick={() => (draft = toggleIn(draft, 'pos', p.value))}>{posPlural(p.value)} <b>{p.n}</b></button>
        {/each}
      </div>
    {/if}
    {#if hasWords && (options.cefr.length || draft?.cefr?.length)}
      <div class="label">Words: level</div>
      <div class="chips">
        {#each CEFR_LEVELS.filter((c) => options!.cefr.some((x) => x.value === c) || on('cefr', c)) as c (c)}
          <button class="chip-btn" class:on={on('cefr', c)} aria-pressed={on('cefr', c)} onclick={() => (draft = toggleIn(draft, 'cefr', c))}>{c}</button>
        {/each}
      </div>
    {/if}
    {#if hasWords && (options.directions.length > 1 || draft?.directions?.length)}
      <div class="label">Words: direction</div>
      <div class="chips">
        {#each options.directions as d (d.value)}
          <button class="chip-btn" class:on={on('directions', d.value)} aria-pressed={on('directions', d.value)} onclick={() => (draft = toggleIn(draft, 'directions', d.value))}>{directionName(d.value, langs)}</button>
        {/each}
      </div>
    {/if}
    <p class="note">Picks in a row add up; tags and the rows narrow each other. Only what has cards is offered. Cards outside the filter wait and don't use the day's new cards.</p>
  {/if}
  <div class="actions">
    <button class="btn" onclick={() => (draft = null)} disabled={!draft}>Clear</button>
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="btn primary grow" onclick={done} disabled={saving}>{saving ? 'Saving…' : 'Done'}</button>
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
    min-height: 40px;
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
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 20px;
  }
  .grow {
    flex: 1;
  }
</style>
