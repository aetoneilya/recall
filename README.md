# recall — Mnemosyne

Personal spaced repetition; the app and the Telegram bot (@mnemosyne_cards_bot) are called **Mnemosyne**, the code is `recall`. Cards live in SQLite on a VPS; I review them on my phone in a web app (installable PWA, also a Telegram Mini App); Claude adds and edits them through MCP. Scheduling is FSRS (`ts-fsrs`), shared by the server and the offline client.

Architecture, data model, API and MCP tools: [DESIGN.md](DESIGN.md). Visual design of the app: [web/DESIGN.md](web/DESIGN.md).

## Layout

| | |
|---|---|
| `packages/core` | Types (words, facts, decks, cards), FSRS wrapper, word → card faces, study-day math. Imported as TS source by both sides. |
| `server` | Node 24 + Express 5 + `node:sqlite`: REST API, `/mcp`, OAuth for claude.ai, Telegram bot, Decks importer, nightly backups. Runs `.ts` directly (type stripping). |
| `web` | Svelte 5 + Vite PWA. Offline queue in IndexedDB, ratings applied locally and synced through an outbox. |
| `deploy`, `scripts/deploy.sh` | systemd unit, nginx server block, deploy script for the exit VPS. |

## Local development

Node 24+. Behind the VK proxy run npm as `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy npm …` (`.npmrc` pins the public registry).

```bash
npm install
npm run dev                       # API on :8080, --dev: no auth, ./server/recall.db
npm -w @recall/web run dev        # app on :5173, proxies /api and /mcp to :8080
open 'http://localhost:5173/?mock'  # UI alone, in-memory fake API (password "recall" with ?mock=login)
npm run check                     # typecheck + tests in all workspaces
npm run build                     # web/dist
```

Content packs (ready-made cards, e.g. 159 irregular verbs) live in `server/data/packs/*.json` and are added per user, into a deck of your choice, from Settings → Packs (or MCP `add_pack`); see DESIGN.md *Content packs* for the file format. The grammar handbook pack (rules with exercises plus theory cards, format `grammar-handbook`) is built from its two parts, validated with the server's own checks:

```bash
node server/data/packs/build-grammar-handbook.ts <part-a.json> <part-b.json> [server/data/packs/grammar-handbook.json]
```

Grammar rules with exercise pools (kept outside the repo: they come from private notes) are imported per user, into the English deck tagged `Grammar/<group>` and `Grammar/My rules` (`--deck` to change the deck, `--tag` the root); `rules.choice.json`, then `rules.reviewed.json` next to the file is preferred, re-running adds only new rules and items, and `--replace` swaps an imported rule's old typed exercises for the new tap ones (flagged out of the pool; the card and its history stay):

```bash
node server/src/import-exercises.ts --file <dir>/rules.json --db ./server/recall.db --user <telegram-id> [--deck English] [--tag Grammar] [--replace] --dry-run
```

Import from the Obsidian Decks plugin into one user's collection (reads the source read-only; re-running skips what's already imported and adds what's new; `--user` defaults to `OWNER_TELEGRAM_ID`). Vocabulary goes into the English deck; Decks decks named `<prefix><topic>` become decks of Q&A facts (`--topics` defaults to `"Revolut — "`, so "Revolut — Java Core" → "Java Core", tagged `revolut`; `--topics ""` imports no topics):

```bash
node server/src/import-decks.ts --from <vault>/.obsidian/plugins/decks/flashcards.db --db ./server/recall.db --user <telegram-id> [--topics "Revolut — "] --dry-run
```

Decks are big containers (English, Programming); subjects inside are tags. To fold separate decks into one, each source's name becoming a tag on its cards (cards, schedules and history kept; duplicates stay behind and are listed; emptied sources are deleted; `--dry-run` rolls back):

```bash
node server/src/merge-decks.ts --db ./server/recall.db --user <telegram-id> --into Programming --create-into "Java Core" Concurrency Databases --dry-run
node server/src/merge-decks.ts --db ./server/recall.db --user <telegram-id> --into English Grammar "Irregular verbs" --dry-run
```

Tags with `/` are paths (`Grammar/Tenses`, `Books/wuthering heights`); filtering or searching by a tag takes the tags under it. To rename, delete or add tags across a deck (its review filter follows renames), one step or a mapping file of steps in one transaction; it prints what each step changed, `--dry-run` rolls back (see DESIGN.md *Retagging* for the mapping format):

```bash
node server/src/retag.ts --db ./server/recall.db --deck English --from "wuthering heights" --to "Books/wuthering heights" --dry-run
node server/src/retag.ts --db ./server/recall.db --deck English --delete vocab --dry-run
# the October 2026 move of the English deck to Grammar/…, Books/…, Leon/…: dry run, check the counts, then without --dry-run
node server/src/retag.ts --db ./server/recall.db --map server/scripts/retag-english-2026-10.json --dry-run
```

## Deploy (small VPS, no Docker)

