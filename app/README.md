# engram — durable local-model project brain (kernel + solo executable)

A durable, local-model "project brain" agent on **pi-durable**, in two modes:

- **Executable mode** — `node src/main.ts` runs a single project-brain agent: chat + Web UI +
  optional Telegram client, token-auth HTTP/SSE API, approval-gated external actions, parallel
  subagents, per-conversation workspaces, config-driven tool extension, and sandboxed code
  execution in disposable Podman sidecars. No build step — Node runs the TypeScript sources
  natively (type stripping).
- **Kernel mode** — apps pin engram as a component and call `createCoreInstance()` to compose
  their own product on top of the same durable runtime. The flagship app is
  **[lalanikarim/collective](https://github.com/lalanikarim/collective)** (a fleet of project
  brains with a shared board, jobs, channels, and remote members). The kernel knows nothing
  about boards or fleets; apps install their machinery via `extraExtensions` + app-registered
  routes.

Ecosystem framing (kernel vs. apps, solo/collective/society flows):
[`docs/ecosystem-flows.md`](../docs/ecosystem-flows.md).

## Requirements

- Node ≥ 22.19 (Node 24 in the container) — native TypeScript type stripping, no compiler.
- A local OpenAI-compatible model endpoint (Unsloth on Aurora; `OPENAI_BASE_URL` + `OPENAI_API_KEY`).
- Optional: `rg` (ripgrep) for faster `kb_search` — a dependency-free Node fallback is used otherwise.
- Optional: Podman — required only for sandboxed conversations (`sandbox: true`). On macOS the
  sandbox workspace must live under `$HOME` (the Podman VM shares only the home directory).

## Run locally (solo)

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
npm test                  # live-model suites against a real server over temp dirs:
#   test/api.test.ts      91 checks: API surface, tools, approvals (tiers/rules/TTL/batching),
#                         subagents, steering, SIGKILL mid-run recovery, pending-approval-across-crash,
#                         double-submit races
#   test/telegram.test.ts 28 checks: binding, task→progress→answer, access control,
#                         inline approval button → callback → settle → retry, topic→fork, model picker,
#                         persistent allow-rules

node test/webui.test.ts   # 20 Playwright e2e checks (needs a local Playwright install —
                          # not a repo dependency): token gate, live-streamed answers,
                          # steering, approvals panel + exactly-once execution, new
                          # conversations, per-conversation model picker (create + switch + reset)

node test/sandbox.test.ts   # 16 checks (needs Podman + the sandbox image): exec timeout
                          # contract, container isolation (no host secrets, egress blocked,
                          # host FS not mounted), workspace mount, containment guard,
                          # per-task disposal + respawn

node test/hardening.test.ts # 13 checks (D14; part B needs Podman): prompt-injection probe
                          # through the real server (no exfil, no executed injected action),
                          # SIGKILL mid-run in a sandboxed conversation → orphan sweep → resume
```

Board/fleet suites live with the Collective app: `github.com/lalanikarim/collective`.

## Composable core (issue #42)

`createCoreInstance()` in [`src/core.ts`](src/core.ts) is the public seam apps build on. It
assembles config → model catalog → registry → harness → root conversation → HTTP server, and
accepts:

- `extraExtensions` — plain pi-durable extension objects, installed after the core set, before
  `Harness.open` (run with full core privilege — vet them like first-party code; consequential
  actions should register their own approval-gated tools through the existing gates mechanism)
- `routes` — app-registered HTTP endpoints, tried after core routes (how apps serve their own
  surfaces, e.g. the Collective's `GET /board`)
- `extraTokens` — extra bearer tokens accepted by the auth gate (e.g. peer tokens for an
  app's RPC surface; identity is re-resolved per route)
- `rootAgent` / `rootInit` — root conversation agent + a deterministic init commit
- optional `host`/`port` (`0` = ephemeral; actual port returned), and a deterministic idempotent
  `close()`

The package exports the app-facing surface: `import { createCoreInstance, loadConfig, ... }
from "engram"` and `import { TelegramClient } from "engram/telegram"`. Consumers get compiled
JS — `npm run build` emits `dist/` (tsc), and `prepare` runs it automatically on git installs.
Stability contract: the instance lifecycle and the extension/route/token injection points are
stable across versions; options and config fields are additive. Breaking changes require a major
version bump with a deprecation window. Covered by `test/core-instance.test.ts` (seam visibility,
route seam, teardown/port release, two instances per process).

Flows and the product-engineer reference: [`docs/ecosystem-flows.md`](../docs/ecosystem-flows.md)
(current; self-contained HTML edition alongside it) — `docs/product-core-split.md` remains the
PR #43 record for this seam API.

## Apps built on the kernel

- **[Collective](https://github.com/lalanikarim/collective)** — a fleet of project brains: a
  shared board (named members with own workspaces/models/domain memory, jobs with atomic
  single-winner claims, channels, knowledge exchange), a standing coordinator, peer trust tiers
  + allowlists, remote members on other engram instances (M2 transport + M2.2 board RPC).

Placement rules for new apps: durable state inside an instance → app-layer extension via
`extraExtensions`; read/write through public primitives only → upstream client; new HTTP
endpoint → app-registered route via the route seam (never a kernel special case); consequential
side effect from any layer → approval-gated tool.

## Web UI

Open `http://HOST:PORT/` — a single-page app (Preact + htm, served from `node_modules`,
no build step) with a token gate. Static assets are public; every data route keeps its
bearer-token requirement. It supports: conversation list + creation (with model pick), full
transcript view, live streaming via SSE (cursor-based reconnect), steering a running turn,
per-conversation model switching (chat header), and the pending-approvals panel
(Approve/Deny → 409-safe idempotent decisions). If the instance serves a `GET /board` endpoint
(as the Collective app does), a board dashboard panel appears in the sidebar; solo instances
have none.

