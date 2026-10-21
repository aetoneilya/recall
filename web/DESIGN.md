---
name: Mnemosyne
description: A calm, one-handed study tool where the card is the hero.
colors:
  paper: "#f4f3ef"
  card: "#ffffff"
  paper-shade: "#ebeae5"
  ink: "#1b1b1d"
  ink-muted: "#68686e"
  ink-faint: "#8c8c92"
  ink-blue: "#36559a"
  again: "#b3362d"
  hard: "#8f5c0c"
  good: "#1d7046"
  easy: "#2b5fae"
  night: "#131416"
  night-card: "#1e1f22"
  night-shade: "#2b2c30"
  night-ink: "#ededef"
  night-ink-muted: "#9d9da3"
  night-blue: "#8ea8e8"
typography:
  vocab-word: { fontFamily: "system-ui (SF Pro)", fontSize: 34px, fontWeight: 600, lineHeight: 1.15, letterSpacing: -0.022em }
  vocab-answer: { fontFamily: "system-ui (SF Pro)", fontSize: 23px, fontWeight: 400, lineHeight: 1.32 }
  screen-title: { fontFamily: "system-ui (SF Pro)", fontSize: 30px, fontWeight: 700, lineHeight: 1.12, letterSpacing: -0.025em }
  question: { fontFamily: "system-ui (SF Pro)", fontSize: 19px, fontWeight: 600, lineHeight: 1.38, letterSpacing: -0.012em }
  body: { fontFamily: "system-ui (SF Pro)", fontSize: 17px, fontWeight: 400, lineHeight: 1.5 }
  secondary: { fontFamily: "system-ui (SF Pro)", fontSize: 15px, fontWeight: 400, lineHeight: 1.45 }
  label: { fontFamily: "system-ui (SF Pro)", fontSize: 13px, fontWeight: 500, lineHeight: 1.4 }
  code: { fontFamily: "ui-monospace (SF Mono)", fontSize: 13px, fontWeight: 400, lineHeight: 1.55 }
rounded:
  card: 20px
  panel: 14px
  control: 12px
  chip: 6px
spacing:
  s1: 4px
  s2: 8px
  s3: 12px
  s4: 16px
  s5: 24px
  s6: 32px
---

# Design System: Mnemosyne

## Overview

**Creative North Star: "The index card on a quiet desk"**

Warm paper in the light theme, deep graphite at night, and one white (or charcoal) card that carries all the attention. Chrome recedes to hairlines and muted grey; colour appears only where it means something: the accent for the current place and primary action, and the four rating hues for the decision the owner makes a few hundred times a day.

The app is Operate-mode: familiar iOS patterns (large titles, grouped inset lists, segmented controls, a bottom tab bar), system fonts, and no decorative motion. Character lives in the precise details: the vocabulary word that doesn't jump when its translation appears, the pronunciation set under the English word like a dictionary entry, the cloze blank that lights up in place.

**Key characteristics**

- The card is the only elevated surface on the review screen; everything else is flat.
- One family (SF Pro via the system stack). Hierarchy by size and weight, never by a second face.
- Rating colours are semantic and fixed across themes; the accent follows Telegram's `button_color`.
- Motion is short, ease-out and interruptible; nothing plays on app load.

## Colors

Restrained: warm neutrals plus one ink-blue accent; the rating hues are the only saturated colours and only appear on the rating bar, swipe feedback and stats.

