<script lang="ts">
  import { answerDiff, exerciseRating, type ExerciseAttempt, type ExerciseCheck, type FactQueueItem } from '@recall/core'
  import Icon from './Icon.svelte'
  import Markdown from './Markdown.svelte'

  // A rule reviewed through its exercises: one item at a time (`index`),
  // the verdict once checked, and after the last one (`revealed`) a summary
  // with the rule. `results` holds the items done so far; `check` the
  // current one's verdict, `given` what was typed. `onbad` takes the current
  // item out of the pool; `onedit` opens the rule.
  let {
    item,
    index,
    results,
    check,
    given,
    revealed,
    onbad,
    onedit,
  }: {
    item: FactQueueItem
    index: number
    results: ExerciseAttempt[]
    check: ExerciseCheck | null
    given: string
    revealed: boolean
    onbad?: () => void
    onedit?: () => void
  } = $props()

  const items = $derived(item.exercises ?? [])
  const ex = $derived(items[Math.min(index, items.length - 1)])
  const INSTRUCTION = { gap: 'Fill the gap', fix: 'Fix the mistake', rewrite: 'Complete the sentence' } as const
  // The prompt split around its "___", so the gap can be drawn.
  const parts = $derived(ex ? ex.prompt.split(/_{3,}/) : [])
  const current = $derived(results[index])
  const diff = $derived(check && !check.correct && given.trim() ? answerDiff(given, check.expected) : null)
  const right = $derived(results.filter((r) => r.correct && !r.bad).length)
  const graded = $derived(results.filter((r) => !r.bad).length)
  const rating = $derived(exerciseRating(results))
  let showRule = $state(false)
  // Something went wrong: the rule opens by itself on the summary.
  $effect(() => {
    if (revealed) showRule = results.some((r) => !r.correct && !r.bad)
  })
</script>

