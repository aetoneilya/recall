<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cubicOut, quintOut } from 'svelte/easing'
  import { fade, fly } from 'svelte/transition'

  // A bottom sheet over a dimmed screen. It closes only from its own
  // buttons: what it shows (a one-time secret) shouldn't vanish on a stray tap.
  let { title, children, label }: { title: string; children: Snippet; label?: string } = $props()

  const still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
</script>

<div class="scrim" transition:fade={{ duration: 200 }}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label={label ?? title} in:fly={{ y: still ? 0 : 80, opacity: 0, duration: 320, easing: quintOut }} out:fly={{ y: still ? 0 : 40, duration: 200, easing: cubicOut }}>
  <div class="grabber" aria-hidden="true"></div>
  <h2>{title}</h2>
  {@render children()}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.32);
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 41;
    max-width: 560px;
    max-height: calc(100% - var(--sat) - 24px);
    margin: 0 auto;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--bg);
    border-radius: var(--radius) var(--radius) 0 0;
    /* The hairline keeps the edge visible over the scrim in dark mode. */
    box-shadow: var(--shadow-lift), inset 0 0.5px 0 var(--hairline);
    padding: 8px calc(16px + var(--sar)) calc(var(--sab) + 16px) calc(16px + var(--sal));
  }
  .grabber {
    width: 36px;
    height: 5px;
    border-radius: 3px;
    background: var(--hairline);
    margin: 0 auto 14px;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
</style>
