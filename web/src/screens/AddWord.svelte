<script lang="ts">
  import { cleanWord, dedupeKey, normalizeTerm, posLabel, type Word } from '@recall/core'
  import { onMount, tick, untrack } from 'svelte'
  import AddTypeSwitch from '../components/AddTypeSwitch.svelte'
  import Header from '../components/Header.svelte'
  import Icon from '../components/Icon.svelte'
  import WordFields from '../components/WordFields.svelte'
  import { HttpError, NetworkError } from '../lib/api.ts'
  import { api, status, wordOutbox } from '../lib/app.svelte.ts'
  import { session } from '../lib/review.svelte.ts'
  import { navigate, router } from '../lib/router.svelte.ts'
  import { haptic } from '../lib/telegram.ts'
  import { setUnsaved } from '../lib/unsaved.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'
  import type { AutofillResult, DeckWithCounts, Draft, WordItem } from '../lib/types.ts'
  import { emptyForm, formFrom, formToInput, guessPos, newTranslations, withContext, type WordForm } from '../lib/wordForm.ts'
  import { words } from '../lib/words.svelte.ts'

  // One field, ✨ autofill as soon as typing pauses, one Add. After adding,
  // the form clears and the cursor is back in the field for the next word.

  // The tags stay for the next word: usually the same book.
  const TAGS_KEY = 'recall.lastTags'
  const readTags = () => {
    try {
      return localStorage.getItem(TAGS_KEY) ?? localStorage.getItem('recall.lastSource') ?? ''
    } catch {
      return ''
    }
  }
  const rememberTags = (tags: string[] | undefined) => {
    try {
      localStorage.removeItem('recall.lastSource')
      if (tags?.length) localStorage.setItem(TAGS_KEY, tags.join(', '))
      else localStorage.removeItem(TAGS_KEY)
    } catch {
      // Not remembered; the next word just starts without tags.
    }
  }

  // The deck it goes to: ?deck= (from the Cards tab's +), else the server's
  // default (the English deck).
  const deckId = router.route.query.get('deck') || undefined
  // A bot link can bring the word along: #/words/new?term=…
  let term = $state((() => router.route.query.get('term')?.trim() ?? '')())
  let context = $state('')
  let contextOpen = $state(false)
  let form = $state<WordForm>(emptyForm('', readTags()))
  // idle: nothing typed; loading: ✨ in flight; ready: fields to check or fill.
  let phase = $state<'idle' | 'loading' | 'ready'>('idle')
  let fallback = $state('')
  let alternatives = $state<Draft[]>([])
  let duplicate = $state<Word | null>(null)
  let adding = $state(false)
  let problem = $state('')
  let added = $state<{ id: string | null; term: string; translation: string }[]>([])
  let termEl: HTMLInputElement | undefined = $state()
  let translationInput: HTMLInputElement | undefined = $state()

  const cache = new Map<string, AutofillResult>()
  // The term + context the fields were last filled for.
  let filledFor = ''
  let seq = 0
  // 503 (not configured) or 429 (daily limit): don't ask again this visit.
  let autofillOff = false
  let edited = false
  // Enter came before the draft: add it the moment it arrives.
  let addWhenFilled = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  const key = (t: string, c: string) => `${t.replace(/\s+/g, ' ').trim().toLowerCase()}|${c.replace(/\s+/g, ' ').trim()}`

  onMount(() => {
    termEl?.focus()
    void words.ensure()
    return () => {
      clearTimeout(timer)
      setUnsaved('add', false)
    }
  })

  // A typed word not added yet: Telegram asks before closing, updates wait.
  $effect(() => setUnsaved('add', !!term.trim()))

  // Autofill once typing pauses for 600 ms.
  $effect(() => {
    const t = term
    const c = context
    untrack(() => {
      clearTimeout(timer)
      if (!t.trim()) {
        phase = 'idle'
        duplicate = null
        alternatives = []
        problem = ''
        filledFor = ''
        if (!edited) form = emptyForm('', form.tags)
        return
      }
      if (key(t, c) === filledFor) return
      // Still typing: an earlier Enter was for a different word.
      addWhenFilled = false
      timer = setTimeout(() => void fill(t, c), 600)
    })
  })

  async function fill(t: string, c: string, viaEnter = false) {
    clearTimeout(timer)
    const k = key(t, c)
    const my = ++seq
    if (viaEnter) addWhenFilled = true
    if (autofillOff || !status.online) {
      if (!status.online) fallback = "You're offline — fill it in by hand; it'll be added when you're back online."
      manual(t, c, viaEnter)
      return
    }
    let r = cache.get(k)
    if (!r) {
      phase = 'loading'
      try {
        r = await api.autofill(t.trim(), c.trim() || undefined, deckId)
        cache.set(k, r)
      } catch (e) {
        if (my !== seq || key(term, context) !== k) return
        fallback = failureText(e)
        manual(t, c, viaEnter)
        return
      }
    }
    if (my !== seq || key(term, context) !== k) return
    apply(r, c, viaEnter)
  }

  function failureText(e: unknown): string {
    if (e instanceof NetworkError) return "You're offline — fill it in by hand; it'll be added when you're back online."
    if (e instanceof HttpError) {
      if (e.status === 503 && /not configured/i.test(e.message)) {
        autofillOff = true
        return 'Autofill is off on this server — fill it in by hand.'
      }
      if (e.status === 429) {
        autofillOff = true
        return 'Daily autofill limit reached — fill it in by hand.'
      }
      if (e.status === 422) return "Claude couldn't fill this one in — fill it in by hand."
    }
    return 'Autofill failed — fill it in by hand.'
  }

  function apply(r: AutofillResult, c: string, viaEnter: boolean) {
    // Show the base form ("frown" → "to frown") without asking again for it.
    filledFor = key(r.draft.term, c)
    cache.set(filledFor, r)
    if (r.draft.term !== term.trim()) term = r.draft.term
    const f = formFrom(r.draft)
    form = { ...f, tags: form.tags, examples: withContext(f.examples, c) }
    alternatives = r.alternatives
    duplicate = r.duplicate
    fallback = autofillOff ? fallback : ''
    phase = 'ready'
    edited = false
    problem = ''
    const go = addWhenFilled
    addWhenFilled = false
    if (go && form.translations.length) {
      // Unless it turns out to be a word already there: then the panel
      // below says so and nothing is added behind the person's back.
      void tick().then(() => {
        if (!existing && filledFor === key(term, context)) void submit()
      })
    } else if ((viaEnter || go) && !form.translations.length) void tick().then(() => translationInput?.focus())
  }

  // No autofill: the fields for this term, keeping what was typed into them.
  function manual(t: string, c: string, viaEnter: boolean) {
    viaEnter ||= addWhenFilled
    addWhenFilled = false
    filledFor = key(t, c)
    if (!edited) form = { ...emptyForm(t.trim(), form.tags), examples: withContext([], c) }
    else form.pos = form.translations.length ? form.pos : guessPos(t)
    duplicate = null
    alternatives = []
    phase = 'ready'
    if (viaEnter) void tick().then(() => translationInput?.focus())
  }

  function onTermKey(e: KeyboardEvent) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (!term.trim()) return
    if (phase === 'ready' && filledFor === key(term, context)) void submit()
    else if (phase !== 'loading') void fill(term, context, true)
    else addWhenFilled = true
  }

  // The sentence is one line: Enter there works like Enter on the word.
  function onContextKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey) return
    onTermKey(e)
  }

  // The existing word still matches (same term and part of speech).
  const dupActive = $derived(!!duplicate && dedupeKey(duplicate.term, duplicate.pos) === dedupeKey(term || duplicate.term, form.pos))
  // The same term under another part of speech (imported words are often
  // "other"): not a duplicate for the server, but most likely the same word.
  const similar = $derived.by(() => {
    const t = normalizeTerm(term)
    // Not while autofill is still to answer: it may well say "already there".
    if (!t || (duplicate && dupActive) || phase !== 'ready' || filledFor !== key(term, context)) return null
    return words.all?.find((w) => w.status !== 'rejected' && normalizeTerm(w.term) === t) ?? null
  })
  const existing = $derived<Word | null>(duplicate && dupActive ? duplicate : similar)
  const toMerge = $derived(existing ? newTranslations(existing.translations, form.translations) : [])

  function submit() {
    if (dupActive) {
      if (toMerge.length) return merge()
      return openDuplicate()
    }
    return add()
  }

  async function add() {
    if (phase === 'loading') return
    const input = { ...formToInput({ ...form, term }), ...(deckId ? { deckId } : {}) }
    const c = cleanWord(input)
    if ('error' in c) {
      problem = c.error === 'at least one translation is required' ? 'Add at least one translation.' : c.error === 'term is empty' ? 'Type the word first.' : c.error
      if (!input.translations.length) translationInput?.focus()
      else if (!input.term) termEl?.focus()
      return
    }
    problem = ''
    if (!status.online) return queueOffline(input)
    // Clear the form at once so the next word can be typed while this one
    // uploads; a refusal brings it back (if the field is still free).
    const snapshot = { term, context, contextOpen, form: $state.snapshot(form) as WordForm, alternatives: $state.snapshot(alternatives) as Draft[] }
    const restore = () => {
      if (term.trim()) return false
      ;({ term, context, contextOpen } = snapshot)
      form = snapshot.form
      alternatives = snapshot.alternatives
      filledFor = key(term, context)
      phase = 'ready'
      return true
    }
    reset()
    adding = true
    try {
      const w = await api.createWord(input)
      words.upsert(w)
      session.markStale()
      rememberTags(input.tags)
      haptic.notify('success')
      added = [{ id: w.id, term: w.term, translation: w.translations[0] ?? '' }, ...added].slice(0, 5)
      showToast(`Added “${w.term}”`, { action: { label: 'Undo', run: () => void undoAdd(w) } })
    } catch (e) {
      if (e instanceof HttpError && e.status === 409 && e.data.existing) {
        const existing = e.data.existing as Word
        haptic.notify('warning')
        if (restore()) duplicate = existing
        else showToast(`“${existing.term}” is already in your words`, { action: { label: 'Open', run: () => navigate(`/word/${existing.id}?from=${encodeURIComponent('/words')}`) } })
      } else if (e instanceof NetworkError) queueOffline(input, false)
      else {
        restore()
        haptic.notify('error')
        showToast(`Not added: ${errorText(e)}`)
      }
    } finally {
      adding = false
    }
  }

  function queueOffline(input: ReturnType<typeof formToInput>, clear = true) {
    const id = wordOutbox.add(input)
    rememberTags(input.tags)
    added = [{ id: null, term: input.term, translation: input.translations[0] ?? '' }, ...added].slice(0, 5)
    showToast(`Saved “${input.term}” — adds when you're back online`, { action: { label: 'Undo', run: () => void (wordOutbox.remove(id) || showToast(`“${input.term}” was already on its way — delete it from Cards`)) } })
    if (clear) reset()
  }

  async function undoAdd(w: WordItem) {
    try {
      await api.deleteWord(w.id)
      words.remove(w.id)
      session.markStale()
      added = added.filter((a) => a.id !== w.id)
      showToast(`Removed “${w.term}”`)
    } catch (e) {
      showToast(`Not removed: ${errorText(e)}`)
    }
  }

  async function merge() {
    const d = existing
    if (!d || adding) return
    adding = true
    const before = { translations: d.translations, examples: d.examples }
    const input = formToInput({ ...form, term })
    const examples = [...d.examples, ...(input.examples ?? []).filter((e) => !d.examples.some((x) => x.text === e.text))].slice(0, 5)
    try {
      const w = await api.updateWord(d.id, { translations: [...d.translations, ...toMerge], examples })
      words.upsert(w)
      session.markStale()
      const n = toMerge.length
      showToast(`Added ${n} ${n === 1 ? 'translation' : 'translations'} to “${w.term}”`, {
        action: {
          label: 'Undo',
          run: () =>
            void api.updateWord(d.id, before).then(
              (x) => words.upsert(x),
              (e) => showToast(`Not undone: ${errorText(e)}`),
            ),
        },
      })
      reset()
    } catch (e) {
      showToast(errorText(e))
    } finally {
      adding = false
    }
  }

  function openDuplicate() {
    if (existing) navigate(`/word/${existing.id}?from=${encodeURIComponent('/words')}`)
  }

  function pickAlternative(alt: Draft) {
    const current: Draft = { ...formToInput({ ...form, term }), ipa: form.ipa || null, note: form.note || null, cefr: form.cefr || null } as Draft
    alternatives = [current, ...alternatives.filter((a) => a !== alt)]
    const f = formFrom(alt)
    form = { ...f, tags: form.tags, examples: withContext(f.examples, context) }
    if (alt.term !== term.trim()) {
      filledFor = key(alt.term, context)
      term = alt.term
    }
    duplicate = null
    haptic.select()
  }

  function reset() {
    clearTimeout(timer)
    seq++
    term = ''
    context = ''
    contextOpen = false
    form = emptyForm('', readTags())
    phase = 'idle'
    alternatives = []
    duplicate = null
    problem = ''
    edited = false
    addWhenFilled = false
    filledFor = ''
    if (!autofillOff) fallback = ''
    termEl?.focus()
  }

  function openContext() {
    contextOpen = true
    requestAnimationFrame(() => document.getElementById('add-context')?.focus())
  }

  const altLabel = (a: Draft) => [a.term !== term.trim() ? a.term : null, posLabel(a.pos), a.translations[0]].filter(Boolean).join(' ')
  const actionLabel = $derived(
    phase === 'loading' && addWhenFilled
      ? 'Adding when it’s filled in…'
      : dupActive ? (toMerge.length ? `Add ${toMerge.length === 1 ? 'it' : 'them'} to “${duplicate!.term}”` : `Open “${duplicate!.term}”`) : 'Add',
  )
