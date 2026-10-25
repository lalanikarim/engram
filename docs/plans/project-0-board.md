# Project 0 — the board (P0): shared coordination substrate for a collective of engrams

Status: **planned** (branch `feature/engram-ecosystem-research`, 2026-10-25). Core mechanics
**validated by spike** `poc/11-board.mjs` (two standing members; atomic claim + member work loop
both PASS on Qwen3.8-27B). Research thread: [`../research/board.md`](../research/board.md); framing:
[`../research/engram-ecosystem.md`](../research/engram-ecosystem.md).

## Goal

Build the **board** — the shared, durable coordination substrate that both **Option A (Collective)**
and **Option B (Society)** will build on. It is a single-owner broker that is itself an engram:
durable coordination state underneath (documents), a coordinator brain on top (triage/routing), and
**standing named members** as clients. P0 is the **in-harness (M1)** form: one process, one storage;
members are persistent named conversations, not separate instances.

This changes nothing about the current single-brain product — it adds a composable layer on top of
the existing harness/conversations/approvals/clients.

## Requirements

1. **Board store (session-scoped doc families)** shared by all members + the human:
   - `board.engram` (family): id, name, kind, capabilities[], restrictions[], skills[], boundaries,
     trustLevel, status(idle|busy|offline), conversationId, createdAt.
   - `board.human` (family): id, name, roles[], permissions, prefs, channels[].
   - `board.job` (family): id, title, body, requester{type,id}, assignee{type,id}|null, status,
     priority, due?, artifacts[], result?, timestamps.
   - `board.jobIndex` (singleton): open: jobId[] (maintained on post/claim) — enables atomic claims
     without a doc-family scan.
   - `board.channel` (family): id, conversationId, members[], purpose.
   - `board.knowledge` (family): id, title, body, author{type,id}, source(human|engram|web), trustTier, createdAt.
2. **Coordinator engram** — a standing root/coordinator conversation with the board tools + KB +
   approvals; does triage/routing/reasoning; also registered as a member (`kind: "coordinator"`).
3. **Board tools** (installed on coordinator + members, gated by role/trust):
   - `register` (gated to coordinator/human in A) — upsert `board.engram[id]` + link the member's standing conversation.
   - `post_job` — write `board.job[id]` (open or pre-assigned) + push to index; if assigned, trigger the member.
   - `claim_job` — **atomic single-winner** claim of an open job (verify still open → credit claimer → remove from index, one commit).
   - `route_message` — resolve a member/channel and deliver a message (exactly-once requestId). **This is the `send_message` seam** → becomes `POST /tasks` to a peer in M2.
   - `publish_knowledge` — write a knowledge post with provenance + trust tier; consumed as untrusted data.
   - `report_status` — update a job's status/result durably.
   - `board_status` (read-only) — members + open jobs + pending requests, for dashboards.
