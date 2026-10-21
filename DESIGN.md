# recall — design

Personal vocabulary trainer (English ↔ Russian for now) on spaced repetition. Words live in one SQLite database on a VPS. I review on an iPhone through a web app (installable PWA, also opens as a Telegram Mini App), add words by hand with an ✨ AI autofill, or have Claude propose them through a remote MCP server. A vocabulary-size estimate (a periodic Yes/No test, adjusted continuously by the words known in the app) shows where I stand. A few users — the owner plus Telegram accounts on an allowlist — each with a fully separate collection.

## Layout

```
packages/core   shared TS: types (Word, Deck, Card…), FSRS wrapper (ts-fsrs), word → card faces, dedupe key, study-day math, typed-answer check. Source of truth for shapes.
server          Node 24 + Express 5 + node:sqlite. REST API, MCP endpoint, OAuth, Telegram bot, autofill (Anthropic SDK), vocabulary test, Decks importer.
server/data     en-freq.tsv, vocab-test.json, vocab-scale.json (+ README.md, build scripts) — static data, all optional at runtime.
web             Svelte 5 + Vite. Review (typed answers), add word with autofill, word list, inbox, dashboard, vocabulary test. PWA + Telegram Mini App.
deploy          Caddyfile. Root Dockerfile + docker-compose.yml build one image serving web + API + MCP.
```

npm workspaces; `@recall/core` is imported as TS source (`exports: ./src/index.ts`). The server runs TS directly with Node's type stripping (`node --experimental-strip-types` is default in Node 24 — use `.ts` import specifiers, no enums/namespaces/parameter properties). Web bundles it through Vite.

On this machine npm and fetches go through a corporate proxy that breaks the public registry: run npm as `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy npm …`. `.npmrc` pins the public registry.

## Model

