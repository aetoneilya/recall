<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import { status } from '../lib/app.svelte.ts'
  import { LEVEL_NAMES, LEVELS, nextLevel, PACES, STEPS, wizard, type Level } from '../lib/onboarding.svelte.ts'
  import { session } from '../lib/review.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { haptic, setBackButton } from '../lib/telegram.ts'
  import VocabTest from './VocabTest.svelte'

  // The first-run wizard (lib/onboarding.svelte.ts): one short screen per
  // step, Skip in the corner, Back to retrace, the primary action at the foot.
  const w = wizard
  const at = $derived(STEPS.indexOf(w.step))
  const offers = $derived(w.offers)
  const chosen = $derived(w.chosen)
  const names = $derived(offers.filter((o) => chosen.includes(o.pack.id)).map((o) => o.pack.name))

  onMount(() => {
    void w.load()
  })

  // Telegram's Back follows ours; the test runs its own.
  $effect(() => {
    if (w.testing) return
    setBackButton(w.trail.length ? () => w.back() : null)
  })

  function pickLevel(l: Level | 'unsure') {
    haptic.select()
    w.chooseLevel(l)
  }

  async function start() {
    if (!(await w.finish())) return
    haptic.notify('success')
    navigate('/', { replace: true })
    void session.refresh()
  }

  const viaText = $derived(w.levelVia === 'test' ? 'from your test' : w.levelVia === 'pick' ? 'your pick' : 'a guess — the test can tell')
  const greeting = $derived(status.me?.user.name ? `Welcome, ${status.me.user.name}` : 'Welcome to Mnemosyne')
</script>

