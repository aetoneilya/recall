<script lang="ts">
  import type { Snippet } from 'svelte'
  import { status } from '../lib/app.svelte.ts'
  import { back } from '../lib/router.svelte.ts'
  import Icon from './Icon.svelte'

  // Title row for nested screens. Inside Telegram the native BackButton
  // replaces ours.
  let { title, actions }: { title: string; actions?: Snippet } = $props()
</script>

<div class="screen-title">
  {#if !status.telegram}
    <button class="icon-btn back" onclick={back} aria-label="Back"><Icon name="back" /></button>
  {/if}
  <h1 class="small">{title}</h1>
  {#if actions}{@render actions()}{/if}
</div>

<style>
  .back {
    margin-left: -12px;
    color: var(--accent);
  }
  h1.small {
    font-size: 22px;
  }
</style>