4. **Standing named members** — persistent registered conversations (not ephemeral subagents), each
   with its own model/tools/**workspace** (`cwd` → per-member dir via the harness `env`) and durable
   domain memory across sessions.
5. **Member identity** — a member knows its own id when acting (resolve from a conversation-scoped
   member-id doc or equivalent) so claims/status are credited correctly without the caller passing it by hand.
6. **Member-abstraction seam** — `route_message`/delegation addressed by member id against local
   conversations now; unchanged when a target becomes a remote instance (M2). This keeps M1→M2 a
   deployment change, not a rewrite.
7. **Approval routing** — any member's external side effect still routes to the human via the existing
   `ApprovalDoc` pattern; the board surfaces pending requests.
8. **Client surfaces** — Web UI + Telegram board dashboards (members, open jobs, pending approvals)
   over existing SSE + doc snapshots.

## Non-goals (P0 / M1)
- No separate instances / multi-process / cross-box (M2). One harness, one storage.
- No dynamic trust/reputation, governance/charter, self-initiated jobs, or multi-human (Option B).
- No embeddings/vector KB yet — `kb_search` stays ripgrep; knowledge search reuses it.
- No per-member separate model endpoint/box (members may use different models within the one process).

## Design notes / verified facts (from spike `poc/11-board.mjs`, 2026-10-25)
- **Atomic single-winner claim works:** a claim is one `api.commit((tx) => …)` that reads the job doc,
  checks `status === "open"`, credits the claimer, and removes it from the `board.jobIndex` singleton.
  A second claim of the same job returns "not open". Verified: alpha claimed job-1; beta's re-claim was blocked.
- **Standing member work loop works (live model):** a member conversation created via
  `tx.createConversation({ownership:{kind:"ownerless"}})` + `configure(tx, id, {model, tools, cwd, instructions})`
  can call `claim_job`, create a file in its own per-conversation workspace (harness `env` maps
  `target.cwd` → dir), and call `report_status`; the job doc durably shows `status=done`, correct
  `assignee`, and `result`. Verified on Qwen3.8-27B (~47s for a 3-step tool sequence).
- **Session-scoped families/singletons are shared across all conversations:** `defineDocFamily({family:true, scope:"session", …})`
  and `defineDoc({scope:"session", …})` are addressable by key from any conversation/tool — the right
  scope for board state. Read outside a commit via `harness.snapshot(Token, key, ctx)`.
- **Tool-level atomic commits:** `ToolExecutionApi.commit((tx) => …)` gives tools the same atomic
  read+write surface as tasks — no need to route claims through a task.
- **Registry tool enumeration:** top-level `registry.snapshot().installed()` (the task runtime uses
  `runtime.registry.installed()`).

## Phases (ordering)

**Phase 0a — Board store + coordinator skeleton.**
- Tasks: doc families/singleton; coordinator conversation; `register`, `post_job`, `board_status`.
- Acceptance: register a member; post a job; `board_status` lists the member + open job durably
  (survives restart).

**Phase 0b — Claim + member work loop.** *(spike already proves the mechanics)*
- Tasks: `claim_job` (atomic) + `report_status`; standing named members with per-member workspace +
  tools; member self-identity (req 5); promote the spike into an automated test.
- Acceptance: two members; exactly one claims a given job; a member completes an assigned/open job in
  its own workspace and the job doc reflects done+result.

**Phase 0c — Comms bus + knowledge.**
- Tasks: `route_message` (send_message seam) + channels as conversations; `publish_knowledge` with
  provenance + trust tier; untrusted-input discipline on consumption.
- Acceptance: a member routes a message to another member/channel and it appears in that conversation;
  a knowledge post is stored with provenance and rendered as delimited data (never instructions).

**Phase 0d — Client surfaces + approval routing.**
- Tasks: Web UI + Telegram board dashboards; route any member's gated action to the human via
  `ApprovalDoc`; notification on completion/approval-need.
- Acceptance: the human sees live members/open jobs/pending approvals and approves a member's gated
  action from Telegram or Web UI; the decision is durable.

## Test plan
- **Spike → automated test:** generalize `poc/11-board.mjs` into a repeatable suite (atomic claim, no
  double-claim, member work loop, status durability, restart survival).
- **Live integration** (mirrors `app/test/api.test.ts` style): register → post → claim → complete →
  report round trip; crash mid-run → resume → state consistent, no duplicate side effects.
- **Security:** a knowledge/web post cannot trigger an action (data-only); a member's gated external
  effect is blocked until the human approves; claims are exactly-once under concurrent attempts.

## Decision log
- P0 is **in-harness (M1)**: one process/storage; members are standing conversations. M2 (separate
  instances) is deferred and reached via the member-abstraction seam, not a rewrite.
- Board = **single-owner broker + engram brain**; system of record (docs) kept separate from the
  compacting coordinator transcript.
- `board.jobIndex` singleton chosen over a doc-family scan for atomic claims (no family-scan API on `Tx`).
- Member identity resolved internally (req 5) rather than passed by callers — the spike used an
  explicit `meId` param only to keep it minimal; P0 wires real self-identity.
