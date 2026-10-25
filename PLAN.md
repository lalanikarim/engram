# Pi Durable Build Plan — "Project Brain" Agent

Derived from `brainstorm-responses.md` (2026-10-18). Sources of truth: INVESTIGATION.md, report.html.

## 1. Design decisions (from the questionnaire)

| Area | Decision | Consequence |
|---|---|---|
| Purpose | Personal assistant / project brain | One long-lived root conversation + documents (todos/plans) + compaction for weeks-long context |
| Users | Just me, 1 human at a time | No multi-user auth complexity; still build the client API properly |
| Work | Shell/sysadmin, web research, data analysis, monitoring/scheduled checks, code read/edit/test | CodingTools + web tools + sandboxed execution + background tasks |
| Autonomy | Autonomous; dangerous/external actions need human approval | `beforeTool` hooks + memos; approval surface in Telegram (inline buttons) and Web UI |
| Duration | Indefinite standing conversations | Background compaction tuned for local models; handoff notes for fresh context |
| Multi-agent | Core: orchestrator + specialized workers, parallel workstreams | Subagent tool creating owned conversations per role; concurrent by design |
| Tools | Web fetch, browser automation later, codemode; **extend via config without code changes** | Config-driven HTTP tool loader (JSON-declared tools → generated `defineTool` wrappers) |
| Memory | Searchable knowledge base (my docs, project wikis) | `/kb` volume + ripgrep-based search tool first; embeddings later (local embedding model) |
| Hosting | Always-on home server (MacBook Air or Linux laptop), 24/7 one box, auto-restart | Docker on the box; compose/systemd restart policies; **sleep must be disabled** (caffeinate / systemd-inhibit / lid settings) — operational risk noted in PoC plan |
| Packaging | Single container image (+ sandbox sidecar — see §5), **Podman** as container engine (verified on the Mac; Docker not required) | One image built from a Dockerfile (`podman build`); sandbox as a second lightweight service via `podman run` script (no compose dependency) |
| Storage | SQLite (accept last-commit loss on hard power failure) | PVC/volume at `/data/agent.sqlite`; `resume()` on every start |
| Tool execution | Mix: local for dev, sandboxed for generated/untrusted code | Per-conversation ExecutionEnv; disposable sandbox containers for code gen/test |
| Agents | Many/dynamic — spawn per project or ticket | Conversation-per-project with own `cwd` (`/work/<project>`); created on demand via API |
| Budget | No cloud spend | Local models only |
| Primary client | Chat platform bot → **Telegram** (per E3) | Telegram Bot API via **long polling** — outbound only, no inbound port needed (fits LAN-only) |
| Additional clients | Email, agent-to-agent (MCP bridge), dashboards, cron/scripts | Roadmap items; API is already shaped for them |
| Exposure | Localhost / trusted LAN only | No public IP/ports; token auth on the API regardless |
| Crash recovery | **Critical** — exactly-once matters | `requestId` everywhere; replay policies per tool; approval decisions in memos |
| Risk tolerance | External side effects allowed with approval gates | Gates on: deploy, send email/message, payments, any non-local write outside /work |
| Models | **Local only** — Unsloth on Aurora serving `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF` via OpenAI-compatible endpoint (API key set in config when ready) | pi-ai openai-compatible provider → Aurora endpoint; single model for all roles initially, role pool later if PoC shows quality/latency gaps |
| Security | Top constraint: no loss of control to hackers/malware | Dedicated security model in §5 |

## 2. Architecture

