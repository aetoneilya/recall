<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import { AuthError, HttpError } from '../lib/api.ts'
  import { api, signedIn } from '../lib/app.svelte.ts'
  import { countdown, TelegramLogin, type LoginState } from '../lib/login.ts'
  import { errorText } from '../lib/toast.svelte.ts'

  let { onsignedin }: { onsignedin: () => void } = $props()

  let tg = $state<LoginState>({ kind: 'preparing' })
  let flow: TelegramLogin | undefined
  let now = $state(Date.now())
  let showPassword = $state(false)

  onMount(() => {
    flow = new TelegramLogin({ api, onChange: (s) => (tg = s) })
    void flow.prepare()
    return () => flow?.stop()
  })

  // The countdown ticks only while there is one to show.
  $effect(() => {
    if (tg.kind !== 'waiting') return
    now = Date.now()
    const t = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(t)
  })

  $effect(() => {
    if (tg.kind === 'ok') done()
  })

  function done() {
    signedIn()
    onsignedin()
  }

  // A real link tap: the browser (or iOS, handing off to the Telegram app)
  // opens it; here we only start waiting.
  function tapLink(e: MouseEvent) {
    if (tg.kind !== 'ready') {
      e.preventDefault()
      return
    }
    flow?.begin()
  }

  // ---- owner password ----

  let password = $state('')
  let error = $state('')
  let busy = $state(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!password || busy) return
    busy = true
    error = ''
    try {
      await api.login(password)
      flow?.stop()
      done()
    } catch (err) {
      error = err instanceof HttpError && err.status === 429 ? 'Too many attempts, wait a minute' : err instanceof AuthError ? 'Wrong password' : errorText(err)
    } finally {
      busy = false
    }
  }

  // The bot is off: the password is the only way in.
  const passwordOnly = $derived(tg.kind === 'unavailable')
</script>

<div class="login">
  <div class="panel">
    <img src="/icons/icon.svg" alt="" width="72" height="72" />
    <h1>Mnemosyne</h1>

    {#if tg.kind === 'waiting'}
      <div class="wait" role="status">
        <span class="beacon" aria-hidden="true"><Icon name="send" size={22} stroke={1.9} /></span>
        <strong>Waiting for Telegram…</strong>
        <p class="muted">Press Start in the bot, tap Log in, then come back.</p>
        <p class="expires">Link expires in {countdown(tg.expiresAt, now)}</p>
      </div>
      <a class="btn block" href={tg.url} target="_blank" rel="noopener noreferrer">Open Telegram again</a>
      <button class="text-btn" onclick={() => flow?.cancel()}>Cancel</button>
    {:else if tg.kind === 'error'}
      <p class="error">{tg.message}</p>
      <button class="btn block" onclick={() => flow?.prepare()}>Try again</button>
    {:else if passwordOnly}
      <p class="note">Telegram sign-in is off on this server. The owner can sign in with the password.</p>
    {:else}
      {#if tg.kind === 'ready' && tg.renewed}
        <p class="note">That link expired or was cancelled. Tap to try again.</p>
      {/if}
      <a
        class="btn primary block"
        href={tg.kind === 'ready' ? tg.url : undefined}
        target="_blank"
        rel="noopener noreferrer"
        aria-disabled={tg.kind !== 'ready'}
        onclick={tapLink}
      >
        <Icon name="send" size={20} stroke={2} /> Log in with Telegram
      </a>
    {/if}

    {#if !passwordOnly}
      <button class="disclosure" aria-expanded={showPassword} onclick={() => (showPassword = !showPassword)}>
        Use owner password <span class="chev" class:open={showPassword}><Icon name="chevron" size={15} stroke={2} /></span>
      </button>
    {/if}

    {#if passwordOnly || showPassword}
      <form class:revealed={!passwordOnly} onsubmit={submit}>
        <input type="text" name="username" autocomplete="username" value="owner" hidden />
        {#if passwordOnly}
          <!-- svelte-ignore a11y_autofocus -->
          <input type="password" bind:value={password} placeholder="Password" autocomplete="current-password" autofocus enterkeyhint="go" />
        {:else}
          <input type="password" bind:value={password} placeholder="Owner password" autocomplete="current-password" enterkeyhint="go" />
        {/if}
        {#if error}<p class="error">{error}</p>{/if}
        <button class="btn block" class:primary={passwordOnly} type="submit" disabled={!password || busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    {/if}
  </div>
</div>

<style>
  .login {
    height: 100%;
    overflow-y: auto;
    padding: calc(var(--sat) + 16px) calc(24px + var(--sar)) calc(var(--sab) + 16px) calc(24px + var(--sal));
  }
  .panel {
    width: 100%;
    max-width: 320px;
    /* Roughly centred, but anchored at the top so opening the password
       form grows downwards instead of shifting everything. */
    margin: max(24px, calc(50dvh - 200px)) auto 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    text-align: center;
  }
  img {
    border-radius: 18px;
  }
  h1 {
    margin: 0 0 12px;
    font-size: 28px;
    letter-spacing: -0.02em;
  }
  a.btn {
    text-decoration: none;
    -webkit-touch-callout: none;
  }
  a.btn[aria-disabled='true'] {
    cursor: default;
  }
  .error {
    color: var(--again);
    margin: 0;
    font-size: 15px;
  }
  .note {
    margin: 0;
    font-size: 15px;
    color: var(--muted);
    text-wrap: balance;
  }

  .wait {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    animation: rise-sm var(--t-base) var(--ease-out);
  }
  .wait strong {
    font-size: 18px;
    font-weight: 600;
    margin-top: 10px;
  }
  .wait p {
    margin: 0;
    font-size: 15px;
    text-wrap: balance;
  }
  .wait .expires {
    font-size: 13px;
    font-weight: 500;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
    margin-top: 2px;
  }
  /* A soft accent disc with a ring breathing out of it. */
  .beacon {
    position: relative;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    background: var(--accent-soft);
  }
  .beacon::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: 0 0 0 1.5px var(--accent-ring);
    animation: beacon 1.8s var(--ease-out) infinite;
  }
  @keyframes beacon {
    from {
      transform: scale(1);
      opacity: 1;
    }
    to {
      transform: scale(1.7);
      opacity: 0;
    }
  }
  /* Reduced motion: the ring only fades. */
  @keyframes beacon-still {
    50% {
      opacity: 0.25;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .beacon::after {
      animation-name: beacon-still;
    }
  }

  .text-btn,
  .disclosure {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
    padding: 0 10px;
    font-size: 15px;
    font-weight: 500;
    color: var(--muted);
    transition: opacity var(--t-fast) ease;
  }
  .text-btn:active,
  .disclosure:active {
    opacity: 0.45;
    transition-duration: 0ms;
  }
  .disclosure {
    margin-top: 8px;
    font-weight: 400;
  }
  .chev {
    display: inline-flex;
    transition: transform var(--t-fast) var(--ease-out);
  }
  .chev.open {
    transform: rotate(90deg);
  }

  form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  form.revealed {
    animation: rise-sm var(--t-fast) var(--ease-out);
  }
</style>
