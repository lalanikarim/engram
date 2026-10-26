# Option B — The Society (build plan)

**Status:** build plan for Option B, following the confirmed research in [`../research/society.md`](../research/society.md).
Option A (Collective) is **complete on main** (board P0 + A1–A4: domain memory, peer trust tier, containment,
standing team + coordinator triage, heterogeneous models). This turns B's confirmed decisions into a concrete,
phased plan grounded in the real A primitives we shipped. **No code in this doc** — it is the direction for the
pivot to B. Companion research: [`../research/society.md`](../research/society.md),
[`../research/board.md`](../research/board.md); A's plan: [`./collective.md`](./collective.md).

## Confirmed decisions, made concrete against A

The two load-bearing calls are settled in the research doc. Here is how each maps onto the **actual** A code,
so B1 can start without re-deriving them.

### 1. Trust model — tiered clearance + per-capability grants (TTL, human-approved promotion)
- **What A built:** `EngramProfile.allowedTargets` (a static per-member routing allowlist),
  `trustLevel: "trusted" | "untrusted"`, and the gates `canRouteInTx` / `canPostJobInTx`. Trust is binary and
  hand-set; there is no notion of *how much* an agent may do.
- **B generalizes it to:** a per-member **trust tier** (`T0 data-only → T1 may propose in-scope work → T2 may
  initiate within grants`) plus **per-capability grants** with scope + TTL, revocable. **Promotion is
  human-approved**; outcomes (jobs done, approvals granted/denied, incidents) are tracked as a *signal that
  informs* promotion, never an autonomous grantor.
- **Reuses:** engram's existing approval allow-rule machinery — persistent global allow-rules + TTL + the
  destructive guard (`./approvals.md`) — for the grant/TTL mechanics, so we do not invent a reputation engine.
- **Invariants carried from A (must survive B):** peer/web content rendered as untrusted data (never
  instructions); the destructive guard (destructive actions are never auto-approved or grant-covered); and A3's
  central revoke as the hard kill-switch — a revoked member is frozen regardless of tier.

### 2. Autonomy boundary — self-initiation = proposals within scope; external side effects always gated
- **What A built:** members coordinate on work posted by the human/coordinator; they do **not** self-initiate
  (`canPostJobInTx` is coordinator/human-only); every external effect routes to the human approval gate. This
  is the floor.
- **B generalizes it to:** higher tiers may **self-post jobs and initiate peer handoffs** within scope + budget.
  The floor never moves: any action with an **external side effect** still routes to the human approval gate at
  every tier, and destructive actions are always human-approved (A3's guard).
- **Initiation ≠ side effects:** autonomy produces *proposals*; the control boundary is enforced at the action
  level. This preserves the guiding invariant — **the human is the control boundary**.

## Phased build plan (each phase reuses A's core; no rework)

**B1 — Dynamic trust store + tiered gating.**
- Tasks: add `trustTier` + `grants[]` (`{ capability, scope, ttl }`) to `board.engram`; new human-approved
  `grant` / `revoke` / `promote` tools; generalize `canRouteInTx` / `canPostJobInTx` from allowlist →
  tier+grant check (TTL-aware); keep A3's revoke and the destructive guard as overrides that beat any grant.
- Acceptance: a T0 member is data-only; a granted capability expires at its TTL; promotion requires human
  approval; an A3 revoke still hard-freezes a member regardless of tier. Deterministic (no model).

**B2 — Self-initiation within scope.**
- Tasks: allow in-scope members to `post_job` as *proposals* (tier-gated); proposals execute only past the human
  action gate; a budget cap pauses self-initiation when exhausted.
- Acceptance: a mid-tier member can propose an in-scope job but cannot force an external side effect without
  approval; over-budget self-initiation is paused.

**B3 — Charter + broker-side action enforcement.**
- Tasks: a durable `board.charter` doc (standing rules, forbidden actions, escalation paths, human override);
  the broker checks every action against **charter + tier + grants + budget** before it proceeds — generalizing
  A's per-tool gates to action-level policy.
- Acceptance: an action outside charter/tier/grants is blocked at the broker and escalated; **no self-elevation**
  (an agent cannot modify its own tier, grants, or the charter).

**B4 — Kill-switches / circuit breakers + audit/provenance.**
- Tasks: suspend any agent *or the whole population*; freeze pending actions; global grant revoke; an
  append-only audit of every action and grant change with job provenance (initiator + tier at the time). Extends
  A3's per-member disable to population scale.
- Acceptance: a compromised member is suspended and its pending actions frozen, durably (survives restart);
  every action is auditable back to initiator + tier.

**B5 — Containment at scale (M2) + safety.**
- Tasks: per-instance isolation (members as separate instances, not just in-harness), no shared secrets, egress
  limits — generalizing A3's Podman sandbox from per-conversation to per-instance; role/model pooling (cheap
  models for low tiers, strong models for high-stakes work).
- Acceptance: a compromised member cannot read another's secrets or exceed its grants; population size is bounded
  by how many concurrent agents the hardware serves well.

**B6 — Multi-human governance (deferred, schema-ready).**
- Tasks: humans as a governance layer with roles/permissions over charter/grants/approvals; per-role approval
  routing and escalation.
- Acceptance: an approver role approves within its scope; the owner overrides all.

## Sequencing & gate
B1 → B2 → B3 → B4 → B5 → B6, each incremental on A's board core. **Start small** (a handful of agents); B's
ceiling is local-model capacity under "no cloud spend." B builds only after A has proven out — which it now has.

## Open items (need your call before B1)
- **Scale target** — how many concurrent agents / boxes before B beats "a bigger A"? (bounded by local-model capacity)
- **Grant granularity** — which capabilities get individual grants vs. coarse tiers?
- **Charter content defaults** — the standing rules for the first charter.
- **Multi-human scope** — how many roles, and when to build it (B6).

## Non-goals (B1–B2)
No separate instances yet (M2 is B5); no auto-reputation (signal only); no multi-human governance (B6); no cloud spend.
