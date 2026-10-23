# AGENTS.md — guidance for AI coding agents working in this repo

## What this is

A durable, local-model "project brain" agent on **pi-durable**. The PoC validated the
foundation (all gates passed — see `POC-FINDINGS.md`); the 2-week MVP per `PLAN.md` is in
progress. **MVP Week 1 (core) + durability hardening are merged** — see the progress log at the
bottom of `POC-FINDINGS.md`. Week 2 (Telegram client, Web UI, sandbox sidecar, D14 security pass)
is next.

## Repo layout

- `poc/` — standalone PoC scripts (`00`–`10`) + shared libs in `poc/lib/`
- `app/` — the MVP agent (TS, run natively by Node ≥22.19): `src/` (server, extensions),
  `test/api.test.ts` (48-check live-model integration suite incl. crash recovery),
  `roles.json`/`tools.json` (declarative config), `kb/` (knowledge base), `Dockerfile`.
  Run: `cd app && npm install && npm start`; test: `npm test`.
- `poc-factory/` — companion "issue → reviewed PR" factory PoC (phase 0 merged; phases 1–6
  pending). See `poc-factory/README.md`.
- `poc/.env` / `app/.env` — local secrets (gitignored); templates in `.env.example`
- `POC-PLAN.md` / `POC-FINDINGS.md` — assumptions register and results; `POC-FINDINGS.md`
  doubles as the durable progress log — update it when work completes

## Running things

- Node ≥ 22.19. `cd poc && npm install`.
- Every script auto-loads `poc/.env` if present (`lib/env.mjs`). Required vars:
  `OPENAI_BASE_URL` + `OPENAI_API_KEY` (any OpenAI-compatible local endpoint; the served
  model is auto-discovered via `/v1/models`).
- `06-telegram.mjs` additionally needs `TELEGRAM_BOT_TOKEN` (+ `ALLOWED_TELEGRAM_IDS` for access control).
- `07-sandbox.mjs` needs Podman with a running VM and the `python:3.12-alpine` image.
- Storage/work artifacts go to `poc/data/` and `poc/work/` — both gitignored. Deleting them
  loses conversation history; safe for tests, confirm before doing it on real data.

## Hard rules (non-negotiable)

- **Never commit secrets.** `poc/.env`, `*.sqlite`, `poc/data/`, `poc/work/` are gitignored —
  verify with `git status` before committing. Stage explicit paths only; never `git add -A`.
- **Git workflow:** branch from an up-to-date `main`; sign off commits (`-s`); never commit on
  `main`; never force-push shared branches; never merge PRs (the user does that in the UI).
- The live Telegram bot may be running as a background process — don't kill or restart it
  without telling the user.

## Gotchas learned during the PoC (details in `POC-FINDINGS.md`)

- `watchEvents()` returns a Promise — await it before `.start(listener)`.
- pi-ai reserves a fixed **4096-token** context safety margin; `reserveTokens` must exceed it
  or generation silently degrades to 1-token answers.
- Approval decision keys are `sha1(tool + exact args)` → approvals are per distinct action and
  idempotent across crash-retries (an approved action re-executes on retry by design).
- Telegram: gate progress-message edits on `run_start`/`run_end`, and settle (edit away)
  approval buttons after a decision; make `recordApproval` idempotent.
- Compaction summary budget = `min(0.8 × reserveTokens, model.maxTokens)`.

## Style

- ESM `.mjs`, no TypeScript in the PoC (the MVP will be TS per `PLAN.md`).
- Scripts stay standalone-runnable with clear console output — they double as acceptance tests.
- Keep `poc/.env.example` in sync with any new env vars.
