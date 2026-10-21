<script lang="ts">
  import type { Direction } from '@recall/core'
  import BandBars from '../components/BandBars.svelte'
  import Heatmap from '../components/Heatmap.svelte'
  import Icon from '../components/Icon.svelte'
  import LineChart from '../components/LineChart.svelte'
  import ScaleLadder from '../components/ScaleLadder.svelte'
  import { api, kv } from '../lib/app.svelte.ts'
  import { navigate } from '../lib/router.svelte.ts'
  import { errorText } from '../lib/toast.svelte.ts'
  import type { Dashboard } from '../lib/types.ts'

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
  const history = $derived([...(v?.history ?? [])].reverse())
  const tiles = $derived(
    data
      ? [
          { n: data.counts.known, label: 'known' },
          { n: data.counts.mastered, label: 'mastered' },
          { n: data.counts.words.active, label: 'active' },
          { n: data.counts.words.inbox, label: 'inbox', go: '/inbox' },
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
      {#each [0, 1, 2, 3, 4] as i (i)}<div class="tile"><span class="skel" style="width: 60%; height: 20px"></span><span class="skel" style="width: 80%; margin-top: 6px; height: 10px"></span></div>{/each}
    </div>
    <div class="panel" style="margin-top: 36px"><span class="skel" style="height: 110px; border-radius: 8px"></span></div>
  {:else}
    <!-- Hero: the estimate and where it puts you. -->
    <div class="panel hero">
      {#if cur}
        <div class="big"><span class="approx">≈</span>{fmt(cur.adjusted)}</div>
        <div class="what">English words you know</div>
        <div class="levels">
          {#if cur.cefr.level}<span class="cefr">{cur.cefr.level.id}</span>{:else}<span class="cefr dim">pre-A1</span>{/if}
          <span class="next">
            {#if cur.cefr.next}next: {cur.cefr.next.id} at {fmt(cur.cefr.next.size)}{:else}top of the learner scale{/if}
          </span>
        </div>
        <p class="native">≈ {fmt(cur.nativeEquivalent.value)} as natives count</p>
        <p class="explain">
          Lemmas you know among the 30,000 most frequent English ones{cur.basis === 'app' ? ', from the words known in the app only' : ''}. The native comparison is a calibration, so it's approximate.
        </p>
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
          <button class="btn primary block cta" onclick={() => navigate('/test')}>Take the 3-minute test</button>
        {/if}
      {/if}
    </div>

    {#if cur && v?.scale?.points.length}
      <div class="section-label">Where that puts you</div>
      <div class="panel ladder-panel">
        <ScaleLadder scale={v.scale} value={cur.adjusted} />
      </div>
    {/if}

    <div class="section-label">Words</div>
    <div class="tiles">
      {#each tiles as t (t.label)}
        {#if t.go}
          <button class="tile tap" onclick={() => navigate(t.go!)}><b>{fmt(t.n)}</b><span>{t.label}</span></button>
        {:else}
          <div class="tile"><b>{fmt(t.n)}</b><span>{t.label}</span></div>
        {/if}
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

    <div class="section-label">Activity · 90 days</div>
    <div class="panel">
      <div class="streaks">
        <div class="streak">
          <Icon name="flame" size={22} />
          <span><b>{data.activity.streak.current}</b> {data.activity.streak.current === 1 ? 'day' : 'days'} in a row</span>
        </div>
        <span class="faint">longest {data.activity.streak.longest}</span>
      </div>
      <Heatmap days={data.activity.days} />
      <p class="foot">
        {fmt(data.activity.totals.reviews)} reviews · {duration(data.activity.totals.timeMs)} spent{#if !data.activity.streak.studiedToday && data.activity.streak.current} · review today to keep the streak{/if}
      </p>
    </div>

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
  {/if}
</div>

<style>
  .panel {
    background: var(--surface);
    border-radius: var(--radius-m);
    padding: 14px;
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
    min-height: 36px;
  }
  .ladder-panel {
    padding: 8px 14px;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
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
  .tile.tap {
    transition: transform var(--t-press) var(--ease-out);
  }
  .tile.tap:active {
    transform: scale(0.96);
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
  .streak {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .streak :global(svg) {
    color: var(--accent);
  }
  .streak b {
    font-size: 20px;
    font-weight: 700;
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
</style>
