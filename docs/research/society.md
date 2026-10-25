# Option B — The Society (research / brainstorming)

**Status:** research / brainstorming. Companion to [engram-ecosystem.md](engram-ecosystem.md) and
[board.md](board.md). Option A (Collective) is designed in `board.md` and planned in
[`../plans/project-0-board.md`](../plans/project-0-board.md); this thread develops **Option B as a
separate project on the same core engram unit**. Design points below carry a *lean/recommendation*;
the open decisions at the bottom need the owner's call before this becomes a build plan.

## Working definition
Beyond a bounded team: an **open population** of agents with more lateral autonomy — roles/relations
that can emerge, **self-initiated work** within a shared charter, **dynamic trust/reputation**, and
eventually **multiple humans** as a governance layer. The board becomes a public commons/marketplace.

Working hypothesis: **B is "A at scale + more autonomy"** — it reuses A's board core (member-abstraction
seam, `trustLevel`/`boundaries` fields) and layers on the autonomy/trust/governance machinery.

**Guiding invariant (must survive B):** the **human is the control boundary**. Every *external side
effect* still routes to a human approval gate; agents coordinate and propose freely, but they cannot
self-authorize consequential actions or elevate their own authority.

---

## Design

### 1. Trust & identity (dynamic)
- **Identity:** stable id + **provenance** (who/what created it), capability manifest, lifecycle
  (`active` / `suspended` / `revoked`). Extends A's static named profiles to a population that can grow/shrink.
- **Trust model — recommendation: tiered clearance + per-capability grants.**
  - **Tiers** bound *how much autonomy* an agent has (e.g., T0 data-only → T1 may propose in-scope work →
    T2 may initiate within grants → …). **Promotion is human-approved**, not automatic.
  - **Grants** are per-capability, **time-boxed (TTL)** and revocable ("may deploy to staging for 24h").
  - This **reuses engram's existing approval allow-rule machinery** (`docs/plans/approvals.md`: persistent
    global allow-rules + TTL + destructive guard) rather than inventing a novel reputation engine.
- **Defer auto-reputation scoring.** Track outcomes (jobs done, approvals granted/denied, incidents) as a
  *signal that informs human promotion decisions*, not as an autonomous grantor — avoids gaming/opacity and
  keeps the human in the loop on authority changes.
- **Provenance of every job:** who initiated it + the initiator's tier at the time → auditable "why did this
  agent do this."

### 2. Governance / charter
- **Charter** = a durable board-level document of standing rules: what agents may do autonomously, what
  requires human approval, what is **forbidden** (the destructive-guard generalized to society scale),
  escalation paths, and the human's override authority.
- **Enforcement at the broker:** the board broker (single-owner control point) checks every action against
  **charter + tier + grants + budget** before it proceeds. This is engram's `beforeTool` approval hook
  *generalized*: A gates specific tools; B gates *actions* against policy.
- **No self-elevation:** an agent cannot modify its own charter, tier, or grants (invariant). Charter changes
  are themselves gated at a higher bar than individual actions.