```
                    ┌──────────────────────────── home server (LAN only) ────────────────────────────┐
                    │                                                                                │
 Telegram ◄──long polling (outbound)──┐                                                            │
 Web UI   ◄──HTTP + SSE────────────────┤                                                            │
 (later: email, MCP bridge, cron)      │                                                            │
                    │            ┌──────▼──────────────────────────────────────────┐                │
                    │            │  agent container (single Docker image)          │                │
                    │            │  ├─ HTTP/WS API server (token auth)             │                │
                    │            │  │    POST /tasks {content, requestId}          │                │
                    │            │  │    GET  /stream?conversationId&cursor (SSE)  │                │
                    │            │  │    GET  /conversations · POST /conversations │                │
                    │            │  │    POST /steer · POST /approvals/:id         │                │
                    │            │  ├─ Harness over SQLite (/data/agent.sqlite)   │                │
                    │            │  │    resume() on startup                       │                │
                    │            │  ├─ Extensions: CodingTools, web_fetch, kb_search,│             │
                    │            │  │    approval hook (memo), subagent tool,      │                │
                    │            │  │    config-driven HTTP tools                  │                │
                    │            │  └─ env: per-conversation → /work/<project>     │                │
                    │            │         or sandbox container id                 │                │
                    │            └──────────────┬──────────────────────────────────┘                │
                    │                           │ exec (sandboxed code gen/test)                     │
                    │            ┌──────────────▼───────────┐        ┌──────────────────────┐       │
                    │            │ sandbox sidecar container │        │ /data  (SQLite)      │       │
                    │            │ disposable per task,      │        │ /work  (projects)    │       │
                    │            │ no host secrets, egress-  │        │ /kb    (knowledge)   │       │
                    │            │ limited                   │        └──────────────────────┘       │
                    │            └───────────────────────────┘                                       │
                    └────────────────────────────────────────────────────────────────────────────────┘
                                        ▲ OpenAI-compatible (local models, on your GPU box / LAN)
```

### Conversation model
- **Root conversation** = the standing "project brain" (weeks long, compacted in background).
- **Project conversations** = one per project/ticket, `cwd: /work/<project>`, spawned on demand (API or subagent tool). Forks for threads/variants.
- **Worker conversations** = subagents owned by an orchestrator task: roles like `researcher` (read-only tools, no shell), `worker` (coding tools in sandbox), `reviewer` (read + test). Each with its own model from the pool.
- **Background tasks** = scheduled checks ("verify X daily"), reminders, long-running jobs — survive restarts by design.

### Approval flow (D2/A4)
1. Tool call hits a gated tool (deploy, send message, payment, write outside /work).
2. `beforeTool` hook checks memo → if none, writes a pending-approval document and pauses (blocks the call), notifies Telegram + Web UI.
3. Human taps Approve/Deny (Telegram inline button or web click) → `POST /approvals/:id`.
4. Hook resumes; decision stored in **memo** — a crash between ask and answer never re-asks, and the decision survives restarts.

## 3. Model strategy (local-only constraint)

- pi-ai configured with an OpenAI-compatible provider pointing at your local endpoint(s) (e.g., Unsloth/vLLM/Ollama on the GPU box).
- **Start with one model** (`ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF` via Unsloth on Aurora) for all roles. If the PoC shows quality or latency gaps, introduce a **model pool per role** (config, hot-swappable via registry):
  - `orchestrator` — strongest local model you can serve comfortably
  - `worker` — strong coder GGUF (this is where quality matters most)
  - `researcher` / `triage` / subagents — smaller, faster variants
  - `compaction` — mid-size; compaction summaries run in background
- **Honest risk:** local models are weaker than frontier APIs at long-horizon agentic coding. Mitigations: role splitting, structured outputs, approval gates as the safety net, and keeping the provider config swappable so a cloud key can be added later if B7 ever relaxes.
- Compaction tuning for local models: raise `reserveTokens` (start compacting earlier) and prefer manual compaction with explicit instructions ("keep the failing test names") at natural breakpoints; older messages stay searchable regardless.
- Track per-conversation token usage in `pi.usage` even without cost — visibility into which roles burn context.

## 4. Two-week MVP (per E3)

**Scope: Telegram + Web UI clients, web fetch, local code generation & testing, list/continue any conversation.**

### Week 1 — core
- **D1–2 Scaffold:** Node 24 + TS app; Dockerfile; `Harness.open(sqlite /data)` → `resume()`; health/readiness endpoints (ready after resume); model config for the local endpoint(s). Pin all versions.
- **D3–4 API server:** token auth; `POST /tasks` (`requestId` exactly-once), `GET /stream` (SSE from `watchEvents()`, cursor reconnect), `GET/POST /conversations` (list/create with cwd), `POST /steer`.
- **D5–7 Extensions & tools:**
  - CodingTools scoped to `/work/<project>` per conversation
  - `web_fetch` tool (`replay: "safe"`) — fetch + readability-extract, content rendered as clearly-delimited untrusted data (prompt-injection hygiene)
  - `kb_search` tool (ripgrep over `/kb`)
  - Approval hook + pending-approval document + `POST /approvals/:id`
  - Subagent tool: owned conversation per role, role configs (model/tools/instructions), parallel fan-out with `failFast`
  - Config-driven HTTP tool loader: tools declared in YAML/JSON → generated `defineTool` wrappers (A8: extend without code changes)