- **user** — a Telegram account: `telegramId`, `name` (Telegram first name), `timeZone`, `reminderTime`, `eveningReminderTime` (null = off). Defaults come from `TZ_NAME` / `REMINDER_TIME` / `EVENING_REMINDER_TIME` at creation; each user changes their own via `PATCH /api/me`. A row is created on the first successful sign-in. Who may sign in is configuration, not data: `OWNER_TELEGRAM_ID` (the admin) plus `ALLOW_USER_IDS`; anyone else is refused everywhere, and a user dropped from the list loses access with all their sessions and tokens.
- Every deck, word, card, review, vocabulary test and autofill counter belongs to exactly one user (decks, words and tests carry `user_id`; cards and logs through their word). Every query is scoped by the authenticated user, including by-id lookups: another user's id behaves exactly like an unknown id (404, skipped review), never 403. Dedupe is per user.
- **deck** — one per language per user: `name` ("English"), `targetLang` / `nativeLang` (ISO 639-1, `en` / `ru`; unique per user by `targetLang`), `newPerDay` (default 15), `forwardEnabled` / `reverseEnabled` (at least one on), `reverseAfterDays` (null = off). The user's English deck is created on first use (`GET /api/decks`, adding a word, MCP). Grouping by book or topic goes into a word's `tags`, not into decks.
- **word** (`core/types.ts` `Word`) — `term` (base form as given: "to frown", "a far cry from"), `pos` (`noun | verb | adjective | adverb | phrasal_verb | idiom | phrase | preposition | conjunction | pronoun | interjection | other`), `translations` (≥ 1, main first), `ipa` (stored without slashes, General American from autofill; imported words keep whatever the source had), `examples` (≤ 5 × `{text, translation | null}`), `note` (usage, register, collocations — in the native language), `tags` (book / article / topic), `freqRank`, `cefr` (`A1…C2` | null), `status` (`inbox | active | rejected`), `createdBy` (`user | claude | import`). Manual words are `active` at once; Claude's land in `inbox` unless `autoApprove`. Validation and cleaning: `core.cleanWord` (trims, dedupes translations/tags, strips IPA delimiters, limits in `core.LIMITS`).
- **Dedupe key** = deck + `core.dedupeKey(term, pos)`: the term lowercased, spaces collapsed, a leading "to " dropped, plus the part of speech — "to frown" and "Frown" (verbs) are one word, "frown" the noun is another. Enforced by a unique index; a duplicate add returns the existing word (REST `409 {error, existing}`; MCP lists it under `duplicates` with what differs). Rejected words count, so a re-proposal is caught.
- **freqRank** — computed by the server from `en-freq.tsv` (`server/src/lexicon.ts`): the term without "to ", parentheticals and punctuation is looked up by lemma with a light lemmatiser (the word itself, then plural -s/-es/-ies, -ed, -ing, -er/-est with e-restoration and undoubling, kept only if that stem is in the list). A multi-word term takes its **rarest** component's rank, or null if any component is missing (so "a broken bone" is null: "a"/"broken" are not lemmas in the list; irregular forms are not handled). Recomputed for all words at startup and whenever the list is (re)loaded (`syncFreqRanks`).
- **card** — exactly two per word, `direction` `forward` (target → native, EN→RU, recognition) and `reverse` (native → target, production); created with the word, whatever its status. Holds the FSRS state (`CardState`). Editing a word never touches its cards, so history survives any fix. Suspending a word suspends both cards.
- **Faces** — `core.wordFace(word, direction)` → `{direction, front, back}`, each side a `FaceSide {term, ipa, posLabel, translations, example, exampleTranslation, note}` (fields that don't apply are null / []). forward: front = term + IPA + pos label; back = translations, first example + its translation, note. reverse: front = translations + pos label + the first example with the term blanked as `___` (`core.blankTerm`: case-insensitive, simple inflections -s/-es/-ed/-d/-ing/-er/-est, y→ies/ied, e-drop before -ing, consonant doubling; "someone/something/one's…" in idioms match any word); if the term isn't found, the example's translation instead; back = term + IPA + pos label + the full example (+ translation) + note.
- **Direction settings** — a disabled direction's cards are kept with their state and history but are invisible to the queue, deck counts, due forecast, stats and dashboard "known"; turning it back on restores them as they were. With `reverseAfterDays = N`, a word's *new* reverse card is only introduced once its forward card is out of the new state with stability ≥ N days (ignored while forward is disabled); already started reverse cards are unaffected.
- **review_log** — every rating, with the state before/after. Client-generated UUID id → idempotent uploads.
- **Known** — a card is known when it is in review state with retrievability ≥ 0.9 now (`study.KNOWN_R`); a word is known when any of its enabled, unsuspended cards is. **Mastered** — every enabled direction's card in review with stability ≥ 21 days.

- **Per-user FSRS** — `requestRetention` (0.75–0.97, default 0.9) and `fsrsWeights` (null = defaults) per user; every server-side rating (`applyReviews`) uses them, the web reads them from `GET /api/me` for local scheduling. See *FSRS parameters*.
- **Deck `typeAnswer`** — `off | reverse | both`: whether the review screen asks to type the answer (only on reverse cards, or on both). Server-side setting returned with the deck (`DeckInfo = Deck & {typeAnswer}` in `repo.ts`); the web acts on it.

Scheduling always goes through `core.review()`; never reimplement FSRS. The review engine is generic: it schedules cards, the word is only what the face shows.

### Study day and limits

The user's `timeZone` (new users get `TZ_NAME`, default `Europe/Moscow`) and the global `DAY_START_HOUR` (default 4) define the study day (`core.dayKey`). Due = `card.schedule.due < nextDayStart(now)` for learning/review cards. New cards per deck per study day are capped by `deck.newPerDay` minus new cards already introduced today (a card counts as introduced when its first review log falls in today). Suspended cards, cards of non-active words and cards of disabled directions are never queued.

### Queue order

Learning/relearning due now first, then review cards by due date, then new cards interleaved (one new after every ~4 reviews) in word `createdAt` order (forward before reverse). One card per word per day: siblings are buried until tomorrow — a card is skipped if the other direction was reviewed today or is earlier in the same queue.

## Schema (server/src/db.ts, server/src/migrate-v3.ts; v4 columns below)

```sql
users(id TEXT PK, telegram_id INT UNIQUE, name TEXT, time_zone TEXT, reminder_time TEXT, evening_reminder_time TEXT NULL,
      bot_started_at TEXT NULL /*set by /start: reminders go to chat = telegram_id*/, morning_sent_day TEXT, evening_sent_day TEXT,
      created_at TEXT)
decks(id TEXT PK, user_id FK users, name TEXT, target_lang TEXT, native_lang TEXT, new_per_day INT,
      forward_enabled INT, reverse_enabled INT, reverse_after_days REAL NULL, created_at TEXT,
      UNIQUE(id, user_id))           -- + UNIQUE (user_id, name COLLATE NOCASE), UNIQUE (user_id, target_lang)
words(id TEXT PK, user_id TEXT, deck_id TEXT, term TEXT, pos TEXT, translations TEXT /*json string[]*/, ipa TEXT NULL,
      examples TEXT /*json [{text, translation}]*/, note TEXT NULL, tags TEXT /*json*/, freq_rank INT NULL,
      cefr TEXT NULL, status TEXT CHECK (inbox|active|rejected), created_by TEXT, dedupe_key TEXT,
      import_ref TEXT NULL /*comma-joined Decks flashcard ids, for idempotent imports*/, created_at TEXT, updated_at TEXT,
      FOREIGN KEY (deck_id, user_id) REFERENCES decks(id, user_id))   -- + UNIQUE (deck_id, dedupe_key)
cards(id TEXT PK, word_id FK words ON DELETE CASCADE, direction TEXT CHECK (forward|reverse), suspended INT, due TEXT,
      stability REAL, difficulty REAL, elapsed_days REAL, scheduled_days REAL, learning_steps INT, reps INT, lapses INT,
      state INT, last_review TEXT, UNIQUE(word_id, direction))
review_logs(id TEXT PK, card_id FK ON DELETE CASCADE, rating INT, reviewed_at TEXT, duration_ms INT,
            before TEXT /*json CardState*/, after TEXT /*json CardState*/)
vocab_tests(id TEXT PK, user_id FK, deck_id TEXT NULL, items TEXT /*json [{id, word, kind: real|pseudo, band}] — the answer key*/,
            answers TEXT NULL, result TEXT NULL /*json TestResult*/, created_at TEXT, completed_at TEXT NULL)
autofill_usage(user_id FK, day TEXT /*study day*/, calls INT, input_tokens INT, output_tokens INT, PK(user_id, day))
sessions(id TEXT PK /*sha256*/, user_id FK, created_at TEXT, expires_at TEXT)          -- web cookies
api_tokens(id TEXT PK, user_id FK, token_hash TEXT UNIQUE, name TEXT, created_at TEXT, last_used_at TEXT)
login_nonces(nonce_hash TEXT PK, user_id FK NULL /*set on confirm*/, created_at, expires_at, confirmed_at, used_at)
oauth_clients(client_id PK, info TEXT /*json*/, created_at)       -- dynamic client registration
oauth_codes(code PK, user_id FK, client_id, code_challenge, redirect_uri, scopes, resource, expires_at)
oauth_tokens(token_hash PK, kind 'access'|'refresh', user_id FK, client_id, scopes, resource, expires_at)
settings(key PK, value TEXT)                                       -- server-wide; `migration.v3` holds the v3 summary
-- v4
users  + weekly_report INT (1), weekly_report_day INT 0-6 (0 = Sunday), weekly_report_time TEXT ('19:00'), weekly_sent_week TEXT NULL /*local date of the last slot handled*/,
         weekly_last_estimate INT NULL /*vocabulary estimate in the last report*/, request_retention REAL (0.9), fsrs_weights TEXT NULL /*json number[21]*/,
         fsrs_prev_weights TEXT NULL, fsrs_trained_at TEXT NULL, fsrs_reviews_used INT NULL, fsrs_attempted_at TEXT NULL, fsrs_result TEXT NULL /*json, last attempt*/
decks  + type_answer TEXT ('off') CHECK (off|reverse|both)
bot_drafts(id TEXT PK /*bd_…*/, user_id FK ON DELETE CASCADE, kind TEXT /*word|duplicate|batch|pick*/, payload TEXT /*json*/, created_at TEXT, expires_at TEXT /*+7 days*/)
```

IDs: short random base36 strings with a prefix (`us_`, `dk_`, `wd_`, `cd_`, `tk_`, `vt_`). Store hashes, never raw tokens. WAL mode, foreign keys on, migrations as an ordered list applied by `PRAGMA user_version`; each runs in one transaction with foreign keys off (table rebuilds need it) and must leave `PRAGMA foreign_key_check` clean, otherwise it rolls back and startup fails. A migration may have a `before` step that runs outside the transaction (the v3 backup: `VACUUM INTO` can't run inside one).

**v2 (multi-user)** rebuilds `decks`, `notes`, `sessions`, `oauth_tokens` with `user_id` (create new → copy → drop old → rename, so children's foreign keys keep pointing at the right name), recreates `oauth_codes` (in-flight codes are dropped), adds `users`, `api_tokens`, `login_nonces`. Existing rows — decks, notes, sessions, OAuth tokens — go to an owner user created from `OWNER_TELEGRAM_ID`; the bot's old `settings` keys (`telegram_chat_id`, `reminder_*_day`) move onto that user. If there are decks or notes and no `OWNER_TELEGRAM_ID`, startup fails with a message saying so and nothing is changed. Cards and review logs are untouched.

**v3 (words)** — flashcards become vocabulary. Before the transaction, a snapshot `VACUUM INTO <db dir>/backups/pre-v3-<ISO timestamp>.db` (skipped for `:memory:` and for databases without notes; `MigrationEnv.backupDir` overrides the directory). Then, per user (`users` ∪ deck owners):
- one deck "English" (`en` → `ru`, both directions on, `reverseAfterDays` null, `newPerDay` = the largest of the old decks that contributed words, else 15);
- **reversible** notes → words. The English side is found per note (`vocab-convert.englishSide`: the side without Cyrillic while the other has it, parentheticals ignored; mixed sides by Cyrillic share). Front English: ordinal 0 → `forward`, ordinal 1 → `reverse`; front Russian: swapped. FSRS state, suspension and card ids are kept, so are their logs;
- **basic** notes in a vocabulary deck (a deck with any reversible note, or named like vocab/словарь) whose sides are an English/Russian term pair (one line each, no markdown, English ≤ 10 words and not a question) → words; their card becomes the direction its old front asked (Russian front → `reverse`), the missing direction is a new card;
- fields: `term`/`pos` from the English side (`termAndPos`: a trailing "(adj.)"-style marker sets the part of speech and is removed; "to X up/out/…" phrasal_verb, "to X" verb, several words phrase, else `other`); translations from the Russian side, split on top-level ";" always and on "," only when every part is ≤ 4 words and none starts a subordinate clause ("как", "что", …); `extra` lines `IPA: /…/` (or a bare `/…/`) → `ipa`, the rest → `note`; tags kept except direction tags ("Russian → English"), the first breadcrumb-like tag (not a one-word plugin tag such as "vocab") → `source`; old `source` `decks:<ids>` → `import_ref`;
- **dedupe** across the old decks by the new key: translations merged (unique, order kept, a translation already present as comma pieces of another skipped), first IPA, notes joined, tags unioned, status active if any; per direction the card with more review logs (then more reps, then the earlier note) is kept, the other card is deleted with its logs; each merge is logged;
- everything else — cloze notes, basic Q&A (Revolut, grammar decks), unrecognisable pairs — is deleted with its cards and logs, and all old decks are dropped (approved by the user; the snapshot above is the way back). Then `notes`, old `cards` and `decks` are dropped and `cards_v3`/`decks_v3` renamed (review_logs keeps pointing at `cards`). `freq_rank` is filled at the next startup. The summary (words, merges, cards per direction with history, deleted notes by reason, logs kept/dropped) is printed and stored in `settings['migration.v3']`.

**v4** — `ALTER TABLE … ADD COLUMN` only (the columns above, with defaults) plus `bot_drafts`; no rebuild, no backup step, every row kept.

**v5** — `words.source` dropped: a non-blank source not already among the word's tags is appended to them (cut to 100 chars, unless the word already has 30 tags).

## Auth

Every authenticated request resolves to a user (`req.user`); nothing implicitly means "the owner". Checked in this order:

1. **Telegram Mini App** — `X-Telegram-Init-Data` validated with `BOT_TOKEN` (HMAC per Telegram docs, `auth_date` ≤ 24 h); the Telegram id must be allowed. Creates the user on first sight and refreshes `name` from `first_name`. Wins over a cookie, since inside Telegram it is authoritative. A valid but not allowed id (and no other credential) gets `401 {error:'not allowed', telegramId}`.
2. **Session cookie** `recall_session` (`HttpOnly; SameSite=Lax; Secure` on https, 90 days) → its `user_id`. Issued by the bot login, the password fallback and the OAuth page's Telegram step.
3. **Bearer** (`Authorization: Bearer …`, on `/api` and `/mcp`):
   - the static `MCP_TOKEN` env → the owner (kept for the owner's existing Claude Code setup);
   - a **personal API token** `mn_…` → its user (`last_used_at` refreshed at most once a minute);
   - an **OAuth access token** → the user who approved it.

`OWNER_TELEGRAM_ID` is the admin: owns the pre-multi-user data, `MCP_TOKEN` and `OWNER_PASSWORD` sign in as them. `-dev` / `DEV=1`: no auth, everything runs as one dev user (Telegram id `OWNER_TELEGRAM_ID`, or `0` if unset).

### Log in with Telegram (PWA / browser, no initData)

1. `POST /api/login/telegram` → `{ nonce, url: "https://t.me/<bot>?start=login_<nonce>", expiresAt }`. The bot username comes from `getMe` at bot start; until then (or with the bot off) the route is `503`. Nonce: 128 random bits (22 base64url chars), stored as SHA-256, 5-minute TTL; 20 per IP per 15 min (`429`), at most 500 pending overall.
2. The user opens `url`; the bot gets `/start login_<nonce>`. Opening alone logs nobody in: if the sender is allowed and the nonce is live, the nonce is bound to that account (the first one to open it; anyone else gets "expired") and the bot asks "Log in to Mnemosyne on the web?" with ✅ Log in / ✖ Cancel buttons. Their callback data carries an opaque ref (the nonce's SHA-256, base64url), never the nonce. At press time the nonce must still be live and the presser must be the account that opened it; ✅ confirms it and the message becomes "✅ Logged in on the web — you can go back to the app", ✖ deletes it (the web's next poll gets `410`) and the message becomes "Cancelled". Strangers never get past the bot's allowlist check.
3. The web app polls `GET /api/login/telegram/:nonce`: `202 {status:'pending', expiresAt}` → `200 {status:'ok', user}` + `Set-Cookie` session, exactly once → afterwards (and for expired or unknown nonces) `410 {status:'expired', error}`.

Risk accepted: like any device-code flow, someone who gets an allowed user to open *their* link and press ✅ logs in as that user. The explicit question makes that a deliberate act rather than a side effect of tapping a link; the allowlist is a handful of friends.

### Password fallback

`OWNER_PASSWORD` env, owner only, for when Telegram is unreachable. `POST /api/login {password}` → session cookie for the owner. Constant-time compare, 10 failures per IP per 15 min.

### Personal API tokens

For Claude Code (`claude mcp add … --header "Authorization: Bearer mn_…"`) and scripts. `mn_` + 32 random bytes base64url (46 chars); only the hash is stored, the plaintext is returned once. At most 50 per user. Managed from a signed-in app (session, Mini App or dev) — not with a bearer, so a leaked token can't mint more.

### OAuth for claude.ai

The server is its own OAuth 2.1 authorization server, using the MCP SDK's Express helpers (`mcpAuthRouter`, `requireBearerAuth`) with an `OAuthServerProvider` implemented over the tables above:

- `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/register` (dynamic client registration), `/authorize`, `/token`, `/revoke` — from `mcpAuthRouter`.
- `/authorize` shows a tiny server-rendered page. With a session cookie: "Allow <client> to manage your cards, <name>?" + Approve / Deny. Without one: a "Confirm in Telegram" button that runs the bot-login flow inline (shows the t.me link, polls, then submits Approve with the fresh session), plus the owner-password form as a fallback. PKCE S256 required. CSP allows only the page's own nonce'd script and same-origin fetches.
- Codes, access tokens (1 h) and refresh tokens (90 days, rotated) carry the approving user's id; `verifyAccessToken` passes it to `/mcp` in `authInfo.extra.userId`. A token issued for one user never acts as another.

## REST API (web app)

All JSON, all except `/api/health` and the `/api/login…` routes require auth, and everything is the signed-in user's own data. Errors are `{error, …extra}` with the HTTP status; `400` for bad input (zod message), `404` for unknown or someone else's ids.

Shapes used below (TypeScript, `core/types.ts` unless noted):
- `Deck {id, name, targetLang, nativeLang, newPerDay, forwardEnabled, reverseEnabled, reverseAfterDays: number|null, typeAnswer: 'off'|'reverse'|'both', createdAt}` (`typeAnswer` is server-side: `repo.DeckInfo`)
- `Word {id, deckId, term, pos, translations, ipa, examples: {text, translation}[], note, tags, freqRank, cefr, status, createdBy, createdAt, updatedAt}`
- `Card {id, wordId, direction: 'forward'|'reverse', suspended, schedule: CardState}`
- `CardSummary {id, direction, enabled, suspended, state: 'new'|'learning'|'review'|'relearning', due, stability, difficulty, reps, lapses, lastReview, retrievability: number|null}` (server `repo.ts`)
- `WordItem = Word & {deckName, cards: {forward: CardSummary|null, reverse: CardSummary|null}}`
- `WordInput {term, pos, translations: string[], ipa?, examples?: {text, translation?}[], note?, tags?, cefr?}` (`ipa`/`note`/`cefr` accept null). No separate source: the book or article is a tag

| Route | |
|---|---|
| `GET /api/health` | `{ok:true}` after a DB ping |
| `POST /api/login {password}` · `POST /api/logout` | owner password session (`401` wrong, `429` limited, `503` no `OWNER_TELEGRAM_ID`) / drop the cookie |
| `POST /api/login/telegram` | `{ nonce, url, expiresAt }` — see *Log in with Telegram*; `503` bot unknown, `429` limited |
| `GET /api/login/telegram/:nonce` | `202 {status:'pending', expiresAt}` · `200 {status:'ok', user:{id, telegramId, name, isOwner}}` + session cookie, once · `410 {status:'expired', error}` |
| `GET /api/me` | `{ user: {id, telegramId, name, isOwner}, authenticatedVia: 'session'\|'telegram'\|'bearer'\|'dev', timeZone, dayStartHour, today, reminderTime, eveningReminderTime, weeklyReport, weeklyReportDay /*0-6, 0 = Sunday*/, weeklyReportTime, botUsername, fsrs: {weights: number[]\|null, requestRetention, trainedAt: string\|null, reviewsUsed: number\|null, minReviews} }` (`botUsername` null while the bot is off) |
| `PATCH /api/me` | `{timeZone?: IANA zone, reminderTime?: 'HH:MM', eveningReminderTime?: 'HH:MM'\|null, weeklyReport?: boolean, weeklyReportDay?: 0-6, weeklyReportTime?: 'HH:MM', requestRetention?: 0.75-0.97}` → same shape as `GET`; unknown keys / bad values `400` |
| `POST /api/fsrs/optimize` | trains the user's FSRS weights now → `{adopted, reason?, reviews, metrics: {logLoss, rmse}\|null, baseline: {logLoss, rmse}\|null /*the defaults on the same data*/, fsrs}`; `422 {reviews, minReviews}` below `FSRS_MIN_REVIEWS`, `429 {retryAfterSeconds}` within a day of the last attempt, `409` while running, `503` binding unavailable |
| `GET /api/tokens` · `POST /api/tokens {name}` · `DELETE /api/tokens/:id` | personal tokens: `{tokens:[{id, name, createdAt, lastUsedAt}]}` / `201 {token, secret:"mn_…"}` (the only time the secret is shown) / `{ok:true}`; all `403` with a bearer |
| **Review** | |
| `GET /api/queue?limit=200&deck=` | `{ items: {card: Card, word: Word, deckName}[], counts: {new, learning, review}, inbox: number }` — today's queue (render with `core.wordFace(item.word, item.card.direction)`), enough for an offline session. `deck` = id, name or language code |
| `POST /api/reviews` | body `ReviewInput[]` (`{id, cardId, rating 1-4, reviewedAt, durationMs?}`, ≤ 5000). Applied in `reviewedAt` order with `core.review()`; already-seen ids and unknown cards are skipped. `{ applied, skipped, cards: Card[] }` |
| `POST /api/reviews/undo` | `{id}` → `{card: Card}` — restores `before` of that log if it is the card's latest log (`409` otherwise), deletes the log |
| **Decks** | |
| `GET /api/decks` | `{decks: (Deck & {counts: {total, active, inbox, known, learning, due, new, newTotal}})[]}` — creates the English deck if the user has none. `total/active/inbox/known` count words; `learning/due/new/newTotal` count cards of enabled directions (`new` = available today after the daily budget and the reverse gate) |
| `POST /api/decks {name?, targetLang, nativeLang, newPerDay?}` | `201 {deck}`; `409` if a deck for that language (or that name) exists |
| `PATCH /api/decks/:id {name?, newPerDay?, forwardEnabled?, reverseEnabled?, reverseAfterDays?: number (1..365)\|null, typeAnswer?: 'off'\|'reverse'\|'both'}` | `{deck}`; `400` if both directions would be off, for an unknown `typeAnswer`, or for unknown keys |
| **Words** | |
| `GET /api/words?deck=&q=&status=&pos=&cefr=&tag=&sort=recent\|alpha\|freq\|difficulty&limit=50&offset=0` | `{words: WordItem[], total}`. `q`: substring over term, translations, examples, note, tags (case-insensitive for Latin only). `freq`: by `freqRank`, nulls last; `difficulty`: most lapses, then highest FSRS difficulty. `limit` ≤ 500 |
| `GET /api/words/:id` | `{word: WordItem, logs: ReviewLog[]}` — last 20 ratings of both cards, newest first |
| `POST /api/words` | `WordInput & {deckId?}` (default the English deck) → `201 {word: WordItem}`, status `active`, `createdBy: 'user'`. Duplicate → `409 {error, existing: Word}` so the app can offer "add the translation to the existing word" (a `PATCH`) |
| `PATCH /api/words/:id` | `Partial<WordInput> & {status?}` → `{word: WordItem}`; only given fields change, cards and history always stay; `409 {error, existing}` if the new term/pos collides |
| `DELETE /api/words/:id` | `{ok:true}` — the word, both cards and their logs |
| `POST /api/words/:id/approve` · `/reject` | → `{word: WordItem}` (→ active / rejected) |
| `POST /api/words/:id/suspend` · `/unsuspend` | both cards → `{word: WordItem}` |
| `POST /api/cards/:id/suspend` · `/unsuspend` | one card → `{card: Card & {summary: CardSummary}}` |
| `GET /api/inbox?deck=` | `{words: WordItem[]}` — inbox words, oldest first |
| `POST /api/inbox/approve-all {deckId?}` | `{approved: number}` |
| `POST /api/words/autofill {deckId?, term, hint?}` | ✨ see *Autofill* → `{draft: Draft, alternatives: Draft[], freqRank, duplicate: Word\|null}`, `Draft = {term, pos, translations, ipa, examples, note, cefr}`. `503 {error:'autofill is not configured'}` without `ANTHROPIC_API_KEY`; `429 {error, limit}` over the daily limit; `422 {error, category}` when Claude declines; `504` timeout; `502` other API failures / unusable answer |
| **Progress** | |
| `GET /api/stats?days=30&deck=` | `{days: [{day, reviews, again}], reviews, retention, retentionByDirection: {forward, reverse}, forecast: [{day, due}] /*14 days*/, cardsByState: {new, learning, review, relearning, suspended}}` — enabled directions only |
| `GET /api/dashboard?deck=` | `Dashboard` (server `dashboard.ts`), below |
| `POST /api/vocab-test {deckId?}` | `201 {testId, items: [{id, word}]}`; `503` without `vocab-test.json` |
| `POST /api/vocab-test/:id/answers {answers: [{id, known}]}` | `TestResult` (below); `409` if already answered, `400` if fewer than half the items are answered |
| `GET /api/vocab-tests` | `{tests: [{id, createdAt, completedAt, items: number, result: TestResult\|null}]}`, newest first |

`Dashboard`:
```ts
{
  deck: Deck,
  counts: {
    words: {total, active, inbox, rejected},
    // active words' cards per direction
    directions: {forward|reverse: {enabled, new, learning, known /*review, R ≥ 0.9 now*/, fading /*review, R < 0.9*/, suspended}},
    known: number,      // active words with a known enabled card
    mastered: number,   // every enabled direction in review with stability ≥ 21 d
  },
  growth: {date: 'YYYY-MM-DD', known}[],   // 26 weekly points ending now
  activity: {days: {day, reviews, again, timeMs}[] /*90 study days*/, streak: {current, longest, studiedToday}, totals: {reviews, timeMs}},
  retention: {forward|reverse: {rate: number|null, reviews}},   // last 30 days: non-Again share of review-state ratings
  coverage: {from, to, words, known}[],   // rank bands 1-1000, 1001-2000, 2001-5000, 5001-10000, 10001-20000, 20001-30000
  vocabulary: VocabularySummary,
}
```
- `growth`: for each point t, a card's state is the `after` of its last review before t (a card without logs: its current state from `lastReview` on); a word counts if that state is review with R(t) ≥ 0.9 — the same "known" as now, reconstructed. Disabled and suspended cards are left out.
- `streak`: consecutive study days (user's zone) with ≥ 1 review, ending today, or yesterday if nothing yet today; `longest` over all history.
- `coverage`: distinct lemmas of single-word active terms with a `freqRank` in the band (multi-word terms are left out); `known` as above.

`VocabularySummary`:
```ts
{
  available: {frequencies, test, scale},             // which data files are loaded
  latestTest: (TestResult & {completedAt}) | null,   // latest valid completed test, as scored then
  current: VocabEstimate | null,                     // now: the latest test's band shares + today's known words; null without en-freq.tsv
  history: {testId, completedAt, estimate, adjusted, nativeEquivalent, reliability, valid}[],   // oldest first
  scale: {unit: 'lemmas', points: ScalePoint[], calibration: {adultSize, expectedInList, listSize}} | null,
}
VocabEstimate {
  estimate: number | null,      // in-list lemmas from the test alone (null without a test)
  interval: [lo, hi] | null,    // rough 95% interval of `estimate`
  adjusted: number,             // test ∪ app (below); without a test, the app's lower bound
  srsKnown: number,             // lemmas known in the app (hard lower bound)
  basis: 'test+app' | 'app',
  nativeEquivalent: {value, approximate: true},
  cefr: {level: ScalePoint|null, next: ScalePoint|null},     // learner points vs the in-list number
  scale: Record<'learner'|'native'|'fun', {level, next}>,    // learner vs in-list, native/fun vs nativeEquivalent
  perBand: {from, to, items, yes, hitRate, known /*test share, corrected + smoothed*/, srs /*app share*/}[],
}
ScalePoint {id, size, label, labelRu, emoji, group, range: [lo, hi]|null, approximate, source, url}
TestResult = VocabEstimate & {testId, falseAlarmRate, pseudowords: {items, yes}, answered, method: 'corrected'|'isdt'|'raw', reliability: 'ok'|'low', valid}
```

## Vocabulary size (server/src/vocab.ts, server/data/README.md)

Unit: English **lemmas within the 30,000-lemma list** of `en-freq.tsv`.

- **Test** — `POST /api/vocab-test` samples `itemsPerBand` (3) words from every 1000-rank band of `vocab-test.json` (30 bands, 1k…30k), skipping words the user already has in the app (by normalised term and lemma — those are known or not from the SRS), plus pseudowords at ~25 % of the items (`round(real × 0.25 / 0.75)`), shuffled. The items with the answer key are stored in `vocab_tests`; the client only gets `{id, word}`.
- **Scoring** (the file's `scoring`): h_b = share of band b's words ticked, f = share of pseudowords ticked (one f). known_b = max(0, (h_b − f)/(1 − f)) (correction for guessing; `isdt` = Huibregtse, Admiraal & Meara 2002 I_SDT per band, and `raw` = h_b, are selectable by the file). Bands without items take their neighbours' mean; the curve is then made non-increasing over bands (pool-adjacent-violators, weighted by items). `estimate = bandSize × Σ known_b`. `interval` = ± 1.96 × the combined binomial error of the band hit rates. `reliability: 'low'` when f > 0.2 or the overall hit rate does not beat f; `valid: false` (retake; never used as the latest test) when f > 0.5.
- **Adjusted** (README §4): per band `max(known_b, srs_b) × bandSize`, where srs_b = distinct lemmas of the band whose single-word term is known in the app / bandSize. The SRS count is a hard lower bound, so learning words raises the estimate between tests and a lucky test is never overruled. Recomputed on every dashboard read against the latest valid test.
- **Scale** (`vocab-scale.json`): learner points (CEFR, X_Lex ≤ 5k) compare against the in-list number; native and fun points against `nativeEquivalent = adultSize (42,000) × inList / expectedInList (26,686)` — approximate by construction (README §3: Brysbaert's 42k is on a larger list). Every point carries its `approximate` flag for the "≈".
- Data files are loaded lazily and re-read when they appear or change (checked at most every 30 s): without `en-freq.tsv` ranks and coverage are null/empty and `current` is null; without `vocab-test.json` the test routes are `503`; without `vocab-scale.json` placements are empty.

## Autofill (server/src/autofill.ts)

`POST /api/words/autofill` drafts a word from a bare term with the official Anthropic TypeScript SDK: `client.beta.messages.create` with `model` = `CLAUDE_MODEL` (default `claude-opus-5-5`), `output_config: {effort: 'low', format: {type: 'json_schema', schema}}` (structured outputs: `{draft: Sense, alternatives: Sense[]}`, every field required, nullable ones as `anyOf [..., null]`), `max_tokens` 8000 (thinking counts towards it), the server-side refusal fallback (`fallbacks: 'default'` with beta `server-side-fallback-2026-07-01`), and a client `timeout` of 30 s with the SDK's default 2 retries. System prompt: a bilingual lexicographer — base form, natural Russian translations by frequency, General American IPA without slashes, 1–2 natural examples with translations, a CEFR estimate, a concise usage note in Russian, other senses / parts of speech as alternatives (≤ 3). The answer goes through `core.cleanWord`; `duplicate` is the deck's existing word with the draft's key; `freqRank` comes from the list. Per-user limit `AUTOFILL_DAILY_LIMIT` (default 200) calls per study day, counted before the call (failures count too); token usage is logged and summed in `autofill_usage`. Off (`503`) without `ANTHROPIC_API_KEY`. Tests inject a fake client (`AppContext.autofill`). The bot's words and word picking (below) go through the same `structuredCall` and share that budget. An internal `context` (a sentence the term was met in) is passed as `Context: …`: it picks the sense and is made the draft's first example (`withFirstExample`: Claude's copy with its translation if it used the sentence verbatim, else the sentence with `translation: null`).

## FSRS parameters (server/src/fsrs.ts)

Trained per user with fsrs-rs through `@open-spaced-repetition/binding` 0.5.0 (napi-rs; prebuilt `.node` per platform as optional deps — `linux-x64-gnu` is an x86-64 ELF needing glibc ≥ 2.17, N-API so Node-version independent; no compiler on the server). Imported lazily: if it can't load, training is off with a warning and scheduling keeps working.
- **Data** — per card, its logs in order as `(rating, delta_t)` with delta_t = study days (user's zone, `DAY_START_HOUR`) since the previous review, 0 for the first and same-day ones; cards whose logged history doesn't start at state new (imports) are skipped. FSRSItems as Anki builds them: one per review after the first (the history up to it), kept when it holds a long-term review. `computeParameters(items, {enableShortTerm: true, numRelearningSteps: 1})` (ts-fsrs defaults: steps 1m/10m, relearning 10m). The binding's `timeout` option is not used — in 0.5.0 it makes the call never resolve.
- **When** — only with ≥ `FSRS_MIN_REVIEWS` (default 1000) usable reviews. A background pass every hour (first a minute after start) trains users with no attempt in the last 7 days and more reviews than the weights in use were trained on; `POST /api/fsrs/optimize` trains now, at most once per 24 h per user. One run per user at a time.
- **Adoption** — `core.sanitizeWeights` (exactly 21 finite numbers, then ts-fsrs `clipParameters`), then `evaluate` on the same items: log loss and RMSE must be ≤ those of the default weights and of the user's current weights. Adopted: `fsrs_prev_weights` ← old, `fsrs_weights`, `fsrs_trained_at`, `fsrs_reviews_used`; every attempt stores `fsrs_attempted_at` and `fsrs_result` (status, reason, metrics) and logs one line.
- **Use** — `userScheduler(db, userId)` = `core.scheduler({weights, requestRetention})`, used by `applyReviews`. "Known" (R ≥ 0.9) and other read-side retrievability still use the default weights.

## MCP tools (server/src/mcp.ts)

Streamable HTTP at `POST /mcp`, stateless (new `McpServer` + transport per request). Tool inputs are zod schemas; descriptions are written for Claude — the field formats (base-form term, part of speech, Russian translations, General American IPA without slashes, examples containing the term) and that Claude's words go to the inbox. `deck` arguments accept an id, a name or a language code and default to the English deck.

| Tool | Input → output |
|---|---|
| `list_decks` | → decks with settings and the `GET /api/decks` counts |
| `search_words` | `{query?, deck?, status?, pos?, cefr?, limit≤100 (20), offset?}` → `{total, words: [{id, deck, term, pos, translations, ipa, examples, note, cefr, freqRank, tags, status, createdBy, createdAt, cards: {forward, reverse: {state, enabled, suspended, due, stabilityDays, lapses, retrievability}}}]}` |
| `get_word` | `{id}` → the same plus `faces` (`core.wordFace` per direction) and `recentReviews: [{direction, rating, reviewedAt}]` |
| `add_words` | `{deck?, words: [{term, pos, translations, ipa?, examples?, note?, cefr?, tags?}] ≤ 100, autoApprove?: false}` → `{deck: {id, name}, created: [{index, id, term, pos, status, freqRank}], duplicates: [{index, existingId, existingStatus, term, pos, differs: {newTranslations?, newExamples?, term?, ipa?, note?, cefr?}}], errors: [{index, term, error}]}`. Same validation and dedupe as the REST add; words go to `inbox` unless `autoApprove`; `createdBy: 'claude'` |
| `update_word` | `{id, term?, pos?, translations?, ipa?\|null, examples?, note?\|null, cefr?\|null, tags?}` → the word; arrays replace; history kept; a duplicate key is an error |
| `set_word_status` | `{ids[] ≤ 200, action: approve\|reject\|delete\|suspend\|unsuspend}` → `{action, results: [{id, ok, error?}]}` |
| `review_stats` | `{deck?, days?}` → `GET /api/stats` |
| `get_leeches` | `{deck?, direction?, minLapses=4, limit=20}` → `[{wordId, deckName, term, pos, translations, maxLapses, cards: [{id, direction, lapses, reps, suspended, lastRatings}]}]` |
| `vocabulary_profile` | `{deck?}` → `{deck, words, knownWords, masteredWords, directions, vocabularySize: {inListLemmas, fromLastTest, lastTestAt, lastTestReliability, knownInApp, basis, nativeEquivalentApprox, cefrLike, nextMilestone}, coverage: [{ranks, wordsInApp, knownInApp, testShareKnown}], retention30d, streak, partsOfSpeech, cefrLevels, weakest: [{id, term, translations, maxLapses, directions}], inbox}` — so Claude can suggest what to learn next |

Each request builds its server for the bearer's user, so every tool sees only that user's collection; other users' ids come back as "not found".

## Telegram

grammY, long polling (no webhook needed). Only allowed users (owner + `ALLOW_USER_IDS`) get answers; others get "This is a private bot. Your Telegram id: N — send it to the owner to get access."

- `getMe` at startup (retried every 60 s if Telegram is unreachable) caches the bot username for the login links.
- `/start` — creates the user if needed, marks them as started (`bot_started_at`; their chat is their Telegram id), sets the chat menu button "Review" → Mini App (`APP_ORIGIN`), says hello by name with their counts. `/start login_<nonce>` instead asks "Log in to Mnemosyne on the web?" with ✅ Log in / ✖ Cancel inline buttons; the press confirms or cancels the web login (see Auth).
- Reminders, per started user, in their time zone: at `reminderTime` "N cards due · M in inbox" with a `web_app` button; skipped when nothing is due. The last sent study day is stored on the user so restarts don't double-send and a late start still catches up. A second nudge at `eveningReminderTime` (optional) if nothing was reviewed that day. A user who blocked the bot (403) is skipped until the next `/start`.
- `/due` — the sender's counts now. `/stats` — "📊 Vocabulary ≈ N words (CEFR)", known · mastered, streak (best), due today · inbox, with an "Open dashboard" button. `/help` — how to add words. Commands are registered with `setMyCommands` at start. Reminders read "N cards due · M words in inbox".
- **Weekly report** (`weekly.ts`) — per started user with `weeklyReport` on, at `weeklyReportDay`/`weeklyReportTime` (Sunday 19:00) local. The slot handled is stored as its local date (`weekly_sent_week`); a missed slot is still sent within 48 h, later (or one from before the user's `/start`) it is consumed silently. Rolling 7 days vs the 7 before, default deck: reviews (vs last week, %), new words, known (+change, from the growth reconstruction), streak, retention per direction (non-Again on review-state cards), vocabulary estimate (+change since the last report's), the 3 words with most Again, and one suggestion (inbox ≥ 5 → approve; a direction's retention < 80 % on ≥ 20 reviews → "try typing answers" unless that direction is already typed; no reviews; reviews down > 30 %; no vocabulary test in 60 days; inbox; few new words). Button "Open dashboard" → `#/dashboard`. Users without any words get nothing.

### Adding words by message (server/src/bot-words.ts, extract.ts, drafts.ts)

Private chats, allowed users only. What a text means (`parseMessage`):
- **a word / short phrase** (≤ 6 words, Latin letters, no `. ! ? ; :` except one trailing) → autofill (typing… shown) and saved at once: `status: inbox`, `createdBy: 'user'`. Reply: `<b>term</b> /ipa/ · pos · CEFR`, translations, one example + translation; buttons `✅ Add` · `✏️ Edit` (web_app `APP_ORIGIN/#/words/<id>`) · `✖`, and `↔ Other meaning` when autofill gave alternatives (cycles the word through them in place, skipping senses that collide with another word). ✅ → active, message becomes "✅ Added: term — перевод" with only ✏️ Edit; ✖ deletes the inbox word → "✖ Removed: term".
- **duplicate** (the draft's key exists, any status) → "Already in your deck: term — tr1, tr2 · new|learning|known|suspended|in inbox|rejected"; if autofill found other translations, "Also: …" and `➕ Add translations` (also appends the context sentence as an example), otherwise no buttons.
- **no autofill / limit / refusal / error** → nothing is stored (translations are required, no placeholders): "Couldn't fill in term: <reason>. Add it in the app:" + web_app `✏️ Add in the app` → `#/words/new?term=<term>`.
- **word + context** — `term — sentence` (≥ 3 words with Latin letters) or a sentence with the word marked `*word*`, `"word"`, `«word»`, `“word”`, `_word_` → the sentence is sent as `Context:` and becomes the first example. `term — перевод` (no target-language sentence) is a `Hint:` instead.
- **several lines**, each one of the above (≤ 20; more → the first 20 and a note) → one "⏳ Adding N words…" message edited as each finishes ("… k/N"), then the list "📥 N words in your inbox:" (+ duplicates and failures) with `✅ Add all` · `✏️ Review in app` (`#/inbox`) · `✖ term` per word (struck through when removed). After the limit or "not configured" the rest are not attempted.
- **anything else** (prose, > 1 line of prose, a paragraph) or a **photo** / image file (jpeg/png/gif/webp ≤ 3.75 MB; the largest photo size under that, via `getFile`, kept in memory only, sent as a base64 image block with the caption) → "🔍 Looking for words…", one structured call (`extract.ts`, same model/effort/fallback; counts as 1 on the daily budget). The prompt gives the learner's CEFR and vocabulary estimate and the rank below which words count as known (first frequency band with < 80 % known by test or app; 2000 without a test) and up to 600 deck terms to skip; the server then drops deck words (term or lemma), single words more frequent than that rank and repeats, keeping ≤ 12 `{term, pos, sentence, gloss}`. Reply: the numbered list with a toggle button per word (`✓ ` when selected) and `➕ Add selected (n)` → the batch flow above in the same message, each with its sentence as context and the gloss as hint. A link alone gets "I can't open links…".
- **Buttons** carry `<w|d|b|p>:<action>:<bd_ id>[:<index>]` (≤ 22 bytes); the draft holds the rest and is looked up by id *and* the presser's user id and kind, unexpired (7 days; expired rows are deleted whenever a draft is created). Anything else → popup "This message has expired — send the word again".
- Work runs in a per-user queue (`TaskQueue`) so the poller (grammY processes updates one by one) and other users aren't held up by a slow batch; tests await `queue.idle()`.

Bot is off when `BOT_TOKEN` is unset (and then Telegram sign-in is off too).

## Importer (server/src/import-decks.ts)

`node server/src/import-decks.ts --from <flashcards.db> --db <recall.db> [--user <telegram id>] [--dry-run]`. Imports into that user's English deck (default user `OWNER_TELEGRAM_ID`; the user row is created if missing, even on a dry run). Reads the Obsidian **Decks** plugin DB read-only (`decks`, `flashcards`, `review_logs`, `card_state_overlays`). Produces words directly, by the v3 migration's rules (`vocab-convert.ts`), so a fresh import gives what migrating an old import gives:

- `table` / `header-paragraph` rows are paired into one word: an `rcard_*` with its forward row (same breadcrumb, swapped front/back), or two one-way rows that mirror each other; table rows read their columns from `template_row` (a pronunciation column → `IPA: …`). A single row counts only in a vocabulary deck (one with pairs, or named like vocab) and when it looks like a term/gloss pair. Cloze and Q&A rows are skipped (counted).
- Each row becomes the card of the direction its front asks (English front → `forward`); a missing direction is a new card. State: `state='new'` → `newCardState`; `review` → CardState from `due_date`, `stability`, `difficulty`, `repetitions`, `lapses`, `last_reviewed`, `interval` (minutes → `scheduledDays`), `state: 2`. `review_logs` → `review_logs` with before/after built from `old_*`/`new_*`.
- The breadcrumb after the deck name (e.g. `wuthering heights`) is a tag (unless it is a direction section like "Russian → English"); Decks' own `tags` add more tags. `import_ref` = the comma-joined Decks ids.
- The same word twice in the import is merged (translations, per-direction card with more logs). Words active, `createdBy: 'import'`. Idempotent per user: rows whose Decks id is already in some word's `import_ref` are skipped; a word whose key already exists from elsewhere is counted as a duplicate and skipped. Log ids are Decks' own and global, so importing the same Decks DB into a second user skips its logs.
- Prints `{flashcards, words: {created, merged, alreadyImported, duplicates}, cards: {forward, reverse, new, review, suspended}, logs: {imported, alreadyImported, orphaned}, skipped: {cloze, notWords, unsupportedType}}`.

## Web app

Mobile-first, iPhone in one hand; one excellent path per job, as few taps as possible, nothing reversible behind a confirmation (changes apply at once, with an Undo toast). UI strings in English, content English/Russian + IPA. Visual system: `web/DESIGN.md`. Tabs: **Review · Words · Inbox · Progress · Settings**; hash routes `#/`, `#/words`, `#/word/<id>`, `#/add`, `#/inbox[/<id>]`, `#/progress`, `#/test`, `#/settings`. `lib/route.ts` also accepts the bot's deep links (`#/words/<id>`, `#/words/new?term=…` → add screen prefilled, `#/dashboard`, `#/inbox`) and drops every `tgWebApp*` parameter Telegram appends (after `?`, after a bare `&`, or as the whole hash → home).

- **Review** (home): counts (new / learning / due), progress bar, sync pill, a round "+" (add word). The card comes from `core.wordFace(word, card.direction)`: a small direction marker (EN → RU / RU → EN) and tags; **forward** front = term (34 px) + /IPA/ + pos label, back = main translation (23 px) + the others, first example with the term in bold (`lib/mark.ts`, the same matcher as `core.blankTerm`) + its translation, note; **reverse** front = main translation + the others + pos + the example with the term as a blank, back = term + IPA + full example + note. The front never moves on reveal. Tap / Space reveals; four rating buttons labelled with `core.preview()` intervals; after reveal swipe ← Hard, → Good, ↓ Again, ↑ Easy (legend for the first five swipes); keys 1–4, Enter = Good; undo button (and z/u/Backspace); haptics; a summary at the end. Intervals and local scheduling use `core.scheduler({weights, requestRetention})` from `GET /api/me` `fsrs` (`lib/fsrs.ts`, cached for offline; defaults when absent).
- **Typed answers** (deck `typeAnswer`: `reverse` = RU→EN cards, `both` = also EN→RU, typing the translation; missing → `off`): the action row becomes a field (`autocapitalize/autocorrect/spellcheck` off, `enterkeyhint=done`) + Check (reads "Don't know" while empty) + undo. Enter checks with `core.checkAnswer(input, word, direction)` (below); the card shows a verdict pill (Correct / Almost — a typo / Not quite / Didn't know) and, for close/wrong, your answer vs the closest accepted one with the differing letters marked (`core.answerDiff`). The suggested rating (exact → Good, close → Hard, wrong/empty → Again) is ringed on the bar; a second Enter takes it, any button or swipe overrides it. The field stays mounted and focused across typed cards (after the check it steps out of view but keeps focus; rating buttons don't steal focus; the next card renders synchronously inside the tap via `flushSync`), so the iOS keyboard doesn't drop between cards. The shell follows `visualViewport` (`lib/viewport.ts`: `--vv-h`/`--vv-top` size `#app`, `html[data-keyboard]` hides the tab bar), so the field and rating bar sit right above the keyboard without layout jumps.
- **`core.checkAnswer`** (`packages/core/src/answer.ts`): accepted answers = the term and its "/" or ";" alternatives (reverse) or every translation and its ","/";" pieces (forward), each also with parenthesised words dropped and kept ("take (it) easy"). Normalisation: NFKC, lowercase, ё → е, apostrophes dropped, hyphens/slashes → spaces, other punctuation removed, spaces collapsed; English also loses a leading "to" and article (a/an/the) and reads smb/sb/somebody → someone, sth/smth → something. Distance = Damerau–Levenshtein (OSA) to the closest accepted answer; tolerance by its length: ≤ 3 → 0, 4–6 → 1, 7–10 → 2, longer ⌈len/5⌉. Verdicts: equal → `exact`; within tolerance, or the input is an inflected form of the term ("frowned") → `close`; nothing typed → `empty`; else `wrong`. Returns `{verdict, distance, matched, suggestedRating}`.
- **Offline**: today's queue (server items + deck settings) in IndexedDB; ratings applied locally and queued in the review outbox → `POST /api/reviews` (on 5 pending, at the end, on hide, with backoff). Turning a direction off hides its cards on the spot. Words added offline (or when a POST fails on the network) go into `lib/wordOutbox.ts` (persisted; flushed with the reviews; a 409 on retry counts as done; refused words are dropped with a toast) and show "waiting to sync" on the add screen. The sync pill counts both. Service worker caches the shell.
- **Add word** (`#/add`, from the "+" on Review and the floating "+" on Words): one autofocused field "English word or phrase"; ✨ `POST /api/words/autofill` 600 ms after typing stops or on Enter (cached per term + context; stale answers ignored), with a pulsing sparkle and a skeleton meanwhile. An optional "Sentence where you met it" goes as `hint` and becomes the first example. The draft is an editable card: translations as chips (main first; tap a chip for ← → to reorder, × to remove; the trailing field adds on Enter, "," or ";"), part of speech, CEFR, IPA, examples, note, tags (remembered from the last add); other senses as one-tap chips that swap in. The base form replaces what was typed ("frown" → "to frown"). Enter (in the term field, or on the empty translation field) or the bottom button adds: the form clears at once and the cursor is back in the field while the POST runs ("Added “x” · Undo" deletes it; a refusal brings the form back). Duplicates: autofill's `duplicate` or a `409` shows the existing word inline with "Add “…” to it" (PATCH merging translations and examples, Undo restores them) and Open; the same term under another part of speech (imported words are often `other`) gets the same panel, softer. 503 / 429 (autofill off for the visit) / 422 / 5xx / offline fall back to the empty fields with a one-line note; adding by hand always works.
- **Words** (`#/words`): the whole collection cached on the device (`lib/words.svelte.ts`, pages of 500, refreshed after a minute or when something changed), so search-as-you-type (term, translations, examples, note, tags; case and ё folded), filters (sort Recent / A–Z / Most common / Hardest; state new / learning / known / fading / suspended in either direction; status, default studied + inbox; part of speech; CEFR — native selects under chips, one tap each) and sorting are instant and offline (`lib/wordFilter.ts`). Rows: term, pos, translations, two state dots (EN→RU, RU→EN: new blue, learning red, known green, fading hollow green, suspended/off hollow grey). Search, filters and scroll survive a visit to a word; no match → "Add “query”".
- **Word** (`#/word/<id>`, also `#/inbox/<id>`): every field (same editor as the draft card), both cards (state, due, stability, recall %, lapses, last ratings; Suspend / Resume per direction; "off in deck settings"), Delete (the word disappears, the DELETE is held for the Undo toast and sent when it goes or the page hides). Save in the bottom bar; leaving with valid edits saves them. Inbox mode: Reject / Approve (Save & approve when edited).
- **Inbox**: proposals (Claude, the bot) as a swipe stack — right approve, left reject, tap to edit; each decision and "Approve all" toast with Undo (back to `inbox` via PATCH).
- **Progress** (`#/progress`, cached in IndexedDB for an instant, offline paint): hero ≈ `vocabulary.current.adjusted` with CEFR level and the next one, "≈ N as natives count", one line on what the number is (lemmas known within the 30k list; native comparison is a calibration); "Take the 3-minute test" without a test, else "Retake". Scale ladder: all scale points on one axis (native/fun converted to in-list units = size × expectedInList / adultSize, shown with ≈), "You" between the nearest points, collapsed around you, tap a point for its source. Word tiles (known, mastered, active, inbox, total); per direction a stacked bar new / learning / known / fading (+ suspended) and 30-day retention; known words over 26 weeks (line); 90-day heatmap with current / longest streak, reviews and time; frequency coverage bars per band (in app vs known); test history.
- **Vocabulary test** (`#/test`): instruction "Mark a word as known only if you can explain its meaning — some words are made up.", Start; one word at a time, big type, "Don't know" / "Know" (swipe ←/→, keys ←/→ or J/K), progress; Back (ours and Telegram's) undoes the last answer, or leaves on the first word. Submits on the last word; result: estimate with interval, CEFR, the ladder with the marker sliding to the new place, native equivalent ≈, reliability notes (`low` / `valid: false` → Retake), per-band shares (test vs app); Done → Progress. A failed submit keeps the answers and offers Retry.
- **Settings**: account; per deck "Study": EN → RU (recognise) / RU → EN (recall) switches (the last one on can't be turned off), "Introduce RU → EN after EN → RU is stable for" Off / 3 / 7 / 14 / 30 d (both on only), new cards per day stepper, "Type the answer" Off / RU → EN / Both — all optimistic `PATCH /api/decks/:id` with rollback, applied to the review queue immediately; reminders (time zone, morning, evening nudge, weekly report in Telegram with day + time — shown when the server sends them); sync; appearance; personal tokens; Advanced: desired retention slider 80–95 % (`PATCH /api/me {requestRetention}`) and FSRS status with "Optimize now" (`POST /api/fsrs/optimize`; 422 shows the review count, 429 the wait); the claude.ai connector URL.
- **Login**, **Telegram Mini App** and **PWA** as before: bot-login link + polling with the owner password behind a disclosure, invite-only screen for `not allowed`; inside Telegram initData header, `ready()`/`expand()`, theme params, BackButton, HapticFeedback; standalone manifest, safe areas, light/dark.
- **Mock** (`?mock`, `web/src/mock`): an in-memory server with the same routes — a seeded English deck (typed RU→EN answers on), words with IPA/examples, inbox proposals, 90 days of history, autofill drafts after 400 ms with alternatives ("frown" duplicates a seeded word), a full vocabulary test with pseudowords, FSRS optimize; variants `login`, `nobot`, `denied`, `bearer`, `noautofill`.

## Config (env)

`DB_PATH` (default `./recall.db`), `PORT` (8080), `APP_ORIGIN` (`https://cards.example.com`, used for OAuth issuer and Mini App button), `OWNER_TELEGRAM_ID` (admin; required once the DB has data), `ALLOW_USER_IDS` (comma-separated Telegram ids besides the owner), `OWNER_PASSWORD` (owner fallback), `MCP_TOKEN` (legacy static bearer → owner), `BOT_TOKEN`, `TZ_NAME` / `REMINDER_TIME` / `EVENING_REMINDER_TIME` (defaults for new users), `DAY_START_HOUR` (global), `STATIC_DIR` (built web), `BACKUP_DIR`, `DATA_DIR` (default `server/data`), `ANTHROPIC_API_KEY` (✨ autofill; off when unset), `CLAUDE_MODEL` (default `claude-opus-5-5`), `AUTOFILL_DAILY_LIMIT` (Claude calls per user per study day — autofill, bot words, word picking; default 200), `FSRS_MIN_REVIEWS` (usable reviews before per-user FSRS training, default 1000), `DEV`.

## Deploy

The VPS has no Docker and already runs nginx behind an SNI-routing front proxy, so: Node 24 + a systemd unit (`deploy/recall.service`, app in `/opt/recall`, DB in `/var/lib/recall`), an nginx `server` block on `:8444` (`deploy/nginx-exit.conf`), `scripts/deploy.sh` to rsync and restart. `node:sqlite` is built in; the one native dep, the FSRS optimizer, ships prebuilt binaries (`npm ci` on the host picks `binding-linux-x64-gnu` from the lockfile) and is optional at runtime. Nightly backup inside the server: `VACUUM INTO <db dir>/backups/recall-YYYY-MM-DD.db`, keep 14.

Connect Claude Code: create a personal token in Settings, then `claude mcp add --transport http recall https://<domain>/mcp --header "Authorization: Bearer mn_…"` (the owner's existing `$MCP_TOKEN` setup keeps working). claude.ai: Settings → Connectors → Add custom connector → `https://<domain>/mcp` (OAuth flow).