## Sandboxed execution (D12–13)

Conversations created with `{"sandbox": true}` run their code in a **disposable Podman
sidecar**: one container per conversation, torn down when the run ends and recreated for the
next run. Code executes via `podman exec -w /sandbox`; the host workspace dir is bind-mounted
at `/sandbox`, so file tools operate on the same files (guarded so paths cannot escape the
workspace). No host env vars cross into the container, and egress is limited to
`SANDBOX_NETWORK` (default `none`). Orphaned containers from crashed runs are removed at
startup (name-prefix sweep).

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"cwd": "my-project", "sandbox": true}' http://127.0.0.1:8791/conversations
```

## API (all routes require `Authorization: Bearer <API_TOKEN>`)

| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /ready` | readiness (true once the harness is open + resumed) |
| `POST /tasks` | `{content, requestId[, conversationId]}` → exactly-once submit (202 `{submissionId}`). Resubmitting a `requestId` returns the same submission. |
| `GET /stream?conversationId=&cursor=` | SSE: durable entries (id > cursor) + lifecycle events (`run_start`, `run_end`, `tool_execution_start`, `message_update`, `submission`). Reconnect with the last seen entry id as `cursor`. |
| `GET /conversations` | list all conversations: id, name, cwd, sandbox, createdAt, lastEntryId, openSubmissions |
| `POST /conversations` | `{cwd?, name?, sandbox?, model?}` → new conversation; `cwd` (relative, no traversal) maps to `work/<cwd>`; `sandbox: true` routes execution into a Podman sidecar; `model` (`"<provider>:<modelId>"`) pins the conversation's model |
| `GET /conversations/:id/entries?after=&limit=` | full transcript entries after a cursor (history rendering, final-answer text) |
| `POST /conversations/:id/fork` | `{name?}` → fork the conversation at its current head (Telegram forum topics); falls back to a fresh sibling when the parent has no entries |
| `PATCH /conversations/:id` | `{model?: "<provider>:<modelId>" \| null}` → durable per-conversation model switch (`null` resets to the global default) |
| `GET /models` | full catalog: every provider's models with availability + the default ref |
| `POST /steer` | `{content, requestId[, conversationId]}` → inject input into a running turn (`whenBusy: "steer"`) |
| `GET /approvals` | pending approval requests discovered from transcript markers |
| `POST /approvals/:key` | `{decision: "approved" \| "denied"}` → durable decision (409 if already decided — idempotent under double-tap races) |

App-registered routes (e.g. the Collective's `/board*` family) are served by the same server
after these core routes; see the app's README for its surface.

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
  (comma-separated tool names requiring human approval), compaction sizing, Telegram settings,
  sandbox image/network (`SANDBOX_IMAGE`, `SANDBOX_NETWORK`).
- **`gates.json`** — risk-tiered approval gates: per-tool `autoPatterns` (pass silently) and
  `default: "prompt"`, plus built-in destructive patterns that always win. Optional
  `classifier` block (`enabled`, `model`, `timeoutMs`, `destructiveThreshold`): a local model
  scores each prompt-tier action before the human sees it — risk score + one-line note on the
  approval, and escalation to the destructive tier when the score crosses the threshold.
  The classifier can only escalate/annotate; it never approves or suppresses (fail-safe).
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
- Sandboxed conversations: code runs in a container with no host env vars, egress-limited
  networking, and a containment guard on every file op; the workspace mount is the only bridge.
- Web/tool output is always wrapped in `<untrusted>` delimiters; researcher subagents have no shell.
