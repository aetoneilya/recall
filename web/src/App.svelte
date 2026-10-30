<script lang="ts">
  import TabBar from './components/TabBar.svelte'
  import Toast from './components/Toast.svelte'
  import { loadMe, status } from './lib/app.svelte.ts'
  import { needsWizard } from './lib/onboarding.svelte.ts'
  import { session } from './lib/review.svelte.ts'
  import { back, parentOf, router } from './lib/router.svelte.ts'
  import { setBackButton } from './lib/telegram.ts'
  import { checkpoint } from './lib/update.ts'
  import AddWord from './screens/AddWord.svelte'
  import Dashboard from './screens/Dashboard.svelte'
  import Decks from './screens/Decks.svelte'
  import Packs from './screens/Packs.svelte'
  import FactEditor from './screens/FactEditor.svelte'
  import Denied from './screens/Denied.svelte'
  import Login from './screens/Login.svelte'
  import Practice from './screens/Practice.svelte'
  import Handbook from './screens/Handbook.svelte'
  import Review from './screens/Review.svelte'
  import Settings from './screens/Settings.svelte'
  import VocabTest from './screens/VocabTest.svelte'
  import Welcome from './screens/Welcome.svelte'
  import WordEditor from './screens/WordEditor.svelte'
  import Words from './screens/Words.svelte'

  const r = $derived(router.route)
  // A new account: the first-run wizard instead of the tabs.
  const wizard = $derived(needsWizard(status))
  const [a, b] = $derived(r.parts)

  // Pushed screens slide in from the right, popped ones from the left; tab
  // switches are instant (they happen too often to animate).
  const depth = () => (history.state as { depth?: number } | null)?.depth ?? 0
  let lastDepth = depth()
  let lastTab = router.route.tab
  let enter = $state<'push' | 'pop' | 'none'>('none')
  $effect.pre(() => {
    void r.path
    const d = depth()
    enter = r.tab !== lastTab ? 'none' : d > lastDepth ? 'push' : d < lastDepth ? 'pop' : 'none'
    lastDepth = d
    lastTab = r.tab
  })

  // A new version waiting applies when a screen opens with nothing in progress.
  $effect(() => {
    void r.path
    checkpoint('route')
  })

  // The test runs its own Back (it undoes the last answer); so does the wizard.
  $effect(() => {
    if (r.parts[0] === 'test' || wizard) return
    setBackButton(status.auth === 'ok' && parentOf(r) !== null ? back : null)
  })

  // Escape: out of a field first, then back from a pushed screen. A sheet
  // handles its own Escape first; the test has its own Back.
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[data-sheet]')) return
    const t = e.target as HTMLElement | null
    if (t?.closest?.('input, textarea, select')) {
      t.blur()
      return
    }
    if (r.parts[0] !== 'test' && !wizard && parentOf(r) !== null) {
      e.preventDefault()
      back()
    }
  }

  function afterLogin() {
    void loadMe()
    void session.refresh()
  }
</script>

<svelte:window onkeydown={onKey} />

{#if status.auth === 'login'}
  <Login onsignedin={afterLogin} />
{:else if status.auth === 'denied'}
  <Denied />
{:else if wizard}
  <div class="shell"><main><div class="view"><Welcome /></div></main></div>
{:else}
  <div class="shell">
    <main>
      {#key r.path}
      <div class="view" data-enter={enter}>
      {#if a === 'add'}
        <AddWord />
      {:else if a === 'fact' && b}
        <!-- Question and Grammar rule share #/fact/new: ?rule=1 tells them apart. -->
        {#key `${b}:${r.query.get('rule') ?? ''}`}<FactEditor id={b} />{/key}
      {:else if a === 'word' && b}
        {#key b}<WordEditor id={b} />{/key}
      {:else if a === 'words'}
        <Words />
      {:else if a === 'deck' || a === 'decks'}
        <Decks id={a === 'deck' ? b : undefined} />
      {:else if a === 'packs'}
        <Packs />
      {:else if a === 'practice'}
        <Practice />
      {:else if a === 'handbook'}
        {#key b}<Handbook topic={b ?? null} />{/key}
      {:else if a === 'progress'}
        <Dashboard />
      {:else if a === 'test'}
        <VocabTest />
      {:else if a === 'settings'}
        <Settings />
      {:else}
        <Review />
      {/if}
      </div>
      {/key}
    </main>
    <TabBar />
  </div>
{/if}
<Toast />

<style>
  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  main {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }
  .view {
    position: absolute;
    inset: 0;
  }
  .view[data-enter='push'] {
    animation: push var(--t-slow) var(--ease-drawer);
  }
  .view[data-enter='pop'] {
    animation: pop var(--t-slow) var(--ease-drawer);
  }
  @keyframes push {
    from {
      opacity: 0;
      transform: translateX(var(--push));
    }
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateX(calc(var(--push) * -1));
    }
  }
</style>