<article class="card" class:revealed>
  <div class="context">
    <span class="deck">{item.deckName}</span>
    <span class="meta">{item.fact.front}</span>
    {#if !revealed}
      <span class="steps" aria-label="Item {index + 1} of {items.length}">
        {#each items as _, i (i)}<i class:done={i < index || (i === index && !!check)} class:now={i === index} class:bad={results[i] && !results[i]!.correct && !results[i]!.bad}></i>{/each}
        <b>{index + 1}/{items.length}</b>
      </span>
    {/if}
  </div>
  {#if onedit && (revealed || check)}
    <button
      class="edit"
      onclick={(e) => {
        e.stopPropagation()
        onedit()
      }}
      onmousedown={(e) => e.preventDefault()}
      aria-label="Open the rule"
    >
      <Icon name="edit" size={18} />
    </button>
  {/if}
  <div class="body">
    {#if !revealed && ex}
      <p class="instruction">{INSTRUCTION[ex.type]}</p>
      <p class="prompt" lang="en">
        {#each parts as part, i (i)}{#if i > 0}<span class="gap" class:filled={!!check} aria-label="gap">{check ? (check.correct ? given.trim() || check.expected : check.expected) : '…'}</span>{/if}{part}{/each}
      </p>
      {#if check}
        <div class="verdict reveal-in" data-ok={check.correct}>
          <span class="pill">{current?.overridden ? 'Counted as right' : check.correct ? 'Correct' : given.trim() ? 'Not quite' : "Didn't know"}</span>
          {#if !check.correct}
            <div class="diff" aria-label="Your answer compared with the expected one">
              {#if diff}
                <p class="yours"><span class="lbl">You</span><span class="txt">{#each diff.input as p, i (i)}{#if p.same}{p.text}{:else}<mark class="bad">{p.text}</mark>{/if}{/each}</span></p>
                <p><span class="lbl">Answer</span><span class="txt">{#each diff.expected as p, i (i)}{#if p.same}{p.text}{:else}<mark class="fix">{p.text}</mark>{/if}{/each}</span></p>
              {:else if ex.type === 'fix'}
                <p><span class="lbl">Answer</span><span class="txt">{check.expected}</span></p>
              {/if}
            </div>
          {/if}
          {#if ex.explain}<p class="explain" lang="ru">{ex.explain}</p>{/if}
          {#if onbad}
            <button class="badlink" onclick={(e) => { e.stopPropagation(); onbad() }} onmousedown={(e) => e.preventDefault()} disabled={current?.bad}>
              {current?.bad ? 'Taken out of the pool' : 'Bad item'}
            </button>
          {/if}
        </div>
      {/if}
    {:else if revealed}
      <div class="summary reveal-in">
        <p class="score"><b>{right}</b> of {graded || results.length} right{#if results.length}<span class="faint">&nbsp;· {rating === 3 ? 'Good' : rating === 2 ? 'Hard' : 'Again'}</span>{/if}</p>
        <ul class="results">
          {#each results as r, i (i)}
            {@const it = items.find((x) => x.id === r.id)}
            <li class:ok={r.correct && !r.bad} class:no={!r.correct && !r.bad} class:skip={r.bad}>
              <span class="mark" aria-hidden="true">{r.bad ? '–' : r.correct ? '✓' : '✗'}</span>
              <span class="what" lang="en">{it?.prompt ?? ''}{#if !r.correct && !r.bad && it}<span class="ans"> → {it.answer}</span>{/if}</span>
            </li>
          {/each}
        </ul>
        <button class="rule-toggle" onclick={(e) => { e.stopPropagation(); showRule = !showRule }} aria-expanded={showRule}>
          <Icon name="chevron" size={14} stroke={2} /> {showRule ? 'Hide the rule' : 'Show the rule'}
        </button>
        {#if showRule}<div class="rule"><Markdown source={item.fact.back} /></div>{/if}
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
    padding: 16px 48px 0 20px;
    font-size: 13px;
    line-height: 18px;
    color: var(--muted);
  }
  .deck {
    font-weight: 600;
    letter-spacing: 0.01em;
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
  .steps {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .steps i {
    width: 6px;
    height: 6px;
    border-radius: 3px;
    background: var(--surface-2);
  }
  .steps i.now {
    background: var(--accent);
  }
  .steps i.done {
    background: var(--good);
  }
  .steps i.done.bad {
    background: var(--again);
  }
  .steps b {
    margin-left: 4px;
    font-weight: 600;
  }
  .edit {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 14px;
    color: var(--faint);
    animation: fade-in var(--t-fast) ease;
  }
  .edit:active {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    display: flex;
    flex-direction: column;
    padding: 14px 22px 44px;
  }
  .body::before {
    content: '';
    flex: 0 1 12%;
  }
  p {
    margin: 0;
  }
  .instruction {
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .prompt {
    font-size: 21px;
    line-height: 1.45;
    font-weight: 500;
    letter-spacing: -0.01em;
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }
  /* The gap: an accent-soft pill like the cloze blank; filled in on check. */
  .gap {
    display: inline;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
    min-width: 2.6em;
    padding: 0 0.45em;
    margin: 0 0.1em;
    border-radius: 6px;
    color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
    font-weight: 600;
    line-height: 1.3;
  }
  .gap:not(.filled) {
    display: inline-block;
    text-align: center;
  }
  /* Checked: the right form in place (what was typed, if it was right). */
  .gap.filled {
    color: var(--good);
    background: var(--good-bg);
    box-shadow: none;
  }
  .verdict {
    --c: var(--again);
    --cb: var(--again-bg);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    margin-top: 20px;
  }
  .verdict[data-ok='true'] {
    --c: var(--good);
    --cb: var(--good-bg);
  }
  .pill {
    padding: 3px 10px;
    border-radius: 11px;
    font-size: 13px;
    font-weight: 650;
    color: var(--c);
    background: var(--cb);
  }
  .diff {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 4px 10px;
    font-size: 17px;
    line-height: 1.35;
  }
  .diff p {
    display: contents;
  }
  .lbl {
    font-size: 12px;
    font-weight: 500;
    color: var(--faint);
  }
  .txt {
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
  }
  mark.fix {
    color: var(--good);
    background: var(--good-bg);
    font-weight: 650;
  }
  .explain {
    font-size: 15px;
    line-height: 1.45;
    color: var(--muted);
  }
  .badlink {
    font-size: 13px;
    color: var(--faint);
    text-decoration: underline;
    text-underline-offset: 0.2em;
    padding: 6px 0;
  }
  .badlink:disabled {
    text-decoration: none;
  }
  .score {
    font-size: 19px;
    font-weight: 600;
  }
  .score b {
    font-size: 23px;
  }
  .faint {
    color: var(--faint);
    font-weight: 500;
  }
  .results {
    list-style: none;
    padding: 0;
    margin: 14px 0 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .results li {
    display: flex;
    gap: 10px;
    font-size: 15px;
    line-height: 1.4;
  }
  .mark {
    flex: none;
    width: 1.2em;
    font-weight: 700;
  }
  li.ok .mark {
    color: var(--good);
  }
  li.no .mark {
    color: var(--again);
  }
  li.skip {
    color: var(--faint);
  }
  .what {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .ans {
    color: var(--good);
    font-weight: 600;
  }
  .rule-toggle {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 18px;
    padding: 6px 0;
    font-size: 14px;
    font-weight: 500;
    color: var(--accent);
  }
  .rule-toggle[aria-expanded='true'] :global(svg) {
    transform: rotate(90deg);
  }
  .rule {
    margin-top: 6px;
    font-size: 16px;
    line-height: 1.5;
  }
  .reveal-in {
    animation: rise-sm var(--t-fast) var(--ease-out) both;
  }
</style>
