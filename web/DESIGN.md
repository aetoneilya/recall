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
- **Question** (600, 19px, 1.38): the front of a Q&A card; also question rows in the Cards tab.
- **Body** (400, 17px, 1.5, `text-wrap: pretty`): answers, cloze prose (1.55).
- **Secondary** (400, 15px): extra, list subtitles, tables.
- **Label** (500, 13px): counts, section labels (sentence case, no uppercase eyebrows), card context.
- **Code** (SF Mono 13px / 1.55 in blocks, 0.84em inline).

### Named Rules
**The No-Jump Rule.** A revealed answer is added below the question; the question never re-centres.

## Identity

The name is **Mnemosyne**. The icon is the app's own object: a white index card on the ink-blue field with a second card fanned behind it, and a round-stroked monogram M in the card, legible at 60px. `public/icons/icon.svg` is the source; PNGs (192, 512, maskable 512 with the art inside the 80% safe zone, full-bleed 180px apple-touch-icon) are rendered from it with `sips`.

## Layout

Phone-first single column. 16px side gutters plus safe-area insets (12px on the review screen so the card is as wide as possible). Spacing steps 4 · 8 · 12 · 16 · 24 · 32. Review screen: counts row (40px), deck switcher + filter button (30px), an optional filter summary line, 3px progress, the card fills the rest, then the action row (66px buttons) directly above the tab bar, which sits on the home-indicator inset. Editors keep their primary action in a bottom bar.

Code blocks and tables bleed 10px into the card padding and scroll sideways on their own; the card scrolls vertically.

## Elevation & Depth

Flat tonal layering everywhere except the study card.

- **Card** (`--shadow`: `0 1px 2px` + `0 8px 28px -6px`, warm-tinted in light, deeper in dark): the study card and Show answer.
- **Lift** (`--shadow-lift`): the toast.

## Shapes

Card 20px, panels and grouped lists 14px, buttons and inputs 12px, rating buttons 18px, chips 6px, pills fully round. Separators are 0.5px hairlines.

## Components

