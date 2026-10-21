<script lang="ts">
  import { cleanWord, formatInterval, type Direction, type ReviewLog } from '@recall/core'
  import { onDestroy } from 'svelte'
  import Header from '../components/Header.svelte'
  import Icon from '../components/Icon.svelte'
  import WordFields from '../components/WordFields.svelte'
  import { api, status } from '../lib/app.svelte.ts'
  import { session } from '../lib/review.svelte.ts'
  import { back } from '../lib/router.svelte.ts'
  import { haptic } from '../lib/telegram.ts'
  import { setUnsaved } from '../lib/unsaved.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'
  import type { CardSummary, WordItem } from '../lib/types.ts'
  import { dirState } from '../lib/wordFilter.ts'
  import { formFrom, formToInput, type WordForm } from '../lib/wordForm.ts'
  import { words } from '../lib/words.svelte.ts'

  // A word with all its fields and both cards. Edits save with one tap (and
  // on the way out, so Back never loses them); delete is undoable.
  let { id, inbox = false }: { id: string; inbox?: boolean } = $props()

  let word = $state.raw<WordItem | null>(null)
  let logs = $state.raw<ReviewLog[]>([])
  let form = $state<WordForm | null>(null)
  let saved = ''
  let error = $state('')
  let saving = $state(false)
  let gone = false

  function adopt(w: WordItem) {
    word = w
    form = formFrom(w)
    saved = JSON.stringify(formToInput(form))
  }
  // Paint at once from the cached list; the fetch below brings logs and the latest state.
  ;(() => {
    const cached = words.get(id)
    if (cached) adopt(cached)
  })()

  async function load() {
    try {
      const d = await api.word(id)
      // Don't clobber edits made while it loaded.
      if (!form || !dirty) adopt(d.word)
      else word = d.word
      logs = d.logs
      error = ''
    } catch (e) {
      if (!word) error = errorText(e)
    }
  }
  void load()

  const dirty = $derived(!!form && JSON.stringify(formToInput(form)) !== saved)
  const problem = $derived.by(() => {
    if (!form) return ''
    const r = cleanWord(formToInput(form))
    return 'error' in r ? (r.error === 'at least one translation is required' ? 'Add at least one translation.' : r.error) : ''
  })

  async function save(opts: { quiet?: boolean; approve?: boolean } = {}): Promise<boolean> {
    if (!form || !word || saving || problem) return false
    const input = formToInput(form)
    const changed = dirty
    if (!changed && !opts.approve) return true
    saving = true
    try {
      let w = word
      if (changed) w = await api.updateWord(id, input)
      if (opts.approve) {
        w = await api.approve(id)
        status.inbox = Math.max(0, status.inbox - 1)
      }
      if (!gone) adopt(w)
      else saved = JSON.stringify(input)
      words.upsert(w)
      // The review card it was opened from shows the fix at once.
      session.patchWord(w)
      session.markStale()
      if (!opts.quiet) showToast(opts.approve ? `Approved “${w.term}”` : 'Saved')
      return true
    } catch (e) {
      showToast(`Not saved: ${errorText(e)}`)
      return false
    } finally {
      saving = false
    }
  }

  // Edits not saved yet: Telegram asks before closing, updates wait.
  $effect(() => setUnsaved('word', dirty))

  // Leaving with unsaved (valid) edits keeps them.
  onDestroy(() => {
    setUnsaved('word', false)
    gone = true
    if (dirty && !problem && word) void save({ quiet: false })
  })

  async function approve() {
    if (await save({ approve: true })) back()
  }

  async function reject() {
    if (!word) return
    const w = word
    try {
      const r = await api.reject(w.id)
      words.upsert(r)
      status.inbox = Math.max(0, status.inbox - 1)
      showToast(`Rejected “${w.term}”`, {
        action: {
          label: 'Undo',
          run: () =>
            void api.updateWord(w.id, { status: 'inbox' }).then(
              (x) => {
                words.upsert(x)
                status.inbox++
              },
              (e) => showToast(errorText(e)),
            ),
        },
      })
      saved = JSON.stringify(formToInput(form!))
      back()
    } catch (e) {
      showToast(errorText(e))
    }
  }

  function remove() {
    if (!word) return
    // Nothing left to save once it's gone.
    saved = form ? JSON.stringify(formToInput(form)) : saved
    words.deleteWithUndo(word, () => void session.refresh())
    session.dropWord(word.id)
    session.markStale()
    back()
  }

  async function toggleCard(c: CardSummary) {
    if (!word) return
    const on = !c.suspended
    const patch = (s: boolean) => {
      if (!word) return
      const next = { ...word, cards: { ...word.cards, [c.direction]: { ...c, suspended: s } } }
      word = next
      words.upsert(next)
      session.patchWord(next)
    }
    patch(on)
    haptic.select()
    try {
      await api.suspendCard(c.id, on)
      session.markStale()
    } catch (e) {
      patch(!on)
      showToast(errorText(e))
    }
  }

  const dirs: Direction[] = ['forward', 'reverse']
  const dirTitle: Record<Direction, string> = { forward: 'EN → RU · recognise', reverse: 'RU → EN · recall' }
  const STATE_TEXT = { new: 'New', learning: 'Learning', known: 'Known', fading: 'Fading', suspended: 'Suspended', off: 'Off' } as const

  function dueText(c: CardSummary) {
    if (c.state === 'new') return 'not studied yet'
    const due = new Date(c.due)
    const now = new Date()
    return due <= now ? 'due now' : `due in ${formatInterval(now, due)}`
  }
  function cardStats(c: CardSummary): string {
    if (!c.enabled) return 'off in deck settings'
    const parts = [c.suspended ? 'suspended' : dueText(c)]
    if (c.state !== 'new') {
      parts.push(`stability ${days(c.stability)}`)
      if (c.retrievability !== null) parts.push(`recall ${Math.round(c.retrievability * 100)}%`)
      if (c.lapses) parts.push(`${c.lapses} ${c.lapses === 1 ? 'lapse' : 'lapses'}`)
    }
    return parts.join(' · ')
  }
  const days = (n: number) => (n < 1 ? `${Math.round(n * 24)} h` : `${n < 10 ? n.toFixed(1) : Math.round(n)} d`)
  const logsFor = (cardId: string | undefined) => logs.filter((l) => l.cardId === cardId).slice(0, 12).reverse()

  const title = $derived(inbox ? 'Proposal' : word?.term ?? 'Word')
