# Pi Durable Build — Brainstorm Questionnaire

Answer these to pin down **what to build**, **how to host it**, and **how to access it**.
- ⦿ = single choice · ☐ = multi-select · ✍️ = free form
- Answer whatever you're sure about; "unsure" is a valid answer — it shapes the MVP.

---

## A. What we build (purpose & scope)

**A1. Primary purpose of the agent.** ⦿
- [ ] Autonomous coding agent (fixes, refactors, tests on repos)
- [ ] Team chat bot (Slack/Discord/Telegram — channel = conversation, threads = forks)
- [ ] CI/CD integration (PR reviews, test triage, build fixes; gates wait on results)
- [ ] Research / analysis pipeline (multi-agent: scout → writer → reviewer)
- [ ] Personal assistant / project "brain" (long-lived context, memory, scheduled jobs)
- [ ] Ops agent with approval gates (deploys, incidents — human approves dangerous steps)
- [ ] Other: ✍️ ______________________

**A2. Who will use it?** ⦿
- [ ] Just me
- [ ] Me + 1–5 people (team/family)
- [ ] Many users / external clients
- [ ] Non-human clients primarily (CI, webhooks, other agents)

**A3. What kind of work should it do?** ☐
- [ ] Read/analyze code and answer questions
- [ ] Edit code + run tests/builds locally
- [ ] Shell/system administration
- [ ] Web research / browsing
- [ ] Data analysis (databases, files, spreadsheets)
- [ ] Communication (drafting messages, triaging tickets/issues)
- [ ] Monitoring & scheduled checks ("verify X daily", "alert if Y")
- [ ] Other: ✍️ ______________________

**A4. Autonomy level.** ⦿
- [ ] Fully autonomous — it decides and acts within its sandbox
- [ ] Autonomous, but dangerous/external actions require human approval (hooks + memos)
- [ ] Human-in-the-loop throughout — I steer at each step
- [ ] Mixed: autonomous for routine work, approval for the rest

**A5. Expected run duration of a typical task.** ⦿
- [ ] Minutes
- [ ] Hours (overnight runs matter)
- [ ] Days — must survive machine sleep/reboots mid-task
- [ ] Indefinite / standing conversations (weeks+ with compaction)

**A6. Concurrency needs.** ⦿
- [ ] One conversation at a time is fine
- [ ] A few parallel conversations (e.g., one per project/ticket)
- [ ] Many concurrent users/threads on shared conversations
- [ ] Parallel subagent workstreams inside one task

**A7. Do we need multi-agent workflows (subagents, chains, pipelines)?** ⦿
- [ ] No — single agent with tools is enough
- [ ] Yes — occasional fan-out (e.g., parallel research)
- [ ] Yes — core to the design (orchestrator + specialized workers)
- Details: ✍️ ______________________

**A8. Tools the agent needs.** ☐ (built-in read/write/edit/bash + codemode are given)
- [ ] Web search / fetch
- [ ] Browser automation (forms, JS-heavy sites)
- [ ] Databases (Postgres/SQLite/etc.)
- [ ] Internal APIs / services on my network
- [ ] Git hosting API (GitHub/GitLab — issues, PRs, webhooks)
- [ ] Image generation / image understanding
- [ ] Voice (TTS/STT)
- [ ] MCP servers I already use: ✍️ ______________________
- [ ] Other: ✍️ ______________________

**A9. Memory beyond the conversation transcript.** ⦿
- [ ] None — transcript + compaction is enough
- [ ] Persistent curated notes (preferences, projects, decisions) → documents
- [ ] Searchable knowledge base (my docs, project wikis)
- [ ] Vector/semantic memory (embeddings over a corpus)

---

## B. How we host it

