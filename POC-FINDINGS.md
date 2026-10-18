# PoC Findings

Per-assumption verdicts and numbers from the limited PoC (see POC-PLAN.md for gates/fallbacks).

## Phase 0 — Environment & endpoint ✅ PASS (2026-10-18)

| Check | Result |
|---|---|
| Unsloth on Aurora serving | **ACTIVE: `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF`** — quant **IQ3_S**, ctx **228,096** (native 262144), vision ✓, tools ✓, reasoning levels low/medium/xhigh |
| Endpoint | `http://aurora.infinidigm:8888/v1` (OpenAI-compatible; API key already in `~/.pi/agent/models.json` → provider `aurora`) |
| Tool calling (Gate 0 test) | ✓ `get_weather(city)` emitted correctly, `finish_reason: tool_calls`, ~5.9s for first response (`poc/00-endpoint-test.mjs`) |
| Node | v22.23.1 — satisfies pi-durable/chord/pi-ai `>=22.19.0` ✓ (product Dockerfile can still use node:24) |
| Container engine | **Podman 5.6.0 verified as Docker replacement** — VM `podman-machine-default` (applehv, 4 CPU/7.45 GiB) running; tested: basic run, two-way bind mounts from Mac FS, `--network none` egress isolation, long-lived container + streamed `podman exec`; `python:3.12-alpine` base image pre-cached. Docker.app present but daemon not running — **not needed** |
| Git | Project not yet a repo — init at MVP per plan |

### Notes & opportunities
- **Only one on-disk variant** of Qwen3.8-27B-GSQ-RCO (IQ3_S, 12.1 GB). Swapping quant/variant for the A1 fallback requires a download via Unsloth (`load --allow-remote`).
- **Same box proxies Ollama** (`aurora.infinidigm:11434`) with useful extras: embedding models (`bge-m3`, `nomic-embed-text`, `snowflake-arctic-embed2` — future `/kb` vector search), small fast models (`qwen3.5:4b/2b`, `gemma4:e2b/e4b` — candidate subagent/compaction roles for a future model pool), and larger ones (`ornith 9b/35b`, `qwen3.6:27b`).
- Studio serves exactly one active Unsloth model; the `model` field in requests is informational. Role-pooling (if needed later) means either switching the active model in Studio or routing different roles to different endpoints (e.g., Ollama for small models).
- 5.9s first response on a trivial tool call — expect multi-turn agentic loops to be noticeably slower; Phase 7 will measure real turn times.

## Phase 1 — Core harness loop ✅ PASS (2026-10-18)

Setup: `poc/01-core.mjs` + `poc/lib/aurora.mjs` (pi-ai custom provider) + `poc/lib/web-fetch.mjs`. SQLite at `poc/data/agent.sqlite`, NodeExecutionEnv cwd `poc/work`, thinkingLevel medium.

| Task | Result | Time | Tool calls | Self-corrected errors |
|---|---|---|---|---|
| T1 coding (create fib.py + run) | ✅ done | 7.0s | write, bash | 0 |
| T2 multi-step (edit + rerun, same output) | ✅ done | 8.6s | read/edit/bash ×4 | 0 |
| T3 web fetch (example.com, untrusted delimiters) | ✅ done (after fix) | ~3s | web_fetch | 0 |

**Gate: PASS** — ≤1 self-corrected tool error per task (actual: 0); schema errors across all calls: 0.

### Findings
- **A2 verified**: pi-ai ↔ Unsloth works via `createProvider` + `openAICompletionsApi()`. Wiring gotchas (now in `poc/lib/aurora.mjs`):
  - Custom model entries must carry `provider` and `baseUrl` fields explicitly — `createProvider` does **not** inject them (missing `provider` → "Unknown provider: undefined" at generation).
  - `CodingTools` is exported from `@earendil-works/pi-durable/tools`, not the package root.
  - Tool `execute()` returns `{ output: [...] }` for the model-facing channel — returning `content:` is silently ignored (empty tool result). Cost fields are $/M-token; local = all zeros.
