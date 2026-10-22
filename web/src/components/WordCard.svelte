<script lang="ts">
  import { answerDiff, formsLine, wordFace, type AnswerCheck, type WordQueueItem } from '@recall/core'
  import { tick } from 'svelte'
  import { markTerm } from '../lib/mark.ts'
  import CardActions from './CardActions.svelte'

  // One review card, faces from core.wordFace(). `typed` / `check`: the
  // learner's typed answer and its verdict, shown above the answer.
  // `onedit`: opens the word's editor; offered once the answer shows, which
  // is when a wrong translation gets noticed.
  let {
    item,
    revealed,
    typed = '',
    check = null,
    langs = ['en', 'ru'],
    onedit,
    ondrop,
  }: { item: WordQueueItem; revealed: boolean; typed?: string; check?: AnswerCheck | null; langs?: [string, string]; onedit?: () => void; ondrop?: () => void } = $props()

  const f = $derived(wordFace(item.word, item.card.direction))
  const forward = $derived(item.card.direction === 'forward')
  const isNew = $derived(item.card.schedule.state === 0)
  const [target, native] = $derived(langs)
  const dirLabel = $derived(forward ? `${target.toUpperCase()} → ${native.toUpperCase()}` : `${native.toUpperCase()} → ${target.toUpperCase()}`)
  const ipa = (s: string | null) => (s ? `/${s}/` : '')
  // An irregular verb's past · participle, on the revealed side (absent on
  // words cached before the server sent them).
  const forms = $derived(item.word.forms ? formsLine(item.word.forms) : null)
  // The front example with its blank as a separate piece.
  const blankParts = $derived(f.front.example ? f.front.example.split('___') : [])
  const diff = $derived(check && check.verdict !== 'exact' && check.verdict !== 'empty' && check.matched ? answerDiff(typed, check.matched) : null)
  const verdictText = $derived(
    check ? { exact: 'Correct', close: check.distance ? 'Almost — a typo' : 'Almost', wrong: 'Not quite', empty: "Didn't know" }[check.verdict] : '',
  )

  let body: HTMLElement | undefined = $state()
  let answer: HTMLElement | undefined = $state()

  // Long cards: bring the answer into view instead of leaving it below the fold.
  $effect(() => {
    if (!revealed) return
    void tick().then(() => {
      if (!body || !answer) return
      if (answer.offsetTop + 80 > body.clientHeight) body.scrollTo({ top: Math.max(0, answer.offsetTop - 72), behavior: 'smooth' })
    })
  })
</script>

