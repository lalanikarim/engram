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

## Assumption tracker

| ID | Status | Notes |
|----|--------|-------|
| A1 model agentic reliability | ⏳ pending (Phases 1, 7) | |
| A2 pi-ai ↔ Unsloth integration | 🟡 half-verified: raw endpoint works; pi-ai provider wiring untested (Phase 1) | |
| A3 durability (resume/exactly-once) | ⏳ pending (Phase 2) | |
| A4 compaction on local model | ⏳ pending (Phase 6) | ctx 228k known now |
| A5 subagent pattern | ⏳ pending (Phase 3) | |
| A6 approval hook + memo | ⏳ pending (Phase 3) | |
| A7 sandbox ExecutionEnv | ⏳ pending (Phase 5) | Docker daemon must be running |
| A8 clients (SSE + Telegram) | ⏳ pending (Phase 4) | |
| A9 web_fetch + injection hygiene | ⏳ pending (Phases 1, 7) | |
| A10 latency/usability | 🟡 data point: 5.9s trivial tool call; full battery in Phase 7 | |
