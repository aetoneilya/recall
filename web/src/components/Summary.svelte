<script lang="ts">
  import { status } from '../lib/app.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { session } from '../lib/review.svelte.ts'
  import Icon from './Icon.svelte'

  const s = $derived(session.stats)
  const retention = $derived.by(() => {
    const base = s.matured || s.reviewed
    const lapses = s.matured ? s.maturedAgain : s.again
    return base ? Math.round((1 - lapses / base) * 100) : null
  })
  const minutes = $derived(Math.max(1, Math.round(s.ms / 60000)))
  const w = $derived.by(() => {
    void session.now
    return session.waiting()
  })
  const inMin = $derived(w.next ? Math.max(1, Math.round((w.next.getTime() - session.now) / 60000)) : 0)
</script>

{#if !session.loaded && !session.error}
  <div class="loading" aria-label="Loading cards">
    <span class="skel" style="width: 40%"></span>
    <span class="skel big" style="width: 62%"></span>
    <span class="skel" style="width: 48%"></span>
  </div>
{:else}
  <div class="summary">
    {#if !session.loaded}
      <Icon name="offline" size={40} stroke={1.4} />
      {#if session.error === 'offline'}
        <h2>You're offline</h2>
        <p class="muted">No cards are cached on this device yet. Open Mnemosyne once while online and they'll be here next time.</p>
        <button class="btn" onclick={() => session.refresh()} disabled={session.refreshing}>
          <Icon name="refresh" size={18} /> Try again
        </button>
      {:else}
        <h2>Couldn't load cards</h2>
        <p class="muted">{session.error}</p>
        <button class="btn" onclick={() => session.refresh()} disabled={session.refreshing}>
          <Icon name="refresh" size={18} /> Try again
        </button>
      {/if}
    {:else}
      <svg class="mark" class:done={s.reviewed} width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle cx="28" cy="28" r="27" />
        <path d="M17 29l7.5 7.5L39.5 21" />
      </svg>
      <h2>{s.reviewed ? 'Done for now' : 'Nothing due'}</h2>
      {#if s.reviewed}
        <p class="tally">
          <b>{s.reviewed}</b>
          {s.reviewed === 1 ? 'card' : 'cards'} in <b>{minutes}</b> min{#if retention !== null}<span class="sep">·</span><b>{retention}%</b> remembered{/if}
        </p>
      {:else}
        <p class="muted">You're all caught up. Reviews and new words appear here as they come due.</p>
      {/if}
      {#if w.count}
        <p class="next">
          <Icon name="clock" size={16} />
          {w.count} learning {w.count === 1 ? 'card' : 'cards'} back in {inMin} min
        </p>
      {/if}
      {#if status.inbox}
        <button class="row inbox" onclick={() => navigate('/inbox', { replace: true })}>
          <Icon name="inbox" size={20} />
          <span>{status.inbox} {status.inbox === 1 ? 'word' : 'words'} from Claude to vet</span>
          <Icon name="chevron" size={18} />
        </button>
      {/if}
      <div class="actions">
        {#if session.canUndo}
          <button class="btn" onclick={() => session.undo()}><Icon name="undo" size={18} /> Undo</button>
        {/if}
        <button class="btn" onclick={() => session.refresh()} disabled={session.refreshing}>
          <Icon name="refresh" size={18} /> {session.refreshing ? 'Checking…' : 'Check for more'}
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .summary {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 10px;
    padding: 24px 12px 64px;
    animation: rise var(--t-base) var(--ease-out);
  }
  .summary > :global(svg:first-child) {
    color: var(--faint);
    margin-bottom: 4px;
  }
  h2 {
    font-size: 28px;
    line-height: 1.15;
    font-weight: 700;
    letter-spacing: -0.025em;
    margin: 0;
  }
  p {
    margin: 0;
    max-width: 300px;
    text-wrap: balance;
  }
  .tally {
    font-size: 17px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .tally b {
    color: var(--text);
    font-weight: 650;
  }
  .sep {
    margin: 0 8px;
    color: var(--faint);
  }
  .next {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 15px;
    color: var(--muted);
  }

  /* The session-end check: drawn once, the one celebratory moment. */
  .mark {
    margin-bottom: 6px;
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .mark circle {
    stroke: var(--surface-2);
    stroke-width: 2;
    fill: var(--surface);
  }
  .mark path {
    stroke: var(--faint);
    stroke-width: 3;
  }
  .mark.done circle {
    fill: var(--good-bg);
    stroke: transparent;
  }
  .mark.done path {
    stroke: var(--good);
    stroke-dasharray: 34;
    animation: tick 420ms var(--ease-out) 120ms both;
  }
  @keyframes tick {
    from {
      stroke-dashoffset: 34;
    }
    to {
      stroke-dashoffset: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mark.done path {
      animation: none;
    }
  }

  .inbox {
    max-width: 340px;
    margin-top: 14px;
    border-radius: var(--radius-m);
    background: var(--surface);
    color: var(--text);
    font-size: 15px;
  }
  .inbox :global(svg) {
    color: var(--accent);
    flex: none;
  }
  .inbox :global(svg:last-child) {
    color: var(--faint);
  }
  .inbox span {
    flex: 1;
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }

  .loading {
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 20px;
    animation: fade-in var(--t-base) ease 150ms both;
  }
  .loading .big {
    height: 22px;
    margin-top: 18%;
    align-self: center;
  }
  .loading .big + .skel {
    align-self: center;
  }
</style>
