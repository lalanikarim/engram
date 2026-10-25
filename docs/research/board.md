# The Board — central coordination artifact (research / brainstorming)

**Status:** research / brainstorming. Part of the [engram-ecosystem](engram-ecosystem.md) thread.
The board is the **Project 0** artifact: the shared substrate both **Option A (Collective)** and
**Option B (Society)** build on. Nothing here is committed; it refines the rough list from the
working session into a concrete, durable data model grounded in pi-durable primitives.

## Core principle — what the board is and isn't

**The board is durable state + routing, not a new engine.** It is built entirely from primitives
engram already has: `documents` (durable app state changed atomically with the transcript),
`submissions` (exactly-once work requests), `conversations` (durable, multiplayer, streamable),
`watch`/`watchEvents` (live deltas), and background `tasks` with timers.

Two consequences:
- **Don't rebuild chat.** A forum channel and a DM are *conversations* (pi-durable conversations
  already support late-join from full state, multiplayer steering, and streams). The board's job
  for communication is the **directory/routing layer** — which conversation to join, who's allowed —
  not a bespoke message store.
- **Everything is crash-safe & exactly-once by construction.** A job claim, a status change, or a
  knowledge post is an atomic commit; no two actors can double-claim, and restarts never lose or
  duplicate state.

The board's real value is the **directory + work-tracking + trust layer** on top of those primitives:
who/what exists, what work is open, who did what, and what each party is allowed to do.

---

## Shape / topology of the board

Two questions: is it a broker? is it an engram with extra wiring? **Both, layered.**

**The substrate nearly forces a broker.** pi-durable has one process owning one storage at a time,
with no cross-process locking. The coordination *store* (registry, jobs, claims, trust, routing,
knowledge index) must have a **single authoritative owner** to stay atomic and exactly-once. A purely
peer-to-peer shared board across independent instances is impossible without a central owner or a
custom Postgres-backed store. So the board's system of record is a **single-owner durable service =
broker**, whether members are conversations in one harness or separate instances.