**B1. Where does it run?** ⦿
- [ ] My laptop (fine if it sleeps — resumes when I'm back)
- [ ] Always-on home server / spare machine (Mac mini, Pi 5, …)
- [ ] NAS (Synology/QNAP containers)
- [ ] Local Kubernetes (kind/minikube/k3s)
- [ ] Managed cloud k8s (GKE/EKS)
- [ ] PaaS (Vercel durable-harness / Cloudflare Durable Objects)
- [ ] Other: ✍️ ______________________

**B2. Availability expectation.** ⦿
- [ ] While the machine is on — that's enough
- [ ] 24/7 on one box (auto-restart on crash)
- [ ] 24/7 with failover to another machine (needs Postgres-backed storage or Temporal)

**B3. Packaging preference.** ⦿
- [ ] Bare Node process + pm2/launchd/systemd
- [ ] Single Docker container
- [ ] Docker Compose (agent + UI + supporting services)
- [ ] Kubernetes Deployment + PVCs

**B4. Storage backend.** ⦿
- [ ] SQLite (built-in, simplest — accept last-commit loss on hard power failure)
- [ ] Postgres-backed custom storage (stronger durability / multi-Pod HA — extra build work)
- [ ] JSONL (built-in, simple, append-only)
- [ ] Don't care yet

**B5. Where do the agent's tools execute?** ⦿
- [ ] Directly on the host filesystem (NodeExecutionEnv)
- [ ] Docker container per conversation (custom ExecutionEnv — isolation)
- [ ] Remote machine(s) over the network (RemoteExecutionEnv pattern)
- [ ] Cloud sandboxes (Vercel Sandbox / Modal / Daytona style)
- [ ] Mix: local for dev, sandboxed for untrusted clients

**B6. How many independent agents do we want?** ⦿
- [ ] One agent
- [ ] A few (e.g., coding + research + ops), each its own storage/Pod
- [ ] Many / dynamic — spawn per project or ticket

**B7. Budget & constraints.** ✍️
(e.g., "local only, no cloud spend" / "~$20/mo fine" / "have a GPU box I want to use for local models")

---

## C. How we access it (clients)

**C1. Primary client surface.** ⦿
- [ ] Web UI in the browser
- [ ] Terminal TUI (built on pi's TUI components, like the vacation-planner demo)
- [ ] Chat platform bot: ✍️ which? (Slack / Discord / Telegram / other)
- [ ] IDE integration (VS Code sidebar)
- [ ] API only — I drive it from scripts/other tools

**C2. Additional surfaces.** ☐
- [ ] Mobile (app or gateway like SMS/WhatsApp)
- [ ] Email (email the agent, get replies by email)
- [ ] CI/CD (GitHub Actions / GitLab jobs submitting tasks)
- [ ] Other agents driving it (agent-to-agent; MCP bridge)
- [ ] Dashboards (costs, todos, run status — read-only)
- [ ] Scheduled/cron submissions from scripts

**C3. How many humans use it at the same time?** ⦿
- [ ] 1
- [ ] 2–5
- [ ] Many / unknown

**C4. Interaction style.** ⦿
- [ ] Fire-and-forget: submit task, get result later
- [ ] Live steering: I watch it work and redirect mid-run (`whenBusy: "steer"`)
- [ ] Multiplayer co-steering: several people steer the same live conversation
- [ ] Mixed

**C5. Streaming needs.** ⦿
- [ ] Final results only (poll or notify on completion)
- [ ] Live progress stream (tool output, partial answers) — SSE/WebSocket
- [ ] Both, per client

**C6. Network exposure & auth.** ⦿
- [ ] Localhost / trusted LAN only
- [ ] Tailscale tailnet (private VPN; recommended default)
- [ ] Public internet with token auth
- [ ] SSO / existing identity provider
Notes: ✍️ ______________________

**C7. Which existing systems must it integrate with?** ✍️
(e.g., GitHub, a ticket tracker, home lab services, specific APIs, email accounts, calendars)

---

## D. Reliability & safety (where Pi Durable earns its keep)

**D1. How important is crash recovery?** ⦿
- [ ] Nice to have — losing an in-flight task occasionally is OK
- [ ] Important — long tasks must not be lost when the box reboots
- [ ] Critical — it drives real work (deploys, payments, external side effects); exactly-once matters

**D2. Risk tolerance for tool actions.** ⦿
- [ ] Read-only / analysis only
- [ ] Local writes OK (files, repos on my machines)
- [ ] External side effects allowed with human approval gates (hooks + memos)
- [ ] External side effects fully autonomous within budgets

**D3. Cost control.** ⦿
- [ ] None — run it as long as needed
- [ ] Per-task budget caps
- [ ] Daily/weekly caps with alerts
- [ ] Cheapest model by default; escalate to strong models for hard steps

**D4. Models to use.** ✍️
(e.g., "Claude + GPT via API" / "local Ollama where possible" / "mix: cheap model for subagents, strong model for the main agent")

---

## E. Free-form wrap-up

**E1. The one thing you most want this agent to do that no current tool does well:**
✍️ ______________________________________________________________

**E2. Hard constraints (hardware, network, compliance, data location):**
✍️ ______________________________________________________________

**E3. MVP scope — what would make this "working" for you in 2 weeks?**
✍️ ______________________________________________________________

**E4. Anything I've missed / a use case you had in mind:**
✍️ ______________________________________________________________

---

## How answers map to design decisions (cheat sheet)

| Answer | Design consequence |
|---|---|
| A5 days+ / D1 critical | SQLite on persistent volume + `resume()`; Postgres backend if failover needed (B2) |
| A2 team / C3 many / C4 multiplayer | Forks per thread, ownership kinds, watch() streams to N clients |
| A4 approval gates | `beforeTool` hooks + memos (decision survives restart) |
| A6/A7 subagents | Owned-conversation subagent tool; `failFast` task graphs for pipelines |
| A8 internal APIs / MCP | Custom tools (+ codemode/MCP bridge); `replay: "safe"` on read-only ones |
| B1 home server + C6 tailnet | Docker Compose + Tailscale; token per client type |
| B5 container-per-conversation | Custom ExecutionEnv, one env id per container |
| C2 CI/CD | `POST /tasks` with `requestId` = run id; `structuredOutput` for gates |
| C7 webhooks (GitHub/Slack) | Webhook adapters → submit; channel = conversation, thread = fork |
| D3 budgets | Hooks + per-conversation `pi.usage` tracking; model pools with failover |
