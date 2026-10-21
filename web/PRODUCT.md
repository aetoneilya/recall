# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (mobile-first PWA, also opened as a Telegram Mini App; primary device is an iPhone)

## Name

The product is **Mnemosyne** (the Greek goddess of memory) everywhere a person sees it: page title, home-screen name, login, settings, the MCP server name in `claude mcp add … mnemosyne`, and the Telegram bot @mnemosyne_cards_bot. The codebase, packages (`@recall/*`), IndexedDB names and API paths keep the internal name `recall`.

## Users

One person, the owner. Reviews on an iPhone held in one hand, in short sessions through the day: in transit, in a queue, before sleep. Also adds and vets notes, usually on the same phone. Has used Anki-style apps before and left an Obsidian flashcard plugin because reviewing in it was inconvenient.

## Product Purpose

Mnemosyne is a personal spaced-repetition system. The review screen is the product: the owner spends about 95% of their time there. Success is that reviewing feels effortless enough to do every day: open, tap, rate, done, without friction or thinking about the tool.

## Positioning

Notes are written mostly by Claude through an MCP server and land in an inbox for the owner to vet; the app is where they're approved and studied. Scheduling is FSRS (`@recall/core`), works offline, and syncs to a single SQLite database on the owner's VPS.

## Operating Context

- Content: English↔Russian vocabulary (word / translation, IPA in `extra`, a tag naming the source book or article); Java and distributed-systems interview Q&A with inline code, code blocks and tables; long cloze texts about English grammar (one note, many deletions, mixed English and Russian).
- Imported notes come from the Obsidian Decks plugin and can still contain `[[wikilinks]]` and "Header: value" lines in `extra`.
- Used as an installed PWA (standalone, safe areas, no browser chrome) and inside Telegram, which supplies `themeParams`, a native BackButton and haptics.
- Often offline or on a bad connection; ratings queue locally and upload later.

## Capabilities and Constraints

- Review: tap or Space to reveal; four ratings (Again, Hard, Good, Easy) labelled with the next interval; after reveal, swipe right = Good, left = Hard, down = Again, up = Easy; keys 1–4; undo.
- Inbox: Claude's proposals as a swipeable stack (right approve, left reject), edit, approve all.
- Login and Settings will gain Telegram login and personal tokens (multi-user work in progress on the server); their flows belong to that work, design passes there are visual only.
- Browse decks and notes with search; note editor with live card previews; stats; settings.
- UI strings are English; card content is English and Russian (Cyrillic) plus IPA glyphs.
- No new runtime dependencies without a clear reason; the app shell is precached by a service worker, so any font must be precached and cover Cyrillic and IPA.
- Scheduling always goes through `@recall/core`; the web app never reimplements FSRS.

## Product Principles

1. The card is the hero; everything else gets out of its way.
2. One thumb reaches every action on the review screen.
3. Nothing the owner reads moves unless it has to: the question stays put when the answer appears.
4. Feedback is immediate and quiet: haptics and short motion, never waiting on choreography.
5. Offline is normal, not an error.

## Accessibility & Inclusion

Respect `prefers-reduced-motion` (keep fades, drop travel), keep text contrast at WCAG AA, 44 pt minimum touch targets, light and dark themes.
