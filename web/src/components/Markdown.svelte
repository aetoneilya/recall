<script lang="ts">
  import { renderMarkdown } from '../lib/markdown.ts'

  // A fact's Markdown, rendered by lib/markdown.ts (which escapes the source
  // before adding any tag, so {@html} is safe). Size and colour come from
  // the parent; this sets spacing, lists, code and wikilinks.
  let { source }: { source: string } = $props()
  const html = $derived(renderMarkdown(source))
</script>

<div class="md">{@html html}</div>

<style>
  .md {
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }
  .md :global(p),
  .md :global(ul),
  .md :global(ol),
  .md :global(pre) {
    margin: 0;
  }
  .md :global(* + p),
  .md :global(* + ul),
  .md :global(* + ol),
  .md :global(* + pre),
  .md :global(p + *) {
    margin-top: 0.75em;
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.3em;
  }
  .md :global(li + li) {
    margin-top: 0.3em;
  }
  .md :global(li::marker) {
    color: var(--faint);
  }
  /* A first line that is only bold: the big answer ("began · begun"). */
  .md :global(strong.lead) {
    font-size: 1.36em;
    line-height: 1.25;
    font-weight: 650;
    letter-spacing: -0.015em;
  }
  .md :global(strong) {
    font-weight: 650;
  }
  .md :global(code) {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.84em;
    padding: 0.1em 0.35em;
    border-radius: 5px;
    background: var(--surface-2);
    overflow-wrap: anywhere;
  }
  /* Code blocks bleed into the card padding and scroll sideways on their own. */
  .md :global(pre) {
    margin-left: -10px;
    margin-right: -10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--surface-2);
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    text-align: left;
    -webkit-user-select: text;
    user-select: text;
  }
  .md :global(pre code) {
    display: block;
    width: max-content;
    min-width: 100%;
    padding: 0;
    background: none;
    font-size: 13px;
    line-height: 1.55;
    white-space: pre;
    overflow-wrap: normal;
  }
  /* [[wikilinks]]: emphasised, quieter than the prose. */
  .md :global(em.wl) {
    color: var(--muted);
    font-style: italic;
  }
  .md :global(hr) {
    border: 0;
    border-top: 0.5px solid var(--hairline);
    margin: 1em 0;
  }
</style>
