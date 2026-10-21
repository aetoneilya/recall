# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (mobile-first PWA, also opened as a Telegram Mini App; primary device is an iPhone)

## Name

The product is **Mnemosyne** (the Greek goddess of memory) everywhere a person sees it: page title, home-screen name, login, settings, the MCP server name in `claude mcp add … mnemosyne`, and the Telegram bot @mnemosyne_cards_bot. The codebase, packages (`@recall/*`), IndexedDB names and API paths keep the internal name `recall`.

## Users

The owner plus a few invited Telegram accounts, each with a separate collection. Someone learning English vocabulary (Russian native), on an iPhone held in one hand, in short sessions through the day: in transit, in a queue, before sleep. Words met while reading get added on the same phone, by hand in the app or by messaging the bot. The owner left an earlier flashcard tool because using it was inconvenient, so every daily action has to take the fewest taps, the least waiting and the least thinking.

## Product Purpose

A personal English↔Russian vocabulary trainer on spaced repetition, plus topic decks of question-and-answer cards (Java Core, Concurrency, Databases… for interview preparation) studied in the same session. The review screen is the product: open, reveal, rate, done, without thinking about the tool. Around it: adding a word in seconds (✨ Claude fills in translations, IPA, examples), vetting words the bot or Claude proposed, and seeing the vocabulary grow (an estimate of how many English words one knows).

## Positioning

Words come from three places: typed into the app with autofill, sent to the Telegram bot (a word, a list, a sentence or a photo of a page), or proposed by Claude through the MCP server. Proposals land in an inbox; the app is where they're vetted and studied. Scheduling is FSRS (`@recall/core`), works offline, and syncs to one SQLite database on a VPS.

## Operating Context

- Content: a word or phrase (`term`, part of speech, translations, General American IPA, up to five examples with translations, a usage note in Russian, tags such as the source book or article). Two cards per word: EN → RU (recognise) and RU → EN (recall, optionally typed).
- Topic decks: a question and a Markdown answer (lists, bold, inline and block code, Obsidian `[[wikilinks]]`), one card each, imported from the Obsidian Decks plugin or written in the app. Which decks are in today's review is a tap on their chip.
- Imported words (from the Obsidian Decks plugin) can have `other` as part of speech and older IPA.
- Used as an installed PWA (standalone, safe areas, no browser chrome) and inside Telegram, which supplies `themeParams`, a native BackButton, haptics and closing confirmation.
- Often offline or on a bad connection: today's queue, the word list and progress are cached on the device; ratings and added words queue locally and upload later.

## Capabilities and Constraints

- Review: tap or Space to reveal; four ratings (Again, Hard, Good, Easy) labelled with the next interval; after reveal, swipe right = Good, left = Hard, down = Again, up = Easy; keys 1–4; undo. Typed answers per deck (RU → EN, or both) with a verdict and a suggested rating. The pencil on a revealed card edits the word (or the fact) and comes back to the same card. Deck chips on the review screen turn a deck in or out of the session, with what each has left today; facts never ask for typed answers.
- The end of a session says what's next: tomorrow's reviews, the inbox, adding words. A new account with no words sees "Add your first words" and the bot.
- Add word: one field, autofill once typing pauses, Enter adds (even before the draft has arrived: it's added as soon as it does) and the field is ready for the next word; an optional sentence where the word was met picks the sense and becomes the first example; the last tags are remembered; duplicates are caught inline.
- Inbox: proposals as a swipeable stack (right approve, left reject), edit, approve all; paints from the device's copy.
- Words: the whole collection cached on the device, instant search and filters. Word editor with both cards' state.
- Progress: vocabulary estimate, scale, growth, streaks; a 3-minute vocabulary test.
- Settings: what's studied daily (directions, new words per day, typed answers; per topic: in review, new per day) first; reminders; one-time setup (Claude connector, tokens) and scheduling folded away.
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
