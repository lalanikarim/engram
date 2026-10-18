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

## Assumption tracker

| ID | Status | Notes |
|----|--------|-------|
| A1 model agentic reliability | ✅ verified Ph.1 (0/3 self-corrected errors); injection probe still pending (Ph.7). Caveat: one toolset hallucination — mitigate via explicit capability notes | |
| A2 pi-ai ↔ Unsloth integration | ✅ verified: custom openai-completions provider works; gotchas documented in Phase 1 findings | |
| A3 durability (resume/exactly-once) | ⏳ pending (Phase 2) | |
| A4 compaction on local model | ⏳ pending (Phase 6) | ctx 228k known now |
| A5 subagent pattern | ⏳ pending (Phase 3) | |
| A6 approval hook + memo | ⏳ pending (Phase 3) | |
| A7 sandbox ExecutionEnv | ⏳ pending (Phase 5) | Docker daemon must be running |
| A8 clients (SSE + Telegram) | ⏳ pending (Phase 4) | |
| A9 web_fetch + injection hygiene | 🟡 tool works with untrusted delimiters (Ph.1); adversarial probe pending (Ph.7) | |
| A10 latency/usability | 🟡 data point: 5.9s trivial tool call; full battery in Phase 7 | |