</script>

<div class="editor">
  <div class="screen scroll">
    <Header {title} />
    {#if !form || !word}
      {#if error}
        <div class="empty">
          <p><strong>Couldn't open this word</strong>{error}</p>
          <button class="btn" onclick={load}><Icon name="refresh" size={18} /> Try again</button>
        </div>
      {:else}
        <div class="skel-fields" aria-label="Loading">
          {#each [48, 60, 44, 96, 64] as h, i (i)}<span class="skel" style="height: {h}px; border-radius: 12px"></span>{/each}
        </div>
      {/if}
    {:else}
      <div class="meta">
        {#if word.createdBy === 'claude'}<span class="by">by Claude</span>{/if}
        {#if word.freqRank}<span>#{word.freqRank.toLocaleString()} most common</span>{/if}
        <span>added {new Date(word.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        {#if word.status !== 'active'}<span class="chip status {word.status}">{word.status}</span>{/if}
      </div>

      <WordFields bind:form onsubmit={() => void save()} />

      {#if word.status === 'active' || word.cards.forward?.reps || word.cards.reverse?.reps}
        <div class="section-label">Cards</div>
        <div class="group">
          {#each dirs as d (d)}
            {@const c = word.cards[d]}
            {#if c}
              {@const s = dirState(c)}
              <div class="row card-row">
                <div class="cmain">
                  <div class="ctitle">{dirTitle[d]} <span class="state {s}">{s ? STATE_TEXT[s] : ''}</span></div>
                  <div class="cstats">{cardStats(c)}</div>
                  {#if logsFor(c.id).length}
                    <div class="ratings" aria-label="Recent ratings">
                      {#each logsFor(c.id) as l (l.id)}<span class="r{l.rating}" title={new Date(l.reviewedAt).toLocaleString()}></span>{/each}
                    </div>
                  {/if}
                </div>
                <button class="btn small" onclick={() => toggleCard(c)} aria-label="{c.suspended ? 'Resume' : 'Suspend'} {dirTitle[d]}">
                  <Icon name={c.suspended ? 'play' : 'pause'} size={16} stroke={2} />
                  {c.suspended ? 'Resume' : 'Suspend'}
                </button>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#if !inbox}
        <button class="btn danger block delete" onclick={remove}><Icon name="trash" size={18} /> Delete word</button>
      {/if}
    {/if}
  </div>

  {#if form && word}
    <div class="bar">
      {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
      <div class="bar-row">
        {#if inbox && word.status === 'inbox'}
          <button class="btn danger" onclick={reject}>Reject</button>
          <button class="btn primary grow" onclick={approve} disabled={!!problem || saving}>{dirty ? 'Save & approve' : 'Approve'}</button>
        {:else}
          <button class="btn primary grow" onclick={() => save()} disabled={!dirty || !!problem || saving}>{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .editor {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    height: auto;
  }
  .skel-fields {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin: -4px 4px 14px;
    font-size: 13px;
    color: var(--muted);
  }
  .by {
    color: var(--accent);
    font-weight: 600;
  }
  .status.inbox {
    color: var(--accent);
  }
  .status.rejected {
    color: var(--again);
  }
  .card-row {
    align-items: flex-start;
    padding-top: 12px;
    padding-bottom: 12px;
  }
  .cmain {
    flex: 1;
    min-width: 0;
  }
  .ctitle {
    font-weight: 600;
    font-size: 15.5px;
  }
  .state {
    margin-left: 4px;
    font-weight: 500;
    font-size: 13px;
  }
  .state.new {
    color: var(--c-new);
  }
  .state.learning {
    color: var(--c-learn);
  }
  .state.known,
  .state.fading {
    color: var(--c-review);
  }
  .state.suspended,
  .state.off {
    color: var(--faint);
  }
  .cstats {
    margin-top: 2px;
    font-size: 13.5px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .ratings {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .ratings span {
    width: 9px;
    height: 9px;
    border-radius: 3px;
  }
  .r1 {
    background: var(--again);
  }
  .r2 {
    background: var(--hard);
  }
  .r3 {
    background: var(--good);
  }
  .r4 {
    background: var(--easy);
  }
  .btn.small {
    min-height: 36px;
    padding: 0 12px;
    font-size: 14px;
    flex: none;
  }
  .delete {
    margin-top: 28px;
  }
  .bar {
    flex: none;
    padding: 10px calc(16px + var(--sar)) 10px calc(16px + var(--sal));
    background: var(--bg);
    box-shadow: inset 0 0.5px 0 var(--hairline);
  }
  .bar-row {
    display: flex;
    gap: 10px;
  }
  .grow {
    flex: 1;
  }
  .bar .btn {
    min-height: 50px;
  }
  .problem {
    margin: 0 4px 8px;
    font-size: 14px;
    color: var(--again);
  }
</style>
