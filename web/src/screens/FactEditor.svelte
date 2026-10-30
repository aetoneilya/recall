<script lang="ts">
  import { cleanExercise, cleanFact, isTapType, formatInterval, type ExerciseType, type ReviewLog } from '@recall/core'
  import ConfirmButton from '../components/ConfirmButton.svelte'
  import { onDestroy, tick, untrack } from 'svelte'
  import AddTypeSwitch from '../components/AddTypeSwitch.svelte'
  import Header from '../components/Header.svelte'
  import TagSuggest from '../components/TagSuggest.svelte'
  import Icon from '../components/Icon.svelte'
  import Markdown from '../components/Markdown.svelte'
  import { api, editOutbox } from '../lib/app.svelte.ts'
  import { HttpError, NetworkError } from '../lib/api.ts'
  import { dropCard } from '../lib/drop.ts'
  import { duplicateFact } from '../lib/factFilter.ts'
  import { facts } from '../lib/facts.svelte.ts'
  import { session } from '../lib/review.svelte.ts'
  import { back, navigate, router } from '../lib/router.svelte.ts'
  import { haptic } from '../lib/telegram.ts'
  import { setUnsaved } from '../lib/unsaved.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'
  import type { DeckWithCounts, ExerciseInfo, FactItem } from '../lib/types.ts'
  import { dirState } from '../lib/wordFilter.ts'

  // One fact: its deck, question, answer (Markdown, with a preview) and
  // tags; its card's state and history; its exercise pool (a grammar rule
  // has three or more); suspend, drop and delete (undoable). `id = 'new'`
  // writes new cards one after another into the chosen deck; with ?rule=1 it
  // starts a grammar rule and opens it after the add, to fill the pool.
  // Edits save with one tap and on the way out, like the word editor.
  let { id }: { id: string } = $props()
  const isNew = $derived(id === 'new')
  const asRule = router.route.query.get('rule') === '1'

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
      // No storage: the next add starts from the deck under review.
    }
  }

  const decks = $derived(Object.values(session.decks))
  const deckTags = (id: string) => ((session.decks[id] as Partial<DeckWithCounts> | undefined)?.tags ?? []).map((t) => t.tag)

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
      const f: Form = { deckId: router.route.query.get('deck') || readLast() || session.deckId, front: router.route.query.get('term') ?? '', back: '', tags: asRule ? 'Grammar' : '' }
      form = f
      saved = key(f)
      return
    }
    // Paint at once from the device's copy or today's queue; the fetch brings logs and the latest.
    const queued = session.fact(id)
    const cached = facts.get(id) ?? (queued ? ({ ...queued, card: null } as FactItem) : undefined)
    if (cached) adopt(cached)
  })()
  // New card: a known deck, else the one under review, else the first.
  $effect(() => {
    if (!isNew || !form || !decks.length) return
    if (!decks.some((d) => d.id === form!.deckId)) {
      form.deckId = session.decks[session.deckId] ? session.deckId : decks[0]!.id
      saved = key(form)
    }
  })

  // The rule's exercise pool (empty for a plain fact): the list, flag /
  // unflag / delete, and a form to add one.
  let pool = $state.raw<ExerciseInfo[]>([])
  let poolOpen = $state(false)
  let draft = $state({ type: 'choose' as 'choose' | 'spot', prompt: '', answer: '', accepted: '', explain: '', options: '', wrong: '' })
  let draftError = $state('')
  const poolActive = $derived(pool.filter((e) => e.status === 'active').length)
  async function loadPool() {
    if (isNew) return
    try {
      pool = (await api.exercises(id)).filter((e) => isTapType(e.type))
    } catch {
      // Offline: the section stays as it was.
    }
  }
  void loadPool()
  async function setFlag(e: ExerciseInfo, flagged: boolean) {
    try {
      const x = await api.patchExercise(e.id, flagged ? { status: 'flagged' } : { status: 'active', needsReview: false })
      pool = pool.map((p) => (p.id === x.id ? x : p))
      session.markStale()
    } catch (err) {
      showToast(errorText(err))
    }
  }
  async function removeItem(e: ExerciseInfo) {
    try {
      await api.deleteExercise(e.id)
      pool = pool.filter((p) => p.id !== e.id)
      session.markStale()
    } catch (err) {
      showToast(errorText(err))
    }
  }
  async function addItem() {
    const list = (v: string) => v.split(';').map((a) => a.trim()).filter(Boolean)
    const input = {
      type: draft.type, prompt: draft.prompt, answer: draft.answer, explain: draft.explain || null,
      options: list(draft.options), wrong: draft.type === 'spot' ? draft.wrong : null,
    }
    const c = cleanExercise(input)
    if ('error' in c) {
      draftError = c.error
      return
    }
    try {
      const r = await api.addExercises(id, [c.item])
      if (r.duplicates.length) {
        draftError = 'The pool already has this prompt.'
        return
      }
      pool = r.exercises.filter((e) => isTapType(e.type))
      draft = { ...draft, prompt: '', answer: '', accepted: '', explain: '', options: '', wrong: '' }
      draftError = ''
      session.markStale()
    } catch (err) {
      draftError = errorText(err)
    }
  }
  const TYPE_NAMES: Record<ExerciseType, string> = { choose: 'Choose', spot: 'Spot', gap: 'Gap', fix: 'Fix', rewrite: 'Rewrite', write: 'Write' }

  async function load() {
    if (isNew) return
    try {
      const d = await api.fact(id)
      // Edits made offline and not sent yet show over the server's copy.
      const pending = editOutbox.get('fact', id)
      if (pending) d.fact = { ...d.fact, ...(pending as Partial<FactItem>) }
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
  // A new card's empty answer is said only once the answer box was left (or
  // Add tapped): not in red before anything was typed there.
  let answerLeft = $state(false)
  const problem = $derived.by(() => {
    if (!form) return ''
    if (isNew && !form.front.trim() && !form.back.trim()) return ''
    const r = cleanFact(toInput(form))
    return 'error' in r ? (r.error === 'front is empty' ? 'Write the question.' : r.error === 'back is empty' ? 'Write the answer.' : r.error) : ''
  })
  // The same question already in the chosen deck, caught as you type.
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
  const deckName = (deckId: string) => decks.find((d) => d.id === deckId)?.name ?? fact?.deckName ?? 'this deck'

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

  async function save(opts: { quiet?: boolean } = {}): Promise<boolean> {
    if (!form || !fact || saving || problem || dup) return false
    if (!dirty) return true
    const snapshot = key(form)
    const patch = { ...toInput(form), ...(form.deckId !== fact.deckId ? { deckId: form.deckId } : {}) }
    saving = true
    try {
      const f = await api.updateFact(id, patch)
      editOutbox.supersede('fact', id, patch)
      if (!gone) adopt(f)
      else saved = snapshot
      after(f)
      if (!opts.quiet) showToast('Saved')
      return true
    } catch (e) {
      if (e instanceof NetworkError) return keepOffline(patch, snapshot)
      if (!conflict(e)) showToast(`Not saved: ${errorText(e)}`)
      return false
    } finally {
      saving = false
    }
  }

  // Offline: the edit waits on the device (sent with the ratings) and shows
  // everywhere at once.
  function keepOffline(patch: { front: string; back: string; tags: string[]; deckId?: string }, snapshot: string): boolean {
    if (!fact) return false
    editOutbox.add('fact', id, patch)
    const f: FactItem = { ...fact, ...patch, ...(patch.deckId ? { deckName: deckName(patch.deckId) } : {}) }
    if (!gone) adopt(f)
    else saved = snapshot
    after(f)
    showToast("Saved on this device — it syncs when you're online")
    return true
  }

  // New cards: add, then clear the question and answer for the next one
  // (deck and tags stay), cursor back in the question. A new grammar rule
  // opens in its editor instead, at the exercise pool.
  async function add() {
    answerLeft = true
    if (!form || saving || problem || dup || !form.front.trim()) return
    const input = { deckId: form.deckId, ...toInput(form) }
    saving = true
    try {
      const f = await api.createFact(input)
      after(f)
      remember(f.deckId)
      if (asRule) {
        saved = key(form)
        navigate(`/fact/${f.id}?from=${fromPath}&rule=1`, { replace: true })
        return
      }
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

  // Dropped: never shown again, kept so it isn't added again.
  async function drop(on: boolean) {
    if (!fact || !form) return
    if (dirty && !(await save({ quiet: true }))) return
    const f = fact
    if (!(await dropCard('fact', f.id, f.front, on))) return
    if (on) back()
    else fact = { ...f, status: 'active' }
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
  const title = $derived(isNew ? 'Add' : 'Card')
  // Opened right after adding a rule: the pool is what's left to fill.
  let exPrompt: HTMLInputElement | undefined = $state()
  $effect(() => {
    if (asRule && !isNew && exPrompt) untrack(() => exPrompt!.scrollIntoView({ block: 'center' }))
  })
  const fromPath = encodeURIComponent(router.route.query.get('from') ?? '/words')
</script>

<div class="editor">
  <div class="screen scroll">
    <Header {title} />
    {#if isNew}<AddTypeSwitch current={asRule ? 'rule' : 'question'} deck={form ? session.decks[form.deckId] : undefined} />{/if}
    {#if isNew && !decks.length}
      <div class="empty">
        <Icon name="words" size={40} stroke={1.4} />
        <p><strong>No decks yet</strong>Cards live in decks such as “Programming”. Create one in Settings first.</p>
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
          {#if fact.createdBy === 'import'}<span>imported</span>{/if}
          <span>added {new Date(fact.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          {#if fact.status === 'rejected'}<span class="chip status rejected">dropped</span>{/if}
        </div>
      {/if}
      <div class="fields">
        <label class="f">
          <span class="lbl">Deck{#if fact && form.deckId !== fact.deckId}&nbsp;<em>moves there on save</em>{/if}</span>
          <select bind:value={form.deckId}>
            {#each decks as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
            {#if fact && !decks.some((d) => d.id === fact?.deckId)}<option value={fact.deckId}>{fact.deckName}</option>{/if}
          </select>
        </label>
        <label class="f">
          <span class="lbl">{asRule ? 'Rule' : 'Question'}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <textarea bind:this={frontInput} bind:value={form.front} maxlength="2000" use:autogrow={form.front} rows="1" placeholder={asRule ? 'Present Perfect vs Past Simple' : 'What is …?'} autofocus={isNew}></textarea>
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
            <textarea class="answer" onblur={() => (answerLeft = true)} bind:value={form.back} maxlength="20000" use:autogrow={form.back} rows="5" spellcheck="false" placeholder={asRule ? 'The rule in a few lines, with an example' : '**Key point** first; - lists, `code`, ``` blocks'}></textarea>
          {/if}
        </div>
        <label class="f">
          <span class="lbl">Tags</span>
          <input bind:value={form.tags} placeholder="comma-separated; a/b nests" autocomplete="off" autocapitalize="off" />
          <TagSuggest bind:value={form.tags} tags={deckTags(form.deckId)} />
        </label>
      </div>

      {#if fact?.card}
        <div class="section-label">Card</div>
        <div class="group">
          <div class="row card-row">
            <div class="cmain">
              <div class="ctitle">This card <span class="state {cstate}">{cstate ? STATE_TEXT[cstate] : ''}</span></div>
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
      {#if isNew && asRule}
        <p class="hint rule-hint">Next: three or more exercises — then the rule is reviewed by tapping through them.</p>
      {/if}
      {#if fact}
        <div class="section-label">Exercises{#if pool.length}&nbsp;<span class="faint-n">{poolActive} active{pool.length > poolActive ? ` · ${pool.length - poolActive} flagged` : ''}</span>{/if}</div>
        {#if pool.length}
          <div class="group pool">
            {#each poolOpen ? pool : pool.slice(0, 5) as e (e.id)}
              <div class="row ex" class:flagged={e.status === 'flagged'}>
                <div class="exmain">
                  <div class="exprompt"><span class="extype">{TYPE_NAMES[e.type]}</span>{e.prompt}</div>
                  {#if e.type === 'spot'}
                    <div class="exans"><span class="was">{e.wrong}</span> → {e.answer}{#if (e.options?.length ?? 0) > 1}<span class="faint-n"> · of {e.options!.join(' · ')}</span>{/if}</div>
                  {:else if e.type === 'choose'}
                    <div class="exans">{e.answer}<span class="faint-n"> · of {(e.options ?? []).join(' · ')}</span></div>
                  {:else if e.type === 'write'}
                    <div class="exans">Graded by Claude{#if e.rubric}<span class="faint-n"> · {e.rubric}</span>{/if}</div>
                  {:else}
                    <div class="exans">→ {e.answer}{#if e.accepted.length}<span class="faint-n"> · {e.accepted.join(' · ')}</span>{/if}<span class="faint-n"> · typed (legacy)</span></div>
                  {/if}
                  <div class="exstats">
                    {#if e.status === 'flagged'}<span class="chip">flagged</span>{/if}
                    {#if e.needsReview}<span class="chip review">“I was right”</span>{/if}
                    <span>{e.shownCount ? `shown ${e.shownCount} · ✓ ${e.correctCount} · ✗ ${e.wrongCount}` : 'not shown yet'}</span>
                  </div>
                </div>
                <div class="exactions">
                  <button class="btn small" onclick={() => setFlag(e, e.status !== 'flagged')}>{e.status === 'flagged' ? 'Unflag' : 'Flag'}</button>
                  <ConfirmButton class="btn small danger" onconfirm={() => void removeItem(e)} confirmLabel="Delete?"><Icon name="trash" size={15} /></ConfirmButton>
                </div>
              </div>
            {/each}
            {#if pool.length > 5}
              <button class="row more" onclick={() => (poolOpen = !poolOpen)}>{poolOpen ? 'Show fewer' : `Show all ${pool.length}`}</button>
            {/if}
          </div>
        {/if}
        <form class="add-ex" onsubmit={(ev) => { ev.preventDefault(); void addItem() }}>
          <div class="add-row">
            <select bind:value={draft.type} aria-label="Type">
              <option value="choose">Choose</option>
              <option value="spot">Spot</option>
            </select>
            <input bind:this={exPrompt} bind:value={draft.prompt} maxlength="500" placeholder={draft.type === 'choose' ? 'The backup runs ___ 3 a.m.' : 'His shoes gets wet.'} aria-label="Sentence" autocomplete="off" />
          </div>
          {#if draft.type === 'spot'}
            <input bind:value={draft.wrong} placeholder="The wrong word(s), as in the sentence" aria-label="Wrong word" autocomplete="off" autocapitalize="off" />
          {/if}
          <input bind:value={draft.options} placeholder={draft.type === 'choose' ? 'Options: at; in; on (— = nothing)' : 'Replacements: get; getting (— = delete)'} aria-label="Options" autocomplete="off" autocapitalize="off" />
          <input bind:value={draft.answer} maxlength="300" placeholder="The right option" aria-label="Answer" autocomplete="off" autocapitalize="off" />
          <input bind:value={draft.explain} maxlength="500" placeholder="Why (one line, optional)" aria-label="Why" autocomplete="off" />
          {#if draftError}<p class="problem">{draftError}</p>{/if}
          <button class="btn" type="submit" disabled={!draft.prompt.trim() || !draft.answer.trim()}><Icon name="plus" size={16} stroke={2.2} /> Add exercise</button>
          {#if poolActive < 3}<p class="hint" class:wanted={asRule}>{asRule ? `A grammar rule wants at least three exercises (${poolActive} so far): it is` : 'With three or more, this card is'} reviewed through three of them at a time, by tapping, instead of question and answer.</p>{/if}
        </form>
        <div class="danger-zone">
          {#if fact.status === 'rejected'}
            <button class="btn" onclick={() => drop(false)}><Icon name="undo" size={18} /> Restore</button>
          {:else}
            <button class="btn" onclick={() => drop(true)}><Icon name="x" size={18} /> Drop</button>
          {/if}
          <button class="btn danger" onclick={remove}><Icon name="trash" size={18} /> Delete</button>
        </div>
        <p class="zone-note">{fact.status === 'rejected' ? 'Dropped: never shown, and not suggested again.' : 'Drop: never shown again, and not suggested again. Delete removes it with its history.'}</p>
      {/if}
    {/if}
  </div>
  {#if form && (fact || (isNew && decks.length))}
    <div class="bar">
      {#if problem && !(isNew && !answerLeft && !form.back.trim())}<p class="problem" role="alert">{problem}</p>{/if}
      <div class="bar-row">
        {#if isNew}
          <button class="btn primary grow" onclick={add} disabled={!form.front.trim() || !!problem || !!dup || saving}>{saving ? 'Adding…' : `Add to ${deckName(form.deckId)}`}</button>
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
  .faint-n {
    color: var(--faint);
    font-weight: 400;
  }
  .ex {
    align-items: flex-start;
    gap: 10px;
    padding-top: 10px;
    padding-bottom: 10px;
  }
  .ex.flagged .exmain {
    opacity: 0.55;
  }
  .exmain {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 15px;
    line-height: 1.4;
  }
  .exprompt {
    overflow-wrap: anywhere;
  }
  .extype {
    display: inline-block;
    margin-right: 6px;
    padding: 0 6px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    vertical-align: 1px;
    color: var(--muted);
    background: var(--surface-2);
  }
  .was {
    color: var(--again);
    text-decoration: line-through;
  }
  .exans {
    color: var(--good);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .exstats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .chip.review {
    color: var(--hard);
  }
  .exactions {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: stretch;
  }
  .more {
    justify-content: center;
    color: var(--accent);
    font-weight: 500;
  }
  .add-ex {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 10px;
  }
  .add-row {
    display: flex;
    gap: 8px;
  }
  .add-row select {
    flex: none;
    width: 108px;
  }
  .add-row input {
    flex: 1;
    min-width: 0;
  }
  .add-ex .btn {
    align-self: flex-start;
  }
  .hint {
    margin: 0 4px;
    font-size: 13px;
    color: var(--faint);
  }
  .btn.small {
    min-height: 40px;
    padding: 0 12px;
    font-size: 14px;
    flex: none;
  }
  .hint.wanted {
    color: var(--accent);
  }
  .rule-hint {
    margin-top: 16px;
  }
  .danger-zone {
    display: flex;
    gap: 10px;
    margin-top: 28px;
  }
  .danger-zone .btn {
    flex: 1;
  }
  .zone-note {
    margin: 8px 4px 0;
    font-size: 13px;
    color: var(--faint);
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
