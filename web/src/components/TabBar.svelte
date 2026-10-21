<script lang="ts">
  import { status } from '../lib/app.svelte.ts'
  import { navigate, router, type Tab } from '../lib/router.svelte.ts'
  import { haptic } from '../lib/telegram.ts'
  import Icon from './Icon.svelte'

  const tabs: { tab: Tab; path: string; label: string }[] = [
    { tab: 'review', path: '/', label: 'Review' },
    { tab: 'words', path: '/words', label: 'Words' },
    { tab: 'inbox', path: '/inbox', label: 'Inbox' },
    { tab: 'progress', path: '/progress', label: 'Progress' },
    { tab: 'settings', path: '/settings', label: 'Settings' },
  ]

  function go(t: (typeof tabs)[number]) {
    if (router.route.path === t.path) return
    haptic.select()
    // Tabs replace history so Back never walks through tab switches.
    navigate(t.path, { replace: true })
  }
</script>

<nav class="tabs">
  {#each tabs as t (t.tab)}
    <button class:active={router.route.tab === t.tab} onclick={() => go(t)} aria-label={t.label}>
      <span class="icon">
        <Icon name={t.tab} size={24} />
        {#if t.tab === 'inbox' && status.inbox > 0}
          <span class="badge">{status.inbox}</span>
        {/if}
      </span>
      <span class="label">{t.label}</span>
    </button>
  {/each}
</nav>

<style>
  .tabs {
    flex: none;
    display: flex;
    background: var(--surface);
    box-shadow: inset 0 0.5px 0 var(--hairline);
    padding: 0 var(--sar) var(--sab) var(--sal);
  }
  /* The keyboard is up: what's being typed and its buttons get the room. */
  :global(:root[data-keyboard]) .tabs {
    display: none;
  }
  button {
    flex: 1;
    height: 52px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    color: var(--faint);
    transition: color var(--t-fast) ease;
  }
  button.active {
    color: var(--accent);
  }
  .icon {
    position: relative;
    display: flex;
    transition: transform var(--t-press) var(--ease-out);
  }
  button:active .icon {
    transform: scale(0.88);
  }
  .badge {
    position: absolute;
    top: -5px;
    left: 15px;
    height: 17px;
    min-width: 17px;
    font-size: 11px;
    padding: 0 5px;
    box-shadow: 0 0 0 2px var(--surface);
  }
  .label {
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.01em;
  }
  button.active .label {
    font-weight: 600;
  }
</style>
