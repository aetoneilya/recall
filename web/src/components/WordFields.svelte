<script lang="ts">
  import { CEFR_LEVELS, PARTS_OF_SPEECH } from '@recall/core'
  import { POS_NAMES, type WordForm } from '../lib/wordForm.ts'
  import Icon from './Icon.svelte'
  import TranslationChips from './TranslationChips.svelte'

  // Every field of a word except (optionally) the term. Used by the add
  // screen's draft card and the editor; `form` is edited in place.
  let {
    form = $bindable(),
    showTerm = true,
    langs = ['en', 'ru'],
    onsubmit,
    onedit,
    translationInput = $bindable(),
  }: {
    form: WordForm
    showTerm?: boolean
    langs?: [string, string]
    onsubmit?: () => void
    // Any change by the user (not by code).
    onedit?: () => void
    translationInput?: HTMLInputElement
  } = $props()

  const [target, native] = $derived(langs)

  function autogrow(node: HTMLTextAreaElement, _v: string) {
    const fit = () => {
      node.style.height = 'auto'
      node.style.height = `${node.scrollHeight + 2}px`
    }
    fit()
    return { update: () => requestAnimationFrame(fit) }
  }

  function addExample() {
    form.examples = [...form.examples, { text: '', translation: '' }]
    onedit?.()
  }

  function removeExample(i: number) {
    form.examples = form.examples.filter((_, k) => k !== i)
    onedit?.()
  }
</script>

<div class="fields" oninput={() => onedit?.()} onchange={() => onedit?.()} role="group">
  {#if showTerm}
    <label class="f">
      <span class="lbl">Word or phrase</span>
      <input bind:value={form.term} lang={target} autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
    </label>
  {/if}

  <div class="f">
    <span class="lbl">Translations <em>main first · tap one to move it</em></span>
    <div class="box"><TranslationChips bind:value={form.translations} bind:input={translationInput} lang={native} {onsubmit} /></div>
  </div>

  <div class="row3">
    <label class="f">
      <span class="lbl">Part of speech</span>
      <select bind:value={form.pos}>
        {#each PARTS_OF_SPEECH as p (p)}<option value={p}>{POS_NAMES[p]}</option>{/each}
      </select>
    </label>
    <label class="f">
      <span class="lbl">Level</span>
      <select bind:value={form.cefr}>
        <option value="">—</option>
        {#each CEFR_LEVELS as c (c)}<option value={c}>{c}</option>{/each}
      </select>
    </label>
  </div>

  <label class="f">
    <span class="lbl">Pronunciation <em>IPA, General American</em></span>
    <span class="ipa-wrap">
      <span class="slash">/</span>
      <input class="ipa" bind:value={form.ipa} placeholder="optional" lang={target} autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <span class="slash">/</span>
    </span>
  </label>

  <div class="f">
    <span class="lbl">Examples</span>
    {#each form.examples as ex, i (i)}
      <div class="example">
        <textarea bind:value={ex.text} use:autogrow={ex.text} rows="1" lang={target} placeholder="Sentence with the word"></textarea>
        <textarea class="tr" bind:value={ex.translation} use:autogrow={ex.translation} rows="1" lang={native} placeholder="Translation (optional)"></textarea>
        <button type="button" class="rm" onclick={() => removeExample(i)} aria-label="Remove example {i + 1}"><Icon name="x" size={16} stroke={2} /></button>
      </div>
    {/each}
    {#if form.examples.length < 5}
      <button type="button" class="add-ex" onclick={addExample}><Icon name="plus" size={16} stroke={2.2} /> Example</button>
    {/if}
  </div>

  <label class="f">
    <span class="lbl">Note <em>usage, register, collocations</em></span>
    <textarea bind:value={form.note} use:autogrow={form.note} rows="1" lang={native} placeholder="Optional"></textarea>
  </label>

  <label class="f">
    <span class="lbl">Tags <em>book, article, topic</em></span>
    <input bind:value={form.tags} placeholder="comma-separated" autocomplete="off" autocapitalize="off" />
  </label>
</div>

<style>
  .fields {
    display: flex;
    flex-direction: column;
    gap: 14px;
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
  .box {
    padding: 6px;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .row3 {
    display: grid;
    grid-template-columns: 1.6fr 1fr;
    gap: 10px;
  }
  .ipa-wrap {
    display: flex;
    align-items: center;
    gap: 2px;
    color: var(--faint);
  }
  .slash {
    font-size: 19px;
    padding: 0 2px;
  }
  .ipa {
    letter-spacing: 0.01em;
  }
  .example {
    position: relative;
    display: flex;
    flex-direction: column;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .example textarea {
    border: 0;
    border-radius: 0;
    background: transparent;
    padding-right: 40px;
    min-height: 44px;
  }
  .example textarea:focus {
    box-shadow: none;
    background: color-mix(in srgb, var(--accent) 5%, transparent);
  }
  .example .tr {
    border-top: 0.5px solid var(--hairline);
    font-size: 16px;
    color: var(--muted);
  }
  .rm {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--faint);
  }
  .add-ex {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 10px;
    font-size: 15px;
    font-weight: 500;
    color: var(--accent);
    background: var(--surface);
  }
  .add-ex:active {
    transform: scale(0.97);
  }
</style>
