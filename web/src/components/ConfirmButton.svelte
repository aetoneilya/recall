<script lang="ts">
  import type { Snippet } from 'svelte'

  // Two-tap confirmation without a modal: the first tap arms, the second
  // (within 3 s) runs the action.
  let {
    onconfirm,
    children,
    confirmLabel = 'Tap again to confirm',
    class: cls = 'btn',
    disabled = false,
  }: { onconfirm: () => void; children: Snippet; confirmLabel?: string; class?: string; disabled?: boolean } = $props()

  let armed = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  function click() {
    if (!armed) {
      armed = true
      clearTimeout(timer)
      timer = setTimeout(() => (armed = false), 3000)
      return
    }
    armed = false
    clearTimeout(timer)
    onconfirm()
  }
</script>

<button class={cls} class:armed onclick={click} {disabled}>
  {#if armed}{confirmLabel}{:else}{@render children()}{/if}
</button>

<style>
  .armed {
    outline: 2px solid currentColor;
    outline-offset: -2px;
  }
</style>
