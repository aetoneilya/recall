<script lang="ts">
  import type { FactQueueItem } from '@recall/core'
  import { tick } from 'svelte'
  import Icon from './Icon.svelte'
  import Markdown from './Markdown.svelte'

  // One fact's review card: the question, and once revealed the answer
  // under it, both Markdown. The deck is the context marker, like the
  // direction on a word's card. `onedit` opens the fact's editor; offered
  // once the answer shows.
  let { item, revealed, onedit }: { item: FactQueueItem; revealed: boolean; onedit?: () => void } = $props()

  const isNew = $derived(item.card.schedule.state === 0)

  let body: HTMLElement | undefined = $state()
  let answer: HTMLElement | undefined = $state()

  // Long answers: bring the start of the answer into view.
  $effect(() => {
    if (!revealed) return
    void tick().then(() => {
      if (!body || !answer) return
      if (answer.offsetTop + 80 > body.clientHeight) body.scrollTo({ top: Math.max(0, answer.offsetTop - 72), behavior: 'smooth' })
    })
  })
</script>

<article class="card" class:revealed>
  <div class="context">
    <span class="deck">{item.deckName}</span>
    {#each item.fact.tags as t (t)}<span class="meta">{t}</span>{/each}
    {#if isNew}<span class="new">New</span>{/if}
  </div>
  {#if revealed && onedit}
    <button
      class="edit"
      onclick={(e) => {
        e.stopPropagation()
        onedit()
      }}
      onmousedown={(e) => e.preventDefault()}
      aria-label="Edit this card"
    >
      <Icon name="edit" size={18} />
    </button>
  {/if}
  <div class="body" bind:this={body}>
    <div class="question"><Markdown source={item.fact.front} /></div>
    {#if revealed}
      <div class="answer reveal-in" bind:this={answer}>
        <hr class="divider" />
        <Markdown source={item.fact.back} />
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
    /* Room on the right for the edit button, so nothing shifts on reveal. */
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
  .new {
    margin-left: 2px;
    padding: 1px 7px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--c-new);
    background: color-mix(in srgb, var(--c-new) 13%, var(--surface));
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
    transition:
      color var(--t-fast) ease,
      background-color var(--t-fast) ease;
  }
  .edit:active {
    color: var(--accent);
    background: var(--accent-soft);
  }

  /* The question sits a little way down and stays put when the answer
     appears beneath it. Prose reads left-aligned. */
  .body {
    position: relative;
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
  .question {
    font-size: 19px;
    line-height: 1.38;
    font-weight: 600;
    letter-spacing: -0.012em;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .divider {
    width: 56px;
    height: 2px;
    border: 0;
    border-radius: 1px;
    background: var(--hairline);
    margin: 22px auto 20px;
  }
  .revealed .divider {
    animation: draw var(--t-slow) var(--ease-out) both;
  }
  @keyframes draw {
    from {
      transform: scaleX(0.2);
      opacity: 0;
    }
  }
  .answer {
    font-size: 17px;
    line-height: 1.5;
  }

  .question :global(code) {
    font-weight: 500;
  }

  .reveal-in {
    animation: rise-sm var(--t-fast) var(--ease-out) both;
  }
</style>
