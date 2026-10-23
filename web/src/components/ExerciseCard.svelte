<script lang="ts">
  import { answerDiff, correctedParts, exerciseRating, isTapType, NOTHING, spotTokens, type ExerciseAttempt, type ExerciseCheck, type FactQueueItem, type WriteGrade } from '@recall/core'
  import CardActions from './CardActions.svelte'
  import CardTags from './CardTags.svelte'
  import Icon from './Icon.svelte'
  import Markdown from './Markdown.svelte'

  // A rule reviewed through its exercises: one item at a time (`index`),
  // the verdict once answered, and after the last one (`revealed`) a summary
  // with the rule. `results` holds the items done so far.
  // Tap items (choose, spot): `tap` is the current one's state — the option
  // picked, the token tapped (spot), done — and `onchoose` / `ontoken`
  // answer. Legacy typed items: `check` is the verdict, `given` what was typed.
  // `onbad` takes the current item out of the pool; `onedit` opens the rule.
  let {
    item,
    index,
    results,
    check,
    given,
    tap = { pick: null, token: null, done: false },
    revealed,
    onchoose,
    ontoken,
    onbad,
    onedit,
    ondrop,
    onread,
    writeGrade = null,
  }: {
    item: FactQueueItem
    index: number
    results: ExerciseAttempt[]
    check: ExerciseCheck | null
    given: string
    tap?: { pick: string | null; token: number | null; done: boolean }
    revealed: boolean
    onchoose?: (option: string) => void
    ontoken?: (index: number) => void
    onbad?: () => void
    onedit?: () => void
    ondrop?: () => void
    onread?: () => void
    // A written sentence's verdict from the server.
    writeGrade?: WriteGrade | null
  } = $props()

  const items = $derived(item.exercises ?? [])
  const ex = $derived(items[Math.min(index, items.length - 1)])
  const INSTRUCTION = { choose: 'Choose the right word', spot: 'Tap the mistake', gap: 'Fill the gap', fix: 'Fix the mistake', rewrite: 'Complete the sentence', write: 'Write a sentence' } as const
  const isTap = $derived(!!ex && isTapType(ex.type))
  const answered = $derived(isTap ? tap.done : !!check)
  // spot: the sentence as tappable tokens, and once a token was tapped
  // whether it was the mistake (then the replacement options show).
  const tokens = $derived(ex?.type === 'spot' && ex.wrong ? spotTokens(ex.prompt, ex.wrong) : [])
  const foundIt = $derived(tap.token !== null && !!tokens[tap.token]?.wrong)
  const showOptions = $derived(ex?.type === 'choose' || (ex?.type === 'spot' && foundIt))
  const fixed = $derived(ex?.type === 'spot' && ex.wrong && tap.done ? correctedParts(ex.prompt, ex.wrong, ex.answer) : null)
  const tapRight = $derived(!!results[index]?.correct)
  const optionLabel = (o: string) => (o === NOTHING ? (ex?.type === 'spot' ? '— delete it' : '— (nothing)') : o)
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
  <!-- While answering, one line: the title and a tag cut short, the steps
       at the end; the summary has room for both tags. -->
  <div class="context" class:one={!revealed}>
    <span class="deck">{item.fact.front}</span>
    <CardTags tags={item.fact.tags} max={revealed ? 2 : 1} />
    {#if !revealed}
      <span class="steps" aria-label="Item {index + 1} of {items.length}">
        {#each items as _, i (i)}<i class:done={i < index || (i === index && answered)} class:now={i === index} class:bad={results[i] && !results[i]!.correct && !results[i]!.bad}></i>{/each}
        <b>{index + 1}/{items.length}</b>
      </span>
    {/if}
  </div>
  {#if onedit && (revealed || answered)}
    <CardActions {onedit} {ondrop} {onread} label="Open the rule" />
  {/if}
  <div class="body">
    {#if !revealed && ex && isTap}
      <p class="instruction">{ex.type === 'spot' && foundIt && !tap.done ? 'Now pick the right form' : INSTRUCTION[ex.type]}</p>
      {#if ex.type === 'choose'}
        <p class="prompt" lang="en">
          {#each parts as part, i (i)}{#if i > 0}<span class="gap" class:filled={tap.done} aria-label="gap">{tap.done ? (ex.answer === NOTHING ? '—' : ex.answer) : '…'}</span>{/if}{part}{/each}
        </p>
      {:else}
        <p class="prompt tokens" lang="en">
          {#each tokens as t, i (i)}
            <button
              class="tok"
              class:hit={tap.token === i && t.wrong}
              class:miss={tap.token === i && !t.wrong}
              class:show={tap.done && t.wrong && !(tap.token !== null && tokens[tap.token]?.wrong)}
              disabled={tap.token !== null}
              onclick={(e) => {
                e.stopPropagation()
                ontoken?.(i)
              }}>{t.text}</button
            >{' '}
          {/each}
        </p>
      {/if}
      {#if showOptions}
        <div class="options" role="group" aria-label="Options">
          {#each ex.options ?? [] as o, k (o)}
            <button
              class="opt"
              class:right={tap.done && o === ex.answer}
              class:wrong={tap.done && tap.pick === o && o !== ex.answer}
              class:dim={tap.done && o !== ex.answer && tap.pick !== o}
              disabled={tap.done}
              onclick={(e) => {
                e.stopPropagation()
                onchoose?.(o)
              }}
            >
              <span class="key" aria-hidden="true">{k + 1}</span><span class="otext">{optionLabel(o)}</span>
              {#if tap.done && o === ex.answer}
                <svg class="tick" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
      {#if tap.done && !tapRight}
        <div class="verdict strip" data-ok={tapRight}>
          <span class="pill">{tapRight ? 'Correct' : ex.type === 'spot' && !foundIt ? 'The mistake was elsewhere' : 'Not quite'}</span>
          {#if fixed}
            <p class="fixed" lang="en">{#each fixed as p, i (i)}{#if p.changed}{#if p.text}<mark class="fix">{p.text}</mark>{:else}{' '}<mark class="gone">{ex.wrong}</mark>{/if}{:else}{p.text}{/if}{/each}</p>
          {/if}
          {#if ex.explain}<p class="explain" lang="ru">{ex.explain}</p>{/if}
          {#if onbad}
            <button class="badlink" onclick={(e) => { e.stopPropagation(); onbad() }} onmousedown={(e) => e.preventDefault()} disabled={current?.bad}>
              {current?.bad ? 'Taken out of the pool' : 'Bad item'}
            </button>
          {/if}
        </div>
      {/if}
    {:else if !revealed && ex && ex.type === 'write'}
      <p class="instruction">{INSTRUCTION.write}</p>
      <p class="prompt task" lang="ru">{ex.prompt}</p>
      {#if check}
        <div class="verdict strip" data-ok={check.correct}>
          <span class="pill">{current?.overridden ? 'Counted as right' : check.correct ? 'Correct' : !given.trim() ? "Didn't know" : writeGrade?.score === 1 ? 'Almost' : 'Not quite'}</span>
          {#if given.trim() && writeGrade && !check.correct}
            <div class="diff" aria-label="Your sentence and the corrected one">
              {#each [answerDiff(given, writeGrade.corrected)] as d (d)}
                <p class="yours"><span class="lbl">You</span><span class="txt" lang="en">{#each d.input as p, i (i)}{#if p.same}{p.text}{:else}<mark class="bad">{p.text}</mark>{/if}{/each}</span></p>
                <p><span class="lbl">Better</span><span class="txt" lang="en">{#each d.expected as p, i (i)}{#if p.same}{p.text}{:else}<mark class="fix">{p.text}</mark>{/if}{/each}</span></p>
              {/each}
            </div>
          {/if}
          {#if writeGrade?.explain}<p class="explain" lang="ru">{writeGrade.explain}</p>{/if}
          {#if onbad}
            <button class="badlink" onclick={(e) => { e.stopPropagation(); onbad() }} onmousedown={(e) => e.preventDefault()} disabled={current?.bad}>
              {current?.bad ? 'Taken out of the pool' : 'Bad item'}
            </button>
          {/if}
        </div>
      {/if}
    {:else if !revealed && ex}
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
              <span class="what" lang="en">
                {#if it?.type === 'spot' && it.wrong}
                  {#each correctedParts(it.prompt, it.wrong, it.answer) as p, k (k)}{#if p.changed}<span class="ans">{p.text || '—'}</span>{:else}{p.text}{/if}{/each}
                {:else if it?.type === 'choose'}
                  {#each it.prompt.split(/_{3,}/) as part, k (k)}{#if k > 0}<span class="ans">{it.answer}</span>{/if}{part}{/each}
                {:else if it?.type === 'write'}
                  {r.given || it.prompt}
                {:else}
                  {it?.prompt ?? ''}{#if !r.correct && !r.bad && it}<span class="ans"> → {it.answer}</span>{/if}
                {/if}
              </span>
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
    padding: 16px 92px 0 var(--ctx-left, 20px);
    font-size: 13px;
    line-height: 18px;
    color: var(--muted);
  }
  .deck {
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .context.one {
    flex-wrap: nowrap;
  }
  .context.one .deck {
    flex: 0 1 auto;
    min-width: 3em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The tag gives way before the title does. */
  .context.one :global(.tag) {
    flex: 0 3 auto;
    min-width: 0;
  }
  .context.one .steps {
    flex: none;
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
  /* The space above the item never gives way: a verdict growing below it
     scrolls instead of lifting the sentence (the No-Jump rule). */
  .body::before {
    content: '';
    flex: 0 0 12%;
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
  /* Tap items. */
  .tokens {
    line-height: 1.7;
  }
  .tok {
    display: inline;
    padding: 2px 3px;
    margin: 0 -3px;
    border-radius: 6px;
    font: inherit;
    color: inherit;
    transition:
      background-color var(--t-fast) ease,
      color var(--t-fast) ease;
  }
  /* A short word ("of", "my") is still a thumb's target: the hit area
     reaches past the text without moving it. */
  .tok {
    position: relative;
  }
  .tok::after {
    content: '';
    position: absolute;
    top: -8px;
    bottom: -8px;
    left: 50%;
    width: max(100% + 8px, 44px);
    translate: -50% 0;
  }
  .tok:active:not(:disabled) {
    background: var(--accent-soft);
  }
  .tok:disabled {
    cursor: default;
    opacity: 1;
    color: inherit;
  }
  .tok.hit {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .tok.miss {
    color: var(--again);
    background: var(--again-bg);
    animation: flash 360ms ease 2;
  }
  /* Missed: where the mistake was. */
  .tok.show {
    color: var(--hard);
    background: var(--hard-bg);
  }
  @keyframes flash {
    50% {
      opacity: 0.35;
    }
  }
  /* One row of equal targets (two rows of two for four). */
  /* Full-width rows inside the card, one thumb's reach each. */
  .options {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 22px;
  }
  .opt {
    min-width: 0;
    min-height: 52px;
    padding: 8px 14px;
    display: flex;
    align-items: center;
    gap: 12px;
    border-radius: 12px;
    text-align: left;
    font-size: 18px;
    font-weight: 600;
    color: var(--text);
    background: var(--surface-2);
    overflow-wrap: anywhere;
    transition:
      transform var(--t-press) var(--ease-out),
      background-color var(--t-fast) ease,
      color var(--t-fast) ease,
      opacity var(--t-fast) ease;
  }
  .opt:disabled {
    opacity: 1;
    cursor: default;
  }
  .opt:active:not(:disabled) {
    transform: scale(0.98);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .otext {
    flex: 1;
    min-width: 0;
  }
  .tick {
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 24;
    animation: draw 200ms var(--ease-out) both;
  }
  @keyframes draw {
    from {
      stroke-dashoffset: 24;
    }
    to {
      stroke-dashoffset: 0;
    }
  }
  /* A wrong pick: one small nudge, never a long shake. */
  @keyframes nudge {
    0%,
    100% {
      transform: none;
    }
    25% {
      transform: translateX(-4px);
    }
    60% {
      transform: translateX(4px);
    }
    80% {
      transform: translateX(-2px);
    }
  }
  /* The verdict on a miss rises from the bottom. */
  .strip {
    animation: strip-in 200ms var(--ease-out) both;
  }
  @keyframes strip-in {
    from {
      opacity: 0;
      transform: translateY(24px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .opt.wrong {
      animation: none;
    }
    .strip {
      animation: fade-in 200ms ease both;
    }
  }
  .opt .key {
    font-size: 12px;
    font-weight: 500;
    color: var(--faint);
  }
  .opt.right {
    color: var(--good);
    background: var(--good-bg);
    box-shadow: inset 0 0 0 1.5px var(--good);
  }
  .opt.wrong {
    color: var(--again);
    background: var(--again-bg);
    animation: nudge 240ms var(--ease-out);
  }
  .opt.dim:disabled {
    opacity: 0.45;
  }
  .opt.right .key,
  .opt.wrong .key {
    color: inherit;
  }
  .fixed {
    font-size: 17px;
    line-height: 1.45;
  }
  mark.gone {
    color: var(--again);
    background: var(--again-bg);
    text-decoration: line-through;
    border-radius: 3px;
    padding: 0 2px;
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
  .task {
    font-size: 18px;
    font-weight: 500;
  }
</style>
