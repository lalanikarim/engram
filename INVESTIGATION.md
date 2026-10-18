# Pi Durable — Investigation

Sources:
- Announcement: https://earendil.com/posts/pi-durable/
- Package docs (npm README): https://www.npmjs.com/package/@earendil-works/pi-durable
- Vercel durable-harness guide: https://vercel.com/docs/agent-harnesses/pi
- Temporal integration (pi-temporal): https://temporal.io/blog/the-immortal-life-of-pi-running-the-pi-coding-agent-on-temporal
- Kubernetes agent-sandbox example: https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/pi-code-agent/
- Related package: pi-durable-subagents — https://pi.dev/packages/pi-durable-subagents

## 1. What it is

Pi Durable (`@earendil-works/pi-durable`) is an **experimental durable agent harness** from Earendil, shipped with Pi 1.0 (Oct 2026). It is *not* the Pi coding agent — it's a framework for building any agentic application (coding agents included) that:

- runs anywhere there is a JavaScript runtime,
- supports infinitely long conversations,
- survives catastrophic internal and external failures,
- lets multiple humans/clients steer the same agents.

Core model: **a harness opens over a storage backend** and runs conversations on it. Everything — model calls, tool calls, compaction, your own state machines — is a *task* that checkpoints before moving on. All changes go through one line of atomic commits; nothing is shown before its commit is stored.

Built on `@earendil-works/pi-ai` (model access) and `@earendil-works/chord` (document state). Entire source ≈ 15,000 lines (~150–250k tokens), so it's readable by an agent. **Experimental: API changes without notice.**