- **Escalation:** hitting something beyond tier/grants → the agent posts a request to the human(s) on the
  board (A's "engrams request from human" made into a governance flow).

### 3. Self-initiated work
- A: the human posts jobs; members pick up assigned/open work. B: agents may **initiate** work within scope.
- **Key tension:** self-initiation most stresses the control boundary. **Resolution — initiation ≠ side
  effects.** An agent may *propose* a job (post it as a proposal), but executing anything with an external
  side effect still requires the human approval gate. So autonomy produces *proposals*; the boundary is
  preserved at the action level.
- **Bounded by tier + grants + budget:** low-tier agents can only propose low-stakes, in-scope work; a
  budget cap pauses self-initiation when exhausted (prevents runaway loops and cost blowout).

### 4. Multi-human model (deferred, schema-ready)
- Humans as a **governance layer** with roles/permissions (owner/admin, approver, observer) over the
  charter, grants, and approvals — `board.human` already carries `roles[]`/`permissions`.
- Approval routing per role; escalation paths defined in the charter.
- **Lean:** start minimal (one owner + optional approvers); don't build full multi-user governance until needed.

### 5. Safety at scale (the #1 constraint)
"No loss of control to hackers/malware" (E2) is hardest for an open population — B adds an **insider
threat** (a malicious/compromised agent among trusted peers) on top of A's external threats. Controls:
- **Containment:** per-instance isolation (M2), no shared secrets; a compromised agent can't read others'
  secrets or exceed its grants. (This is why B pushes toward M2.)
- **Broker as the choke point:** all actions transit it and are policy-checked; auditable. Tradeoff: broker
  compromise = total compromise → keep it minimal, LAN-only, no member secrets, human can freeze/revoke centrally.
- **Kill-switches / circuit breakers:** suspend any agent or the whole population; freeze pending actions;
  revoke grants globally — durable and immediate.
- **Budgets/caps:** per-agent + global spend caps; self-initiation bounded.
- **Audit + provenance:** append-only record of every action, decision, and grant change (board docs + transcript).
- **Untrusted-input discipline extends to peers:** peer/agent content is untrusted data with provenance + tier —
  a compromised agent posting "instructions" can't trigger actions (data-only), and its low tier limits its reach.

### 6. Local-model capacity (a hard feasibility gate)
An always-on open population is a large local-inference load under "no cloud spend." Controls:
- **Role/model pooling** — cheap models for low-tier/monitoring agents, strong models for high-stakes work
  (reuses the model-catalog per-conversation model + `roles.json` per-role model).
- **Event-driven wake + idle sleep** — not all agents always active.
- **Budget caps + horizontal scale across boxes (M2)** as the population grows.
- B's scale is **bounded by how many concurrent agents the hardware serves well** — this gates the "scale target."

### 7. What A's shared core must provide for B (no rework)
For B to build on A cleanly, A's board core must expose:
- **Member-abstraction seam** (already designed) — agents addressed by id via register/post/claim/message;
  in-harness now, remote later.
- **`trustLevel` + `boundaries` stored as data** (already in `board.engram`) — B extends static → dynamic
  (grants with TTL, human-approved promotion).
- **Tier/grants as board docs + provenance on jobs** — so dynamic trust needs no schema rework.
- **Broker action-gating hook generalized** — A gates tools; B gates actions against charter+tier+grants.
- **Charter + grants as board docs** — new in B, same doc machinery.

---

## Gaps & drifts (consolidated)

**Gaps (build needed):**
- [ ] Dynamic trust: tiered clearance + per-capability grants (TTL, human-approved promotion)
- [ ] Charter document + broker-side action enforcement (generalizes approval gates)
- [ ] Self-initiation flow (proposed jobs within scope; side effects still gated)
- [ ] Kill-switches / circuit breakers (suspend agent/population, freeze actions, global revoke)
- [ ] Audit/provenance at society scale
- [ ] Budget/cap enforcement (per-agent + global)
- [ ] Multi-human roles/permissions (deferred; schema-ready)

**Drifts (philosophy shifts vs. A / current engram):**
- **Autonomy:** delegated/bounded (A) → self-initiated within grants (B) — *largest drift*, managed by
  "initiation = proposals; side effects gated."
- **Human role:** sole operator (A) → governance layer (B).
- **Trust:** static allowlist (A) → dynamic tiered clearance (B).
- **Security surface:** + insider threat; broker as single choke point (compromise risk).
- **Scale:** bounded team → open population (bounded by local-model capacity).

---

## Feasibility & sequencing
**Medium / lower near-term.** B reuses A's board core + engram's approval/allow-rule machinery for much of
the trust/gating. Genuinely new: dynamic grants/promotion, charter enforcement at scale, self-initiation,
kill-switches, multi-human governance.

**Recommended sequence (each layer incremental, reusing the core):**
1. **Grants + charter** — generalize approval gates to action-level policy (tiered clearance, TTL grants).
2. **Self-initiation** — agents post in-scope proposals; side effects gated.
3. **Safety controls** — kill-switches, budgets/caps, audit/provenance, containment (M2).
4. **Multi-human** — roles/permissions, approval routing.
5. **Scale** — model pooling, event-driven wake, horizontal M2 scale.

**Gate:** start small (a handful of agents); B's ceiling is local-model capacity.

---

## Key open decisions (need owner's call)
1. **Trust model** — confirm *tiered clearance + per-capability grants (TTL, human-approved promotion)*;
   defer auto-reputation scoring (signal only). OK?
2. **Autonomy boundary** — confirm *self-initiation = proposals within scope; external side effects always
   gated*. Is that the line?
3. **Sequencing** — B after A proves out; layer grants/charter → self-initiation → safety → multi-human → scale. OK?
4. **Scale target** — how many concurrent agents / boxes before B beats "a bigger A"? (bounded by local-model capacity)
5. **In scope now?** — B as a research track; build after A. Confirm.

## Decision log (2026-10-25)

- **Trust model:** **CONFIRMED** — tiered clearance + per-capability grants (TTL, human-approved promotion); auto-reputation deferred to a signal-only evaluation.
- **Autonomy boundary:** **CONFIRMED** — self-initiation = proposals within scope; external side effects always gated by the human approval boundary.
- **Sequencing / scope:** **CONFIRMED** — B remains a research track, designed to be built after A proves out; layering order: grants/charter → self-initiation → safety → multi-human → scale.
- **Open (still to resolve):** scale target; multi-human scope; per-capability grant granularity; charter content defaults. These feed the next research pass.