{#if w.testing}
  <VocabTest onfinish={(r) => w.testDone(r)} />
{:else}
  <div class="wizard">
    <div class="top">
      {#if w.trail.length && !status.telegram}
        <button class="icon-btn back" onclick={() => w.back()} aria-label="Back"><Icon name="back" /></button>
      {:else}
        <span class="spacer"></span>
      {/if}
      <div class="dots" aria-label="Step {at + 1} of {STEPS.length}">
        {#each STEPS as s, i (s)}<span class:on={i <= at}></span>{/each}
      </div>
      {#if w.step !== 'done'}
        <button class="skip" onclick={() => w.skip()}>Skip</button>
      {:else}
        <span class="spacer"></span>
      {/if}
    </div>

    {#key w.step}
      <div class="body">
        {#if w.step === 'welcome'}
          <div class="mark" aria-hidden="true"><Icon name="review" size={30} stroke={1.8} /></div>
          <h1>{greeting}</h1>
          <p class="lead">Learn English words a few minutes a day. Each card comes back just before you'd forget it.</p>
          <p class="muted">Add words as you meet them — here, or by sending them to the bot. Let's set up your deck: it takes a minute.</p>
        {:else if w.step === 'level'}
          <h1>How much English do you know?</h1>
          <p class="muted">So the first words aren't too easy or too hard.</p>
          <div class="group">
            <button class="row test" onclick={() => w.takeTest()}>
              <Icon name="progress" size={20} />
              <span class="grow">Take the 3-minute test <span class="sub">Tick the words you know; it finds your level</span></span>
              <Icon name="chevron" size={16} />
            </button>
          </div>
          <div class="section-label">Or pick it</div>
          <div class="group" role="radiogroup" aria-label="Your level">
            {#each LEVELS as l (l)}
              <button class="row" role="radio" aria-checked={w.level === l && w.levelVia !== 'unsure'} onclick={() => pickLevel(l)}>
                <b class="lvl">{l}</b>
                <span class="grow">{LEVEL_NAMES[l]}{#if w.levelVia === 'test' && w.level === l}<span class="sub accent">Your test result</span>{/if}</span>
                {#if w.level === l && w.levelVia !== 'unsure'}<Icon name="check" size={18} stroke={2.4} />{/if}
              </button>
            {/each}
            <button class="row" role="radio" aria-checked={w.levelVia === 'unsure'} onclick={() => pickLevel('unsure')}>
              <span class="grow">Not sure <span class="sub">Start in the middle, at B1</span></span>
              {#if w.levelVia === 'unsure'}<Icon name="check" size={18} stroke={2.4} />{/if}
            </button>
          </div>
        {:else if w.step === 'packs'}
          <h1>What to start with</h1>
          <p class="muted">Ready-made cards for {w.chosenLevel}, introduced a few a day. You can add more in Settings → Packs.</p>
          {#if w.packs === null}
            <div class="group skel-group" aria-label="Loading">
              <div class="row"><span class="skel" style="width: 60%"></span><span class="skel" style="width: 40%"></span></div>
              <div class="row"><span class="skel" style="width: 50%"></span><span class="skel" style="width: 30%"></span></div>
            </div>
          {:else if offers.length}
            <div class="group">
              {#each offers as o (o.pack.id)}
                {@const on = chosen.includes(o.pack.id)}
                <button class="row" role="checkbox" aria-checked={on} onclick={() => (haptic.select(), w.toggle(o.pack.id))}>
                  <span class="box" class:on aria-hidden="true">{#if on}<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>{/if}</span>
                  <span class="grow">{o.pack.name} <span class="faint">· {o.pack.count.toLocaleString('en-US')} {o.pack.format === 'words' ? 'words' : 'cards'}</span>
                    <span class="sub">{o.pack.format === 'words' && o.pack.level === nextLevel(w.chosenLevel) ? 'One level up — for when the first set feels easy' : o.pack.description}</span>
                  </span>
                </button>
              {/each}
            </div>
          {:else}
            <p class="none">Nothing ready-made here yet — you'll add your own words as you go.</p>
          {/if}
        {:else if w.step === 'pace'}
          <h1>New cards a day</h1>
          <p class="muted">How many new cards each day brings. Reviews come on top; you can change it in Settings.</p>
          <div class="seg" role="radiogroup" aria-label="New cards a day">
            {#each PACES as n (n)}
              <button role="radio" aria-checked={w.pace === n} class:on={w.pace === n} onclick={() => (haptic.select(), (w.pace = n))}>{n}</button>
            {/each}
          </div>
          <p class="caption">{w.pace === 5 ? 'Gentle: a few minutes a day.' : w.pace === 10 ? 'Steady: about ten minutes a day.' : 'Fast: plan on twenty minutes or more.'}</p>
        {:else}
          <div class="mark" aria-hidden="true"><Icon name="check" size={30} stroke={2.2} /></div>
          <h1>You're all set</h1>
          <div class="group summary">
            <div class="row"><span class="grow">Level</span><span class="value">{w.chosenLevel} <span class="faint">· {viaText}</span></span></div>
            <div class="row"><span class="grow">Cards</span><span class="value">{names.length ? names.join(', ') : 'Your own words'}</span></div>
            <div class="row"><span class="grow">New a day</span><span class="value">{w.pace}</span></div>
          </div>
          {#if w.error}<p class="err">Couldn't finish setting up: {w.error}</p>{/if}
        {/if}
      </div>
    {/key}

    <div class="foot">
      {#if w.step === 'welcome'}
        <button class="btn primary block" onclick={() => w.next()}>Get started</button>
      {:else if w.step === 'level'}
        {#if w.level && w.levelVia === 'test'}<button class="btn primary block" onclick={() => w.next()}>Continue with {w.level}</button>{/if}
      {:else if w.step === 'packs' || w.step === 'pace'}
        <button class="btn primary block" onclick={() => w.next()}>Continue</button>
      {:else}
        <button class="btn primary block" onclick={start} disabled={w.finishing}>{w.finishing ? 'Setting up…' : w.error ? 'Try again' : 'Start learning'}</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .wizard {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: var(--sat) calc(16px + var(--sar)) calc(var(--sab) + 16px) calc(16px + var(--sal));
  }
  .top {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
  }
  .back {
    margin-left: -10px;
    color: var(--accent);
  }
  .spacer {
    width: 44px;
  }
  .skip {
    min-width: 44px;
    min-height: 44px;
    padding: 0 4px;
    font-size: 16px;
    color: var(--muted);
  }
  .dots {
    display: flex;
    gap: 6px;
  }
  .dots span {
    width: 6px;
    height: 6px;
    border-radius: 3px;
    background: var(--surface-2);
    transition: background-color var(--t-base) ease;
  }
  .dots span.on {
    background: var(--accent);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 16px 0 24px;
    animation: rise var(--t-base) var(--ease-out);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(var(--rise, 6px));
    }
  }
  h1 {
    font-size: 28px;
    line-height: 1.15;
    font-weight: 700;
    letter-spacing: -0.025em;
    margin: 0 0 10px;
    text-wrap: balance;
  }
  p {
    margin: 0 0 12px;
    text-wrap: pretty;
  }
  .lead {
    font-size: 19px;
    line-height: 1.4;
  }
  .mark {
    width: 56px;
    height: 56px;
    border-radius: 28px;
    margin: 24px 0 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .group {
    margin-top: 16px;
  }
  .section-label + .group {
    margin-top: 0;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .sub {
    display: block;
    font-size: 13px;
    color: var(--muted);
  }
  .sub.accent {
    color: var(--accent);
  }
  .faint {
    color: var(--faint);
  }
  .row :global(svg) {
    flex: none;
  }
  .row[role='radio'] :global(svg),
  .test :global(svg) {
    color: var(--accent);
  }
  .test :global(svg:last-child) {
    color: var(--faint);
  }
  .lvl {
    width: 28px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  .box {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1.5px var(--hairline);
    transition: background-color var(--t-fast) ease;
  }
  .box.on {
    background: var(--accent);
    box-shadow: none;
  }
  .box svg {
    fill: none;
    stroke: var(--accent-text);
    stroke-width: 2.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-top: 20px;
    background: var(--surface-2);
    border-radius: 12px;
    padding: 3px;
  }
  .seg button {
    height: 44px;
    border-radius: 9px;
    font-size: 17px;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    transition:
      background-color var(--t-fast) ease,
      color var(--t-fast) ease;
  }
  .seg button.on {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 2px 8px -2px rgba(0, 0, 0, 0.1);
  }
  .caption {
    margin: 12px 4px 0;
    font-size: 15px;
    color: var(--muted);
  }
  .summary .value {
    flex: none;
    max-width: 62%;
    text-align: right;
    color: var(--text);
    font-weight: 500;
  }
  .none {
    margin: 16px 4px;
    color: var(--muted);
  }
  .err {
    margin: 16px 4px 0;
    color: var(--again);
    font-size: 15px;
  }
  .foot {
    flex: none;
    min-height: 44px;
  }
</style>
