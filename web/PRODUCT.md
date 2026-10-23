# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (mobile-first PWA, also opened as a Telegram Mini App; primary device is an iPhone)

## Name

The product is **Mnemosyne** (the Greek goddess of memory) everywhere a person sees it: page title, home-screen name, login, settings, the MCP server name in `claude mcp add … mnemosyne`, and the Telegram bot @mnemosyne_cards_bot. The codebase, packages (`@recall/*`), IndexedDB names and API paths keep the internal name `recall`.

## Users

The owner plus a few Telegram accounts the owner let in (they ask from the bot with one button; the owner taps Allow), each with a separate collection. Someone learning English vocabulary (Russian native), on an iPhone held in one hand, in short sessions through the day: in transit, in a queue, before sleep. Words met while reading get added on the same phone, by hand in the app or by messaging the bot. The owner left an earlier flashcard tool because using it was inconvenient, so every daily action has to take the fewest taps, the least waiting and the least thinking.

## Product Purpose

A personal English↔Russian vocabulary trainer on spaced repetition, plus question-and-answer cards (Java Core, Concurrency, Databases… for interview preparation) and grammar rules. Decks are big containers — English, Programming — holding cards of any type, with subjects as tags; one deck is reviewed at a time. The review screen is the product: open, reveal, rate, done, without thinking about the tool. Around it: adding a word in seconds (✨ Claude fills in translations, IPA, examples), dropping the odd card the bot or Claude added that isn't wanted, and seeing the vocabulary grow (an estimate of how many English words one knows).

## Positioning