### Primary
- **Ink blue** (`--accent`, #36559a light / #8ea8e8 dark): active tab, primary buttons, focus rings, the cloze blank and revealed answer, progress fill. In Telegram it becomes `button_color`.
- **Accent soft** (`--accent-soft`, 13–18% accent over the card colour): fills behind cloze marks, selection. Derived with `color-mix`, so it follows any accent.

### Rating semantics
- **Again** #b3362d / #f28b82 on #f8e5e2 / #3b2523
- **Hard** #8f5c0c / #e6b866 on #f5ecd9 / #382f1f
- **Good** #1d7046 / #74d29d on #dff0e5 / #1f3529
- **Easy** #2b5fae / #88b2f2 on #e1eaf7 / #1f2c3f

Each text colour holds ≥4.8:1 on its own fill. New / learning / review counts reuse easy / again / good (Anki's convention).

### Neutral
- **Paper** (`--bg`, #f4f3ef / #131416): app background, matches `theme-color` and the manifest.
- **Card** (`--surface`, #fff / #1e1f22): cards, grouped lists, tab bar.
- **Paper shade** (`--surface-2`, #ebeae5 / #2b2c30): secondary buttons, chips, segmented track, skeletons.
- **Ink / muted / faint** (`--text`, `--muted`, `--faint`): body, secondary text (≥5:1), tertiary metadata only.
- **Hairline** (`--hairline`, 12% / 10% alpha): 0.5px separators, inset 16px from the left like iOS lists.

### Named Rules
**The One Elevation Rule.** Only the study card (and the Show answer button that belongs to it) casts a shadow on the review screen. Lists and panels are flat tonal surfaces.

**The Meaning-Only Colour Rule.** Rating hues never decorate. If it's green, it means Good.

## Typography

**Font:** the system stack (`-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, …`); mono is `ui-monospace` (SF Mono). No webfont: SF Pro covers Latin, Cyrillic and the IPA glyphs used in pronunciations (ˌ ˈ ə ɒ ʊ ð θ ː), costs nothing offline and follows the platform.

### Hierarchy
- **Vocab word** (600, 34px, 1.15, −0.022em, balanced): the front of a short card, centred, set at 24% of the card height so it doesn't move on reveal.
- **Vocab answer** (400, 23px, 1.32, balanced): the translation.
- **Pronunciation** (400, 17px / 16px under a reversed answer, muted, +0.01em): pulled from an `IPA:` line in `extra` and set under the English word.
- **Screen title** (700, 30px, −0.025em): iOS large-title role on top-level screens; 22px on pushed screens.
- **Question** (600, 19px, 1.38): the front of a Q&A card; also note titles in lists and the inbox.
- **Body** (400, 17px, 1.5, `text-wrap: pretty`): answers, cloze prose (1.55).
- **Secondary** (400, 15px): extra, list subtitles, tables.
- **Label** (500, 13px): counts, section labels (sentence case, no uppercase eyebrows), card context.
- **Code** (SF Mono 13px / 1.55 in blocks, 0.84em inline).

### Named Rules
**The No-Jump Rule.** A revealed answer is added below the question; the question never re-centres.

## Identity

The name is **Mnemosyne**. The icon is the app's own object: a white index card on the ink-blue field with a second card fanned behind it, and a round-stroked monogram M in the card, legible at 60px. `public/icons/icon.svg` is the source; PNGs (192, 512, maskable 512 with the art inside the 80% safe zone, full-bleed 180px apple-touch-icon) are rendered from it with `sips`.

## Layout

Phone-first single column. 16px side gutters plus safe-area insets (12px on the review screen so the card is as wide as possible). Spacing steps 4 · 8 · 12 · 16 · 24 · 32. Review screen: counts row (40px), deck chips (30px, only with several decks) + 3px progress, the card fills the rest, then the action row (66px buttons) directly above the tab bar, which sits on the home-indicator inset. Inbox: filter chips, a stacked deck of cards with two peeking 9px below, round reject / edit / approve buttons, then Approve all. Editors keep their primary action in a bottom bar.

Code blocks and tables bleed 10px into the card padding and scroll sideways on their own; the card scrolls vertically.

## Elevation & Depth

Flat tonal layering everywhere except the study card.

- **Card** (`--shadow`: `0 1px 2px` + `0 8px 28px -6px`, warm-tinted in light, deeper in dark): the study card, inbox top card, Show answer, inbox round buttons.
- **Lift** (`--shadow-lift`): the toast.

## Shapes

Card 20px, panels and grouped lists 14px, buttons and inputs 12px, rating buttons 18px, chips 6px, pills fully round. Separators are 0.5px hairlines.

## Components

- **Rating bar:** four equal 66px buttons, tinted fill + same-hue label and interval, tabular numerals. Press: scale 0.95 with a deeper fill. While a swipe is in progress, the button it would commit lights up (scale 1.04, deeper fill). The bar and the swipe pill share one set of interval labels (FSRS fuzz depends on the moment, so they're computed once per card).
- **Show answer:** full-width 66px card-coloured button with the card's shadow, a 66px undo square beside it.
- **Edit on the card:** once the answer shows, a faint 18px pencil in a 44px target at the card's top-right corner (the context row keeps 48px clear for it, so nothing shifts on reveal); pressed, accent on accent-soft. It opens the word's editor; Back returns to the same revealed card with the fix applied.
- **Session summary:** the check, the tally, a clock line ("Tomorrow: N reviews", or learning cards back in N min), then a grouped list of next steps (Vet N new words in the inbox · Add words) and the Undo / Check for more buttons. A collection with no words yet gets "Add your first words" instead: an accent-soft disc with the sparkle, one primary "Add a word" button and a row for the Telegram bot.
- **Cloze marks:** front blank is an accent-soft pill with a 1px accent ring showing the hint or "…" (inline, so punctuation stays attached; the card scrolls to it). Back answer is accent text on accent-soft.
- **Wikilinks:** `[[x|alias]]` on a fact renders as the alias in muted italic, not as a link.
- **Context row:** direction (word) or deck name (fact), 600 · tags · New pill, 13px muted.
- **Fact card:** the question in the Question style, left-aligned, 12% down; the answer is body text under the divider. Code blocks: SF Mono 13px on paper shade, 10px radius, scrolling sideways; inline code 0.84em on paper shade.
- **Library switch (Words tab):** an iOS segmented control "Words · Topics" (32px segments on paper shade, the selected one card-coloured with a soft shadow) between the large title and the search field; only once a topic deck exists. The tab bar stays at five tabs.
- **Topic list rows:** the question (600, two lines, inline Markdown), then the card state in its colour · tags, the state dot on the right; sections per topic with the topic name as a 600 section label.
- **Fact editor:** an Edit · Preview mini segment (28px) beside the Answer label; the preview is the card's Markdown on a card-coloured panel. A duplicate question shows as a hard-tinted strip under the field with Open.
- **Deck chips (Review):** a scrolling row under the counts, 30px pills, name + count in 650. In the session: accent text on accent-soft; out of it: faint text in a hairline ring. Tap toggles at once (select haptic). Hidden with a single deck.
- **Grouped list rows:** 52px min, inset hairlines, pressed state is the shade fill (not opacity).
- **Buttons:** primary = accent fill; secondary = paper shade; danger = again-coloured text. Press = scale 0.97.
- **Segmented control, stepper, switch:** iOS shapes; selected segment is the card colour with a soft shadow.
- **Empty / error states:** a 40px line icon, a bold one-line title, one sentence that teaches the place, and the next action.
- **Loading:** skeleton blocks in the shape of the content (pulse 1.1s), never a centred spinner.
- **Toast:** ink pill at the top safe area, drops in 16px and leaves the same way. "Updated" after the app has updated itself.
- **Disclosures in Settings:** one-time setup (Connect Claude) and scheduling (Advanced) are single grouped rows with a chevron that turns; the daily settings stay above them.

## Motion

Curves: `--ease-out` cubic-bezier(0.23, 1, 0.32, 1) for entrances and presses; `--ease-drawer` cubic-bezier(0.32, 0.72, 0, 1) for things let go of (swipe snap-back, pushed screens). Durations: press 140ms, fast 180ms, base 240ms, slow 320ms. Only `transform` and `opacity` animate (plus colour fades).

- **Reveal** (hundreds a day): the answer rises 5px and fades in over 180ms; the divider draws out from the centre; on a cloze only the deletion lights up in place.
- **Next card:** rises 10px from 97.5% scale over 240ms.
- **Swipe (after reveal):** right = Good, left = Hard, down = Again, up = Easy. The axis locks after 12px (dominant direction wins). The card follows the finger 1:1 (sideways with a slight rotation), a wash of the rating's colour grows from the edge it leaves by, and a pill in that colour shows the rating and its interval with a bar filling to the commit threshold (28% of the width / 18% of the height, max 110px). Crossing it ticks the haptic and pops the pill; the matching rating button lights up. Released short of it, the card settles back over 320ms on the drawer curve; committed, it flies out the way it was going over 240ms. When the card's content scrolls, vertical drags scroll it; a vertical swipe only starts at an edge moving outward (down from the top, up from the bottom), so scrolling into an edge never rates. A small legend (← Hard · → Good · ↓ Again · ↑ Easy) sits at the card's foot for the first five swipes.
- **Inbox stack:** the next proposal steps up from its peeking position; the round button for the swipe direction grows and tints.
- **Screens:** pushed screens slide in 28px from the right, popped ones from the left, 320ms drawer curve. Tab switches are instant.
- **Session end:** the check draws itself once (420ms), the app's one celebratory moment.
- **Reduced motion:** `--rise`, `--shrink` and `--push` go to zero, so every entrance becomes a plain fade; the check appears without drawing.

## Do's and Don'ts

- Do keep the question where it is when the answer appears.
- Do take colour from tokens; in Telegram, `themeParams` override `--bg`, `--surface`, `--text`, `--muted`, `--accent`, `--accent-text`, `--link` and everything derived follows.
- Don't add a second typeface, uppercase eyebrows, gradient text or decorative motion.
- Don't animate the rating bar or tab switches; they're too frequent.
- Don't use rating colours outside rating meaning.