Traffic path: front proxy `:443` (routes by SNI) → host `:8444` (nginx, PROXY protocol) → `127.0.0.1:8090`. Put `DEPLOY_HOST=root@<host>` in `.deploy.env` (untracked).

First time:

1. DNS: `A <domain> → <front proxy ip>`, and have the proxy send that SNI to host:8444.
2. Host: Node 24 from the official nodejs.org tarball (checksum-verified) into `/usr/local`, symlink `/usr/bin/node`; `useradd --system --no-create-home --shell /usr/sbin/nologin recall`; `install -d /opt/recall /etc/recall`. `/etc/recall/recall.env` (mode 600) from `.env.example` with `PORT=8090`, `HOST=127.0.0.1`, `DB_PATH=/var/lib/recall/recall.db`, `STATIC_DIR=/opt/recall/web/dist`, `APP_ORIGIN=https://<domain>`, `BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `ALLOW_USER_IDS` and the secrets. `deploy/recall.service` → `/etc/systemd/system/`, `systemctl daemon-reload && systemctl enable recall` (`StateDirectory` creates `/var/lib/recall`).
3. From the laptop: `scripts/deploy.sh`.
4. Host: `RELAY_IP=<front proxy ip> /opt/recall/deploy/enable-https.sh <domain>` — checks DNS, issues the certificate (acme.sh standalone, as for the other domains) and enables `conf.d/recall.conf`.
5. Import the Decks DB once: `scp` it over, run the importer as the `recall` user.

Later deploys: `scripts/deploy.sh`.

Backups: the server writes `VACUUM INTO /var/lib/recall/backups/recall-YYYY-MM-DD.db` daily and keeps 14.

## Users

Invite-only. The owner is `OWNER_TELEGRAM_ID`. Someone new sends the bot /start and taps **Request access**; the owner gets their name, @username and Telegram id with **Allow** / **Deny**. Allow lets them in at once (no restart) and sends them the app button; Deny answers politely, and they can't ask again for a week. One request at a time per person. The owner's `/users` lists who has access, with **Revoke** for the people let in from the bot (their sessions and tokens stop working). `ALLOW_USER_IDS` (comma-separated Telegram ids; restart after editing) still works next to it; those show in `/users` as from the config and are changed there. Each user has their own decks, schedule, time zone and reminders.

A new account starts with a short setup: what the app is, the level (a 3-minute vocabulary test, a pick, or "not sure"), ready-made starter words for that level plus optional packs, and how many new cards a day; then a one-time hint on the first card shows the gestures.

Signing in: inside Telegram the Mini App signs in by itself; in Safari / the installed app, "Log in with Telegram" opens the bot, which asks to confirm. `OWNER_PASSWORD` is an owner-only fallback for when Telegram is unreachable.

## Connect Claude

- **Claude Code:** create a personal token in Settings → Personal tokens; the app shows the ready `claude mcp add --transport http mnemosyne https://<domain>/mcp --header "Authorization: Bearer mn_…"` command. (The legacy `MCP_TOKEN` from the env file still works and acts as the owner.)
- **claude.ai / Claude app:** Settings → Connectors → Add custom connector → `https://<domain>/mcp`. The OAuth consent page confirms who you are through the bot.

What Claude can do through MCP: look up, add and fix words (`search_words`, `get_word`, `add_words`, `update_word`, `set_word_status`), read progress (`review_stats`, `get_leeches`, `vocabulary_profile`), add the app's content packs (`list_packs`, `add_pack`; the same as Settings → Packs, e.g. "Irregular verbs" or a level's starter words), and make flashcards from your notes: `list_decks`, `create_deck`, `search_facts`, `add_facts` (into a deck, the subject as a tag; Markdown answers, one idea per card; duplicates by question are reported, not added; `createDeck: true` creates a missing deck), `update_fact` (also moves a fact to another deck), `set_fact_status`, and grammar exercise pools: `list_exercises`, `add_exercises` (tap-based items: choose a word for the gap, or spot the mistake and pick its replacement; distractors from the rule's contrast set, exactly one grammatical option). `add_exercises` also takes `write` items (a task to write your own sentence with the rule, with an optional rubric), which the server grades with Claude when `ANTHROPIC_API_KEY` is set. With `ANTHROPIC_API_KEY` set, pools running low are topped up by Claude once a day per rule. Ask e.g. "make 10 cards on Kafka from this note into Programming".

Words and cards from Claude are studied at once (within the deck's new cards per day) and tagged `claude`; drop the ones you don't want (⋯ on the card, or in its editor) — a dropped card never comes back and Claude won't propose it again.

## Telegram

Bot: @mnemosyne_cards_bot (`BOT_TOKEN`). Each user sends `/start` once; the bot sets the menu button to the app and sends a morning reminder when cards are due, plus an evening one if nothing was reviewed that day — in the user's own time zone and times (Settings; `TZ_NAME`, `REMINDER_TIME`, `EVENING_REMINDER_TIME` are only the defaults for new users). `/due` shows today's counts.