Words come from three places: typed into the app with autofill, sent to the Telegram bot (a word, a list, a sentence or a photo of a page), or proposed by Claude through the MCP server. Everything added is studied at once (within the deck's new cards per day); Claude's cards carry a `claude` tag, nothing more. A card you don't want is dropped: never shown again, and not proposed again. Scheduling is FSRS (`@recall/core`), works offline, and syncs to one SQLite database on a VPS.

## Operating Context

- Content: a word or phrase (`term`, part of speech, translations, General American IPA, up to five examples with translations, a usage note in Russian, tags such as the source book or article). Two cards per word: EN → RU (recognise) and RU → EN (recall, optionally typed).
- Q&A cards: a question and a Markdown answer (lists, bold, inline and block code, Obsidian `[[wikilinks]]`), one card each, imported from the Obsidian Decks plugin or written in the app, in any deck, tagged by subject. Words only go into a deck with languages.
- Review is per deck: a switcher picks the deck (remembered), and "What to review" narrows it — card types, tags, and for words part of speech, level and direction — with live counts; cards outside wait and use no new-card budget.
- Imported words (from the Obsidian Decks plugin) can have `other` as part of speech and older IPA.
- Used as an installed PWA (standalone, safe areas, no browser chrome) and inside Telegram, which supplies `themeParams`, a native BackButton, haptics and closing confirmation.
- Often offline or on a bad connection: today's queue, the cards and progress are cached on the device (per account); ratings, added words and edits queue locally and upload later.

## Capabilities and Constraints

- Review: tap or Space to reveal; four ratings (Again, Hard, Good, Easy) labelled with the next interval; after reveal, swipe right = Good, left = Hard, down = Again, up = Easy; keys 1–4; undo. Typed answers per deck (RU → EN, or both) with a verdict and a suggested rating. The pencil on a revealed card edits the word (or the fact) and comes back to the same card; ⋯ next to it drops the card. The deck switcher shows what each deck has left today; facts never ask for typed answers.
- The end of a session is never a dead end: what was done (reviewed, again, new, minutes), tomorrow's reviews, this week's study days, the cards missed, then a practice run of the hard cards (it doesn't touch the schedule), +5 new cards for today, another deck that still has work, or adding cards.
- Practice runs (from the session end, or a handbook topic's Practice this) use the same cards; Again brings a card back a few later, and nothing is scheduled or logged. A new account with no words sees "Add your first words" and the bot.
- First run: a new account gets a short wizard instead of the tabs — what the app is, the level (the 3-minute vocabulary test, a pick from A1 to C1, or "not sure"), the starter words for that level (preselected) plus the next level, irregular verbs and the grammar handbook as options, new cards a day (5 / 10 / 20), done. Every step can be skipped. On the first card a one-time hint shows tap-to-flip and the four swipes; the first gesture both works and dismisses it.
- Add word: one field, autofill once typing pauses, Enter adds (even before the draft has arrived: it's added as soon as it does) and the field is ready for the next word; an optional sentence where the word was met picks the sense and becomes the first example; the last tags are remembered; duplicates are caught inline.
- Tags nest with "/" (Grammar/Articles & nouns, Books/<title>): filters show them as a tree where a parent takes everything under it, cards show the leaf with its parent quieter, and a deck's tags can be renamed (the subtree follows, same names merge) or removed in Settings.
- Cards tab: one deck's cards of every type (the same switcher), cached on the device: instant search, type chips (All · Words · Q&A · Grammar), tag, state, status (dropped cards can be found and restored), sort. "+" picks what to add: a word, a question, or a grammar rule (then its exercises). Word editor with both cards' state; the card editor has a Markdown preview, moves a card to another deck, suspends it, shows its state and history, drops or deletes it with Undo, and catches a duplicate question as you type. Edits made offline wait on the device.
- Packs: ready-made cards shipped with the app, added with one tap in Settings → Packs, into the deck you pick (irregular verbs → English). Starter words: one set of common words per level (A1 … C1), added as words into the English deck tagged Starter/<level>, words already there skipped. The first is "Irregular verbs" (159 verbs, most frequent first): the verb and translation, then the past and participle with an example. Irregular verbs among the owner's own words show their forms ("began · begun") on the revealed card.
- Grammar handbook: a public pack of grammar topics (a cheat sheet, theory cards and fifteen exercises each, plus two written tasks), added into a deck; a reading view by group with levels and search, each topic with Practice this; the owner's own rules show under "My rules". "Write a sentence" items are graded by Claude online (corrected sentence + a short explanation in Russian) and skipped offline.
- Grammar practice: a rule (from the owner's notes) is a card whose every review is three fresh exercises from its pool, answered with one thumb and no keyboard: choose the right word for the gap (2–4 big options), or tap the mistake in a sentence and pick its replacement. Feedback is instant (green / red, the right form filled in, one line on why). The rating follows the score (3/3 Good, 2/3 Hard, else Again) and is one tap; "Bad item" takes an exercise out of the pool. Older typed exercises still work until a rule has enough tap ones. Claude can add exercises (MCP), and tops pools up by itself when the server has an API key.
- Claude can make cards from the owner's notes (MCP `add_facts`, the subject as a tag); they are studied at once, tagged `claude`.
- Progress: vocabulary estimate, scale, growth, streaks; a 3-minute vocabulary test; a small per-deck block (cards, known, learning, new, due today, top tags).
- Settings: what's studied daily (per deck: name, new cards per day, and for a deck with languages directions and typed answers; decks created, renamed, merged into another and deleted there; packs) first; reminders; one-time setup (Claude connector, tokens) and scheduling folded away.
- Updates install themselves: a new version applies at the next moment nothing is in progress and says "Updated".
- UI strings are English; card content is English and Russian (Cyrillic) plus IPA glyphs.
- No new runtime dependencies without a clear reason; the app shell is precached by a service worker, so any font must be precached and cover Cyrillic and IPA.
- Scheduling always goes through `@recall/core`; the web app never reimplements FSRS.

## Product Principles

1. The card is the hero; everything else gets out of its way.
2. One thumb reaches every action on the review screen.
3. Nothing the owner reads moves unless it has to: the question stays put when the answer appears.
4. Feedback is immediate and quiet: haptics and short motion, never waiting on choreography.
5. Offline is normal, not an error.
6. Nothing reversible asks for confirmation; it happens at once with Undo. Every screen paints from the device first and refreshes behind.

## Accessibility & Inclusion

Respect `prefers-reduced-motion` (keep fades, drop travel), keep text contrast at WCAG AA, 44 pt minimum touch targets, light and dark themes.
