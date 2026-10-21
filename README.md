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

Content packs (ready-made topic decks, e.g. 159 irregular verbs) live in `server/data/packs/*.json` and are added per user from Settings → Topics → Packs (or MCP `add_pack`); see DESIGN.md *Content packs* for the file format.

Grammar rules with exercise pools (kept outside the repo: they come from private notes) are imported per user; a `rules.reviewed.json` next to the file is preferred, re-running adds only new rules and items:

```bash
node server/src/import-exercises.ts --file <dir>/rules.json --db ./server/recall.db --user <telegram-id> [--deck "Grammar"] --dry-run
```

Import from the Obsidian Decks plugin into one user's collection (reads the source read-only; re-running skips what's already imported and adds what's new; `--user` defaults to `OWNER_TELEGRAM_ID`). Vocabulary goes into the English deck; Decks decks named `<prefix><topic>` become topic decks of Q&A facts (`--topics` defaults to `"Revolut — "`, so "Revolut — Java Core" → "Java Core", tagged `revolut`; `--topics ""` imports no topics):

```bash
node server/src/import-decks.ts --from <vault>/.obsidian/plugins/decks/flashcards.db --db ./server/recall.db --user <telegram-id> [--topics "Revolut — "] --dry-run
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

Invite-only. The owner is `OWNER_TELEGRAM_ID`; others are listed in `ALLOW_USER_IDS` (comma-separated Telegram ids; restart after editing). Each user has their own decks, schedule, time zone and reminders. A stranger who writes to the bot gets their id back to send to the owner.

Signing in: inside Telegram the Mini App signs in by itself; in Safari / the installed app, "Log in with Telegram" opens the bot, which asks to confirm. `OWNER_PASSWORD` is an owner-only fallback for when Telegram is unreachable.

## Connect Claude

- **Claude Code:** create a personal token in Settings → Personal tokens; the app shows the ready `claude mcp add --transport http mnemosyne https://<domain>/mcp --header "Authorization: Bearer mn_…"` command. (The legacy `MCP_TOKEN` from the env file still works and acts as the owner.)
- **claude.ai / Claude app:** Settings → Connectors → Add custom connector → `https://<domain>/mcp`. The OAuth consent page confirms who you are through the bot.

What Claude can do through MCP: look up, add and fix words (`search_words`, `get_word`, `add_words`, `update_word`, `set_word_status`), read progress (`review_stats`, `get_leeches`, `vocabulary_profile`), add the app's content packs (`list_packs`, `add_pack`; the same as Settings → Topics → Packs, e.g. "Irregular verbs"), and make topic flashcards from your notes: `list_decks`, `create_topic`, `search_facts`, `add_facts` (Markdown answers, one idea per card; duplicates by question are reported, not added; `createDeck: true` creates a missing topic), `update_fact` (also moves a fact to another topic), `set_fact_status`, and grammar exercise pools: `list_exercises`, `add_exercises` (one clearly correct answer plus listed variants; hints in parentheses for gaps). With `ANTHROPIC_API_KEY` set, pools running low are topped up by Claude once a day per rule. Ask e.g. "make 10 cards on Kafka from this note into the Kafka topic".

New words and cards from Claude land in the **Inbox** and aren't scheduled until approved in the app (unless you ask for `autoApprove`).

## Telegram

Bot: @mnemosyne_cards_bot (`BOT_TOKEN`). Each user sends `/start` once; the bot sets the menu button to the app and sends a morning reminder when cards are due, plus an evening one if nothing was reviewed that day — in the user's own time zone and times (Settings; `TZ_NAME`, `REMINDER_TIME`, `EVENING_REMINDER_TIME` are only the defaults for new users). `/due` shows today's counts.
