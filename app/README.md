# pidurable-app — project-brain agent (MVP Week 1)

Durable, local-model "project brain" assistant on **pi-durable**: token-auth HTTP/SSE API,
approval-gated external actions, parallel subagents, per-conversation workspaces, and
config-driven tool extension. Runs as a single Node container (no build step — Node runs the
TypeScript sources natively).

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
npm test                  # spawns a real server over a temp dir; 48 live-model checks,
                          # incl. SIGKILL mid-run recovery, pending-approval-across-crash,
                          # and concurrent double-submit races
```

## API (all routes require `Authorization: Bearer <API_TOKEN>`)

| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /ready` | readiness (true once the harness is open + resumed) |
| `POST /tasks` | `{content, requestId[, conversationId]}` → exactly-once submit (202 `{submissionId}`). Resubmitting a `requestId` returns the same submission. |
| `GET /stream?conversationId=&cursor=` | SSE: durable entries (id > cursor) + lifecycle events (`run_start`, `run_end`, `tool_execution_start`, `message_update`, `submission`). Reconnect with the last seen entry id as `cursor`. |
| `GET /conversations` | list all conversations: id, name, cwd, createdAt, lastEntryId, openSubmissions |
| `POST /conversations` | `{cwd?, name?}` → new conversation; `cwd` (relative, no traversal) maps to `work/<cwd>` |
| `POST /steer` | `{content, requestId[, conversationId]}` → inject input into a running turn (`whenBusy: "steer"`) |
| `GET /approvals` | pending approval requests discovered from transcript markers |
| `POST /approvals/:key` | `{decision: "approved" \| "denied"}` → durable decision; the agent retries the exact action after approval |

## Configuration

- **Env** (see `.env.example`): endpoint, token, host/port, dirs, `GATED_TOOLS`
  (comma-separated tool names requiring human approval), compaction sizing.
- **`roles.json`** — subagent roles: name → tools + instructions (`delegate` fans jobs out to
  them in parallel; `failFast: true` short-circuits on first failure).
- **`tools.json`** — declarative HTTP tools (name, description, method, url template with
  `{param}` placeholders, param schema, optional JSON-body params). Only allow-listed
  endpoints are reachable. Response bodies are rendered as `<untrusted>` data.

## Security notes (see PLAN.md §5)

- LAN-only + bearer token on every route; no public ports.
- Gated tools cannot self-approve: the hook only reads decisions, the API writes them;
  approval keys are `sha1(tool + exact args)` so crash-retries stay idempotent.
- Per-conversation `cwd` is sanitized (relative, no `..`) and maps inside `work/`.
- Web/tool output is always wrapped in `<untrusted>` delimiters; researcher subagents have no shell.
