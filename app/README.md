# pidurable-app — project-brain agent (MVP)

Durable, local-model "project brain" assistant on **pi-durable**: token-auth HTTP/SSE API,
approval-gated external actions, parallel subagents, per-conversation workspaces,
config-driven tool extension, and a Telegram client (long polling). Runs as a single Node
container (no build step — Node runs the TypeScript sources natively).

## Requirements

- Node ≥ 22.19 (Node 24 in the container) — native TypeScript type stripping, no compiler.
- A local OpenAI-compatible model endpoint (Unsloth on Aurora; `OPENAI_BASE_URL` + `OPENAI_API_KEY`).
- Optional: `rg` (ripgrep) for faster `kb_search` — a dependency-free Node fallback is used otherwise.

## Run locally

```bash
cd app
cp .env.example .env      # set OPENAI_BASE_URL, OPENAI_API_KEY, API_TOKEN
npm install
npm start                 # node src/main.ts
```

The server binds to `HOST:PORT` (default `127.0.0.1:8791`). Storage: `data/agent.sqlite`,
workspaces under `work/`, knowledge base in `kb/`.

## Run tests

```bash
npm test                  # two live-model suites against a real server over temp dirs:
#   test/api.test.ts      48 checks: API surface, tools, approvals, subagents, steering,
#                         SIGKILL mid-run recovery, pending-approval-across-crash, double-submit races
#   test/telegram.test.ts 18 checks: binding, task→progress→answer, access control,
#                         inline approval button → callback → settle → retry, topic→fork, state file

node test/webui.test.ts   # 14 Playwright e2e checks (needs a local Playwright install —
                          # not a repo dependency): token gate, live-streamed answers,
                          # steering, approvals panel + exactly-once execution, new conversations
```

## Web UI

Open `http://HOST:PORT/` — a single-page app (Preact + htm, served from `node_modules`,
no build step) with a token gate. Static assets are public; every data route keeps its
bearer-token requirement. It supports: conversation list + creation, full transcript view,
live streaming via SSE (cursor-based reconnect), steering a running turn, and the
pending-approvals panel (Approve/Deny → 409-safe idempotent decisions).

## API (all routes require `Authorization: Bearer <API_TOKEN>`)

| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /ready` | readiness (true once the harness is open + resumed) |
| `POST /tasks` | `{content, requestId[, conversationId]}` → exactly-once submit (202 `{submissionId}`). Resubmitting a `requestId` returns the same submission. |
| `GET /stream?conversationId=&cursor=` | SSE: durable entries (id > cursor) + lifecycle events (`run_start`, `run_end`, `tool_execution_start`, `message_update`, `submission`). Reconnect with the last seen entry id as `cursor`. |
| `GET /conversations` | list all conversations: id, name, cwd, createdAt, lastEntryId, openSubmissions |
| `POST /conversations` | `{cwd?, name?}` → new conversation; `cwd` (relative, no traversal) maps to `work/<cwd>` |
| `GET /conversations/:id/entries?after=&limit=` | full transcript entries after a cursor (history rendering, final-answer text) |
| `POST /conversations/:id/fork` | `{name?}` → fork the conversation at its current head (Telegram forum topics); falls back to a fresh sibling when the parent has no entries |
| `POST /steer` | `{content, requestId[, conversationId]}` → inject input into a running turn (`whenBusy: "steer"`) |
| `GET /approvals` | pending approval requests discovered from transcript markers |
| `POST /approvals/:key` | `{decision: "approved" \| "denied"}` → durable decision (409 if already decided — idempotent under double-tap races) |

## Telegram client (optional)

Enabled when `TELEGRAM_BOT_TOKEN` is set. Long polling only — outbound connections,
no inbound ports. The bound chat maps to the root conversation; forum topics map to forks
of it (created on first use, named after the topic). Progress streams as a single edited
message per run; gated actions get inline Approve/Deny buttons (settled after the decision);
`approve <key>` / `deny <key>` works as a text fallback. Chat bindings and the polling offset
persist in `data/telegram-state.json`, so restarts rebind without replaying updates
(`requestId = tg-<update_id>` keeps redelivered updates exactly-once).

Access control: `ALLOWED_TELEGRAM_IDS` (comma-separated numeric user IDs). With an empty list
the first message binds as owner — always set this for real use.

## Configuration

- **Env** (see `.env.example`): endpoint, token, host/port, dirs, `GATED_TOOLS`
  (comma-separated tool names requiring human approval), compaction sizing, Telegram settings.
- **`roles.json`** — subagent roles: name → tools + instructions (`delegate` fans jobs out to
  them in parallel; `failFast: true` short-circuits on first failure).
- **`tools.json`** — declarative HTTP tools (name, description, method, url template with
  `{param}` placeholders, param schema, optional JSON-body params). Only allow-listed
  endpoints are reachable. Response bodies are rendered as `<untrusted>` data.

## Security notes (see PLAN.md §5)

- LAN-only + bearer token on every route; no public ports.
- Gated tools cannot self-approve: the hook only reads decisions, the API writes them;
  approval keys are `sha1(tool + canonicalized args)` (recursively key-sorted) so logically
  identical retries — even with different JSON property order — stay idempotent.
- Per-conversation `cwd` is sanitized (relative, no `..`) and maps inside `work/`.
- Web/tool output is always wrapped in `<untrusted>` delimiters; researcher subagents have no shell.