### Week 2 — clients + sandbox + hardening
- **D8–9 Telegram client:** bot via **long polling** (no inbound port); chat ↔ root conversation, forum topics/threads ↔ forks; progress streamed as edited messages; **inline approval buttons**; results posted on completion.
- **D10–11 Web UI:** minimal React app — conversation list ("continue any conversation" = pick one, resume its stream), chat view over SSE with steering box, pending-approvals panel, live tool output.
- **D12–13 Sandboxed execution:** sandbox sidecar container (disposable per task); custom ExecutionEnv mapping code-gen/test conversations into it; no host secrets inside; egress-limited; results back through the env interface.
- **D14 Hardening & docs:** crash tests (kill -9 mid-run → restart → verify resume + no duplicate effects), double-submit test (same `requestId`), security checklist pass (§5), README, version pins.

### MVP acceptance criteria
1. Container killed mid-tool-call → restarts → run continues from checkpoint; gated external effect never fires twice.
2. Same `requestId` submitted twice → one run, same submission returned.
3. Telegram: send task → watch progress → approve a gated action via inline button → receive result.
4. Web UI: list conversations → open any (including old ones) → continue it with live streaming.
5. Agent fetches a web page and answers from it; writes code in `/work/<project>` and runs its tests inside the sandbox.

## 5. Security model (E2 — top constraint)

Threats: (a) network attackers reaching the agent, (b) prompt injection via untrusted content (web pages, email), (c) malicious/buggy generated code escaping the sandbox, (d) supply chain (third-party tools/packages).

1. **Network surface:** LAN-only; no public IP or inbound ports. Telegram uses outbound long polling — the only "external" channel needs zero inbound exposure. API bound to LAN interface + bearer token (still, even on a trusted LAN).
2. **Untrusted input handling:** web/email content is always rendered into the transcript as delimited data blocks, never as instructions; researcher role has **no shell and no write tools** — injected "commands" from a web page can't execute anything in that conversation.
3. **Execution isolation:** generated/external code runs only in disposable sandbox containers (per-conversation env id); sandbox gets no host secrets, minimal egress, read-only mounts except its own workspace; the main agent's shell is scoped to `/work`.
4. **Approval gates as the control boundary:** every external side effect (deploy, send message/email, payment, write outside /work) passes a `beforeTool` hook with memo — the agent cannot self-approve, and decisions survive crashes.
5. **Secrets hygiene:** API keys/model endpoints in container env only; never written into transcripts or documents; sandbox containers get none.
6. **Supply chain:** pin exact versions of pi-durable/pi-ai/chord + all deps; review any third-party tool/package source before installing (pi packages execute code); config-driven tools only call allow-listed endpoints.
7. **Containment last line:** the agent container itself runs unprivileged, with **no container-engine socket** inside it (sandbox containers are started by a tightly-scoped CLI wrapper around `podman` run/exec that only allows the approved base image and mounts), and the box's firewall restricts what the sandbox can reach on the LAN.

## 6. Roadmap after MVP (from C2/E4)

Detailed plans for in-flight/next items live in [`docs/plans/`](docs/plans/) (model catalog — done;
smarter approvals — phase 1 done, phases 2–4 next).

- **Smarter approvals** — risk-tiered gating (`gates.json`), destructive-action guard that always
  wins, persistent global allow-rules, rich prompts with denial reasons, 24 h TTL. Plan:
  [`docs/plans/approvals.md`](docs/plans/approvals.md).
- **Email client** — IMAP poller → submit with `requestId`; replies via SMTP; approval-gated sending.
- **Agent-to-agent / MCP bridge** — expose the agent over MCP so other agents (e.g., a pi coding agent session) can drive it; codemode already bridges tools.
- **Dashboards** — read-only clients on `documentState`/`viewState`: costs/tokens, todos, run status.
- **Scheduled checks** — cron submissions (`requestId = job-<date>`), background tasks with timers, results delivered to Telegram.
- **Report generation + network sharing** — agent writes reports to a served directory (static HTTP on the box); "readily accessible over the network" per E4.
- **Browser automation** — Playwright inside the sandbox container (forms, JS-heavy sites), `replay: "never"` semantics with state checks.
- **Knowledge base v2** — local embedding model + vector search tool over `/kb`.
- **Dynamic agent spawning** — API creates a project conversation + sandbox on demand per ticket.