{#snippet example(text: string, translation: string | null)}
  <div class="example">
    <p lang={target}>
      {#each markTerm(text, item.word.term) as p, i (i)}{#if p.hit}<b>{p.text}</b>{:else}{p.text}{/if}{/each}
    </p>
    {#if translation}<p class="ex-tr" lang={native}>{translation}</p>{/if}
  </div>
{/snippet}

<article class="card" class:revealed>
  <div class="context">
    <span class="dir" aria-label={forward ? 'Recognise: English to Russian' : 'Recall: Russian to English'}>{dirLabel}</span>
    {#each item.word.tags as t (t)}<span class="meta">{t}</span>{/each}
    {#if isNew}<span class="new">New</span>{/if}
  </div>
  {#if revealed && onedit}
    <CardActions {onedit} {ondrop} label="Edit “{item.word.term}”" />
  {/if}
  <div class="body" bind:this={body}>
    {#if forward}
      <div class="front">
        <h2 class="term" lang={target}>{f.front.term}</h2>
        {#if f.front.ipa || f.front.posLabel}
          <p class="sub">
            {#if f.front.ipa}<span class="ipa" lang={target}>{ipa(f.front.ipa)}</span>{/if}
            {#if f.front.posLabel}<span class="pos">{f.front.posLabel}</span>{/if}
          </p>
        {/if}
        {#if revealed && forms}<p class="forms reveal-in" lang={target}>{forms}</p>{/if}
      </div>
    {:else}
      <div class="front">
        <h2 class="prompt" lang={native}>{f.front.translations[0]}</h2>
        {#if f.front.translations.length > 1}<p class="others" lang={native}>{f.front.translations.slice(1).join(', ')}</p>{/if}
        {#if f.front.posLabel}<p class="sub"><span class="pos">{f.front.posLabel}</span></p>{/if}
        {#if f.front.example}
          <p class="cloze" lang={target}>
            {#each blankParts as part, i (i)}{#if i > 0}<span class="blank" aria-label="blank">{revealed && check?.verdict === 'exact' ? '✓' : '…'}</span>{/if}{part}{/each}
          </p>
        {:else if f.front.exampleTranslation}
          <p class="cloze hint" lang={native}>{f.front.exampleTranslation}</p>
        {/if}
      </div>
    {/if}

    {#if revealed}
      <div class="answer reveal-in" bind:this={answer}>
        {#if check}
          <div class="verdict" data-verdict={check.verdict}>
            <span class="pill">{verdictText}</span>
            {#if diff}
              <div class="diff" aria-label="Your answer compared with the correct one">
                <p class="yours"><span class="lbl">You</span><span class="txt">{#each diff.input as p, i (i)}{#if p.same}{p.text}{:else}<mark class="bad">{p.text}</mark>{/if}{/each}</span></p>
                <p class="right"><span class="lbl">Answer</span><span class="txt">{#each diff.expected as p, i (i)}{#if p.same}{p.text}{:else}<mark class="fix">{p.text}</mark>{/if}{/each}</span></p>
              </div>
            {:else if check.verdict === 'exact' && check.matched && forward && check.matched !== f.back.translations[0]}
              <span class="matched">{check.matched}</span>
            {/if}
          </div>
        {/if}
        <hr />
        {#if forward}
          <p class="main-tr" lang={native}>{f.back.translations[0]}</p>
          {#if f.back.translations.length > 1}<p class="others" lang={native}>{f.back.translations.slice(1).join(', ')}</p>{/if}
          {#if f.back.example}{@render example(f.back.example, f.back.exampleTranslation)}{/if}
        {:else}
          <h2 class="term back" lang={target}>{f.back.term}</h2>
          {#if f.back.ipa}<p class="sub"><span class="ipa" lang={target}>{ipa(f.back.ipa)}</span></p>{/if}
          {#if forms}<p class="forms" lang={target}>{forms}</p>{/if}
          {#if f.back.example}{@render example(f.back.example, f.back.exampleTranslation)}{/if}
        {/if}
        {#if f.back.note}<p class="note" lang={native}>{f.back.note}</p>{/if}
      </div>
    {/if}
  </div>
</article>

<style>
  .card {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .context {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    /* Room on the right for the corner buttons, so nothing shifts on reveal. */
    padding: 16px 92px 0 20px;
    font-size: 13px;
    line-height: 18px;
    color: var(--muted);
  }
  .dir {
    font-weight: 600;
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
  }
  .meta {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta::before {
    content: '·';
    margin-right: 6px;
    color: var(--faint);
  }
  .new {
    margin-left: 2px;
    padding: 1px 7px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--c-new);
    background: color-mix(in srgb, var(--c-new) 13%, var(--surface));
  }

  /* The word sits a fifth of the way down and stays put when the answer
     appears beneath it. */
  .body {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    display: flex;
    flex-direction: column;
    text-align: center;
    padding: 14px 22px 44px;
  }
  .body::before {
    content: '';
    flex: 0 1 22%;
  }
  p,
  h2 {
    margin: 0;
  }
  .term,
  .prompt {
    font-size: 34px;
    line-height: 1.15;
    font-weight: 600;
    letter-spacing: -0.022em;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .prompt {
    font-size: 30px;
  }
  .term.back {
    font-size: 30px;
  }
  .sub {
    margin-top: 8px;
    display: flex;
    justify-content: center;
    align-items: baseline;
    gap: 10px;
    color: var(--muted);
  }
  .ipa {
    font-size: 17px;
    letter-spacing: 0.01em;
  }
  /* Irregular verb forms under the IPA / part of speech: small, muted. */
  .forms {
    margin-top: 6px;
    font-size: 15px;
    color: var(--muted);
    letter-spacing: 0.01em;
  }
  .pos {
    font-size: 15px;
    font-style: italic;
    color: var(--faint);
  }
  .others {
    margin-top: 6px;
    font-size: 17px;
    line-height: 1.4;
    color: var(--muted);
    text-wrap: balance;
  }
  .cloze {
    margin-top: 22px;
    font-size: 17px;
    line-height: 1.55;
    text-wrap: pretty;
  }
  .cloze.hint {
    color: var(--muted);
    font-size: 16px;
  }
  .blank {
    display: inline-block;
    min-width: 2.6em;
    padding: 0 0.5em;
    margin: 0 0.1em;
    border-radius: 6px;
    color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
    font-weight: 600;
    line-height: 1.35;
  }

  hr {
    width: 56px;
    height: 2px;
    border: 0;
    border-radius: 1px;
    background: var(--hairline);
    margin: 24px auto 22px;
  }
  .revealed hr {
    animation: draw var(--t-slow) var(--ease-out) both;
  }
  @keyframes draw {
    from {
      transform: scaleX(0.2);
      opacity: 0;
    }
  }
  .main-tr {
    font-size: 23px;
    line-height: 1.32;
    text-wrap: balance;
  }
  .example {
    margin-top: 20px;
    font-size: 16px;
    line-height: 1.5;
    text-wrap: pretty;
  }
  .example b {
    font-weight: 650;
  }
  .ex-tr {
    margin-top: 2px;
    font-size: 15px;
    color: var(--muted);
  }
  .note {
    margin-top: 16px;
    font-size: 15px;
    line-height: 1.45;
    color: var(--muted);
    text-wrap: pretty;
  }

  /* Typed answer: a verdict that suggests the rating, and the letters that differ. */
  .verdict {
    --c: var(--muted);
    --cb: var(--surface-2);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin-top: 18px;
  }
  .verdict[data-verdict='exact'] {
    --c: var(--good);
    --cb: var(--good-bg);
  }
  .verdict[data-verdict='close'] {
    --c: var(--hard);
    --cb: var(--hard-bg);
  }
  .verdict[data-verdict='wrong'] {
    --c: var(--again);
    --cb: var(--again-bg);
  }
  .pill {
    padding: 3px 10px;
    border-radius: 11px;
    font-size: 13px;
    font-weight: 650;
    color: var(--c);
    background: var(--cb);
  }
  .matched {
    font-size: 15px;
    color: var(--muted);
  }
  /* Two aligned rows: label | text. */
  .diff {
    display: grid;
    grid-template-columns: auto auto;
    justify-content: center;
    align-items: baseline;
    gap: 4px 10px;
    font-size: 19px;
    line-height: 1.3;
    letter-spacing: 0.01em;
  }
  .diff p {
    display: contents;
  }
  .lbl {
    text-align: right;
    font-size: 12px;
    font-weight: 500;
    color: var(--faint);
    letter-spacing: 0;
  }
  .txt {
    text-align: left;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .yours .txt {
    color: var(--muted);
  }
  mark {
    border-radius: 3px;
    padding: 0 1px;
  }
  mark.bad {
    color: var(--again);
    background: var(--again-bg);
    text-decoration: line-through;
    text-decoration-thickness: 1.5px;
  }
  mark.fix {
    color: var(--good);
    background: var(--good-bg);
    font-weight: 650;
  }

  /* The reveal: the answer rises into place under the question. */
  .reveal-in {
    animation: rise-sm var(--t-fast) var(--ease-out) both;
  }
</style>
