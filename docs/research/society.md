# Option B — The Society (research / brainstorming)

**Status:** research / brainstorming — **starting scaffold**. Companion to
[engram-ecosystem.md](engram-ecosystem.md) and [board.md](board.md). Option A (Collective) is
designed in `board.md` and planned in [`../plans/project-0-board.md`](../plans/project-0-board.md);
this thread develops **Option B as a separate project on the same core engram unit**.

## What "Society" means (working definition)
Beyond a bounded team: an **open population** of agents with more lateral autonomy — roles/relations
that can emerge, **self-initiated work** within a shared charter, **dynamic trust/reputation**, and
eventually **multiple humans** as a governance layer. The board becomes a public commons/marketplace
rather than a private team channel.

Working hypothesis (from the ecosystem thread): **B is "A at scale + more autonomy"** — it reuses A's
board core (member-abstraction seam, `trustLevel` field) and adds the autonomy/trust/governance layer.

## Agenda (to be developed)
- **Dynamic trust / identity / reputation** — how trust is granted, raised, revoked; task provenance;
  contrast with A's static named allowlist.
- **Governance / charter** — the standing rules that bound agent autonomy; who enforces them; how work
  escalates to humans; what can never be delegated.
- **Self-initiated work** — agents may *initiate* jobs, not just receive them; how this stays inside the
  "human is the control boundary" invariant.
- **Multi-human model** — from one operator to a governance layer: roles, permissions, approvals.
- **Safety at scale** — keeping "no loss of control" (PLAN §5, E2) true for an open population:
  containment, budgets/caps, kill-switches, audit. This is where B most stresses engram's #1 constraint.
- **Local-model capacity** — how many always-on agents the box(es) can serve under "no cloud spend";
  role/model pooling; scheduling.
- **Relationship to A** — exactly what A's board core must provide for B to build on (member-abstraction
  seam, trust tiers as data, board store schema that accommodates dynamic trust without rework).

## Key open decisions
1. Is B in scope now, or a later phase? *(working assumption: research track; build after A proves out)*
2. Trust model: static allowlist (like A) vs. dynamic trust/reputation — and the migration path between them.
3. Autonomy boundary: what may an agent initiate without any human involvement?
4. Scale target: how many concurrent agents, on how many boxes, before B is "worth it" over a bigger A?
5. Multi-human: when (if ever) in scope, and what the governance model looks like.