```
npm install @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

## 2. Features

### Durability / crash survival
- Every step is a task with a checkpoint before it advances. If the process dies, a new process opens the same storage, finds unfinished tasks, and continues from the last checkpoint: `harness.resume()`.
- A model request cut off mid-stream is resent (partial answer stays in transcript, marked aborted).
- Tool calls cut off mid-run rerun **only if declared `replay: "safe"`**; otherwise the model is told the call was interrupted with output-so-far and decides what to do.
- `requestId` on submissions makes them **exactly-once**: a client retrying after a crash gets the original submission back, not a duplicate. `harness.submission(id)` re-acquires a submission after restart.

### Runs anywhere
- Storage backends shipped: **memory, SQLite (Node), JSONL** + a conformance suite and benchmarks for custom backends. The SQLite/JSONL code uses no Node APIs → runs on Bun or inside a Cloudflare Durable Object with a small adapter.
- The storage interface is small; easy to implement over Postgres, a KV store, etc.
- **One process owns a storage at a time**; other clients attach to that process (no cross-process locking in built-in backends — important for k8s design).
- Working set in memory only: active transcripts (bounded by context window via compaction), live tasks, pending submissions. Everything else stays on disk.

### Long runs
- **Compaction** is a durable background task: when the context nears the model limit, older messages are summarized in the background and placed at the next turn boundary; the conversation only waits for the summary if the next request wouldn't fit otherwise. Older messages always stay in storage.
- `reset()` / handoff notes start a fresh context without deleting history (searchable afterwards).

### Many conversations at once
- One harness runs many concurrent conversations, none blocking another.
- **Forks**: any conversation can fork at any point in its transcript (e.g., Slack channel = conversation, thread = fork). Forks see the parent's history up to the fork point without copying it.
- Each conversation stores its own **agent config**: model, thinking level, selected extensions/tools, extra instructions, working directory. A reviewer can run a cheaper model with read-only tools and its own checkout.

### Extensions (pluggable everything)
- An extension = named bundle of **system prompt sections, tools, hooks, wraps (decorators), tasks**. Installed in a registry; each conversation selects which extensions/tools it uses (stored by name, not code).
- System prompt is rebuilt from sections before every request; only changes are re-sent (prompt cache stays warm); changes are recorded positionally in the transcript.
- **Malleable**: the registry can change while conversations run — install under an existing name to replace it atomically. Running calls finish on old code; next call uses new code.

### Tools
- Built-in `CodingTools`: read, write, edit, bash (via the execution environment). Image support via optional Photon WASM processor.
- Custom tools via `defineTool` with TypeBox schemas. Three result channels: `output` (model), `structuredOutput` (programs calling the tool), `details` (UIs).
- `api.output()` streams running output to watchers.
- **Calling tools from tools**: `api.executeTool()` — nested calls are their own durable tasks with their own replay policy; keys make retries idempotent.
- `callers: ["model" | "tools"]` controls who may call a tool; `modelTools` narrows what the model is offered.
- **Code Mode**: a `codemode` tool where the model writes JavaScript calling tools in a QuickJS sandbox; scripts survive restarts via deterministic replay + journaled results.

### Hooks
- Step into built-in tasks (generation, tool call, compaction): `beforeTool`, `afterTool`, `onYield`, `afterResponse`, etc. Can rewrite/block/replace. Multiple hooks chain in selection order.
- **Memos**: a hook that makes a decision stores it with the task; after a crash the memo is found instead of re-deciding (e.g., "ask Slack for approval once" pattern).

### Custom durable tasks
- `defineTask` with phases, checkpoints, ownership tree, timers that survive restarts, waiting on other tasks (`on: [taskIds]`, policy `failFast`), and **abort handlers that clean up effects** (e.g., refund payments when a sibling card is declined).
- Foreground tasks = part of the current work (Esc aborts them); background tasks outlive the turn.

### Documents (durable application state)
- Typed JSON stored next to the transcript, changed in the same atomic commits — app state can never disagree with the transcript that produced it.
- Fork semantics per doc: `asOf` (parent's value at fork point), current, or fresh.
- UIs subscribe to committed values (`harness.documentState(...).subscribe(...)`).

### Multiplayer / remote clients
- Everything a UI needs is committed state → any number of clients attach to any conversation, join late, reconnect from the current view, and steer.
- `viewState()` + `subscribe()` for full views; **`watch()` delivers the exact operations of every commit** (small, socket-friendly); `watchEvents()` maps commits to the Pi coding agent's familiar events (more bytes).
- Steering a busy conversation: `submit({ type: "input", content, whenBusy: "steer" })` — joins after the current tool calls.

### Subagents
- Not built in, but trivially composable: a tool creates an owned conversation (own model/instructions/tools), submits work, waits for the answer. The subagent is a durable conversation → survives crashes, counts its own cost, shows in UI under the call.
- (Separate package `pi-durable-subagents` adds a full orchestrator + CLI with durable subagent workflows to the pi coding agent — see §5.)

### Usage/cost
- Per-conversation usage tracking; tools can report `usage`; spend stored in `pi.usage` document.

## 3. Minimal program shape

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, Harness, CodingTools } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(openaiProvider()); // reads OPENAI_API_KEY

const registry = createRegistry();
registry.install(CodingTools);

const harness = await Harness.open(
  await openNodeSqliteStorage("/data/agent.sqlite"),
  {
    models, registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? "/work" }),
  },
  context,
);
harness.resume(); // continue any run a previous process left unfinished

const root = await harness.root(context, {
  agent: { model: { provider: "openai", modelId: "gpt-6.1-sol" }, cwd: "/work/repo" },
});

const job = { type: "input", content: "Fix the flaky login test", requestId: "job-42" } as const;
await root.submit(job, context);
const settled = await (await root.submit(job, context)).wait(context); // same id → no duplicate
```

## 4. Kubernetes setup

### Key constraint
**One process owns one storage at a time.** So the natural k8s unit is: **one Pod = one harness over one storage**. Scale out by running multiple Pods (each with its own storage/agent), not by scaling replicas of the same storage.

### Recommended architecture

```
┌─────────────────────────────── cluster ───────────────────────────────┐
│                                                                       │
│  Deployment "pi-agent" (replicas: 1)                                 │
│  ├─ Pod: node container                                              │
│  │   ├─ HTTP/WS API server (your code)                               │
│  │   │    POST /tasks          → root.submit({content, requestId})   │
│  │   │    GET  /stream         → watchEvents() as SSE                │
│  │   │    POST /steer          → submit(..., whenBusy: "steer")      │
│  │   ├─ Harness over SQLite on PVC (/data/agent.sqlite)             │
│  │   └─ NodeExecutionEnv cwd=/work (PVC with the repo)               │
│  ├─ PVC: /data (SQLite + working dir)                               │
│  └─ Secret: ANTHROPIC_API_KEY / OPENAI_API_KEY                      │
└─────────────────────────────── cluster ───────────────────────────────┘
```

### Steps

