<script lang="ts">
  import Icon from './Icon.svelte'

  // Translations as chips, main first. Tap a chip to select it: arrows move
  // it, × removes it (always there). The trailing field adds one on Enter,
  // "," or ";" (several at once when pasted); Enter on an empty field is
  // passed on as `onsubmit` (e.g. "add the word").
  let {
    value = $bindable([]),
    lang = 'ru',
    placeholder = 'Add a translation',
    onsubmit,
    input = $bindable(),
  }: { value: string[]; lang?: string; placeholder?: string; onsubmit?: () => void; input?: HTMLInputElement } = $props()

  let text = $state('')
  let selected = $state<number | null>(null)

  function commit(): boolean {
    const parts = text.split(/[;,]/).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
    text = ''
    const fresh = parts.filter((p) => !value.some((v) => v.toLowerCase() === p.toLowerCase()))
    if (fresh.length) value = [...value, ...fresh]
    return parts.length > 0
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!commit()) onsubmit?.()
    } else if (e.key === ',' || e.key === ';') {
      e.preventDefault()
      commit()
    }
  }

  function oninput() {
    // Pasted "a, b; c" splits at once.
    if (/[;,]\s*\S/.test(text)) {
      const last = text.match(/[^;,]*$/)?.[0] ?? ''
      text = text.slice(0, text.length - last.length)
      commit()
      text = last.trimStart()
    }
  }

  function remove(i: number) {
    value = value.filter((_, k) => k !== i)
    selected = null
  }

  function move(i: number, d: -1 | 1) {
    const j = i + d
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j], next[i]]
    value = next
    selected = j
  }
</script>

<div class="chips" role="list">
  {#each value as t, i (t)}
    <span class="chip-t" class:main={i === 0} class:sel={selected === i} role="listitem">
      {#if selected === i && i > 0}
        <button type="button" class="mv" onclick={() => move(i, -1)} aria-label="Move “{t}” earlier"><Icon name="back" size={15} stroke={2.2} /></button>
      {/if}
      <button type="button" class="txt" {lang} onclick={() => (selected = selected === i ? null : i)} aria-pressed={selected === i}>{t}</button>
      {#if selected === i && i < value.length - 1}
        <button type="button" class="mv" onclick={() => move(i, 1)} aria-label="Move “{t}” later"><Icon name="chevron" size={15} stroke={2.2} /></button>
      {/if}
      <button type="button" class="x" onclick={() => remove(i)} aria-label="Remove “{t}”"><Icon name="x" size={14} stroke={2.2} /></button>
    </span>
  {/each}
  <input
    bind:this={input}
    bind:value={text}
    onkeydown={onkey}
    {oninput}
    onblur={() => commit()}
    {lang}
    placeholder={value.length ? 'Add' : placeholder}
    enterkeyhint="enter"
    autocomplete="off"
    aria-label={placeholder}
  />
</div>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .chip-t {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    min-height: 40px;
    border-radius: 10px;
    background: var(--surface-2);
    transition: box-shadow var(--t-fast) ease;
  }
  .chip-t.main {
    background: var(--accent-soft);
  }
  .chip-t.sel {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .txt {
    padding: 6px 4px 6px 11px;
    font-size: 16px;
    line-height: 1.3;
    text-align: left;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
  .main .txt {
    font-weight: 600;
  }
  .x,
  .mv {
    flex: none;
    width: 30px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
  }
  .mv {
    color: var(--accent);
    width: 28px;
  }
  .x:active,
  .mv:active {
    opacity: 0.5;
  }
  input {
    flex: 1 1 120px;
    min-width: 120px;
    width: auto;
    padding: 7px 10px;
    border-radius: 10px;
    font-size: 16px;
    background: transparent;
    border-color: transparent;
  }
  input:focus {
    background: var(--surface);
  }
</style>
