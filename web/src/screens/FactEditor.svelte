<script lang="ts">
  import { cleanFact, formatInterval, type ReviewLog } from '@recall/core'
  import { onDestroy, tick } from 'svelte'
  import Header from '../components/Header.svelte'
  import Icon from '../components/Icon.svelte'
  import Markdown from '../components/Markdown.svelte'
  import { api, status } from '../lib/app.svelte.ts'
  import { HttpError } from '../lib/api.ts'
  import { duplicateFact } from '../lib/factFilter.ts'
  import { facts } from '../lib/facts.svelte.ts'
  import { session } from '../lib/review.svelte.ts'
  import { back, navigate, router } from '../lib/router.svelte.ts'
  import { haptic } from '../lib/telegram.ts'
  import { setUnsaved } from '../lib/unsaved.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'
  import type { FactItem } from '../lib/types.ts'
  import { dirState } from '../lib/wordFilter.ts'

  // One fact: its topic, question, answer (Markdown, with a preview) and
  // tags; its card's state and history; suspend, delete (undoable), and in
  // the inbox approve / reject. `id = 'new'` writes new cards one after
  // another into the chosen topic. Edits save with one tap and on the way
  // out, like the word editor.
  let { id, inbox = false }: { id: string; inbox?: boolean } = $props()
  const isNew = $derived(id === 'new')

  interface Form {
    deckId: string
    front: string
    back: string
    tags: string
  }

  const LAST_TOPIC = 'lastTopic'
  const readLast = () => {
    try {
      return localStorage.getItem(LAST_TOPIC) ?? ''
    } catch {
      return ''
    }
  }
  const remember = (deckId: string) => {
    try {
      localStorage.setItem(LAST_TOPIC, deckId)
    } catch {
      // No storage: the next add starts from the first topic.
    }
  }

  const topics = $derived(Object.values(session.decks).filter((d) => d.kind === 'topic'))

  let fact = $state.raw<FactItem | null>(null)
  let logs = $state.raw<ReviewLog[]>([])
  let form = $state<Form | null>(null)
  let saved = ''
  let error = $state('')
  let saving = $state(false)
  let preview = $state(false)
  let gone = false
  // The server said the question exists (a copy not cached here).
  let serverDup = $state<{ id: string; front: string; deckId: string } | null>(null)
  let frontInput: HTMLTextAreaElement | undefined = $state()

  const toInput = (f: Form) => ({ front: f.front, back: f.back, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) })
  const key = (f: Form) => JSON.stringify({ ...toInput(f), deckId: f.deckId })

  function adopt(f: FactItem) {
    fact = f
    form = { deckId: f.deckId, front: f.front, back: f.back, tags: f.tags.join(', ') }
    saved = key(form)
  }

  ;(() => {
    if (isNew) {
      const f: Form = { deckId: router.route.query.get('deck') || readLast(), front: '', back: '', tags: '' }
      form = f
      saved = key(f)
      return
    }
    // Paint at once from the device's copy or today's queue; the fetch brings logs and the latest.
    const queued = session.fact(id)
    const cached = facts.get(id) ?? (queued ? ({ ...queued, card: null } as FactItem) : undefined)
    if (cached) adopt(cached)
  })()
  // New card: a known topic, else the first one.
  $effect(() => {
    if (!isNew || !form || !topics.length) return
    if (!topics.some((d) => d.id === form!.deckId)) {
      form.deckId = topics[0]!.id
      saved = key(form)
    }
  })

  async function load() {
    if (isNew) return
    try {
      const d = await api.fact(id)
      if (!form || !dirty) adopt(d.fact)
      else fact = d.fact
      logs = d.logs
      error = ''
    } catch (e) {
      if (!fact) error = errorText(e)
    }
  }
  void load()
  void facts.restore()

  const dirty = $derived(!!form && key(form) !== saved)
  const problem = $derived.by(() => {
    if (!form) return ''
    if (isNew && !form.front.trim() && !form.back.trim()) return ''
    const r = cleanFact(toInput(form))
    return 'error' in r ? (r.error === 'front is empty' ? 'Write the question.' : r.error === 'back is empty' ? 'Write the answer.' : r.error) : ''
  })
  // The same question already in the chosen topic, caught as you type.
  const dup = $derived.by(() => {
    if (!form) return null
    const local = duplicateFact(facts.all, form.deckId, form.front, fact?.id)
    if (local) return { id: local.id, front: local.front, deckId: local.deckId }
    return serverDup && serverDup.deckId === form.deckId && serverDup.id !== fact?.id ? serverDup : null
  })
  // A server duplicate only holds for the question it was about.
  $effect(() => {
    void form?.front
    void form?.deckId
    serverDup = null
  })
  const deckName = (deckId: string) => topics.find((d) => d.id === deckId)?.name ?? fact?.deckName ?? 'this topic'

  function after(f: FactItem) {
    facts.upsert(f)
    session.patchFact(f)
    session.markStale()
  }

  function conflict(e: unknown) {
    const ex = e instanceof HttpError && e.status === 409 ? (e.data.existing as { id: string; front: string; deckId: string } | undefined) : undefined
    if (ex) serverDup = { id: ex.id, front: ex.front, deckId: ex.deckId }
    return !!ex
  }

  async function save(opts: { quiet?: boolean; approve?: boolean } = {}): Promise<boolean> {
    if (!form || !fact || saving || problem || dup) return false
    const changed = dirty
    if (!changed && !opts.approve) return true
    const snapshot = key(form)
    const patch = { ...toInput(form), ...(form.deckId !== fact.deckId ? { deckId: form.deckId } : {}) }
    saving = true
    try {
      let f = fact
      if (changed) f = await api.updateFact(id, patch)
      if (opts.approve) {
        f = await api.approveFact(id)
        status.inbox = Math.max(0, status.inbox - 1)
      }
      if (!gone) adopt(f)
      else saved = snapshot
      after(f)
      if (!opts.quiet) showToast(opts.approve ? 'Approved' : 'Saved')
      return true
    } catch (e) {
      if (!conflict(e)) showToast(`Not saved: ${errorText(e)}`)
      return false
    } finally {
      saving = false
    }
  }

  // New cards: add, then clear the question and answer for the next one
  // (topic and tags stay), cursor back in the question.
  async function add() {
    if (!form || saving || problem || dup || !form.front.trim()) return
    const input = { deckId: form.deckId, ...toInput(form) }
    saving = true
    try {
      const f = await api.createFact(input)
      after(f)
      remember(f.deckId)
      form.front = ''
      form.back = ''
      saved = key(form)
      preview = false
      haptic.notify('success')
      showToast(`Added to ${f.deckName}`, {
        action: {
          label: 'Undo',
          run: () =>
            void api.deleteFact(f.id).then(
              () => {
                facts.remove(f.id)
                session.markStale()
              },
              (e) => showToast(errorText(e)),
            ),
        },
      })
      await tick()
      frontInput?.focus()
    } catch (e) {
      if (!conflict(e)) showToast(`Not added: ${errorText(e)}`)
    } finally {
      saving = false
    }
  }

  $effect(() => setUnsaved('fact', dirty))

  onDestroy(() => {
    setUnsaved('fact', false)
    gone = true
    if (!isNew && dirty && !problem && !dup && fact) void save()
  })

  async function reject() {
    if (!fact) return
    const f = fact
    try {
      const r = await api.rejectFact(f.id)
      after(r)
      status.inbox = Math.max(0, status.inbox - 1)
      showToast('Rejected', {
        action: {
          label: 'Undo',
          run: () =>
            void api.updateFact(f.id, { status: 'inbox' }).then(
              (x) => {
                after(x)
                status.inbox++
              },
              (e) => showToast(errorText(e)),
            ),
        },
      })
      saved = form ? key(form) : saved
      back()
    } catch (e) {
      showToast(errorText(e))
    }
  }

  async function approve() {
    if (await save({ approve: true })) back()
  }

  function remove() {
    if (!fact) return
    saved = form ? key(form) : saved
    facts.deleteWithUndo(fact, () => void session.refresh())
    session.dropWord(fact.id)
    session.markStale()
    back()
  }

  async function toggleSuspend() {
    const c = fact?.card
    if (!fact || !c) return
    const on = !c.suspended
    const set = (s: boolean) => {
      if (!fact?.card) return
      const next = { ...fact, card: { ...fact.card, suspended: s } }
      fact = next
      facts.upsert(next)
      session.patchFact(next)
    }
    set(on)
    haptic.select()
    try {
      const r = await api.suspendFact(fact.id, on)
      fact = { ...r, front: fact.front, back: fact.back, tags: fact.tags }
      facts.upsert(r)
      session.markStale()
    } catch (e) {
      set(!on)
      showToast(errorText(e))
    }
  }

  function autogrow(node: HTMLTextAreaElement, _v: string) {
    const fit = () => {
      node.style.height = 'auto'
      node.style.height = `${node.scrollHeight + 2}px`
    }
    fit()
    return { update: () => requestAnimationFrame(fit) }
  }

  const STATE_TEXT = { new: 'New', learning: 'Learning', known: 'Known', fading: 'Fading', suspended: 'Suspended', off: 'Off' } as const
  const days = (n: number) => (n < 1 ? `${Math.round(n * 24)} h` : `${n < 10 ? n.toFixed(1) : Math.round(n)} d`)
  const cardStats = $derived.by(() => {
    const c = fact?.card
    if (!c) return ''
    const parts: string[] = []
    if (c.suspended) parts.push('suspended')
    else if (c.state === 'new') parts.push('not studied yet')
    else {
      const due = new Date(c.due)
      const now = new Date()
      parts.push(due <= now ? 'due now' : `due in ${formatInterval(now, due)}`)
    }
    if (c.state !== 'new') {
      parts.push(`stability ${days(c.stability)}`)
      if (c.retrievability !== null) parts.push(`recall ${Math.round(c.retrievability * 100)}%`)
      if (c.lapses) parts.push(`${c.lapses} ${c.lapses === 1 ? 'lapse' : 'lapses'}`)
    }
    return parts.join(' · ')
  })
  const recent = $derived(logs.slice(0, 16).reverse())
  const cstate = $derived(dirState(fact?.card))
  const title = $derived(isNew ? 'New card' : inbox ? 'Proposal' : 'Card')
  const fromPath = encodeURIComponent(router.route.query.get('from') ?? '/words')
