<script lang="ts">
  import { status } from '../lib/app.svelte.ts'
  import Icon from './Icon.svelte'

  // Ratings normally upload within seconds, so pending alone isn't news.
  const pending = $derived(status.pending + status.pendingWords)
  const visible = $derived(!status.online || (pending > 0 && status.syncFailed))
</script>

{#if visible}
  <span class="pill" class:offline={!status.online} role="status">
    {#if !status.online}
      <Icon name="offline" size={13} stroke={2} />
      <span>offline{#if pending}&nbsp;·&nbsp;{pending}<span class="word">&nbsp;pending</span>{/if}</span>
    {:else}
      <span class="dot" class:spin={status.syncing}></span>
      <span>{pending}<span class="word">&nbsp;pending</span></span>
    {/if}
  </span>
{/if}

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 10px;
    border-radius: 12px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--muted);
    background: var(--surface-2);
    white-space: nowrap;
    flex: none;
    animation: fade-in var(--t-base) ease;
  }
  .pill :global(svg) {
    flex: none;
  }
  @media (max-width: 380px) {
    .word {
      display: none;
    }
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    /* Not a rating hue: pending is just pending. */
    background: var(--muted);
  }
  .dot.spin {
    animation: pulse 0.9s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.3;
    }
  }
</style>