- **A1 nuance (model reliability)**: on T3's first attempt the model **hallucinated its own toolset** — claimed `web_fetch` was unavailable although the system entry proves it was offered. When explicitly told the tool exists, it called it correctly. → Mitigation for MVP: state capabilities explicitly in instructions; candidate argument for a stronger orchestrator model later (role pool).
- **API gotcha**: `harness.root(ctx, {agent})` applies the agent config **only when creating** the root conversation; on an existing root the options are ignored — use `conversation.configure(change, ctx)` to change model/thinking/tools.
- **Env cwd must be absolute** — a relative `./work` resolved against the wrong base ("working directory does not exist: .../work/work").
- **Latency (A10 data point)**: full agentic turns took 3–9s on the 4090 — faster than expected; Unsloth is fast enough for interactive use. Token spend per task was small (in/out ≈ 1.1k/0.3k, 1.2k/0.75k, 1.3k/0.84k).

## Phase 2 — Durability (crash recovery + exactly-once) ✅ PASS (2026-10-18)

Test: `poc/02-durable.mjs` — task with a 15s in-flight bash call; parent process `kill -9` mid-sleep; fresh process reopens same SQLite.

| Test | Result |
|---|---|
| SIGKILL mid-run → reopen + `resume()` + wait on same submission | ✅ PASS — status=done 23.5s after restart; `done.txt` created; no lost work |
| In-flight tool call at crash point | Recorded as explicit **interrupted** error result ("Tool bash was interrupted and may have partially run"), surfaced to the model, which retried once and succeeded — **no silent re-run** |
| Double-submit same `requestId` | ✅ PASS — second submit returned the identical submission id (8==8); exactly one user entry in transcript |

### Findings
- **A3 verified.** Recovery semantics: completed work is never lost or silently re-executed; an in-flight tool call at crash time becomes an explicit `interrupted` diagnostic result, and the *model* decides whether to retry. This matches the PLAN.md design (per-tool replay policies).
- **MVP implication**: side-effecting tools (e.g., anything mutating external state) need idempotency keys / per-tool replay policy so a model-initiated retry after interruption is safe. Read-only tools are trivially safe.

## Phase 3 — Subagents + approval gating ✅ PASS (2026-10-18)

### 3a — Subagents (`poc/03-subagents.mjs`, `poc/lib/worker.mjs`)
Orchestrator (root conversation, tools = `[delegate]` only) delegates two jobs in one parallel fan-out:
- researcher → own conversation, tools = `[web_fetch]` only → fetched example.com ✓
- worker → own conversation, tools = `[read,write,edit,bash]` → created `subagent.txt` ✓

**Result: PASS in 12.4s.** Both results returned to the orchestrator; side effect verified on disk.

### 3b — Approval hook + durable decision (`poc/04-approval.mjs`, `poc/lib/approvals.mjs`)
Flow: model calls `dangerous_action` → `beforeTool` hook blocks with approval key (sha1 of tool+args, stable across retries) → driver (standing in for Telegram inline button) writes `{decision:"approved"}` into a session doc family → model retries same args → hook sees approved → action executes.

| Test | Result |
|---|---|
| Happy path: block → approve → retry → executed | ✅ PASS, exactly one execution |
| **True mid-run SIGKILL** while approval pending → restart → recover | ✅ PASS — in-flight run resumed; approval key found in durable transcript; approved after restart; action executed once |