- **Rating bar:** four equal 66px buttons, tinted fill + same-hue label and interval, tabular numerals. Press: scale 0.95 with a deeper fill. While a swipe is in progress, the button it would commit lights up (scale 1.04, deeper fill). The bar and the swipe pill share one set of interval labels (FSRS fuzz depends on the moment, so they're computed once per card).
- **Show answer:** full-width 66px card-coloured button with the card's shadow, a 66px undo square beside it.
- **Card corner:** once the answer shows, two faint 44px targets at the card's top-right — ⋯ (20px dots) and the 18px pencil (the context row keeps 92px clear, so nothing shifts on reveal); pressed, accent on accent-soft. The pencil opens the editor; Back returns to the same revealed card with the fix applied. ⋯ opens a small card-coloured menu under it (14px radius, soft shadow) with one row: an again-coloured × and "Drop" over "Never show this card again" in muted 12.5px. Dropping is rare, so it stays out of the way.
- **Session summary:** the check, a row of four tabular numbers (reviewed · again · new · min, 22/650 with 12px captions, no tiles), a muted 15px line when cards still wait today ("3 cards come back in ~5 min", no icon, nothing to tap), the clock line ("Tomorrow: N reviews"), seven 8px week dots (accent for days studied), "N you missed" as a short grouped list, then calm rows: Go over them once more / Practice hard cards (with "Doesn't change the schedule" in faint), +5 new cards today, the other decks with work ("Programming · 6 cards"), Add — and the Undo / Check for more buttons. It scrolls when long.
- **Practice:** the same card and stack, an accent line "Practice — doesn't change the schedule" under the title, two big buttons (Again in the again tint, Got it in the good tint) and "N left".
- **No waiting screen:** when only cards that aren't showable yet are left (learning steps, the minimum gap), the session ends on the summary as above, with its "come back" line; nothing to wait in front of and no way to pull a card early. The minutes tick every 15 s, and if the app stays open the card simply appears when it's ready.
- **Handbook:** topics as grouped rows with a level chip, section labels per group, "My rules" last; a topic page is the summary on a card-coloured panel, a primary "Practice this", then theory cards as rows that open in place.
- **Card back (words):** the main translation, then one example on a paper-shade panel (10px radius, 15px, the word in 600), then a faint "+2 examples · note" row that opens the rest in place. A collection with no words yet gets "Add your first words" instead: an accent-soft disc with the sparkle, one primary "Add a word" button and a row for the Telegram bot.
- **Cloze marks:** front blank is an accent-soft pill with a 1px accent ring showing the hint or "…" (inline, so punctuation stays attached; the card scrolls to it). Back answer is accent text on accent-soft.
- **Wikilinks:** `[[x|alias]]` on a fact renders as the alias in muted italic, not as a link.
- **Context row:** direction (word) or deck name (fact), 600 · tags · New pill, 13px muted.
- **Fact card:** the question in the Question style, left-aligned, 12% down; the answer is body text under the divider. Code blocks: SF Mono 13px on paper shade, 10px radius, scrolling sideways; inline code 0.84em on paper shade.
- **Cards tab:** large title "Cards" with the count, the deck switcher, the search field, then type chips (30px, All · Words · Q&A · Grammar with counts in faint 600; the selected one accent on accent-soft; only types the deck has), then the filter picks. Word rows as before; a question row: the question (600, two lines, inline Markdown), then the card state in its colour · tags, the state dot on the right; a grammar rule adds "Grammar · N exercises" in accent before the state. A dropped card has a "dropped" chip in the again colour. The tab bar has four tabs: Review · Cards · Progress · Settings.
- **Fact editor:** an Edit · Preview mini segment (28px) beside the Answer label; the preview is the card's Markdown on a card-coloured panel. A duplicate question shows as a hard-tinted strip under the field with Open.
- **Deck switcher (Review, Cards):** a compact "English 23 ▾" (17/650, the count faint, a 14px chevron that turns), 40px tall; it opens a small popover under it (card surface, 14px radius, soft shadow, 160ms pop) with 44px rows: a check for the current deck, the name, new · learning · due in their colours. A single deck shows just its name.
- **Filter chips (Review):** after the switcher, one line that scrolls sideways: accent-soft 32px chips with the value and a ✕ (44px hit areas), a Clear chip on the surface when more than one, and a small Filter button (icon + "Filter" when nothing is set).
- **Card undo:** ↶ at the card's top-left, 17px in a 44px target, faint, only while there is something to undo; the context row moves over for it.
- **What to review (sheet):** the deck and today's count for the draft, then labelled rows of 36px chips (Cards, Tags, and for words Part of speech, Level, Direction) with counts; selected chips accent-filled. Nothing selected in a row means all of it; picks in a row add up (any of them), the row's other chips stay; tags narrow. Clear · Cancel · Done.
- **Tag tree:** rows of 44px on the surface panel, indented 22px per level; a chevron (rotates 90° open) before a tag with children; a 22px rounded box — accent with a white check when on, accent-soft with a dash when mixed, a hairline ring when off; the count in faint 600 at the right. A "Find a tag" field above it once there are more than eight tags. On cards a nested tag reads "Grammar › Articles & nouns" with the parent quieter.
- **Sheets:** the handle and title drag the sheet down (the content too when it is at its top); it resists upward pulls; let go past 30% or with a downward flick it leaves on the throw curve (flicked back up, it stays; held still before letting go, no flick), otherwise it springs back on the drawer curve; the scrim fades with the distance.
- **Add type switch:** a segmented control at the top of the add screens, Word · Question · Grammar rule (Word only in a deck with languages), 40px segments; it replaces the screen in place and is remembered.
- **Editors' foot:** Drop (or Restore) and Delete side by side, then one faint line saying what each does.
- **Grouped list rows:** 52px min, inset hairlines, pressed state is the shade fill (not opacity).
- **Buttons:** primary = accent fill; secondary = paper shade; danger = again-coloured text. Press = scale 0.97.
- **Segmented control, stepper, switch:** iOS shapes; selected segment is the card colour with a soft shadow; a switch that is on is the accent (never a rating hue). Targets are at least 40px; small pills keep their look with a 44px hit area.
- **Card corner:** ⋯ and ✎, two faint 44px targets; the ⋯ menu holds Read the theory (grammar cards) and Drop.
- **Tables (Markdown):** like code blocks, they bleed 10px and scroll sideways; header cells on paper shade, hairline rows.
- **Empty / error states:** a 40px line icon, a bold one-line title, one sentence that teaches the place, and the next action.
- **Loading:** skeleton blocks in the shape of the content (pulse 1.1s), never a centred spinner.
- **Toast:** ink pill at the top safe area, drops in 16px and leaves the same way. "Updated" after the app has updated itself.
- **First-run wizard** (a new account, instead of the tabs): one short screen per step on the paper background, no card and no shadow. A 48px top row: Back (accent chevron, only once there is a step behind) · five 6px step dots (accent up to the current one) · a muted "Skip" (not on the last step). The screen's 28/700 heading, a muted line or two, then grouped rows as in Settings: the test as a row with a chevron, the levels as 52px radio rows ("A1  Beginner", a 600 tabular level, an accent check on the chosen one, "Your test result" in accent under the one the test gave), packs as checkbox rows with the tag tree's 22px box. New cards a day is the Settings segmented control at 44px. The primary action sits at the foot as a full-width accent button (Get started · Continue · Start learning). Each step fades up 6px in 240ms (reduced motion: a fade); no mascots, illustrations or carousels — the only marks are an accent-soft disc with an icon on the first and last steps.
- **Gesture coach** (once, on the first review card after the wizard): the card is covered by a paper-coloured scrim at 82%, centred: "Tap the card to flip it" in the Question style, the four directions in a 2 × 2 grid of 17/500 labels with accent arrows (→ Good, ← Hard, ↓ Again, ↑ Easy), and one muted line. It fades in over 240ms, takes no touches, and is gone at the first tap, press or rating.
- **Starter words (Settings):** their own grouped list under Packs, one compact row per level ("A1 Beginner · 900 words") with Add / Added, and a single caption; the levels are never mixed into the packs list.
- **Disclosures in Settings:** one-time setup (Connect Claude) and scheduling (Advanced) are single grouped rows with a chevron that turns; the daily settings stay above them.

## Motion

Curves: `--ease-out` cubic-bezier(0.23, 1, 0.32, 1) for entrances and presses; `--ease-drawer` cubic-bezier(0.32, 0.72, 0, 1) for things let go of (swipe snap-back, pushed screens). Durations: press 140ms, fast 180ms, base 240ms, slow 320ms. Only `transform` and `opacity` animate (plus colour fades).

- **Reveal** (hundreds a day): the answer rises 5px and fades in over 180ms; the divider draws out from the centre; on a cloze only the deletion lights up in place.
- **Next card:** already drawn under the top card (see The stack); once on top it steps up from where its preview was, at once, 240ms `--ease-out` (from its place: nothing moves). Without a preview (the first card, after an undo or a deck switch) it rises from the stacked pose.
- **Press:** a finger down on the card lifts it — scale 1.02, translateY −2px over 120ms `--ease-out` — and a pre-rendered deeper shadow layer (`--shadow-lift`) fades in over it; box-shadow itself never animates. Let go without a drag: back in 160ms on the drawer curve. A drag starts from the lifted pose and eases into its own (scale → 1 sideways, → 0.985 vertically, in between on a diagonal, the 2px rise → 0, all by the threshold), so there is no jump. No haptic on press: the tap already reveals.
- **Peek and throw** (plain word and fact cards): on a card not revealed yet, a drag past 8px or a hold of 150ms reveals it under the finger — the same reveal, played at 110ms — and the card keeps following the finger. Past the threshold it rates as usual; released near the centre it stays revealed. Nothing arms until the answer has been visible 300ms: no haptic, no pill, no direction label before that, and a throw that early springs back (revealed). Typed answers and exercise cards keep tap-to-reveal only.
- **Swipe (after reveal):** right = Good, left = Hard, down = Again, up = Easy. No axis lock: past 12px the card follows the finger 1:1 in 2D until it lets go, and the rating is the dominant direction of where it ends up (a drag that starts down and ends right is Good). It tilts 0.06°/px of horizontal offset (max 8°) around a point 10% below the card when grabbed in its lower half (above it when grabbed high) and lifts toward scale 0.985 with its vertical progress — a diagonal does both. A wash of the dominant direction's colour grows from the edge it leaves by, and a pill in that colour shows the rating and its interval with a bar filling to that axis's commit threshold (28% of the width / 18% of the height, max 110px). Crossing it ticks the haptic and pops the pill; it disarms only under 85% of the threshold (swinging to another direction arms afresh), and let go while armed it commits (what the pill shows is what happens). A flick needs the finger still moving in its last 80 ms: a drag held before letting go only counts its distance. Released short, the card settles back in clamp(180 + 0.8·|d|, 200, 320)ms on the drawer curve (a new touch continues from where it is). Committed, it is **thrown** the way it was rated (the other axis keeps its offset): off the stage + 40px in clamp(2·D/v, 160, 260)ms on `--ease-throw` `cubic-bezier(0.3, 0.6, 0.5, 1)` (its starting slope 2 matches the release speed v, at least 1.2px/ms), the tilt carrying on to 1.4×, opacity kept at 1. The rating is recorded at the start of the throw.
- **Rating buttons throw too**, the way their swipe would (Good →, Hard ←, Again ↓, Easy ↑ — the glyph sits in each label, 11px), from rest at 1.6px/ms, with a 0.1 wash of the rating's colour gone by 200ms.
- **The stack:** under the card, the next card itself, fully readable (its front: context row and prompt; an exercise or typed card's first screen, inert), 5px down at scale 0.97, opacity 1. While the top card is dragged it eases up to its place in proportion to the drag (0 → threshold: 5px → 0, 0.97 → 1), through one transform on one element; on a spring-back it returns with the top card (240ms drawer curve). The card after it is only the faint hairline edge (10px down, 0.94). When the next card isn't known (waiting cards, the last card), the edges stand in as before: card-coloured with a hairline, no shadow (5px / 10px down, 0.97 / 0.94), two with three or more left, one with two, none on the last.
- **Tap exercises:** a tap answers. Right: good fill and ring, a check drawing itself (200ms), on to the next item after 450ms. Wrong: again fill with one nudge (0, −4, 4, −2, 0px over 240ms), the right row's check, and the verdict rising 24px with Continue. When the card's content scrolls, vertical drags scroll it; a vertical swipe only starts at an edge moving outward (down from the top, up from the bottom), so scrolling into an edge never rates. That is decided once, when the finger leaves the 12px slop: a scroll stays a scroll, a card drag stays free in 2D. A small legend (← Hard · → Good · ↓ Again · ↑ Easy) sits at the card's foot for the first five swipes, in its own 34px strip: the card's content scrolls above it, never under it.
- **Screens:** pushed screens slide in 28px from the right, popped ones from the left, 320ms drawer curve. Tab switches are instant.
- **Session end:** the check draws itself once (420ms), the app's one celebratory moment.
- **Reduced motion:** the drag still follows the finger; a commit fades the card out (120ms) and the next one in (150ms); snap-back is 120ms linear; the wrong-answer nudge and the strip's travel go (colours still change); the press lift keeps only its shadow fade, and the next card sits still in its stacked pose.
- **Haptics:** arming a swipe `selectionChanged`; a rating `light` (Again `rigid`); right / wrong answers `success` / `error`; Undo `soft`; Delete `medium`; deck and segment switches `selectionChanged`; the session's end `success`, once.
- **Reduced motion:** `--rise`, `--shrink` and `--push` go to zero, so every entrance becomes a plain fade; the check appears without drawing.

## Do's and Don'ts

- Do keep the question where it is when the answer appears.
- Do take colour from tokens; in Telegram, `themeParams` override `--bg`, `--surface`, `--text`, `--muted`, `--accent`, `--accent-text`, `--link` and everything derived follows.
- Don't add a second typeface, uppercase eyebrows, gradient text or decorative motion.
- Don't animate the rating bar or tab switches; they're too frequent.
- Don't use rating colours outside rating meaning.
