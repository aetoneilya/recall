# CLAUDE.md

Notes for coding agents working in this repo. What the project is, how to run it and the scripts: [README.md](README.md).

## Where the spec lives

- [DESIGN.md](DESIGN.md) — architecture, data model, API, MCP tools, packs, the review queue.
- [web/DESIGN.md](web/DESIGN.md) — the app's visual design: tokens, layout, every screen.
- [web/PRODUCT.md](web/PRODUCT.md) — what the app does for its user, feature by feature.

They describe the current behaviour, not plans. A change in behaviour updates them in the same commit.

## Before every commit

- `npm run check` — typecheck and tests in all workspaces — must pass. Behind a proxy, run npm without the proxy variables (see README).
- UI changes: look at them in the browser with `npm -w @recall/web run dev` and `http://localhost:5173/?mock` (fake in-memory API, no server needed).

## Code

- The server runs `.ts` directly (Node type stripping): erasable TypeScript only — no `enum`, `namespace` or parameter properties; imports keep the `.ts` extension.
- `packages/core` is shared by the server and the offline client: scheduling and study-day rules go there, not into one side.
- Match the surrounding code: its naming, its comment density (comments say why), small functions, no new dependencies without a reason.
- Tests sit next to the code in `web/src/lib/*.test.ts` and `packages/core`, and in `server/test/`. New behaviour comes with a test.
- Schema changes: append a migration to the list in `server/src/db.ts` (tracked by `PRAGMA user_version`); never edit an existing one.

## Learning rules

The scheduling is deliberate; don't change these without the owner asking:

- FSRS learning steps (1m, 10m; relearning 10m). Good on a new card is rechecked in 10 minutes on purpose.
- Within a session a card comes back no sooner than 10 other cards or 5 minutes later.
- After a session ends, learning cards come back as a round of at least 10 (`BATCH`); fewer wait for the next day.
- No waiting screens and no "show now" buttons.

## Public repo

This repository is public. Never commit:

- server addresses, hostnames of personal infrastructure, network or proxy setup;
- personal data: Telegram ids, emails other than the commit author's, names;
- content from the owner's private notes (their grammar rules, their programming cards) — those are imported per user from files outside the repo.

The deploy host lives in the untracked `.deploy.env`. Use placeholders such as `<telegram-id>` in docs.

## Git and deploy

- Commit straight to `main` once checks pass; push after committing.
- No AI attribution anywhere: no `Co-Authored-By` trailers for an assistant, no "Generated with …" lines.
- `scripts/deploy.sh` ships to production — run it only when the owner explicitly asks.
- Never print production secrets (the server's env file).
