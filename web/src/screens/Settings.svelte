<script lang="ts">
  import ConfirmButton from '../components/ConfirmButton.svelte'
  import Icon from '../components/Icon.svelte'
  import Sheet from '../components/Sheet.svelte'
  import { HttpError } from '../lib/api.ts'
  import { api, flushNow, setMe, status } from '../lib/app.svelte.ts'
  import { getDecks } from '../lib/decks.ts'
  import { session } from '../lib/review.svelte.ts'
  import { allZones, deviceZone, patchMeOptimistic, type MeFieldPatch, relTime, searchZones, shortDate, zoneLabel, zoneOffset } from '../lib/settings.ts'
  import { applyTheme, loadTheme, type ThemeChoice } from '../lib/theme.ts'
  import { errorText, showToast } from '../lib/toast.svelte.ts'
  import type { ApiToken, AuthVia, DeckPatch, DeckWithCounts, Me, NewToken, TypeAnswer } from '../lib/types.ts'

  let decks = $state<DeckWithCounts[]>([])
  let theme = $state<ThemeChoice>(loadTheme())
  let mockOffline = $state(false)

  void getDecks(true)
    .then((d) => (decks = d))
    .catch(() => {})

  const origin = location.origin
  const mcpUrl = `${origin}/mcp`

  const me = $derived(status.me)

  // Deck settings: shown at once (and the review queue follows at once),
  // sent in the background, put back with a note if the server refuses.
  async function patchDeck(d: DeckWithCounts, p: DeckPatch) {
    const before = Object.fromEntries(Object.keys(p).map((k) => [k, d[k as keyof DeckPatch]])) as DeckPatch
    Object.assign(d, p)
    session.applyDeck($state.snapshot(d) as DeckWithCounts)
    try {
      await api.patchDeck(d.id, p)
      session.markStale()
      void getDecks(true)
    } catch (e) {
      Object.assign(d, before)
      session.applyDeck($state.snapshot(d) as DeckWithCounts)
      showToast(`Not saved: ${errorText(e)}`)
    }
  }

  function setDirection(d: DeckWithCounts, dir: 'forwardEnabled' | 'reverseEnabled', on: boolean, el: HTMLInputElement) {
    const other = dir === 'forwardEnabled' ? d.reverseEnabled : d.forwardEnabled
    // One direction always stays on.
    if (!on && !other) {
      el.checked = true
      showToast('Keep at least one direction on')
      return
    }
    void patchDeck(d, { [dir]: on })
  }

  const GATES: { label: string; value: number | null }[] = [
    { label: 'Off', value: null },
    { label: '3 d', value: 3 },
    { label: '7 d', value: 7 },
    { label: '14 d', value: 14 },
    { label: '30 d', value: 30 },
  ]
  const TYPE_ANSWERS: { label: string; value: TypeAnswer }[] = [
    { label: 'Off', value: 'off' },
    { label: 'RU → EN', value: 'reverse' },
    { label: 'Both', value: 'both' },
  ]
  const code = (l: string) => l.toUpperCase()

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  function setNew(d: DeckWithCounts, delta: number) {
    const v = Math.max(0, Math.min(999, d.newPerDay + delta))
    if (v === d.newPerDay) return
    const before = d.newPerDay
    d.newPerDay = v
    clearTimeout(timers.get(d.id))
    timers.set(
      d.id,
      setTimeout(async () => {
        try {
          await api.patchDeck(d.id, { newPerDay: v })
          session.markStale()
          void getDecks(true)
        } catch (e) {
          d.newPerDay = before
          showToast(`Not saved: ${errorText(e)}`)
        }
      }, 600),
    )
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      showToast('Copied')
    } catch {
      showToast('Copy failed — select the text instead')
    }
  }

  async function logout() {
    try {
      await api.logout()
    } catch {
      // Signing out locally is what matters.
    }
    status.auth = 'login'
  }

  async function syncNow() {
    const ok = await flushNow()
    showToast(ok ? 'Synced' : status.online ? 'Sync failed, will retry' : 'Offline, will retry')
    if (ok) void session.refresh()
  }

  function setMockOffline(v: boolean) {
    mockOffline = v
    const ctl = (window as unknown as { __recallMock?: { offline: boolean } }).__recallMock
    if (ctl) ctl.offline = v
    if (!v) void syncNow()
  }

  function setTheme(t: ThemeChoice) {
    theme = t
    applyTheme(t)
  }

  const lastSync = $derived(status.lastSync ? new Date(status.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not yet')

  // ---- account ----

  const viaText: Record<AuthVia, string> = {
    telegram: 'Signed in through Telegram',
    session: 'Signed in on this device',
    bearer: 'Signed in with an API token',
    dev: 'Dev mode, no sign-in',
  }

  // ---- reminders ----

  const meStore = {
    get: () => (status.me ? ($state.snapshot(status.me) as Me) : null),
    set: (m: Me) => setMe(m),
  }

  async function patch(p: MeFieldPatch) {
    const ok = await patchMeOptimistic(meStore, p, api.patchMe, (e) => showToast(`Not saved: ${errorText(e)}`))
    if (ok && p.timeZone) session.markStale()
  }

  const device = deviceZone()
  let zoneOpen = $state(false)
  let zoneQuery = $state('')
  // Built on first open: ~400 zones.
  let zones = $state<string[]>([])
  const zoneHits = $derived(searchZones(zones, zoneQuery))

  function toggleZones() {
    zoneOpen = !zoneOpen
    zoneQuery = ''
    if (zoneOpen && !zones.length) zones = allZones()
  }

  function pickZone(z: string) {
    zoneOpen = false
    if (me && z !== me.timeZone) void patch({ timeZone: z })
  }

  const isTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v)

  function setTime(key: 'reminderTime' | 'eveningReminderTime', el: HTMLInputElement) {
    const v = el.value
    // Cleared or half-typed (desktop): put the saved value back.
    if (!isTime(v)) {
      el.value = me?.[key] ?? ''
      return
    }
    if (me && me[key] !== v) void patch({ [key]: v })
  }

  // Remembered so switching the evening nudge off and on keeps its time.
  let lastEvening = $state('21:00')
  $effect(() => {
    if (me?.eveningReminderTime) lastEvening = me.eveningReminderTime
  })

  // ---- weekly report ----

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  // Monday first in the picker.
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

  // ---- advanced: FSRS ----

  let advancedOpen = $state(false)
  let retention = $state(0.9)
  $effect(() => {
    if (me?.fsrs) retention = me.fsrs.requestRetention
  })
  let optimizing = $state(false)
  let haveReviews = $state<number | null>(null)

  async function setRetention(v: number) {
    if (!me?.fsrs || Math.abs(v - me.fsrs.requestRetention) < 0.001) return
    const before = me.fsrs.requestRetention
    try {
      setMe(await api.patchMe({ requestRetention: Math.round(v * 100) / 100 }))
      session.markStale()
    } catch (e) {
      retention = before
      showToast(`Not saved: ${errorText(e)}`)
    }
  }

  async function optimize() {
    if (optimizing) return
    optimizing = true
    try {
      const r = await api.optimizeFsrs()
      if (r.reviews !== null) haveReviews = r.reviews
      void loadMe()
      showToast(r.adopted ? `Personal parameters trained on ${r.reviews ?? 'your'} reviews` : `Kept the current parameters${r.reason ? `: ${r.reason}` : ''}`)
    } catch (e) {
      if (e instanceof HttpError && e.status === 422) {
        haveReviews = typeof e.data.reviews === 'number' ? e.data.reviews : haveReviews
        showToast(`Not enough reviews yet${haveReviews !== null ? ` (${haveReviews} of ${e.data.minReviews ?? me?.fsrs?.minReviews ?? '?'})` : ''}`)
      } else if (e instanceof HttpError && e.status === 429) {
        const h = Math.max(1, Math.ceil(Number(e.data.retryAfterSeconds ?? 3600) / 3600))
        showToast(`Trained recently — try again in ${h} h`)
      } else showToast(errorText(e))
    } finally {
      optimizing = false
    }
  }

  async function loadMe() {
    try {
      setMe(await api.me())
    } catch {
      // The next visit shows it.
    }
  }

  const fsrsStatus = $derived.by(() => {
    const f = me?.fsrs
    if (!f) return ''
    if (f.weights && f.trainedAt) {
      const d = new Date(f.trainedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
      return `Personal parameters: trained ${d}${f.reviewsUsed ? ` on ${f.reviewsUsed.toLocaleString()} reviews` : ''}`
    }
    return `Default parameters — personalised after ${f.minReviews ?? 'enough'} reviews${haveReviews !== null ? ` (you have ${haveReviews})` : ''}`
  })

  // ---- personal tokens ----

  // The server refuses token management with a bearer (a leaked token must
  // not mint more), so the section isn't offered then.
  const canManageTokens = $derived(!!me && me.authenticatedVia !== 'bearer')
  let tokens = $state<ApiToken[] | null>(null)
  let tokensError = $state('')
  let tokensRequested = false

  $effect(() => {
    if (canManageTokens && !tokensRequested) {
      tokensRequested = true
      void loadTokens()
    }
  })

  async function loadTokens() {
    tokensError = ''
    try {
      tokens = await api.tokens()
    } catch (e) {
      tokensError = errorText(e)
    }
  }

  let naming = $state(false)
  let tokenName = $state('')
  let creating = $state(false)
  let created = $state<NewToken | null>(null)

  function startNaming() {
    naming = true
    tokenName = ''
  }

  async function createToken(e: SubmitEvent) {
    e.preventDefault()
    const name = tokenName.trim()
    if (!name || creating) return
    creating = true
    try {
      const t = await api.createToken(name)
      tokens = [t.token, ...(tokens ?? [])]
      created = t
      naming = false
    } catch (err) {
      showToast(errorText(err))
    } finally {
      creating = false
    }
  }

  async function revoke(t: ApiToken) {
    const before = tokens
    tokens = (tokens ?? []).filter((x) => x.id !== t.id)
    try {
      await api.deleteToken(t.id)
      showToast(`Revoked “${t.name}”`)
    } catch (e) {
      tokens = before
      showToast(`Not revoked: ${errorText(e)}`)
    }
  }

  const command = (secret: string) => `claude mcp add --transport http mnemosyne ${mcpUrl} --header "Authorization: Bearer ${secret}"`

  function focus(el: HTMLElement) {
    el.focus()
  }
</script>

<div class="screen">
  <div class="screen-title"><h1>Settings</h1></div>

  <div class="group">
    <div class="row">
      <span class="grow">
        <span class="name">
          <span class="ellipsis">{me?.user.name || (me ? `id ${me.user.telegramId}` : 'Your account')}</span>
          {#if me?.user.isOwner}<span class="chip">owner</span>{/if}
        </span>
        <span class="sub">{me ? viaText[me.authenticatedVia] : status.telegram ? viaText.telegram : 'Signed in'}</span>
      </span>
      {#if !status.telegram && me?.authenticatedVia !== 'bearer'}<button class="btn danger" onclick={logout}>Log out</button>{/if}
    </div>
  </div>

  {#each decks as d (d.id)}
    {@const t = code(d.targetLang)}
    {@const n = code(d.nativeLang)}
    <div class="section-label">{decks.length > 1 ? d.name : 'Study'}</div>
    <div class="group">
      <label class="row">
        <span class="grow">{t} → {n} <span class="muted">recognise</span><span class="sub">See the word, recall what it means</span></span>
        <input type="checkbox" class="switch" checked={d.forwardEnabled} onchange={(e) => setDirection(d, 'forwardEnabled', e.currentTarget.checked, e.currentTarget)} />
      </label>
      <label class="row">
        <span class="grow">{n} → {t} <span class="muted">recall</span><span class="sub">See the meaning, produce the word</span></span>
        <input type="checkbox" class="switch" checked={d.reverseEnabled} onchange={(e) => setDirection(d, 'reverseEnabled', e.currentTarget.checked, e.currentTarget)} />
      </label>
      {#if d.forwardEnabled && d.reverseEnabled}
        <div class="row col">
          <span>Introduce {n} → {t} after {t} → {n} is stable for <span class="sub">New words start with recognition only; recall joins once it holds</span></span>
          <div class="seg five" role="radiogroup" aria-label="Introduce {n} → {t} after">
            {#each GATES as g (g.label)}
              <button role="radio" aria-checked={d.reverseAfterDays === g.value} class:on={d.reverseAfterDays === g.value} onclick={() => patchDeck(d, { reverseAfterDays: g.value })}>{g.label}</button>
            {/each}
          </div>
        </div>
      {/if}
      <div class="row">
        <span class="grow">New cards per day <span class="sub">{d.counts.newTotal ? `${d.counts.newTotal} not started yet` : 'Every card started'}</span></span>
        <div class="stepper">
          <button onclick={() => setNew(d, -1)} disabled={d.newPerDay <= 0} aria-label="Fewer new cards"><Icon name="minus" size={18} stroke={2} /></button>
          <span>{d.newPerDay}</span>
          <button onclick={() => setNew(d, 1)} aria-label="More new cards"><Icon name="plus" size={18} stroke={2} /></button>
        </div>
      </div>
      <div class="row col">
        <span>Type the answer <span class="sub">Instead of just revealing it; typos count as Hard</span></span>
        <div class="seg" role="radiogroup" aria-label="Type the answer">
          {#each TYPE_ANSWERS as o (o.value)}
            <button role="radio" aria-checked={d.typeAnswer === o.value} class:on={d.typeAnswer === o.value} onclick={() => patchDeck(d, { typeAnswer: o.value })}>{o.label.replace('RU', n).replace('EN', t)}</button>
          {/each}
        </div>
      </div>
    </div>
    <p class="caption">A direction you turn off keeps its history and comes back as it was.</p>
  {:else}
    <div class="section-label">Study</div>
    <div class="group"><div class="row muted">Loading…</div></div>
  {/each}

  {#if me}
    <div class="section-label">Reminders</div>
    <div class="group">
      <button class="row" aria-expanded={zoneOpen} onclick={toggleZones}>
        <span class="grow">Time zone</span>
        <span class="value">{zoneLabel(me.timeZone).split(' · ')[0]} <span class="faint">{zoneOffset(me.timeZone)}</span></span>
        <span class="chev" class:open={zoneOpen}><Icon name="chevron" size={16} stroke={2} /></span>
      </button>
      {#if zoneOpen}
        <div class="zones">
          <div class="zone-search">
            <Icon name="search" size={18} />
            <input use:focus type="search" bind:value={zoneQuery} placeholder="City or region" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search time zones" />
          </div>
          <div class="zone-list" role="listbox" aria-label="Time zones">
            {#each zoneHits as z (z)}
              <button class="zone" role="option" aria-selected={z === me.timeZone} onclick={() => pickZone(z)}>
                <span class="grow">{zoneLabel(z)}</span>
                <span class="faint">{zoneOffset(z)}</span>
                <span class="tick">{#if z === me.timeZone}<Icon name="check" size={18} stroke={2.2} />{/if}</span>
              </button>
            {:else}
              <p class="none">No time zone matches “{zoneQuery}”</p>
            {/each}
          </div>
        </div>
      {:else if device && device !== me.timeZone}
        <div class="row">
          <span class="grow">
            Use this device's zone
            <span class="sub">{zoneLabel(device)} · {zoneOffset(device)}</span>
          </span>
          <button class="btn small" onclick={() => pickZone(device)}>Use</button>
        </div>
      {/if}
      <label class="row">
        <span class="grow">Morning reminder <span class="sub">What's due today</span></span>
        <input class="time" type="time" value={me.reminderTime} onchange={(e) => setTime('reminderTime', e.currentTarget)} />
      </label>
      <label class="row">
        <span class="grow">Evening nudge <span class="sub">Only if nothing was reviewed</span></span>
        <input
          type="checkbox"
          class="switch"
          checked={me.eveningReminderTime !== null}
          onchange={(e) => patch({ eveningReminderTime: e.currentTarget.checked ? lastEvening : null })}
        />
      </label>
      {#if me.eveningReminderTime !== null}
        <label class="row">
          <span class="grow">Evening time</span>
          <input class="time" type="time" value={me.eveningReminderTime} onchange={(e) => setTime('eveningReminderTime', e.currentTarget)} />
        </label>
      {/if}
      {#if me.weeklyReport !== undefined}
        <label class="row">
          <span class="grow">Weekly report in Telegram <span class="sub">Your progress every week</span></span>
          <input type="checkbox" class="switch" checked={me.weeklyReport} onchange={(e) => patch({ weeklyReport: e.currentTarget.checked })} />
        </label>
        {#if me.weeklyReport && me.weeklyReportDay !== undefined}
          <div class="row">
            <span class="grow">Sent on</span>
            <select class="time day" value={me.weeklyReportDay} onchange={(e) => patch({ weeklyReportDay: Number(e.currentTarget.value) })} aria-label="Weekly report day">
              {#each DAY_ORDER as d (d)}<option value={d}>{WEEKDAYS[d]}</option>{/each}
            </select>
            {#if me.weeklyReportTime}
              <input class="time" type="time" value={me.weeklyReportTime} aria-label="Weekly report time" onchange={(e) => /^\d\d:\d\d$/.test(e.currentTarget.value) && patch({ weeklyReportTime: e.currentTarget.value })} />
            {/if}
          </div>
        {/if}
      {/if}
    </div>
    <p class="caption">
      {me.botUsername ? `Sent by @${me.botUsername} in Telegram.` : 'Sent by the Telegram bot.'} The study day starts at {me.dayStartHour}:00.
    </p>
  {/if}

  <div class="section-label">Sync</div>
  <div class="group">
    <div class="row">
      <span class="grow">
        {status.pending ? `${status.pending} ratings waiting to upload` : 'Everything uploaded'}
        <span class="sub">{status.online ? 'Online' : 'Offline'} · last sync {lastSync}</span>
      </span>
      <button class="btn" onclick={syncNow}>Sync now</button>
    </div>
    {#if status.mock}
      <label class="row">
        <span class="grow">Simulate offline <span class="sub">Mock mode only</span></span>
        <input type="checkbox" class="switch" checked={mockOffline} onchange={(e) => setMockOffline(e.currentTarget.checked)} />
      </label>
    {/if}
  </div>

  {#if !status.telegram}
    <div class="section-label">Appearance</div>
    <div class="seg" role="radiogroup" aria-label="Theme">
      {#each ['auto', 'light', 'dark'] as const as t (t)}
        <button role="radio" aria-checked={theme === t} class:on={theme === t} onclick={() => setTheme(t)}>{t}</button>
      {/each}
    </div>
  {/if}

  {#if canManageTokens}
    <div class="section-label">Personal tokens for Claude</div>
    <div class="group">
      {#if tokens === null && !tokensError}
        <div class="row skel-row" aria-hidden="true"><span class="skel" style="width: 40%"></span><span class="skel" style="width: 62%; height: 10px"></span></div>
      {:else if tokensError}
        <div class="row">
          <span class="grow muted">Couldn't load tokens <span class="sub">{tokensError}</span></span>
          <button class="btn small" onclick={loadTokens}>Retry</button>
        </div>
      {:else}
        {#each tokens ?? [] as t (t.id)}
          <div class="row">
            <span class="grow">
              <span class="ellipsis">{t.name}</span>
              <span class="sub">Created {shortDate(t.createdAt)} · {t.lastUsedAt ? `used ${relTime(t.lastUsedAt)}` : 'never used'}</span>
            </span>
            <ConfirmButton class="btn danger small" confirmLabel="Revoke?" onconfirm={() => revoke(t)}>Revoke</ConfirmButton>
          </div>
        {/each}
      {/if}
      {#if naming}
        <form class="row naming" onsubmit={createToken}>
          <input use:focus bind:value={tokenName} placeholder="Name, e.g. Laptop" maxlength="100" autocomplete="off" enterkeyhint="done" aria-label="Token name" />
          <button class="btn primary small" type="submit" disabled={!tokenName.trim() || creating}>{creating ? 'Creating…' : 'Create'}</button>
          <button class="btn small" type="button" onclick={() => (naming = false)}>Cancel</button>
        </form>
      {:else if tokens !== null}
        <button class="row add" onclick={startNaming}><Icon name="plus" size={20} stroke={2} /> New token</button>
      {/if}
    </div>
    <p class="caption">For Claude Code and scripts. A token acts as you; revoke the ones you no longer use.</p>
  {/if}

  {#if me?.fsrs}
    <div class="group adv">
      <button class="row" aria-expanded={advancedOpen} onclick={() => (advancedOpen = !advancedOpen)}>
        <span class="grow">Advanced <span class="sub">Scheduling</span></span>
        <span class="chev" class:open={advancedOpen}><Icon name="chevron" size={16} stroke={2} /></span>
      </button>
      {#if advancedOpen}
        <div class="row col">
          <span class="retention-head"><span>Desired retention</span><b>{Math.round(retention * 100)}%</b></span>
          <input
            class="range"
            type="range"
            min="0.8"
            max="0.95"
            step="0.01"
            bind:value={retention}
            onchange={() => setRetention(Number(retention))}
            aria-label="Desired retention"
          />
          <span class="sub">How sure you want to be of remembering a card when it comes up. Higher means more reviews; 90% is the usual balance.</span>
        </div>
        <div class="row">
          <span class="grow">{fsrsStatus}</span>
          <button class="btn small" onclick={optimize} disabled={optimizing}>{optimizing ? 'Training…' : 'Optimize now'}</button>
        </div>
      {/if}
    </div>
  {/if}

  <div class="section-label">claude.ai</div>
  <div class="group">
    <div class="block">
      <p class="hint">Settings → Connectors → Add custom connector with this URL. It confirms in Telegram, no token needed.</p>
      <code class="cmd">{mcpUrl}</code>
      <button class="btn copy" onclick={() => copy(mcpUrl)}><Icon name="copy" size={16} /> Copy URL</button>
    </div>
  </div>

  <p class="version">Mnemosyne · {__BUILD__}{status.mock ? ' · mock' : ''}</p>
</div>

{#if created}
  <Sheet title="Token created">
    <p class="lead">Copy it now: it won't be shown again.</p>
    <div class="group">
      <div class="block">
        <div class="label">{created.token.name}</div>
        <code class="cmd secret">{created.secret}</code>
        <button class="btn copy" onclick={() => copy(created!.secret)}><Icon name="copy" size={16} /> Copy token</button>
      </div>
    </div>
    <div class="section-label">Claude Code</div>
    <div class="group">
      <div class="block">
        <code class="cmd">{command(created.secret)}</code>
        <button class="btn copy" onclick={() => copy(command(created!.secret))}><Icon name="copy" size={16} /> Copy command</button>
      </div>
    </div>
    <p class="caption">claude.ai doesn't use tokens: add the connector URL <span class="mono">{mcpUrl}</span> and confirm in Telegram instead.</p>
    <button class="btn primary block done" onclick={() => (created = null)}>Done</button>
  </Sheet>
{/if}

<style>
  .grow {
    flex: 1;
    min-width: 0;
  }
  .sub {
    display: block;
    font-size: 13px;
    color: var(--muted);
  }
  .faint {
    color: var(--faint);
  }
  .ellipsis {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .name .chip {
    font-weight: 500;
    flex: none;
  }
  .caption {
    font-size: 13px;
    line-height: 1.4;
    color: var(--muted);
    margin: 8px 16px 0;
    text-wrap: pretty;
  }
  .mono {
    font-family: var(--mono);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .btn.small {
    min-height: 36px;
    padding: 0 12px;
    font-size: 15px;
    flex: none;
  }
  .stepper {
    display: flex;
    align-items: center;
    background: var(--surface-2);
    border-radius: 10px;
  }
  .stepper button {
    width: 44px;
    height: 38px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    border-radius: 10px;
    transition: background-color var(--t-fast) ease;
  }
  .stepper button:active:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    transition-duration: 0ms;
  }
  .stepper span {
    min-width: 32px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  /* Reminders */
  .value {
    color: var(--muted);
    white-space: nowrap;
  }
  .value .faint {
    font-size: 15px;
    margin-left: 2px;
  }
  .chev {
    display: inline-flex;
    color: var(--faint);
    margin-right: -4px;
    transition: transform var(--t-fast) var(--ease-out);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .zones {
    animation: rise-sm var(--t-fast) var(--ease-out);
  }
  .zone-search {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 12px 6px;
    padding: 0 12px;
    background: var(--surface-2);
    border-radius: 10px;
    color: var(--faint);
  }
  .zone-search input {
    border: 0;
    background: transparent;
    padding: 9px 0;
    box-shadow: none;
  }
  .zone-search input::-webkit-search-cancel-button {
    display: none;
  }
  .zone-list {
    max-height: 288px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-bottom: 4px;
  }
  .zone {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 44px;
    padding: 8px 12px 8px 16px;
    text-align: left;
    font-size: 16px;
    transition: background-color var(--t-fast) ease;
  }
  .zone:active {
    background: var(--surface-2);
    transition-duration: 0ms;
  }
  .zone .faint {
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  .zone[aria-selected='true'] {
    color: var(--accent);
    font-weight: 600;
  }
  .tick {
    width: 18px;
    display: inline-flex;
    color: var(--accent);
  }
  .none {
    margin: 0;
    padding: 12px 16px 14px;
    font-size: 15px;
    color: var(--muted);
  }
  .time {
    width: auto;
    min-width: 84px;
    flex: none;
    padding: 6px 10px;
    border: 0;
    border-radius: 8px;
    background: var(--surface-2);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .time::-webkit-calendar-picker-indicator {
    display: none;
  }

  /* Tokens */
  .skel-row {
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 9px;
    min-height: 62px;
  }
  .naming {
    gap: 8px;
  }
  .naming input {
    flex: 1;
    min-width: 0;
    padding: 7px 12px;
  }
  .add {
    color: var(--accent);
    font-weight: 500;
    gap: 8px;
  }

  /* Copyable blocks */
  .block {
    padding: 12px 14px 14px;
  }
  .label {
    font-weight: 600;
    margin-bottom: 6px;
  }
  .hint {
    font-size: 14px;
    color: var(--muted);
    margin: 0 0 8px;
  }
  .cmd {
    display: block;
    font-family: var(--mono);
    font-size: 12.5px;
    background: var(--code-bg);
    border-radius: 8px;
    padding: 10px 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    -webkit-user-select: all;
    user-select: all;
  }
  .cmd.secret {
    font-size: 13.5px;
  }
  .copy {
    margin-top: 10px;
    min-height: 38px;
    font-size: 14px;
  }
  .lead {
    margin: 0 0 16px;
    font-size: 15px;
    color: var(--muted);
  }
  .done {
    margin-top: 20px;
  }

  .adv {
    margin-top: 28px;
  }
  .retention-head {
    display: flex;
    justify-content: space-between;
  }
  .retention-head b {
    font-variant-numeric: tabular-nums;
  }
  .range {
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    -webkit-appearance: auto;
    appearance: auto;
    height: 28px;
  }
  .range:focus {
    box-shadow: none;
  }
  .time.day {
    min-width: 0;
    text-align: left;
    padding-right: 28px;
    background-position: right 10px center;
  }
  .row.col {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .seg.five {
    grid-template-columns: repeat(5, 1fr);
  }
  .seg.five button {
    text-transform: none;
    font-variant-numeric: tabular-nums;
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    background: var(--surface-2);
    border-radius: 12px;
    padding: 3px;
  }
  .seg button {
    height: 38px;
    border-radius: 9px;
    font-size: 15px;
    text-transform: capitalize;
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
  .switch {
    width: 51px;
    height: 31px;
    padding: 0;
    border-radius: 16px;
    background: var(--surface-2);
    border: 0;
    position: relative;
    flex: none;
    cursor: pointer;
    transition: background 0.2s;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform 0.2s;
  }
  .switch:checked {
    background: var(--good);
  }
  .switch:checked::after {
    transform: translateX(20px);
  }
  .version {
    text-align: center;
    font-size: 12px;
    color: var(--faint);
    margin-top: 28px;
  }
</style>