1. **Image**
   ```dockerfile
   FROM node:24-bookworm-slim
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .
   EXPOSE 8787
   CMD ["node", "dist/server.js"]
   ```

2. **Server code** — wrap the harness in a small HTTP server:
   - On startup: `Harness.open(sqlite at /data/agent.sqlite, ...)` → `harness.resume()` → serve.
   - `POST /tasks` with `{ conversationId?, content, requestId }` → `root.submit(...)`; return submission id + status. `requestId` gives exactly-once semantics for external callers (CI jobs, webhooks) — this is the "give it a task" API.
   - `GET /stream?conversationId=...&cursor=...` → SSE from `watchEvents()`; cursor = last event id → lossless reconnect (this is exactly the pattern Vercel's `chatRoute` documents).
   - `POST /steer` → `submit({ whenBusy: "steer" })`.
   - Auth middleware on all routes.

3. **Manifest sketch**
   ```yaml
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata: { name: pi-agent-data }
   spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 20Gi } } }
   ---
   apiVersion: apps/v1
   kind: Deployment
   metadata: { name: pi-agent }
   spec:
     replicas: 1            # one process owns the storage
     strategy: { type: Recreate }   # never two Pods on the same PVC
     selector: { matchLabels: { app: pi-agent } }
     template:
       metadata: { labels: { app: pi-agent } }
       spec:
         containers:
           - name: agent
             image: REGISTRY/pi-durable-app:0.1.0
             ports: [{ containerPort: 8787 }]
             envFrom: [{ secretRef: { name: pi-agent-keys } }]
             volumeMounts:
               - { name: data, mountPath: /data }
               - { name: work, mountPath: /work }
             livenessProbe:
               httpGet: { path: /healthz, port: 8787 }
             readinessProbe:
               httpGet: { path: /ready, port: 8787 }   # ready once resume() done
         volumes:
           - { name: data, persistentVolumeClaim: { claimName: pi-agent-data } }
           - { name: work, persistentVolumeClaim: { claimName: pi-agent-work } }
   ---
   apiVersion: v1
   kind: Service
   metadata: { name: pi-agent }
   spec: { selector: { app: pi-agent }, ports: [{ port: 80, targetPort: 8787 }] }
   ```

4. **Failure behavior**
   - Pod crash / node loss → k8s restarts the Pod (same PVC) → `harness.resume()` continues interrupted runs from checkpoints. Submissions with known `requestId`s are retrievable via `harness.submission(id)`.
   - Caveat (from Temporal's write-up): built-in SQLite storage means "the newest commits may be lost on power or host failure" — a hard kill can lose the last un-fsynced commit. Acceptable for most agent work (worst case: one step reruns), but if you need stronger guarantees, implement a **custom storage backend over Postgres** (the interface is small; conformance suite included).

5. **Scaling patterns**
   - **Many agents**: N Deployments, each with its own PVC + Service → N independent durable agents. This is the intended pattern.
   - **HA failover for one agent**: with built-in SQLite, failover = new Pod attaching to the same PVC (Recreate strategy handles this). With a Postgres-backed custom storage backend, any Pod can take over — true multi-replica HA.
   - **Per-conversation isolation**: `env` builds an execution environment per conversation from its `cwd`, so you can point different conversations at different directories/containers without changing the harness.

6. **Alternatives / adjacent options**
   - **agent-sandbox CRD (sigs.k8s.io)**: has a ready-made example running the *pi coding agent* (TUI) in k8s with Sandbox CRD + PVCs — good reference for image/PVC patterns, but it's for the interactive TUI agent, not Pi Durable.
   - **Temporal (pi-temporal)**: Temporal Workers as the execution engine over shared storage; automatic failover across machines without your own Postgres backend. It's a retrofit of the pi coding agent (keeps its session files + TUI), not pi-durable itself — but it validates the "transcript is the state, re-open on any machine" model and gives you off-the-shelf HA if you don't want to build one.
   - **Vercel `durable-harness/pi-durable`**: runs the same Harness with World-log storage; its `chatRoute` (POST message → SSE stream, GET reconnect with cursor, steer kind) is the best reference implementation for your k8s API server.

## 5. How to communicate / give tasks

### In-process API (what your server wraps)
| Operation | Call | Notes |
|---|---|---|
| Give a task | `root.submit({ type: "input", content, requestId }, ctx)` | exactly-once via `requestId`; returns a Submission |
| Wait for result | `submission.wait(ctx)` | resolves `done` / `unanswered` |
| Re-acquire after restart | `harness.submission(id)` | then `.wait()` again |
| Watch progress | `viewState().subscribe(...)` or `watchEvents()` | full view first, then deltas; events = pi coding agent's familiar event shape |
| Steer a busy run | `submit({ content, whenBusy: "steer" }, ctx)` | reaches the model at its next model call |
| Queue behind busy work | default submit (no `whenBusy`) | joins after current tool calls |
| Fork a thread | `channel.fork(entryId, { ownership: { kind: "ownerless" } })` | concurrent, independent |
| Configure agent | `root.configure({ model, tools, instructions, cwd }, ctx)` | per conversation |
| Manual compaction | `root.compact("keep the failing test names", ctx)` | runs while working |

### External task submission design (recommended)
1. **HTTP + SSE** as sketched in §4: `POST /tasks` (with client-chosen `requestId`, e.g. a CI run id) → durable, retry-safe; `GET /stream` for live progress; `POST /steer` for intervention.
2. The `requestId` pattern is the key contract: an external system (CI, webhook, Slack bot, another agent) can safely retry — same id + same content = same submission, never a duplicate run.
3. For multi-user: forks give each thread its own conversation; ownership kinds decide what aborts reach.

### Related: `pi-durable-subagents` (different package)
If the goal is durable *subagent workflows driven from outside* on the pi coding agent itself, `pi-durable-subagents` adds an orchestrator process + CLI:
- `pi-durable-subagents run --request <id> --spec <file>` — start a workflow with exactly-once request ids (safe to retry from CI/scripts).
- `send` (steer/answer/follow-up/notify/model), `status`, `events`, `tail`, `describe`, `stop`.
- Survives pi quitting, crashes, machine restarts; worktree writer locks prevent concurrent writes; budget caps.
This is complementary: it drives the TUI agent's subagents durably; Pi Durable is the framework you build your own durable agent app on.

## 6. Use cases

| # | Use case | Why Pi Durable specifically |
|---|----------|------------------------------|
| 1 | Overnight / multi-day autonomous coding agent | Checkpoints + `resume()` survive sleep/reboot; replay-safe tools rerun, unsafe ones report "interrupted" |
| 2 | Team Slack bot (Earendil's own stated plan) — channel = conversation, thread = fork | Forks, multiplayer attach/watch, `whenBusy: "steer"`, per-conversation agent config |
| 3 | CI/CD + GitHub triage — PR webhook → review task; CI gate waits for result | `requestId` exactly-once with webhook retries; `structuredOutput` for machine-readable verdicts; blocking hooks |
| 4 | Approval-gated ops agent (deploy needs human yes in Slack) | `beforeTool` hook + memo: asks once, decision survives restarts |
| 5 | Multi-agent research pipeline (researcher → writer → reviewer) | Custom tasks, ownership trees, `failFast`, per-subagent model/tools, background tasks |
| 6 | Long-lived project "brain" — weeks of context on one repo | Background compaction; old messages searchable; documents hold plans/todos atomically; handoff notes |
| 7 | On-call / incident agent ("check if the deploy stabilized in 24h") | Background tasks (reminders that fire tomorrow), queued inbox, steering while busy |
| 8 | Shared support agent — several staff on one ticket stream, per-ticket sandbox | Multiplayer late-join from full state; `env` builds per-conversation execution environment |
| 9 | Scheduled batch workloads with cost caps | Exactly-once submissions from cron; per-conversation usage/cost tracking; budget gates via hooks |
| 10 | Malleable experimentation platform — hot-swap tools/prompts on a live agent | Atomic registry replacement; running calls finish on old code; positional prompt recording keeps cache warm |

Reference implementations: the vacation-planner demo (~1,300 lines) and the small coding agent on Pi Durable (both in `packages/coding-agent/src/experimental/` of a pi checkout at v1.0.0).

## 7. Local hosting options (multi-client access)

Key fact: **Pi Durable is a library, not a server** — hosting = one Node process wrapping `Harness` + an API server. Multiple clients attach to that one process by design.

| Option | Stack | Storage | Best for |
|--------|-------|---------|----------|
| Bare Node on laptop | node + pm2/launchd/systemd | SQLite in `~/.pi-durable/` | Development; resumes from checkpoint after sleep/reboot |
| Single Docker container | Image; named volumes `/data` (sqlite) + `/work` (repo) | Volume | Portable single-box |
| Docker Compose (agent + UI + extras) | Services: agent, web-ui, optional postgres | Volumes / compose DB | The practical "local PaaS" — sweet spot for multi-client local hosting |
| Always-on home server | Mac mini / Raspberry Pi 5 / NAS (Synology Container Manager, QNAP) running Compose | Persistent disk | Real multi-device access over LAN |
| Local Kubernetes (kind/minikube/k3s) | Deployment + PVC manifests from §4 | PVC | Validating the production pattern at home (crash/resume/recreate behavior) |
| Tailscale on top of any of the above | Tailnet = private VPN over the localhost API | — | Secure remote access without port forwarding/public IP; network-level auth for free |

Recommended local multi-client stack: Docker Compose on an always-on box + Tailscale + small web UI + Slack bot + CI/cron clients. Security: bearer token per client type, tailnet/LAN-only exposure (NodeExecutionEnv gives tools real shell/filesystem access), per-conversation `cwd` isolation or container-per-conversation via custom env.

Non-local fallbacks if local is outgrown: **Vercel durable-harness** (World-log storage, ready-made chat route), **Cloudflare Durable Objects** (SQLite/JSONL adapters run inside DOs — why they avoid Node APIs), **Temporal workers** for cross-machine failover.

## 8. Client options

The harness exposes committed state + `watch()`/`watchEvents()` streams; a client = anything that speaks the HTTP/WS API (or runs in-process).

| Client | How it connects | Typical pattern |
|--------|----------------|-----------------|
| Web UI (browser) | React/Vue → SSE (`GET /stream`) + POST endpoints; cursor-based reconnect | Primary multi-user surface: transcript, live tool output, steering box, cost panel |
| Slack/Discord/Telegram bot | Webhook → `POST /tasks`; stream replies into channel; thread → fork | Flagship use case; Earendil plans to ship this themselves |
| Terminal/TUI client | In-process or local HTTP | Build with pi-coding-agent TUI components (the vacation-planner demo does exactly this on Pi Durable); or a curl-based CLI |
| IDE extension (VS Code) | Extension → local API; SSE sidebar | Chat + task list + live output in the editor |
| CI/CD systems | GitHub Actions/GitLab job as client: submit with `requestId` = run id, wait, post comment | Retries safe by construction; structured results gate merges |
| Agent-to-agent | pi coding agent session drives the durable agent via bash/curl or MCP bridge (codemode supports MCP-style bridging) | Interactive agent as a "fat client" of a durable fleet |
| Mobile app | Any HTTP/SSE app (React Native/Flutter/native); or gateways (Twilio SMS, WhatsApp webhook) | Task submission + push-on-completion |
| Email/calendar | IMAP poller or SMTP→webhook service → submit; results mailed back | "Email the agent" UX for non-technical users |
| Cron/scheduled jobs | Script submits with `requestId` = `job-<date>` (idempotent) | Nightly suites, weekly reports; usage tracked per conversation |
| Dashboards/observability | Read-only clients on `viewState()` / `documentState().subscribe()` | Cost dashboards, todo lists, run status — no steering |

## 9. Accessing resources across the network

Default: built-in file/shell tools only see the **local filesystem of the machine running the harness process**. Network reach is added at three levels:

1. **Clients → harness** (native): `watch()`/`watchEvents()` over sockets; any number of clients attach. Tailscale/LAN exposure + API wrapper + auth.
2. **Harness → remote resources** (trivial): custom tools call anything — HTTP APIs, databases, S3, LAN services. Read-only ones get `replay: "safe"`.
3. **Built-in tools → remote machines/containers** (via ExecutionEnv): the `env` function builds an environment *per tool call* from conversation config. A custom `ExecutionEnv` (small interface: `exec()`, `openBinaryReader()`, `openDirReader()`, optional `listFiles()`, `cleanup()`) can point read/write/edit/bash at another machine or container — "the harness runs on one machine while its tools run on another." An env `id` groups calls that see the same files (one id per host/container = clean isolation). `pi-env`'s `RemoteExecutionEnv`/`LocalExecutionEnv` are reference implementations; conformance suite via `registerEnvConformance()`.

Caveats: storage stays single-owner (only execution and clients distribute); remote env = agent has shell on that machine (isolate per conversation); remote side effects can't be undone — interrupted unsafe tools come back to the model as "possibly ran", so design idempotency keys into tools that matter; latency makes remote file ops WAN-hostile (prefer API-style tools over there).

## 10. Comparison: Hermes Agent & Agent Zero

(Full version in `report.html` §9.)

- **Hermes Agent** (NousResearch, Python): personal agent centered on a messaging gateway — 70+ tools / ~28 toolsets; SKILL.md skills; MEMORY.md/USER.md + pluggable memory providers; context-file discovery + `@ref`; auto-checkpoints + `/rollback`; cron with platform delivery; `delegate_task` subagents; `execute_code` sandboxed Python RPC; gateway/plugin hooks; batch processing → ShareGPT trajectories; voice (wake word, Discord voice channels, 10+ TTS); browser automation (5 backends); MCP client; provider routing/fallbacks/credential pools/prompt caching; OpenAI-compatible API server; ACP IDE integration; SQLite+FTS5 sessions; 25+ platform adapters; ~25k tests.
- **Agent Zero** (agent0ai, Python + Alpine.js Web UI): Dockerized Linux desktop "AI OS"; async monologue loop via LiteLLM (OpenAI/Anthropic/Grok/OpenRouter/Copilot/Ollama); FAISS vector memory (main memories, conversation fragments, proven solutions) + dashboard; SKILL.md skills + Plugin Hub; Projects (isolated workspaces, dedicated agent, Git, secrets); Python extension hooks; knowledge base directory; MCP client **and server**; A2A protocol (FastA2A) between instances; scheduler/cron; built-in browser with DOM annotation; full Linux desktop sandbox with SearXNG + on-demand package install; Web UI with file editor; REST + Socket.io; local Whisper STT + Kokoro TTS; Time Travel snapshots with diff/revert; persistent volume `/a0/usr`.

**Similarities:** SKILL.md skills, MCP, multi-agent (delegation vs A2A), cron, cross-session memory, browser automation, voice, plugin systems, container isolation, rollback/checkpoints, multi-provider models, many client surfaces.

**Key differences:** Hermes = gateway/CLI/IDE-centric with flexible execution backends (7) and file-based memory; Agent Zero = single Docker desktop with Web UI primary and built-in FAISS vector memory. **Neither has step-level durable execution** — no checkpointed mid-turn crash recovery or exactly-once submissions.

**Pi Durable mapping:** every feature maps onto Pi Durable primitives, mostly 1:1 — tools/extensions (tools & toolsets), sections (skills, context files, knowledge base), documents (memory-as-state), background tasks with restart-surviving timers (cron), owned conversations (subagents/A2A), Code Mode (`execute_code`), hooks+memos (event hooks/guardrails), ExecutionEnv (Docker sandbox, more flexible: per-conversation/remote), watch/watchEvents (Web UI, dashboards, all client surfaces). Gaps requiring glue work: tool implementations (browser, vector memory, TTS/STT, image gen), platform adapters (Slack/Telegram/etc. webhooks), a vector backend service, OpenAI-compat API wrapper, batch runner. Pi Durable adds what neither has: step-level durable execution, exactly-once submissions, infinite conversations with background compaction, atomic app state, malleable registry, multiplayer steering.

Effort estimate for "Hermes or Agent Zero on Pi Durable": ~30% core harness wiring (days), ~50% tools + adapters (weeks), ~20% UI polish — durability comes free underneath.

## 11. Open questions / risks
- **Experimental API** — expect breaking changes between releases; pin versions.
- **Single-owner storage** — no built-in multi-process HA; plan around it (one Pod per agent, or Postgres backend).
- **Commit durability window** — last un-fsynced commit can be lost on hard power loss with SQLite.
- **Execution environment security** — `NodeExecutionEnv` gives tools real filesystem/shell access to the Pod; isolate per-conversation via `cwd`/custom env, or run tools in nested containers/sandboxes (see Vercel's sandbox pattern for the threat model).
- **Cost controls** — usage is tracked per conversation; hooks (`beforeTool`) + budgets are how you gate expensive/dangerous actions.