### Findings & API gotchas (now encoded in the PoC libs)
- **Task definitions must be registered** via an extension's `tasks:` array — a task created by name but not installed → scheduler blocks with `missing_task`.
- **`runtime.commit()` callback must return a NextTaskState or undefined** — returning anything else (e.g. an id) corrupts the task state write (SQLite bind error).
- **No `tx.snapshot()`** inside commits; use `runtime.registry` outside the commit for registry reads.
- **Approval key = f(tool, args)**, not call id: a retry gets a new callId, so decisions must key on stable action identity. Decisions live in a session doc family (writable by the app/driver, readable by hooks via `api.snapshot`) — task memos are invocation-writable only, so they can't carry external approvals.
- **Node exits when the event loop drains** even with durable work pending (all parked on watches) — harmless for durability (reopen + resume continues), but long-lived drivers must keep something active or accept restarts.

## Phase 4 — Clients: SSE ✅ PASS / Telegram 🟡 code ready, needs bot token (2026-10-18)

### 4a — SSE with cursor reconnect (`poc/05-sse.mjs`, `poc/05-sse-test.mjs`)
Server on 127.0.0.1:879x, bearer-token auth. Durable entries are cursor-addressable by entry id; ephemeral progress events (tool start/end, usage) are best-effort.

| Test | Result |
|---|---|
| Client A from cursor 0, dropped mid-run | Captured entries up to id 10 |
| Client B reconnects from cursor=10 | Captured the rest; run_end observed |
| Merged A∪B vs full transcript | **Identical — no lost, no duplicated entries** |
| Duplicate `POST /submit` same requestId | Idempotent (202, one execution) |

**Gate: PASS.**

### Findings
- **Durable entries arrive via**: attach/overflow `snapshot`, `message_end.entry`, `tool_execution_end.entry`, and placed user submissions (fetched by id from the `submission` event). There is no standalone per-entry live event — SSE must extract entries from those carriers.
- Cursor semantics: entry ids are monotonic per conversation; server sends strictly `id > cursor`; client-side dedup makes delivery exactly-once across reconnects.

### 4b — Telegram long-polling bot (`poc/06-telegram.mjs`) — **awaiting user's bot token**
Written and syntax-checked; outbound-only (getUpdates long polling, no inbound ports). Features: chat-bound owner, `requestId = tg-<update_id>` (exactly-once vs Telegram retries), one throttled progress message per run, final answer on `run_end`, blocked sensitive action → inline Approve/Deny buttons → durable decision in the same ApprovalDoc family as Phase 3 → retry instruction.
**To test end-to-end:** create a bot via @BotFather → `/newbot`, then provide the token (will be stored in gitignored `.env`).

## Assumption tracker

| ID | Status | Notes |
|----|--------|-------|
| A1 model agentic reliability | ✅ verified Ph.1 (0/3 self-corrected errors); injection probe still pending (Ph.7). Caveat: one toolset hallucination — mitigate via explicit capability notes | |
| A2 pi-ai ↔ Unsloth integration | ✅ verified: custom openai-completions provider works; gotchas documented in Phase 1 findings | |
| A3 durability (resume/exactly-once) | ✅ verified: SIGKILL→resume recovers, no silent re-run; requestId exactly-once confirmed. In-flight tools surface as explicit interrupted errors | |
| A4 compaction on local model | ⏳ pending (Phase 6) | ctx 228k known now |
| A5 subagent pattern | ✅ verified: parallel fan-out, per-role tool restrictions, owned worker conversations; task defs must be registered via extension tasks: | |
| A6 approval hook + memo | ✅ verified: beforeTool block → durable decision in session doc family → retry allowed; survives mid-run SIGKILL. Agent cannot self-approve (only driver writes decisions) | |
| A7 sandbox ExecutionEnv | ⏳ pending (Phase 5) | Docker daemon must be running |
| A8 clients (SSE + Telegram) | 🟡 SSE ✅ PASS (cursor reconnect exact); Telegram bot written, e2e pending user's bot token | |
| A9 web_fetch + injection hygiene | 🟡 tool works with untrusted delimiters (Ph.1); adversarial probe pending (Ph.7) | |
| A10 latency/usability | 🟡 data point: 5.9s trivial tool call; full battery in Phase 7 | |
