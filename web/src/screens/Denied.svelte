<script lang="ts">
  import Icon from '../components/Icon.svelte'
  import { status } from '../lib/app.svelte.ts'
  import { showToast } from '../lib/toast.svelte.ts'

  // A Telegram account that isn't allowed yet. The way in is the bot's
  // Request access button; the id is there for asking the owner directly.
  const id = $derived(status.deniedId)

  async function copy() {
    try {
      await navigator.clipboard.writeText(String(id))
      showToast('Copied')
    } catch {
      showToast('Copy failed — select the id instead')
    }
  }
</script>

<div class="denied">
  <div class="empty">
    <Icon name="lock" size={40} stroke={1.6} />
    {#if id !== null}
      <p><strong>Invite-only</strong>Mnemosyne is invite-only. Ask for access in the bot: send it /start and tap Request access. Your Telegram id:</p>
      <div class="id">
        <span class="num">{id}</span>
        <button class="btn" onclick={copy}><Icon name="copy" size={16} /> Copy</button>
      </div>
      <p class="hint">Once the owner lets you in, close and reopen the app.</p>
    {:else}
      <p><strong>Couldn't sign you in</strong>Telegram didn't confirm who you are. Close the app and open it again from the bot.</p>
    {/if}
  </div>
</div>

<style>
  .denied {
    height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: calc(var(--sat) + 16px) calc(16px + var(--sar)) calc(var(--sab) + 16px) calc(16px + var(--sal));
  }
  .id {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: 300px;
    margin-top: 4px;
    padding: 8px 8px 8px 16px;
    background: var(--surface);
    border-radius: var(--radius-m);
  }
  .num {
    flex: 1;
    min-width: 0;
    text-align: left;
    font-family: var(--mono);
    font-size: 19px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
    -webkit-user-select: all;
    user-select: all;
  }
  .id .btn {
    min-height: 40px;
    padding: 0 14px;
    font-size: 15px;
  }
  .hint {
    font-size: 15px;
  }
</style>