</script>

<div class="add-screen">
  <div class="screen scroll">
    <Header title="Add" />
    <AddTypeSwitch current="word" deck={deckId ? session.decks[deckId] : undefined} />

    <div class="term-box" class:busy={phase === 'loading'}>
      <input
        bind:this={termEl}
        bind:value={term}
        maxlength="200"
        onkeydown={onTermKey}
        class="term"
        placeholder="English word or phrase"
        lang="en"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        enterkeyhint="go"
        aria-label="English word or phrase"
      />
      {#if phase === 'loading'}
        <span class="spark" aria-label="Filling in"><Icon name="sparkle" size={20} stroke={1.8} /></span>
      {:else if term}
        <button class="clear" onclick={reset} aria-label="Clear"><Icon name="x" size={16} stroke={2.2} /></button>
      {/if}
    </div>

    {#if contextOpen}
      <textarea id="add-context" class="context" bind:value={context} onkeydown={onContextKey} enterkeyhint="go" rows="2" lang="en" placeholder="The sentence where you met it — picks the right sense and becomes the first example"></textarea>
    {:else}
      <button class="link" onclick={openContext}><Icon name="plus" size={15} stroke={2.2} /> Sentence where you met it</button>
    {/if}

    {#if existing}
      <div class="dup" role="status">
        <p class="dup-title"><Icon name="info" size={18} /> {dupActive || existing.pos === form.pos ? 'Already in your words' : 'In your words as another part of speech'}</p>
        <p class="dup-word"><b>{existing.term}</b> <span class="pos">{posLabel(existing.pos) ?? existing.pos}</span> — {existing.translations.join(', ')}</p>
        <div class="dup-actions">
          {#if toMerge.length}
            <button class="btn primary" onclick={merge} disabled={adding}>Add {toMerge.map((t) => `“${t}”`).join(', ')} to it</button>
          {/if}
          <button class="btn" onclick={openDuplicate}>Open</button>
        </div>
      </div>
    {/if}

    {#if fallback && phase !== 'idle'}
      <p class="fallback"><Icon name="info" size={16} /> {fallback}</p>
    {/if}

    {#if phase === 'loading'}
      <div class="draft skeleton" aria-label="Filling in">
        <span class="skel" style="width: 38%; height: 14px"></span>
        <div class="skel-chips"><span class="skel"></span><span class="skel"></span><span class="skel"></span></div>
        <span class="skel" style="width: 70%"></span>
        <span class="skel" style="width: 55%"></span>
      </div>
    {:else if phase === 'ready'}
      {#if alternatives.length}
        <div class="alts" role="group" aria-label="Other senses">
          <span class="alts-label">Other senses</span>
          {#each alternatives as a, i (i)}
            <button class="alt" onclick={() => pickAlternative(a)}>{altLabel(a)}</button>
          {/each}
        </div>
      {/if}
      <div class="draft">
        <WordFields bind:form bind:translationInput tags={((session.decks[deckId ?? session.deckId] as Partial<DeckWithCounts> | undefined)?.tags ?? []).map((t) => t.tag)} showTerm={false} onsubmit={() => void submit()} onedit={() => (edited = true)} />
      </div>
    {:else}
      <p class="lead"><Icon name="sparkle" size={16} /> Type a word: Claude fills in translations, pronunciation and examples. Enter adds it, and the next one can follow straight away.</p>
      {#if added.length}
        <div class="section-label">Just added</div>
        <div class="group">
          {#each added as a, i (i)}
            {#if a.id}
              <button class="row recent" onclick={() => navigate(`/word/${a.id}?from=${encodeURIComponent('/words')}`)}>
                <span class="grow"><b>{a.term}</b> <span class="muted">{a.translation}</span></span>
                <Icon name="chevron" size={16} />
              </button>
            {:else}
              <div class="row recent"><span class="grow"><b>{a.term}</b> <span class="muted">{a.translation}</span></span><span class="chip">waiting to sync</span></div>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  <div class="bar">
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
    <button
      class="btn primary block"
      onclick={() => (phase === 'loading' ? (addWhenFilled = true) : void submit())}
      disabled={!term.trim() || (phase === 'loading' && addWhenFilled)}>{actionLabel}</button
    >
  </div>
</div>

<style>
  .add-screen {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    height: auto;
  }
  .term-box {
    position: relative;
    display: flex;
    align-items: center;
  }
  .term {
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.015em;
    padding: 14px 48px 14px 16px;
    border-radius: 14px;
  }
  .spark,
  .clear {
    position: absolute;
    right: 8px;
    width: 36px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--faint);
  }
  .spark {
    color: var(--accent);
    animation: pulse 0.9s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.35;
      transform: scale(0.88);
    }
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 40px;
    margin-top: 4px;
    padding: 0 6px;
    font-size: 15px;
    color: var(--accent);
  }
  .context {
    margin-top: 8px;
    font-size: 16px;
  }
  .lead {
    display: flex;
    gap: 8px;
    margin: 18px 6px 0;
    font-size: 15px;
    line-height: 1.45;
    color: var(--muted);
    text-wrap: pretty;
  }
  .lead :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--accent);
  }
  .fallback {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 10px 6px 0;
    font-size: 14px;
    color: var(--muted);
  }
  .fallback :global(svg) {
    flex: none;
  }
  .draft {
    margin-top: 12px;
    padding: 14px;
    border-radius: var(--radius-m);
    background: var(--surface-2);
    animation: rise-sm var(--t-fast) var(--ease-out);
  }
  .draft.skeleton {
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--surface);
  }
  .skel-chips {
    display: flex;
    gap: 6px;
  }
  .skel-chips .skel {
    width: 84px;
    height: 40px;
    border-radius: 10px;
  }
  .alts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
  }
  .alts-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--muted);
    margin: 0 4px 0 4px;
  }
  .alt {
    min-height: 40px;
    padding: 0 12px;
    border-radius: 17px;
    font-size: 15px;
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--border);
    transition: transform var(--t-press) var(--ease-out);
  }
  .alt:active {
    transform: scale(0.96);
  }
  .dup {
    margin-top: 12px;
    padding: 12px 14px;
    border-radius: var(--radius-m);
    background: var(--accent-soft);
  }
  .dup p {
    margin: 0;
  }
  .dup-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 600;
    color: var(--accent);
  }
  .dup-word {
    margin-top: 4px !important;
    font-size: 16px;
  }
  .pos {
    font-style: italic;
    color: var(--muted);
  }
  .dup-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
  .dup-actions .btn {
    min-height: 40px;
    font-size: 15px;
  }
  .recent {
    font-size: 15.5px;
    color: var(--faint);
  }
  .recent .grow {
    flex: 1;
    min-width: 0;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar {
    flex: none;
    padding: 10px calc(16px + var(--sar)) 10px calc(16px + var(--sal));
    background: var(--bg);
    box-shadow: inset 0 0.5px 0 var(--hairline);
  }
  .bar .btn {
    min-height: 52px;
    font-size: 17px;
  }
  .problem {
    margin: 0 4px 8px;
    font-size: 14px;
    color: var(--again);
  }
</style>
