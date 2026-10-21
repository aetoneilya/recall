<script lang="ts">
  import { fly } from 'svelte/transition'
  import { quintOut } from 'svelte/easing'
  import { runToastAction, toast } from '../lib/toast.svelte.ts'

  const still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
</script>

{#if toast.message}
  {#key toast.id}
    <!-- Drops in from the top edge and leaves the same way. -->
    <div class="toast" class:has-action={toast.action} role="status" transition:fly={{ y: still ? 0 : -16, duration: 260, easing: quintOut }}>
      <span class="msg">{toast.message}</span>
      {#if toast.action}
        <button class="act" onclick={runToastAction}>{toast.action.label}</button>
      {/if}
    </div>
  {/key}
{/if}

<style>
  .toast {
    position: fixed;
    left: 16px;
    right: 16px;
    top: calc(var(--sat) + var(--vv-top, 0px) + 10px);
    margin: 0 auto;
    width: fit-content;
    max-width: calc(100% - 32px);
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--text);
    color: var(--bg);
    padding: 11px 18px;
    border-radius: 14px;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.35;
    text-align: center;
    z-index: 50;
    box-shadow: var(--shadow-lift);
    pointer-events: none;
  }
  .toast.has-action {
    padding: 4px 4px 4px 16px;
    pointer-events: auto;
    text-align: left;
  }
  .act {
    flex: none;
    min-height: 40px;
    padding: 0 14px;
    border-radius: 11px;
    font-weight: 650;
    color: var(--accent);
    color: color-mix(in srgb, var(--accent) 55%, var(--bg));
    transition: background-color var(--t-fast) ease;
  }
  .act:active {
    background: color-mix(in srgb, var(--bg) 14%, transparent);
  }
</style>
