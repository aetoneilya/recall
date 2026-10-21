<script lang="ts">
  import { cleanFact, type Fact } from '@recall/core'
  import { onDestroy } from 'svelte'
  import Header from '../components/Header.svelte'
  import Icon from '../components/Icon.svelte'
  import { api } from '../lib/app.svelte.ts'
  import { session } from '../lib/review.svelte.ts'
  import { setUnsaved } from '../lib/unsaved.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'

  // A fact's question, answer (Markdown) and tags, opened from its review
  // card. Saves with one tap and on the way out, like the word editor, and
  // the card shows the fix when Back returns to it.
  let { id }: { id: string } = $props()

  interface Form {
    front: string
    back: string
    tags: string
  }

  let fact = $state.raw<(Fact & { deckName: string }) | null>(null)
  let form = $state<Form | null>(null)
  let saved = ''
  let error = $state('')
  let saving = $state(false)
  let gone = false

  const toForm = (f: Fact): Form => ({ front: f.front, back: f.back, tags: f.tags.join(', ') })
  const toInput = (f: Form) => ({ front: f.front, back: f.back, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) })
  const key = (f: Form) => JSON.stringify(toInput(f))

  function adopt(f: Fact & { deckName: string }) {
    fact = f
    form = toForm(f)
    saved = key(form)
  }
  // Paint at once from today's queue; the fetch brings the latest.
  ;(() => {
    const cached = session.fact(id)
    if (cached) adopt(cached)
  })()

  async function load() {
    try {
      const d = await api.fact(id)
      if (!form || !dirty) adopt(d.fact)
      else fact = d.fact
      error = ''
    } catch (e) {
      if (!fact) error = errorText(e)
    }
  }
  void load()

  const dirty = $derived(!!form && key(form) !== saved)
  const problem = $derived.by(() => {
    if (!form) return ''
    const r = cleanFact(toInput(form))
    return 'error' in r ? (r.error === 'front is empty' ? 'Write the question.' : r.error === 'back is empty' ? 'Write the answer.' : r.error) : ''
  })

  async function save(opts: { quiet?: boolean } = {}): Promise<boolean> {
    if (!form || !fact || saving || problem) return false
    if (!dirty) return true
    const input = toInput(form)
    saving = true
    try {
      const f = await api.updateFact(id, input)
      if (!gone) adopt(f)
      else saved = JSON.stringify(input)
      session.patchFact(f)
      session.markStale()
      if (!opts.quiet) showToast('Saved')
      return true
    } catch (e) {
      showToast(`Not saved: ${errorText(e)}`)
      return false
    } finally {
      saving = false
    }
  }

  $effect(() => setUnsaved('fact', dirty))

  // Leaving with unsaved (valid) edits keeps them.
  onDestroy(() => {
    setUnsaved('fact', false)
    gone = true
    if (dirty && !problem && fact) void save()
  })

  function autogrow(node: HTMLTextAreaElement, _v: string) {
    const fit = () => {
      node.style.height = 'auto'
      node.style.height = `${node.scrollHeight + 2}px`
    }
    fit()
    return { update: () => requestAnimationFrame(fit) }
  }
</script>

<div class="editor">
  <div class="screen scroll">
    <Header title="Card" />
    {#if !form || !fact}
      {#if error}
        <div class="empty">
          <p><strong>Couldn't open this card</strong>{error}</p>
          <button class="btn" onclick={load}><Icon name="refresh" size={18} /> Try again</button>
        </div>
      {:else}
        <div class="skel-fields" aria-label="Loading">
          {#each [60, 160, 44] as h, i (i)}<span class="skel" style="height: {h}px; border-radius: 12px"></span>{/each}
        </div>
      {/if}
    {:else}
      <div class="meta">
        <span class="deck">{fact.deckName}</span>
        {#if fact.createdBy === 'import'}<span>imported</span>{/if}
        <span>added {new Date(fact.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      </div>
      <div class="fields">
        <label class="f">
          <span class="lbl">Question</span>
          <textarea bind:value={form.front} use:autogrow={form.front} rows="1" placeholder="What is …?"></textarea>
        </label>
        <label class="f">
          <span class="lbl">Answer <em>Markdown: **bold**, `code`, - lists, ``` blocks</em></span>
          <textarea class="answer" bind:value={form.back} use:autogrow={form.back} rows="4" spellcheck="false"></textarea>
        </label>
        <label class="f">
          <span class="lbl">Tags</span>
          <input bind:value={form.tags} placeholder="comma-separated" autocomplete="off" autocapitalize="off" />
        </label>
      </div>
    {/if}
  </div>
  {#if form && fact}
    <div class="bar">
      {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
      <button class="btn primary block" onclick={() => save()} disabled={!dirty || !!problem || saving}>{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
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
  .deck {
    font-weight: 600;
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
  textarea {
    resize: none;
    line-height: 1.45;
  }
  .answer {
    min-height: 120px;
    font-size: 16px;
  }
  .bar {
    flex: none;
    padding: 10px calc(16px + var(--sar)) 10px calc(16px + var(--sal));
    background: var(--bg);
    box-shadow: inset 0 0.5px 0 var(--hairline);
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