**Layer an engram brain on top.** The broker should also be an engram (a root "coordinator"
conversation + board tools) for the parts that benefit from judgment: triage/routing ("who's best
for this job?"), synthesis, drafting to the human, anomaly detection. **Broker topology underneath,
engram reasoning on top.** This is the front-desk/triage member with extra responsibilities.

**Keep the system of record separate from the brain.** Authoritative coordination state lives in
durable *documents* owned by the broker's process — deterministic, atomic, not subject to compaction
or context limits. The brain reads/writes those docs but does not *be* them (don't let a compacting
transcript hold the registry or job queue).

**Members are clients of the board.** Other engrams connect over the same HTTP/SSE client model
Telegram/Web UI already use (`POST /tasks`, `GET /stream`). They register, post/claim jobs, and
exchange routed messages *through* the board — reusing tested client code, one source of truth.

**Depends on the member model:**
- *In-harness (low-risk start):* one harness holds the coordinator + member conversations as owned
  sub-conversations; board = root coordinator + registry/job docs in a single storage. Cross-member
  DMs/jobs are trivially shared state. No separate processes.
- *Multi-instance (A-full / B):* each member is its own instance (own process/storage/model/box);
  all connect to the central broker over the API. The broker owns the coordination store; members
  own their workspaces/transcripts. This is where the broker shape earns its keep.

**Other considerations:**
- *Control boundary:* everything transits the board → natural place to enforce trust tiers, route
  approvals to the human, and contain a bad member. Centralizing policy where you want authority is
  a feature.
- *Failure domain:* central = one failure domain, but durable (`resume`/checkpoints). Keep the broker
  minimal, LAN-only, holding **no member secrets** (members keep their own).
- *Bottleneck:* only coordination *metadata* transits the broker; heavy content (job execution, long
  chats) stays in members' contexts → not a real bottleneck at A or even B scale.
- *Compromise risk:* a compromised broker is worst-case. Mitigations: minimal surface, no central
  secrets, per-member sandboxing, human can revoke/reconfigure centrally; for B, make the policy
  layer auditable + trust model explicit.
- *Federated (no central broker):* more organic, no single compromise point — but conflicts with
  single-owner storage, needs a custom shared store/consensus, and still leaves "who enforces
  policy." Not the right first shape; revisit for B only if/when a Postgres-backed store exists.
- *Evolution path:* in-harness coordinator → extract to a broker *process* (when separate
  instances/models/boxes are needed) → society commons. Same board store schema throughout.

**Recommendation:** build the board as a **single-owner broker that is itself an engram** —
deterministic coordination store underneath, reasoning brain on top, members as clients. Start
in-harness; extract to a process when isolation demands it. The one decision that shapes this is the
**member model** (in-harness vs separate instances).

---

## Member model — in-harness vs separate instances

The board's technical shape hinges on what a *member* is. Two options:

**M1 — In-harness members.** One process, one storage. Members = named *standing* conversations
(not ephemeral subagents), each with its own agent config (model, tools, cwd/workspace,
instructions). The board = root coordinator conversation + registry/job/knowledge doc families in
that single storage. Members coordinate via shared state; DMs/forums are shared conversations.

**M2 — Separate instances.** Each member = its own engram instance (own process/storage/model/
workspace, possibly own box). The board = a central broker process (itself an engram) owning the
coordination store; members connect over HTTP/SSE as clients. Coordination state lives in the
broker; work state stays local to each member.

| Dimension | **M1 in-harness** | **M2 separate instances** |
|---|---|---|
| Atomicity of coordination state | Trivial (one store) | Fine if coordination state kept in broker (single writer); must not fragment |
| Isolation / security | Conversation-level (softer); shared process env/secrets | Hard (separate process/storage/box); no shared secrets — matches §5 |
| Separate models / boxes | Same process/machine; different models OK | Own model endpoint/box/GPU per member; real resource isolation |
| Failure domain / ops | One process, one failure domain, simple | Per-member independent; broker is critical; more complex ops (N instances + broker) |
| Build cost (P0) | Low — reuses conversations/config/approvals/watch; no inter-process netting | Higher — inter-instance API, identity/auth, routing, multi-process ops, maybe Postgres store for HA |
| Fit to A (1 box, trusted team) | Natural fit | Overkill for now |
| Fit to B (open, multi-box) | Insufficient | Required |

**Reversibility is the key.** The board *store schema* (registry, jobs, knowledge, trust) and the
coordinator brain + board tools are identical in M1 and M2 — only where members live changes. If you
build a **member abstraction** from day one (a member is addressed by id and talks via a stable
register/post/claim/message interface), then migrating a member to its own instance later is a
*deployment change, not a rewrite*. The cross-instance delegation tool (`send_message` seam) is
exactly this abstraction: build it against local members now, and it becomes the inter-instance
protocol unchanged.

**Recommendation: start M1, build M2-ready.**
- Members = named standing conversations in one harness; board = coordinator + doc families in one
  storage.
- Build the member abstraction + cross-instance delegation now (against local members).
- Keep the discipline: **coordination state lives in the board store** (atomic + migrates cleanly);
  work state lives in the member.
- The broker exists from day one — just *co-located* with members in one process until you need to
  split it out.

**Stepping stone (M1.5):** extract *one* member to its own instance as a pilot (e.g., the sandboxed
`code` member, or a `research` member on another box) to de-risk M2 incrementally — same board,
one remote member — before committing the whole team.

**Fit:** M1 for A now; migrate members to M2 one at a time when you need hard isolation, a
different model/box, or independent scaling (late-A / B).

---

## Components (refined from the working-session list)

### 1. Engram registry & agent profiles
Auto-registration of an engram with a durable profile:
- `id`, `name`, `kind` (role), `capabilities[]`, `restrictions[]`, `skills[]`, `boundaries`
  (what it may/may not do), `trustLevel`, `status` (idle/busy/offline), `endpoint`/address,
  `currentFocus`, `createdAt`.
- **pi-durable mapping:** a document family (`board.engram`, one doc per engram id). Changed in
  atomic commits; watchable for live "who's here + what they can do."
- **Security note:** registration is an **authorization surface**. In A, profiles are
  human-vetted and static. In B, registration may be dynamic and needs vetting/revocation.

### 2. Human profile(s)
- `id`, `name`, `roles[]`, `permissions` (what they can assign/approve/configure), `prefs`,
  `channels` (where to reach them: Telegram, Web UI, email).
- **Mapping:** document family (`board.human`). A keeps exactly one human (the operator/approver);
  B anticipates multiple humans as a governance layer (deferred).

### 3. Jobs / work items (the work queue)
A job is a tracked unit of work, richer than a raw submission:
- `id`, `title`, `body`, `requester {type: human|engram, id}`, `assignee {type,id} | null`
  (null = open for pickup), `status` (open → claimed → in-progress → blocked/done/failed/cancelled),
  `priority`, `due?`, `artifacts[]`, `result?`, timestamps.
- **Mapping:** a job **record** is a document (`board.job`); the actual execution is an **owned
  conversation/task** of the claiming engram. The board tracks the record; the work happens in the
  engram's own context (so it uses *its* memory — the whole point of a collective vs. subagents).
- **Claim semantics:** claiming is an **atomic commit** — read the job, and only if `status == open`
  set `assignee = self`, `status = claimed`; otherwise another actor won and you move to the next
  open job. pi-durable's single-writer + atomic commits make double-claim impossible *within one
  harness*. (Across separate instances this needs a shared store or a coordination authority — see
  open questions.)

### 4. Communication bus — forum + peer/direct
- **Forum/shared:** a channel any member of can post in and read (late-join, full history).
- **Peer/direct:** a 1:1 between two parties.
- **Mapping:** both are **conversations**. The board stores a lightweight `board.channel` directory:
  channel id → underlying conversation id + members + purpose. Routing ("talk to X" / "join the
  deploy channel") resolves against this directory.
- **Cross-instance nuance:** in-harness, a DM/forum is just a shared conversation. Across separate
  instances (different storage) there is no shared conversation — peer messages become either a
  message document on a shared board or a `POST /tasks` to the peer instance (the cross-instance
  delegation tool). This is the in-harness-vs-multi-instance decision made concrete.

### 5. Knowledge exchange (request & share, human ↔ engram ↔ engram)
- A durable place where knowledge is **published and queried**, with **provenance + trust tier**:
  `id`, `title`, `body`, `author {type,id}`, `source` (human / engram / web), `trustTier`,
  `createdAt`. Searchable (ripgrep now; local embeddings later per PLAN §6).
- **Mapping:** document family (`board.knowledge`) or an elevated `/kb` with metadata.
- **Security note (critical):** knowledge posted by an engram or fetched from the web is
  **untrusted input**. It must carry provenance + trust tier and be treated as *data, never
  instructions* — the same discipline engram already applies to web/email content. This prevents a
  compromised/malicious member from injecting "instructions" via a knowledge post.

### 6. Approvals / requests-to-human (action-requiring)
- Distinct from chat: a **request** that needs a human decision (approve an external side effect,
  answer a question, unblock a job). Trackable, with a durable outcome.
- **Mapping:** reuse the existing `ApprovalDoc` pattern (`beforeTool` hook + memo); the board
  surfaces pending requests and records decisions. This keeps "the human is the control boundary"
  first-class on the board rather than buried in chat.

### 7. Identity, trust & authorization (the layer A and B diverge on most)
- Who may post/assign/claim/approve/configure; how much autonomy an engram has; how trust is
  granted, raised, or revoked.
- **A:** static, human-vetted named allowlist + per-member boundaries from the profile.
- **B:** dynamic trust/reputation/provenance + a governance/charter policy layer.
- This is the component that most stresses engram's #1 constraint (no loss of control).

### 8. Status & observability
- Live status of engrams and jobs; per-engram/per-job usage/cost; dashboards.
- **Mapping:** native — `watch`/`documentState().subscribe()`/`viewState()` over the board docs +
  `pi.usage`. Read-only clients (PLAN §6 dashboards).

### 9. Scheduling & timers
- Recurring jobs, deadlines, reminders ("verify X daily").
- **Mapping:** native — background tasks with restart-surviving timers + cron submissions
  (`requestId = job-<date>`), results delivered to the human's channels. The board lists scheduled
  work and its next fire time.

### 10. Budgets & cost
- Per-engram/per-job spend caps; relevant under "no cloud spend" + finite local-model capacity.
- **Mapping:** native `pi.usage` tracking surfaced on the board; a policy layer enforces caps
  (connects to the smarter-approvals work in `docs/plans/approvals.md`).

### 11. Audit / provenance log
- Append-only record of jobs, messages, decisions, and tool calls — for accountability and
  crash-safety.
- **Mapping:** largely free — the transcript + documents are already an append-only, durable record;
  the board just exposes it per job/member.

### Tool registry (the "???" item) — keep it thin
A board-level tool registry would catalog shared/external tools and **permission** which engram may
call which. Recommendation: **do not build this in P0.** Real tool control already lives in the
per-instance malleable registry + approval gates. Only add a thin shared-tool directory later if
members genuinely need to discover/request shared external tools (e.g., a shared service endpoint).

---

## Data model sketch (doc families; brainstorming, not final)

| Concern | Primitive | Scope | Key fields |
|---|---|---|---|
| Engram profiles | doc family `board.engram` | global | id, name, kind, capabilities, restrictions, skills, boundaries, trustLevel, status, endpoint, currentFocus |
| Human profiles | doc family `board.human` | global | id, name, roles, permissions, prefs, channels |
| Jobs | doc `board.job` + owned conversation/task | global | id, title, body, requester, assignee?, status, priority, due?, artifacts, result |
| Channels (routing) | doc `board.channel` → conversation id | global | id, conversationId, members[], purpose |
| Messages (forum/DM) | **conversation** (not a new store) | per conversation | transcript entries + watch |
| Knowledge | doc family `board.knowledge` (or elevated /kb) | global | id, title, body, author, source, trustTier, createdAt |
| Requests/approvals | existing `ApprovalDoc` + board surfacing | session/global | key, tool/args, decision, decidedBy, decidedAt |
| Status/usage | native `watch` + `pi.usage` | per conv/job | live deltas, tokens/cost |
| Schedule | background tasks + cron submissions | global | job id, cadence, next fire |

**Claim flow (atomic):** `commit(tx)`: read `board.job[id]`; if `status === "open"`, set
`assignee = me`, `status = "claimed"`; else return "taken" and the claimer picks the next open job.
No double-claim within one harness.

---

## Security-critical design points (non-negotiable)
1. **Registration = auth surface.** Only the human (A) or a governed process (B) can register/modify
   profiles; revocation must be durable.
2. **Peer & external content is untrusted data** with provenance + trust tier — never instructions.
3. **Claims and status changes are atomic commits** — no races, exactly-once.
4. **Trust tiers gate action scope** — a member's profile `boundaries`/`trustLevel` constrain what it
   may do; external side effects still route to the human for approval.
5. **Containment of a bad member** — per-member sandbox, no shared secrets, egress-limited; a
   compromised member can't read another's secrets or act beyond its tier.
6. **LAN-only + token-authed** until a project explicitly re-decides exposure.

---

## A vs. B scoping of the board

| Board component | **A (Collective)** | **B (Society)** |
|---|---|---|
| Engram registry | static, human-vetted | dynamic + vetting/revocation |
| Human profiles | exactly one operator | multiple humans / governance |
| Jobs | human posts; members claim | members may also self-initiate |
| Comms bus | team channels + DMs | open commons/marketplace |
| Knowledge | shared with provenance/trust | open knowledge exchange, reputation-weighted |
| Requests/approvals | to the one human | to governance layer |
| Trust/authz | static allowlist + boundaries | dynamic trust/reputation/charter |
| Status/schedule/budgets/audit | same (native) | same (native), at scale |

**P0 (shared, build first):** registry + jobs (atomic claim) + comms-as-conversations + knowledge
with provenance + requests/approvals + status/schedule/budgets + **static** trust. Everything above
is a composition of existing primitives and changes nothing about the current single-brain product.

**B-only (deferred):** dynamic trust/reputation, self-initiated jobs, multi-human governance, open
registration, task-economy/allocation.

---

## P0 in-harness sketch (concrete)

Design-level sketch for the M1 board — what's new vs. reused, the doc families, the tools, the
claim state machine, and the member lifecycle. Not a final spec; exact delivery mechanics marked
*confirm at build*.

> **Core mechanics validated** by spike [`poc/11-board.mjs`](../../poc/11-board.mjs) (two standing
> members; atomic single-winner claim + member work loop both PASS on Qwen3.8-27B, 2026-10-25).
> Build plan: [`docs/plans/project-0-board.md`](../plans/project-0-board.md).

### New vs. reused
- **Reused (already built):** harness over SQLite + `resume()`; conversations with per-conversation
  agent config (model/tools/cwd/instructions); `submit` (exactly-once via `requestId`);
  `watchEvents`/SSE; approval hook (`beforeTool` + memo) + `ApprovalDoc`; documents; the subagent
  task pattern; HTTP/SSE API; Telegram/Web UI clients.
- **New (P0 board):** session-scoped doc families (`board.engram`, `board.human`, `board.job`,
  `board.channel`, `board.knowledge`) + a `board.jobIndex` singleton; the coordinator conversation
  + board tools; **standing named members** (registered conversations, not ephemeral subagents);
  the job/claim state machine; the member-abstraction seam.

### Doc families (session-scoped → shared by all members + human)
| Family / doc | Key | Fields (minimal) |
|---|---|---|
| `board.engram` (family) | engram id | id, name, kind, capabilities[], restrictions[], skills[], boundaries, trustLevel, status(idle\|busy\|offline), conversationId, createdAt |
| `board.human` (family) | human id | id, name, roles[], permissions, prefs, channels[] |
| `board.job` (family) | job id | id, title, body, requester{type,id}, assignee{type,id}\|null, status, priority, due?, artifacts[], result?, createdAt, updatedAt |
| `board.jobIndex` (singleton) | — | open: jobId[] (ids currently claimable; maintained on post/claim) |
| `board.channel` (family) | channel id | id, conversationId, members[], purpose |
| `board.knowledge` (family) | knowledge id | id, title, body, author{type,id}, source(human\|engram\|web), trustTier, createdAt |

All are `defineDocFamily({ family: true, scope: "session", kind, version: 1, initial })`; read/written
inside `api.commit((tx) => …)` via `tx.doc(Family, key, seed)`.

### Board tools (installed on coordinator + members; gated by role/trust)
| Tool | Who | Params (summary) | Behavior / pi-durable call |
|---|---|---|---|
| `register` | coordinator/human (gated) | name, kind, capabilities, restrictions, skills, boundaries, trustLevel | atomic upsert of `board.engram[id]`; creates/links the member's standing conversation; returns profile |
| `post_job` | human/coordinator | title, body, requester, assignee?, priority?, due? | atomic: write `board.job[id]` (status open or assigned) + push id to `board.jobIndex.open`; if assigned, trigger the member (below) |
| `claim_job` | member | filter?{kind?, skill?} | **atomic single-winner claim** (pseudocode below); returns claimed job brief or "none open" |
| `route_message` | any (per trust) | to{type:member\|channel, id}, text, replyTo? | resolve target via `board.channel`/`board.engram`; submit input to that conversation (exactly-once requestId). **This is the `send_message` seam** → becomes `POST /tasks` to a peer in M2 |
| `publish_knowledge` | any (per trust) | title, body, author, source, trustTier | atomic write of `board.knowledge[id]`; searchable; consumed as untrusted data |
| `report_status` | member | jobId, status(done\|failed\|blocked), result?, artifacts? | atomic update of `board.job[jobId]` (+ remove from index if open) |
| `board_status` | any (read-only) | — | snapshot/scan members + open jobs + pending requests; feeds Web UI/Telegram dashboards |

Gated actions by any member still route to the human via the existing `ApprovalDoc` pattern; the board
surfaces those as pending requests.

**Atomic claim (the crux) — one commit, single winner:**
```
const res = await api.commit(async (tx) => {
  const idx = await tx.doc(BoardJobIndex, "", { open: [] });   // singleton
  const id = idx.open.find(jid => matchesCapability(jid, filter));
  if (!id) return { claimed: null };
  const d = await tx.doc(BoardJob, id, seed);
  if (d.status !== "open") { idx.open = idx.open.filter(x => x !== id); return { claimed: null }; }
  d.assignee = { type: "engram", id: meId };
  d.status = "claimed"; d.updatedAt = Date.now();
  idx.open = idx.open.filter(x => x !== id);
  return { claimed: d };
}, ctx);
// member then works `res.claimed` in its own standing conversation (own model/tools/cwd/workspace)
```
No two members can claim the same job — the read+write is one atomic commit.

### Job state machine
| From | To | By | How |
|---|---|---|---|
| — | open | human/coordinator | `post_job` (add to index) |
| open | claimed | member | `claim_job` (atomic, single winner) |
| open/claimed | in-progress | member | begins working (submits brief / starts) |
| in-progress | done \| failed | member | `report_status` with result |
| in-progress | blocked | member | needs human/peer → posts a request/approval to the board |
| any | cancelled | requester/coordinator | `report_status`/cancel |

### Member lifecycle (end-to-end, on the existing API)
**Pull (member picks up work — 3b):**
1. Member's standing conversation is prompted (schedule / notification) to check for work.
2. It calls `claim_job` → atomic claim returns the job brief.
3. It works the brief **in its own context/workspace** (coding/web/etc.); gated actions → approval
   request surfaced to the human.
4. It calls `report_status` (done + result); optionally `route_message` a summary back to the requester.

**Push (human/coordinator assigns — 3a):**
1. Human posts a job (Telegram/Web UI → coordinator, or API `POST /tasks` to the coordinator).
2. Coordinator triages: leaves it open for pickup, or assigns + triggers the member by submitting the
   brief to that member's standing conversation (exactly-once requestId). *Confirm at build:* exact
   delivery = `harness.conversation(id)` handle vs. a small task vs. `tx.createSubmission`.
3. Member wakes, works it in its own context, reports status (as above).

**Observation:** the human reads the board via Web UI/Telegram dashboards (`board_status` +
`watchEvents` on the job docs) — live statuses, open jobs, pending approvals.

### Security notes (P0 / M1)
- **Registration is gated** to coordinator/human in A; profiles carry `boundaries` + `trustLevel` that
  constrain what a member may do.
- **Claim atomicity** = no double-claim, exactly-once.
- **Knowledge/peer content is untrusted data** with provenance + trust tier — consumed as data, never
  instructions (same discipline as web/email).
- **Gated actions by any member** route to the human via `ApprovalDoc`.
- **Shared-process caveat (M1):** members share one process/env; rely on per-conversation tool
  restrictions + sandboxing for code + scoped secrets. Hard isolation is M2's job.

### Implementation outline (what changes in `app/` — no code here)
- New `board` extension: the doc families/singleton + tools, installed on coordinator + members;
  `register`/`post_job` gated by role/trust.
- **Standing members:** a way to create/register a *persistent named* conversation (vs. ephemeral
  subagent) — e.g., board tool or API that creates the conversation + writes its `board.engram` profile.
- **Member-abstraction seam:** `route_message`/delegation addressed by member id against local
  conversations now; unchanged when a target becomes a remote instance (M2).
- **Clients:** Web UI + Telegram board dashboard surfaces (members, open jobs, pending requests) over
  existing SSE + doc snapshots.

---

## Open questions / decisions
1. **Member model:** in-harness named conversations (low-risk start) vs. separate instances? This
   decides whether cross-member DMs are shared conversations or need the cross-instance tool + a
   shared store for atomic claims.
2. **Job posting authority (A):** only the human posts jobs, or may members post sub-jobs to each
   other on already-assigned work? *(lean: members coordinate on assigned work; net-new external
   effects gated to the human)*
3. **Trust model (A):** static named allowlist + profile boundaries — enough for v1?
4. **Knowledge trust tiers:** how many levels, and what can each tier trigger? (data-only vs. may-
   request-action)
5. **Board visibility/permissions:** can every member read every channel/job, or is it scoped per
   member?
6. **Naming:** working names for the board artifacts and the two projects.
