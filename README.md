# PiDurable

A **durable, local-model "project brain" agent** built on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) (Earendil's durable agent harness), plus companion proof-of-concepts.

**Status:** the PoC validated every capability assumption (all gates passed —
[`POC-FINDINGS.md`](POC-FINDINGS.md)), and the 2-week MVP per [`PLAN.md`](PLAN.md) is in progress:
Week 1 core (API server, tools, approvals, subagents) + durability hardening, the Telegram
client (D8–9), and the Web UI (D10–11) are merged; next up are the sandbox sidecar (D12–13)
and the D14 security pass. The MVP agent lives in [`app/`](app/).

## PoC — capability validation

Every capability assumption in [`POC-PLAN.md`](POC-PLAN.md) was validated against a real local model
(27B GGUF served via an OpenAI-compatible endpoint, e.g. Unsloth Studio). Results: [`POC-FINDINGS.md`](POC-FINDINGS.md).

**All gates passed.** Summary:

| # | Capability | Result |
|---|------------|--------|
| 1 | Agentic loop — code gen + run + self-correct, multi-step edit+rerun, web fetch | ✅ |
| 2 | Durability — SIGKILL mid-run → resume; interrupted tools surface as errors; `requestId` exactly-once | ✅ |
| 3 | Parallel subagents with per-role tool restrictions; durable approval memos (agent cannot self-approve) | ✅ |
| 4a | SSE streaming with cursor reconnect — no loss, no duplication | ✅ |
| 4b | Telegram bot — tasks, progress edits, inline approval buttons, ID allowlist (live e2e) | ✅ |
| 5 | Sandboxed execution (Podman) — no host secrets, egress blocked, containment guard | ✅ |
| 6 | Context compaction — manual + natural threshold, key facts retained verbatim | ✅ |
| 7 | Benchmark battery 10/10 tasks, 0 tool errors; prompt-injection probe blocked in both roles | ✅ |

## Requirements

- **Node ≥ 22.19** (required by `pi-durable`)
- An **OpenAI-compatible local model endpoint** (Unsloth Studio, vLLM, llama.cpp server, …)
- Optional: **Podman** with a running VM for the sandbox phase (`poc/07-sandbox.mjs`)
- Optional: a **Telegram bot** for `poc/06-telegram.mjs`

## Quickstart

```bash
cd poc
npm install
cp .env.example .env    # fill in your endpoint + (optionally) Telegram settings
node 00-endpoint-test.mjs   # verify the endpoint: /models, chat, tool calling
```

Every script is standalone and auto-loads `poc/.env` if present. Storage and work
artifacts land in gitignored `poc/data/` and `poc/work/`.

## Scripts

| Script | What it proves |
|---|---|
| `00-endpoint-test.mjs` | Endpoint serves chat + valid tool calls (Phase 0) |
| `01-core.mjs` | Agentic battery: coding, multi-step edit+rerun, web fetch (Phase 1) |
| `02-durable.mjs` | SIGKILL mid-run → resume; interrupted tools surface as errors; `requestId` exactly-once (Phase 2) |
| `03-subagents.mjs` | Parallel researcher/worker fan-out with per-role tool sets (Phase 3) |
| `04-approval.mjs` | Approval gate blocks a dangerous action until a durable human decision (Phase 3) |
| `05-sse.mjs` + `05-sse-test.mjs` | SSE stream with cursor reconnect; client loses nothing, duplicates nothing (Phase 4a) |
| `06-telegram.mjs` | Full Telegram e2e: tasks, progress edits, inline approvals, ID allowlist (Phase 4b) |
| `07-sandbox.mjs` | Podman sandbox ExecutionEnv: no host secrets, egress-limited containment (Phase 5) |
| `08-compaction.mjs` | Manual compaction retains key facts verbatim (Phase 6) |
| `09-compaction-background.mjs` | Natural threshold compaction over a long conversation (Phase 6) |
| `10-bench.mjs` | Benchmark battery ×5 per task type + prompt-injection probe (Phase 7) |

## Model configuration

Scripts resolve the model endpoint in this order:

1. **`OPENAI_BASE_URL` + `OPENAI_API_KEY`** env vars — the served model is
   auto-discovered via `GET /v1/models` (prefers the model currently `loaded`). This is the supported path.
2. Fallback (local dev only): an `aurora` provider in `~/.pi/agent/models.json`.

## Creating the Telegram bot (for `06-telegram.mjs`)

1. In Telegram, message **@BotFather** and send `/newbot`.
2. Choose a display name and a username (must end in `bot`). BotFather replies with your **bot token** (`123456789:AAH…`).
3. Put the token in `poc/.env` as `TELEGRAM_BOT_TOKEN`.
4. **Access control:** Telegram bots are publicly reachable by anyone who finds the username, and BotFather has no allowlist feature — so this bot enforces one app-side. Put your **numeric** Telegram user ID(s) in `ALLOWED_TELEGRAM_IDS` (comma-separated). Find yours by messaging **@userinfobot**. With an empty list, the first message to the bot binds as owner (PoC mode only — always set this for real use).
5. Run `node 06-telegram.mjs`, then message your bot `/start` and send tasks. Gated actions show inline Approve/Deny buttons; approvals are durable across restarts.

## Security notes

- **LAN-only by design:** the agent makes outbound connections only (model endpoint, Telegram long polling); no inbound ports required.
- **Untrusted input:** web content is rendered into transcripts as delimited untrusted data; the researcher role has no shell/write tools — the injection probe in `10-bench.mjs` confirms containment.
- **Approval gates** are the control boundary: every external side effect passes a durable `beforeTool` hook; the agent cannot self-approve and decisions survive crashes.
- **Sandboxing:** generated/external code runs only in disposable Podman containers with no host secrets, limited egress, and scoped mounts.
- **Secrets hygiene:** keys live only in gitignored `poc/.env` / container env — never in transcripts or committed files.

## Layout

```
poc/                        PoC scripts + shared libs (poc/lib/)
app/                        The MVP agent (TS, Dockerfile, integration suite) — see app/README.md
POC-PLAN.md                 Assumptions register (A1–A10) + pass/fail gates
POC-FINDINGS.md             Results, assumption tracker, gotchas (doubles as progress log)
PLAN.md                     Full MVP build plan (2 weeks)
INVESTIGATION.md            Primary-source investigation of pi-durable
report.html                 Self-contained HTML version of the investigation
BRAINSTORM.md               Design questionnaire (31 questions)
brainstorm-responses.md     Completed responses driving PLAN.md
questionnaire.html          Interactive web form for the questionnaire
```

## License

MIT — see [LICENSE](LICENSE).
