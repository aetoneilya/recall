<script lang="ts">
  import type { Direction } from '@recall/core'
  import BandBars from '../components/BandBars.svelte'
  import Heatmap from '../components/Heatmap.svelte'
  import Icon from '../components/Icon.svelte'
  import LineChart from '../components/LineChart.svelte'
  import ScaleLadder from '../components/ScaleLadder.svelte'
  import { api, kv } from '../lib/app.svelte.ts'
  import { getDecks } from '../lib/decks.ts'
  import { session } from '../lib/review.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { errorText } from '../lib/toast.svelte.ts'
  import { studySummary } from '../lib/progress.ts'
  import type { Dashboard, DeckWithCounts } from '../lib/types.ts'

  let data = $state.raw<Dashboard | null>(null)
  let error = $state('')
  let loading = $state(false)

  // The last dashboard paints at once (and offline); the fresh one replaces it.
  void kv
    .get<Dashboard>('dashboard')
    .then((d) => {
      if (d && !data) data = d
    })
    .catch(() => {})

  async function load() {
    loading = true
    try {
      const d = await api.dashboard()
      data = d
      error = ''
      void kv.set('dashboard', d)
    } catch (e) {
      error = errorText(e)
    } finally {
      loading = false
    }
  }
  void load()

  // Every deck, a small block under the vocabulary, with its top tags: from
  // the review session's cached copy (offline too), refreshed on each visit.
  let decks = $state.raw<DeckWithCounts[]>((Object.values(session.decks) as DeckWithCounts[]).filter((d) => d.counts))
  void getDecks(true)
    .then((ds) => (decks = ds))
    .catch(() => {})

  const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
  const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 100)}%`)
  function dateText(iso: string) {
    const d = new Date(iso)
    const sameYear = d.getFullYear() === new Date().getFullYear()
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
  }
  function duration(ms: number) {
    const min = Math.round(ms / 60000)
    if (min < 60) return `${min} min`
    const h = Math.floor(min / 60)
    return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  }

  const v = $derived(data?.vocabulary)
  const cur = $derived(v?.current ?? null)
  const lang = $derived({ t: (data?.deck.targetLang ?? 'en').toUpperCase(), n: (data?.deck.nativeLang ?? 'ru').toUpperCase() })
  const dirs = $derived<{ d: Direction; name: string; verb: string }[]>([
    { d: 'forward', name: `${lang.t} → ${lang.n}`, verb: 'recognise' },
    { d: 'reverse', name: `${lang.n} → ${lang.t}`, verb: 'recall' },
  ])
  const growth = $derived((data?.growth ?? []).map((g) => ({ date: g.date, value: g.known })))
  // Growth proof under the headline: known words now vs about 30 days ago (weekly points).
  const change = $derived(growth.length > 4 ? growth.at(-1)!.value - growth.at(-5)!.value : null)
  const activeDays = $derived((data?.activity.days ?? []).filter((d) => d.reviews > 0).length)
  const weekly = $derived(studySummary(data?.activity.days ?? []))
  const history = $derived([...(v?.history ?? [])].reverse())
  const tiles = $derived(
    data
      ? [
          { n: data.counts.known, label: 'known' },
          { n: data.counts.mastered, label: 'mastered' },
          { n: data.counts.words.active, label: 'active' },
          { n: data.counts.words.total, label: 'total' },
        ]
      : [],
  )
</script>

<div class="screen">
  <div class="screen-title"><h1>Progress</h1></div>

  {#if !data && error}
    <div class="empty">
      <Icon name="offline" size={40} stroke={1.4} />
      <p><strong>Couldn't load your progress</strong>{error}</p>
      <button class="btn" onclick={load} disabled={loading}><Icon name="refresh" size={18} /> Try again</button>
    </div>
  {:else if !data}
    <div class="panel hero" aria-label="Loading">
      <span class="skel" style="width: 55%; height: 44px; border-radius: 10px"></span>
      <span class="skel" style="width: 35%; margin-top: 14px"></span>
      <span class="skel" style="width: 80%; margin-top: 10px"></span>
    </div>
    <div class="tiles" style="margin-top: 12px">
      {#each [0, 1, 2, 3] as i (i)}<div class="tile"><span class="skel" style="width: 60%; height: 20px"></span><span class="skel" style="width: 80%; margin-top: 6px; height: 10px"></span></div>{/each}
    </div>
    <div class="panel" style="margin-top: 36px"><span class="skel" style="height: 110px; border-radius: 8px"></span></div>
  {:else}
    <div class="panel study-hero">
      <div class="study-heading"><span>Across all decks</span><span>{weekly.todayReviews} reviews today</span></div>
      <div class="streak-number">{data.activity.streak.current}<span>{data.activity.streak.current === 1 ? 'day' : 'days'} in a row</span></div>
      <div class="weekly-label">Last 7 days</div>
      <div class="study-metrics">
        <div><b>{fmt(weekly.reviews)}</b><span>reviews</span></div>
        <div><b>{pct(weekly.recalled)}</b><span>recalled</span></div>
        <div><b>{duration(weekly.timeMs)}</b><span>studying</span></div>
      </div>
      <p class="foot">{weekly.reviews ? 'Recalled = answers rated Hard, Good or Easy.' : 'Your first review starts your progress.'}</p>
    </div>

    <div class="section-label">Activity · {data.activity.days.length} days</div>
    <div class="panel">
      <div class="streaks"><span>{activeDays} active days</span><span class="faint">Best streak: {data.activity.streak.longest}</span></div>
      <Heatmap days={data.activity.days} />
      <div class="legend" aria-hidden="true"><span>Reviews per day</span><span class="scale">Less<i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>More</span></div>
      <p class="foot">
        {fmt(data.activity.totals.reviews)} reviews · {duration(data.activity.totals.timeMs)} spent
      </p>
    </div>

    {#if decks.length > 1 || decks.some((d) => d.tags?.length)}
      <div class="section-label">Decks</div>
      <div class="group topics">
        {#each decks as d (d.id)}
          {@const c = d.counts}
          {@const shown = c.total - c.dropped}
          <div class="row topic">
            <span class="tmain">
              <span class="tname">{d.name}</span>
              <!-- Words and questions vs their cards (a word has two): new and learning count cards. -->
              <span class="tsub">{fmt(shown)} {shown === 1 ? 'item' : 'items'} · {fmt(c.known)} known · cards: {fmt(c.learning)} learning, {fmt(c.newTotal)} new</span>
              {#if d.tags?.length}<span class="ttags">{d.tags.slice(0, 4).map((t) => `${t.tag.split('/').join(' › ')} ${t.n}`).join(' · ')}{d.tags.length > 4 ? ` · +${d.tags.length - 4}` : ''}</span>{/if}
            </span>
            <span class="today" aria-label="{c.due + c.new} due today"><b>{fmt(c.due + c.new)}</b> today</span>
          </div>
        {/each}
      </div>
    {/if}

    <div class="section-label">{data.deck.name} · vocabulary</div>
    <div class="panel hero">
      {#if cur}
        <div class="big"><span class="approx">≈</span>{fmt(cur.adjusted)}</div>
        <div class="what">English words you know</div>
        {#if change !== null}<div class="change" class:up={change > 0}>{change > 0 ? '+' : change < 0 ? '−' : '±'}{fmt(Math.abs(change))} known in 30 days</div>{/if}
        <div class="levels">
          {#if cur.cefr.level}<span class="cefr">{cur.cefr.level.id}</span>{:else}<span class="cefr dim">pre-A1</span>{/if}
          <span class="next">
            {#if cur.cefr.next}next: {cur.cefr.next.id} at {fmt(cur.cefr.next.size)}{:else}top of the learner scale{/if}
          </span>
        </div>
      {:else}
        <div class="what solo">Vocabulary size needs the frequency list on the server.</div>
      {/if}
      {#if v?.available.test}
        {#if v.latestTest}
          <div class="retake">
            <span>Last test {dateText(v.latestTest.completedAt)}</span>
            <button class="link" onclick={() => navigate('/test')}>Retake test</button>
          </div>
        {:else}
          <button class="btn block cta" onclick={() => navigate('/test')}>3-minute vocabulary test</button>
        {/if}
      {/if}
    </div>

    <details class="vocab-details">
      <summary>Vocabulary details</summary>
      {#if cur}
        <div class="panel methodology">
        <p class="native">≈ {fmt(cur.nativeEquivalent.value)} as natives count</p>
        <p class="explain">
          Lemmas you know among the 30,000 most frequent English ones{cur.basis === 'app' ? ', from the words known in the app only' : ''}. The native comparison is a calibration, so it's approximate.
        </p>
        </div>
      {/if}
    {#if cur && v?.scale?.points.length}
      <div class="section-label">Where that puts you</div>
      <div class="panel ladder-panel">
        <ScaleLadder scale={v.scale} value={cur.adjusted} />
      </div>
    {/if}

    <div class="section-label">Words</div>
    <div class="tiles">
      {#each tiles as t (t.label)}
        <div class="tile"><b>{fmt(t.n)}</b><span>{t.label}</span></div>
      {/each}
    </div>

    <div class="panel dirs">
      {#each dirs as x (x.d)}
        {@const c = data.counts.directions[x.d]}
        {@const total = Math.max(1, c.new + c.learning + c.known + c.fading)}
        {@const r = data.retention[x.d]}
        <div class="dir" class:off={!c.enabled}>
          <div class="dir-head">
            <span class="dir-name">{x.name} <span class="verb">{x.verb}</span></span>
            {#if c.enabled}
              <span class="ret" title="Remembered in the last 30 days">{pct(r.rate)} <span class="faint">· {r.reviews} {r.reviews === 1 ? 'review' : 'reviews'}</span></span>
            {:else}
              <span class="chip">off</span>
            {/if}
          </div>
          <div class="stack" role="img" aria-label="{x.name}: {c.new} new, {c.learning} learning, {c.known} known, {c.fading} fading">
            {#if c.new}<span class="seg s-new" style="flex: {c.new / total}"></span>{/if}
            {#if c.learning}<span class="seg s-learn" style="flex: {c.learning / total}"></span>{/if}
            {#if c.known}<span class="seg s-known" style="flex: {c.known / total}"></span>{/if}
            {#if c.fading}<span class="seg s-fading" style="flex: {c.fading / total}"></span>{/if}
          </div>
          <div class="nums">
            <span><i class="s-new"></i>{c.new} new</span>
            <span><i class="s-learn"></i>{c.learning} learning</span>
            <span><i class="s-known"></i>{c.known} known</span>
            <span><i class="s-fading"></i>{c.fading} fading</span>
            {#if c.suspended}<span class="faint">{c.suspended} suspended</span>{/if}
          </div>
        </div>
      {/each}
    </div>

    {#if growth.length}
      <div class="section-label">Known words · 26 weeks</div>
      <div class="panel">
        <div class="headline"><b>{fmt(growth.at(-1)!.value)}</b> known now{#if growth[0].value !== growth.at(-1)!.value}<span class="faint">{' · '}{growth.at(-1)!.value >= growth[0].value ? '+' : ''}{fmt(growth.at(-1)!.value - growth[0].value)} since {dateText(growth[0].date)}</span>{/if}</div>
        <LineChart data={growth} label="Known words per week over the last 26 weeks" />
      </div>
    {/if}

    {#if data.coverage.some((b) => b.words)}
      <div class="section-label">Frequency coverage</div>
      <div class="panel">
        <BandBars bands={data.coverage} />
        <p class="foot">Single words in the app by frequency rank: known of in the app.</p>
      </div>
    {/if}

    {#if history.length}
      <div class="section-label">Tests</div>
      <div class="group">
        {#each history as h (h.testId)}
          <div class="row test">
            <span class="grow">
              <b>≈ {fmt(h.adjusted)}</b>
              <span class="sub">{dateText(h.completedAt)} · ≈ {fmt(h.nativeEquivalent)} as natives count</span>
            </span>
            {#if !h.valid}<span class="chip">invalid</span>{:else if h.reliability === 'low'}<span class="chip">low reliability</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
    </details>
  {/if}
</div>

<style>
  .study-heading {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 13px;
    color: var(--muted);
  }
  .streak-number {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 48px;
    font-weight: 700;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
    margin: 10px 0 20px;
  }
  .streak-number span {
    font-size: 17px;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--muted);
  }
  .weekly-label {
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .study-metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .study-metrics div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .study-metrics b {
    font-size: 23px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }
  .study-metrics span {
    color: var(--muted);
    font-size: 13px;
  }
  .vocab-details {
    margin-top: 8px;
  }
  .vocab-details summary {
    min-height: 44px;
    padding: 12px 16px;
    color: var(--accent);
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
  }
  .methodology {
    margin-top: 8px;
  }
  .panel {
    background: var(--surface);
    border-radius: var(--radius-m);
    padding: 14px;
  }
  .study-hero {
    padding: 16px;
  }
  .hero {
    padding: 18px 16px 16px;
    display: flex;
    flex-direction: column;
  }
  .big {
    font-size: 48px;
    line-height: 1.05;
    font-weight: 700;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }
  .approx {
    color: var(--muted);
    font-weight: 500;
    margin-right: 6px;
  }
  .what {
    font-size: 15px;
    color: var(--muted);
    margin-top: 2px;
  }
  .what.solo {
    color: var(--text);
  }
  .levels {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
  }
  .cefr {
    padding: 3px 10px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 700;
    font-size: 15px;
  }
  .cefr.dim {
    color: var(--muted);
    background: var(--surface-2);
  }
  .next {
    font-size: 14px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .native {
    margin: 10px 0 0;
    font-size: 15px;
    font-variant-numeric: tabular-nums;
  }
  .explain {
    margin: 6px 0 0;
    font-size: 13px;
    line-height: 1.4;
    color: var(--muted);
    text-wrap: pretty;
  }
  .cta {
    margin-top: 16px;
    min-height: 50px;
  }
  .retake {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 12px;
    font-size: 13px;
    color: var(--muted);
  }
  .link {
    color: var(--accent);
    font-weight: 600;
    font-size: 15px;
    min-height: 40px;
  }
  .ladder-panel {
    padding: 8px 14px;
  }

  .topic {
    gap: 10px;
  }
  .tmain {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tname {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .tsub {
    font-size: 13px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .ttags {
    font-size: 12.5px;
    color: var(--faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .today {
    flex: none;
    font-size: 13px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .today b {
    font-size: 17px;
    font-weight: 650;
    color: var(--text);
    margin-right: 2px;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .tile {
    background: var(--surface);
    border-radius: 12px;
    padding: 10px 6px 9px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    min-width: 0;
  }
  .tile b {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .tile span {
    font-size: 12px;
    color: var(--muted);
  }

  .dirs {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .dir.off {
    opacity: 0.5;
  }
  .dir-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .dir-name {
    font-weight: 600;
    font-size: 15px;
  }
  .verb {
    font-weight: 400;
    color: var(--muted);
    margin-left: 4px;
  }
  .ret {
    font-size: 15px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .ret .faint {
    font-weight: 400;
    font-size: 13px;
  }
  .stack {
    display: flex;
    gap: 2px;
    height: 12px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--surface-2);
  }
  .seg {
    min-width: 3px;
  }
  .s-new {
    background: var(--c-new);
  }
  .s-learn {
    background: var(--c-learn);
  }
  .s-known {
    background: var(--c-review);
  }
  /* Fading: still in review but due — the known colour, hatched. */
  .s-fading {
    background: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--c-review) 55%, transparent) 0 2px, transparent 2px 5px);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-review) 60%, transparent);
  }
  .nums {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-top: 8px;
    font-size: 13px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .nums span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .nums i {
    width: 9px;
    height: 9px;
    border-radius: 3px;
  }

  .headline {
    font-size: 15px;
    margin-bottom: 8px;
    font-variant-numeric: tabular-nums;
  }
  .headline b {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .streaks {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    font-size: 15px;
    font-variant-numeric: tabular-nums;
  }



  .foot {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .faint {
    color: var(--faint);
  }
  .test b {
    font-variant-numeric: tabular-nums;
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
  .change {
    margin-top: 4px;
    font-size: 15px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .change.up {
    color: var(--good);
  }
  .legend {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .scale {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--faint);
  }
  .scale i {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--surface-2);
  }
  .scale .l1 {
    background: color-mix(in srgb, var(--accent) 30%, var(--surface-2));
  }
  .scale .l2 {
    background: color-mix(in srgb, var(--accent) 55%, var(--surface-2));
  }
  .scale .l3 {
    background: color-mix(in srgb, var(--accent) 78%, var(--surface-2));
  }
  .scale .l4 {
    background: var(--accent);
  }
</style>
