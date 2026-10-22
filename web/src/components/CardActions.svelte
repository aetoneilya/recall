<script lang="ts">
  import Icon from './Icon.svelte'

  // The revealed card's corner: ✎ opens the editor; ⋯ holds what is rarely
  // wanted — Drop (never show this card again).
  let { onedit, ondrop, label }: { onedit: () => void; ondrop?: () => void; label: string } = $props()

  let open = $state(false)
  const stop = (fn: () => void) => (e: Event) => {
    e.stopPropagation()
    fn()
  }
</script>

<svelte:window onclick={() => (open = false)} />

<div class="corner">
  {#if ondrop}
    <button class="icon" onclick={stop(() => (open = !open))} onmousedown={(e) => e.preventDefault()} aria-label="More" aria-expanded={open} aria-haspopup="menu">
      <Icon name="more" size={20} stroke={3} />
    </button>
  {/if}
  <button class="icon" onclick={stop(onedit)} onmousedown={(e) => e.preventDefault()} aria-label={label}>
    <Icon name="edit" size={18} />
  </button>
  {#if open && ondrop}
    <div class="menu" role="menu">
      <button role="menuitem" onclick={stop(() => ((open = false), ondrop()))} onmousedown={(e) => e.preventDefault()}>
        <Icon name="x" size={16} stroke={2} />
        <span>Drop<small>Never show this card again</small></span>
      </button>
    </div>
  {/if}
</div>

<style>
  .corner {
    position: absolute;
    top: 3px;
    right: 3px;
    z-index: 2;
    display: flex;
    animation: fade-in var(--t-fast) ease;
  }
  .icon {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 14px;
    color: var(--faint);
    transition:
      color var(--t-fast) ease,
      background-color var(--t-fast) ease;
  }
  .icon:active,
  .icon[aria-expanded='true'] {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .menu {
    position: absolute;
    top: 46px;
    right: 0;
    min-width: 200px;
    padding: 4px;
    border-radius: 14px;
    background: var(--surface);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 8px 24px rgba(0, 0, 0, 0.16);
    animation: fade-in var(--t-fast) ease;
  }
  .menu button {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    text-align: left;
    font-size: 15px;
    font-weight: 500;
    color: var(--text);
  }
  .menu button:active {
    background: var(--surface-2);
  }
  .menu :global(svg) {
    margin-top: 2px;
    color: var(--again);
  }
  .menu small {
    display: block;
    font-size: 12.5px;
    font-weight: 400;
    color: var(--muted);
  }
</style>
