<script lang="ts">
  import { formsLine, posLabel, type Word } from '@recall/core'
  import { markTerm } from '../lib/mark.ts'

  // A whole word at once, for vetting a proposal: term, pronunciation,
  // translations, examples, note and tags.
  let { word }: { word: Pick<Word, 'term' | 'pos' | 'ipa' | 'translations' | 'examples' | 'note' | 'tags' | 'cefr' | 'freqRank' | 'forms'> } = $props()
</script>

<div class="wp">
  <h2 class="term" lang="en">{word.term}</h2>
  <p class="sub">
    {#if word.ipa}<span lang="en">/{word.ipa}/</span>{/if}
    {#if posLabel(word.pos)}<span class="pos">{posLabel(word.pos)}</span>{/if}
    {#if word.cefr}<span class="lvl">{word.cefr}</span>{/if}
  </p>
  {#if word.forms}<p class="forms" lang="en">{formsLine(word.forms)}</p>{/if}
  <p class="main-tr" lang="ru">{word.translations[0]}</p>
  {#if word.translations.length > 1}<p class="others" lang="ru">{word.translations.slice(1).join(', ')}</p>{/if}
  {#each word.examples as ex, i (i)}
    <div class="example">
      <p lang="en">{#each markTerm(ex.text, word.term) as p, k (k)}{#if p.hit}<b>{p.text}</b>{:else}{p.text}{/if}{/each}</p>
      {#if ex.translation}<p class="ex-tr" lang="ru">{ex.translation}</p>{/if}
    </div>
  {/each}
  {#if word.note}<p class="note" lang="ru">{word.note}</p>{/if}
  {#if word.tags.length}<p class="source">{word.tags.join(' · ')}</p>{/if}
</div>

<style>
  p,
  h2 {
    margin: 0;
  }
  .term {
    font-size: 28px;
    line-height: 1.15;
    font-weight: 600;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: baseline;
    margin-top: 6px;
    color: var(--muted);
    letter-spacing: 0.01em;
  }
  .forms {
    margin-top: 4px;
    font-size: 15px;
    color: var(--muted);
  }
  .pos {
    font-style: italic;
    color: var(--faint);
    font-size: 15px;
  }
  .lvl {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 6px;
    background: var(--surface-2);
    letter-spacing: 0;
  }
  .main-tr {
    margin-top: 16px;
    font-size: 21px;
    line-height: 1.32;
  }
  .others {
    margin-top: 4px;
    font-size: 16px;
    color: var(--muted);
  }
  .example {
    margin-top: 14px;
    font-size: 15.5px;
    line-height: 1.45;
  }
  .example b {
    font-weight: 650;
  }
  .ex-tr {
    font-size: 14.5px;
    color: var(--muted);
  }
  .note {
    margin-top: 14px;
    font-size: 15px;
    color: var(--muted);
  }
  .source {
    margin-top: 14px;
    font-size: 12.5px;
    color: var(--faint);
    overflow-wrap: anywhere;
  }
</style>
