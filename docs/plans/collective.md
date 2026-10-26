# Project A — The Collective (N named engrams, one human)

Status: **planned** (branch `feature/collective`). Builds on the **complete Project 0 board**
(phases 0a–0d merged to main). Framing: [`../research/engram-ecosystem.md`](../research/engram-ecosystem.md) §2;
board design: [`../research/board.md`](../research/board.md). This is the bounded, safe special case of
Option B (Society); it keeps the human as the sole operator and approver.

## Goal

A **bounded standing team** of named engram members serving one human. Each member is a persistent
specialist with its own domain memory, workspace, model, and boundaries. The human reads the board,
assigns work, and approves; members do the work and hand off to one another laterally. What makes this
a *collective* (not fan-out) is **persistence + lateral handoff in each member's own context**: a member
remembers its domain across sessions and acts on that memory when another member hands it work.

## What Project 0 already provides (reused, not rebuilt)

- **Board store:** `board.engram` (member registry), `board.job` (+ `jobIndex`), `board.channel`,
  `board.knowledge`; index singletons for enumeration.
- **Standing named members:** `create_member` → own ownerless conversation + per-member workspace
  (`cwd = name` → `workRoot/<name>`) + tools; member **self-identity** (conversation-scoped id doc).
- **Work loop:** atomic single-winner `claim_job`, `report_status`; a member completes work in its own
  workspace and the job doc reflects done + result.
- **Comms bus:** `route_message` (the `send_message` seam) + channels as conversations; exactly-once delivery.
- **Knowledge exchange:** `publish_knowledge`/`read_knowledge` with provenance + trust tier, rendered untrusted.
- **Client dashboards:** `GET /board`, Web board panel, Telegram `/board`.
- **Approval routing:** a member's gated action routes to the human durably (Web banner + Telegram root chat).

## What A adds (the delta)

1. **Domain memory** — each member consolidates durable, domain-scoped knowledge that survives
   transcript compaction and makes it a specialist on its beat across sessions. *(Headline value of A.)*
2. **Peer trust tier + boundaries** — a static, human-vetted named allowlist; per-member `boundaries` /
   `trustLevel` gate which peers a member may assign/route to and what scope of action it has.
3. **Untrusted peer input** — peer-to-peer messages are delivered as delimited untrusted data (never
   instructions), the same discipline as knowledge/web content.
4. **Containment of a bad member** — per-member sandbox, no shared secrets, egress-limited; the human can
   revoke/reconfigure centrally and durably.

## Non-goals (A)

- Separate instances / multi-process (M2). Members stay **in-harness (M1)**; the member abstraction is
  built M2-ready (`route_message` addressed by member id → local conversation now, remote instance later).
- Dynamic trust/reputation, self-initiated work, governance/charter, multi-human — **Option B**.
- Embeddings/vector KB. Member memory stays file/doc-based (ripgrep search via `kb_search`).

## Design decisions (defaults — adjustable before implementation)

- **Member model: M1 in-harness** (already built). One process/storage; members = named standing
  conversations; board = coordinator + doc families. Coordinator is a registered member (`kind: "coordinator"`).
- **Autonomy boundary:** members coordinate on work the human/coordinator posted, including handing it to a
  peer on that assigned work. Members do **not** self-initiate new work or new external side effects; any
  new external effect still routes to the human for approval.
- **Peer trust model: static named allowlist** + per-member boundaries from the profile (no dynamic reputation).
- **Untrusted peer input:** `route_message` wraps content in `<untrusted from="…">` delimiters; receivers treat
  it as data, never instructions.
- **Containment:** per-member sandbox (existing `SandboxManager`) + per-member workspace isolation; no shared
  secrets; central durable revoke/disable of a member.

## Phases

**Phase A1 — Member domain memory.**
- Tasks: give each member explicit domain instructions + a durable, non-compacted memory surface in its own
  workspace (e.g. `MEMORY.md` read at task start, updated as the member learns); optionally a thin
  `remember`/`recall` tool wrapper. Members already have a persistent transcript + per-member workspace; this
  adds curated domain knowledge that survives compaction.
- Acceptance: across two separate sessions, a member retains domain-specific knowledge it recorded (e.g. a
  runbook or convention) and uses it next time **without being re-told**.

**Phase A2 — Peer trust tier + untrusted peer input.**
- Tasks: extend `board.engram` profile with `boundaries`/allowlist; enforce in `route_message` (may this sender
  route to that target?) and `post_job` (coordinator/human, or allowlisted members) atomically; wrap
  `route_message` content as `<untrusted from="…">`.
- Acceptance: a member not on the allowlist cannot assign/route to a peer it's barred from; the coordinator can.
  A peer message containing embedded instructions is treated as data and does **not** cause the receiver to act
  on it (live test).

**Phase A3 — Containment of a bad member.**
- Tasks: route member code execution through the per-member sandbox + workspace isolation; ensure no shared
  secrets across members; add a coordinator/human `revoke`/disable that durably removes a member from the board.
- Acceptance: a member's side effects are confined to its own workspace/sandbox; it cannot read another member's
  secrets; the human can disable a member centrally and the change is durable (survives restart).

**Phase A4 — Standing team + coordinator triage (end-to-end).**
- Tasks: instantiate a small useful team (e.g. `infra`, `code`, `research`) with domain memory + boundaries;
  the coordinator triages inbound work and routes it to the right specialist; peer handoff happens in the
  receiver's own context/workspace.
- Acceptance: end-to-end — human posts a task → coordinator routes to the right member → the member works in its
  own workspace using its domain memory → hands off / reports → status is on the board and the dashboard.

## Test plan

- **Deterministic:** trust-tier/boundary enforcement (allowed vs barred routing/assignment), untrusted wrapping of
  peer messages, containment config, revoke durability — no model.
- **Live integration:** domain-memory persistence across sessions; end-to-end coordinator triage → member work loop
  (the member work loop itself is already proven by `board-live.test.ts`).
- **Security:** a compromised peer's message cannot trigger an action in another member; a bad member is contained
  and revocable.

## Decision log

- A builds on the merged P0 board; no board rework — only the four deltas above.
- M1 in-harness (not M2) for A; M2-ready abstraction preserved so a member can later become a separate instance.
- Autonomy stays bounded: coordinate on assigned work; new external effects human-gated (preserves the "human is
  the control boundary" invariant).
- Peer trust is a static named allowlist with per-member boundaries (no dynamic reputation — that's B).