</script>

<div class="editor">
  <div class="screen scroll">
    <Header {title} />
    {#if isNew && !topics.length}
      <div class="empty">
        <Icon name="words" size={40} stroke={1.4} />
        <p><strong>No topics yet</strong>Cards live in topics such as “Databases”. Create one in Settings first.</p>
        <button class="btn primary" onclick={() => navigate('/settings', { replace: true })}>Open Settings</button>
      </div>
    {:else if !form || (!isNew && !fact)}
      {#if error}
        <div class="empty">
          <p><strong>Couldn't open this card</strong>{error}</p>
          <button class="btn" onclick={load}><Icon name="refresh" size={18} /> Try again</button>
        </div>
      {:else}
        <div class="skel-fields" aria-label="Loading">
          {#each [44, 60, 160, 44] as h, i (i)}<span class="skel" style="height: {h}px; border-radius: 12px"></span>{/each}
        </div>
      {/if}
    {:else}
      {#if fact}
        <div class="meta">
          {#if fact.createdBy === 'claude'}<span class="by">by Claude</span>{:else if fact.createdBy === 'import'}<span>imported</span>{/if}
          <span>added {new Date(fact.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          {#if fact.status !== 'active'}<span class="chip status {fact.status}">{fact.status}</span>{/if}
        </div>
      {/if}
      <div class="fields">
        <label class="f">
          <span class="lbl">Topic{#if fact && form.deckId !== fact.deckId}&nbsp;<em>moves there on save</em>{/if}</span>
          <select bind:value={form.deckId}>
            {#each topics as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
            {#if fact && !topics.some((d) => d.id === fact?.deckId)}<option value={fact.deckId}>{fact.deckName}</option>{/if}
          </select>
        </label>
        <label class="f">
          <span class="lbl">Question</span>
          <!-- svelte-ignore a11y_autofocus -->
          <textarea bind:this={frontInput} bind:value={form.front} use:autogrow={form.front} rows="1" placeholder="What is …?" autofocus={isNew}></textarea>
        </label>
        {#if dup}
          <div class="dup" role="alert">
            <span>Already in {deckName(dup.deckId)}: <b>{dup.front}</b></span>
            <button class="btn small" onclick={() => navigate(`/fact/${dup.id}?from=${fromPath}`, { replace: !isNew })}>Open</button>
          </div>
        {/if}
        <div class="f">
          <span class="lbl-row">
            <span class="lbl">Answer <em>Markdown</em></span>
            <span class="seg" role="tablist" aria-label="Answer view">
              <button role="tab" aria-selected={!preview} class:on={!preview} onclick={() => (preview = false)}>Edit</button>
              <button role="tab" aria-selected={preview} class:on={preview} onclick={() => (preview = true)}>Preview</button>
            </span>
          </span>
          {#if preview}
            <div class="preview" role="tabpanel">
              {#if form.back.trim()}<Markdown source={form.back} />{:else}<p class="faint">Nothing to preview yet.</p>{/if}
            </div>
          {:else}
            <textarea class="answer" bind:value={form.back} use:autogrow={form.back} rows="5" spellcheck="false" placeholder="**Key point** first; - lists, `code`, ``` blocks"></textarea>
          {/if}
        </div>
        <label class="f">
          <span class="lbl">Tags</span>
          <input bind:value={form.tags} placeholder="comma-separated" autocomplete="off" autocapitalize="off" />
        </label>
      </div>

      {#if fact?.card}
        <div class="section-label">Card</div>
        <div class="group">
          <div class="row card-row">
            <div class="cmain">
              <div class="ctitle">Review <span class="state {cstate}">{cstate ? STATE_TEXT[cstate] : ''}</span></div>
              <div class="cstats">{cardStats}</div>
              {#if recent.length}
                <div class="ratings" aria-label="Recent ratings">
                  {#each recent as l (l.id)}<span class="r{l.rating}" title={new Date(l.reviewedAt).toLocaleString()}></span>{/each}
                </div>
              {/if}
            </div>
            <button class="btn small" onclick={toggleSuspend} aria-label={fact.card.suspended ? 'Resume this card' : 'Suspend this card'}>
              <Icon name={fact.card.suspended ? 'play' : 'pause'} size={16} stroke={2} />
              {fact.card.suspended ? 'Resume' : 'Suspend'}
            </button>
          </div>
        </div>
      {/if}
      {#if fact && !inbox}
        <button class="btn danger block delete" onclick={remove}><Icon name="trash" size={18} /> Delete card</button>
      {/if}
    {/if}
  </div>
  {#if form && (fact || (isNew && topics.length))}
    <div class="bar">
      {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
      <div class="bar-row">
        {#if isNew}
          <button class="btn primary grow" onclick={add} disabled={!form.front.trim() || !!problem || !!dup || saving}>{saving ? 'Adding…' : `Add to ${deckName(form.deckId)}`}</button>
        {:else if inbox && fact?.status === 'inbox'}
          <button class="btn danger" onclick={reject}>Reject</button>
          <button class="btn primary grow" onclick={approve} disabled={!!problem || !!dup || saving}>{dirty ? 'Save & approve' : 'Approve'}</button>
        {:else}
          <button class="btn primary grow" onclick={() => save()} disabled={!dirty || !!problem || !!dup || saving}>{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
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
  .skel-fields,
  .fields {
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
  .f {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .lbl {
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    padding-left: 4px;
  }
  .lbl em {
    font-style: normal;
    font-weight: 400;
    color: var(--faint);
  }
  .lbl-row {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px;
  }
  .seg {
    display: inline-grid;
    grid-template-columns: 1fr 1fr;
    padding: 2px;
    border-radius: 9px;
    background: var(--surface-2);
  }
  .seg button {
    height: 28px;
    padding: 0 12px;
    border-radius: 7px;
    font-size: 13px;
    font-weight: 500;
    color: var(--muted);
  }
  .seg button.on {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
  textarea {
    resize: none;
    line-height: 1.45;
  }
  .answer {
    min-height: 140px;
    font-size: 16px;
  }
  /* The answer as the card will show it. */
  .preview {
    min-height: 140px;
    padding: 12px 16px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    font-size: 17px;
    line-height: 1.5;
    overflow-x: hidden;
  }
  .faint {
    margin: 0;
    color: var(--faint);
  }
  .dup {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: -6px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--hard-bg);
    color: var(--hard);
    font-size: 14px;
  }
  .dup span {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
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
    min-width: 0;
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