## 7. Resolved decisions (2026-10-18 follow-up)
1. **Model endpoint:** Unsloth on Aurora serving `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF` (OpenAI-compatible). API key goes in config when ready to verify. Single model for all roles initially.
2. **Sandbox packaging:** confirmed — 2-service compose (agent + sandbox sidecar).
3. **Telegram:** setup steps included in POC-PLAN.md (Phase 4).
4. **Home server hardware:** MacBook Air or Linux laptop → 24/7 operation depends on disabling sleep (caffeinate / systemd-inhibit / lid closed handling). Operational risk to handle before "always-on" claims.
5. **`/kb` initial content:** instructions about how to use the agent (the agent's own usage docs — dogfooding).

## 8. Next step
PoC passed all gates; **the full 2-week MVP is complete**: Week 1 core + durability
hardening, Telegram client (D8–9), Web UI (D10–11), sandbox sidecar (D12–13), and the D14
hardening & security-checklist pass are all merged (see the progress log at the bottom of
`POC-FINDINGS.md`). Remaining: post-MVP follow-up — §5 item 7 container packaging (unprivileged
agent container, engine socket kept out, scoped podman wrapper in a 2-service compose,
host firewall rules).

## 9. Post-MVP direction — open decisions (2026-10-24)

The MVP is complete and verified; what comes next is a strategic fork, not a continuation.
Three directions:

**A. Make it operational** — run it daily: start a live instance (Web UI on LAN + Telegram),
disable sleep on the home-server box (PLAN §7 decision 4). §5 item 7 packaging is only urgent if
the agent will be exposed beyond trusted-LAN.

**B. Expand capability** — PLAN §6 roadmap, ranked by leverage for a *single-user project brain*:

| Option | Leverage |
|---|---|
| **Scheduled checks** (cron → durable submit → Telegram result) | Biggest "brain" upgrade: turns it from reactive to proactive. Low–med effort; reuses durable submit, Telegram, approvals |
| **MCP bridge** | Makes the brain drivable by other agents (pi, herdr workers) — a shared substrate, not a siloed bot. High leverage for multi-agent setups |
| **KB v2** (local embeddings + vector search over `/kb`) | Makes memory real; today `kb_search` is ripgrep (works, crude) |
| **Dynamic spawning** (conversation + sandbox per ticket on demand) | Scale-out endgame: on-demand isolated project conversations |
| Email client / Dashboards / Browser automation | Useful but narrower or read-only |

**Working recommendation:** if the goal is a *daily personal driver*, do **A (live instance +
sleep-disable) → B: scheduled checks** first (shortest path from verified MVP to proactively
useful, reuses almost everything built). If the goal is a *multi-agent substrate*, lead with the
**MCP bridge**. If the goal is *real memory/knowledge*, lead with **KB v2**.

**Open questions that decide the plan:**
1. What's the end goal — daily personal driver, multi-agent substrate, or a specific use case?
2. Where will it run long-term — this Mac, a dedicated home-server box, exposed beyond LAN? (Decides whether item 7 + sleep-disable are now or later.)
3. Is it time to run it live, or is this still build-phase?

*Decision log: record the answers here when resolved.*

### Decision log (2026-10-25)

- **Multi-provider model support** (merged as PR #21 + #22; spec in
  `docs/plans/model-catalog.md`): the app registers all pi-supported providers plus custom
  models from the global pi config (`~/.pi/agent/models.json` + `auth.json`) — no key
  duplication. Model refs are `<provider>:<modelId>` (first-colon split). The global default is
  operator-configured via `DEFAULT_MODEL` (no provider preferred out of the box); each
  conversation can durably pin its own model (API `PATCH`, Telegram `/model` button picker).
  This deliberately relaxes §1 "local models only / no cloud spend": hosted providers
  (e.g. opencode-go) are available per operator choice, and local hosts remain the default
  fallback.
- **Smarter approvals** (planned; spec in `docs/plans/approvals.md`): risk-tiered gating with a
  destructive-action guard that always wins and can never be allow-listed; persistent global
  allow-rules ("always allow"); rich prompts with denial reasons fed back to the agent; 24 h
  TTL auto-deny. Phases: tiers+guard+prompts → rules → TTL → batching; classifier scoring deferred.
