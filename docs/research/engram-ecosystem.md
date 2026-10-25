# Engram Ecosystem — Collective vs. Society (research / brainstorming thread)

**Status:** research / brainstorming — **not** a committed plan or spec. This is a living
thread; sections marked *open* need decisions before anything here becomes a build plan.
It deliberately does **not** pick one direction. Instead it frames two candidate directions as
**separate projects that both build on the same core engram unit**, and records gaps, drifts,
and feasibility for each.

Derived from: `PLAN.md` (§1 design decisions, §5 security model, §9 post-MVP direction),
`INVESTIGATION.md` (§5 communication, §8 client/agent-to-agent, §10 Hermes/Agent Zero
comparison), and the current MVP in `app/`.

---

## 0. Framing

Today engram is **one durable project-brain serving one human**: a single harness over one
SQLite storage, with a root conversation, project/worker conversations, subagents, approval
gates, a KB, and clients (HTTP/SSE, Telegram, Web UI). `PLAN.md` §9 already names a strategic
fork — including a *"multi-agent substrate"* direction.

This thread explores **two** ways to go beyond one brain, kept deliberately separate:

- **Option A — The Collective:** a *bounded standing team* of named engram instances serving
  **one human**. The human stays the sole operator and approver.
- **Option B — The Society:** an *open population* of agents with more lateral autonomy —
  roles/relations that can emerge, self-initiated work, possibly multiple humans later.

Both are framed as **separate projects on a shared core** (see §1). The working hypothesis is
that **A is the bounded, safe special case of B**, so building A first de-risks and reuses
everything B needs.

---

## 1. The shared foundation — the "core engram unit"

Everything both projects build on is one instance of the existing core. Defining this precisely
is what makes "two separate projects on the same core" coherent.

**A core engram unit is:**
- One durable harness over one storage (SQLite), `resume()` on start, exactly-once via
  `requestId`.
- Conversations: root + project/worker; forks; owned subagent conversations.
- Tools/extensions (CodingTools, `web_fetch`, `kb_search`, approval hook, config-driven HTTP
  tools) — malleable registry, per-conversation selection.
- **Approval gates** (`beforeTool` hook + memo): the control boundary. The agent cannot
  self-approve; decisions survive crashes.
- Durable primitives: submissions (exactly-once), steering (`whenBusy`), `watch`/`watchEvents`
  streams, **documents** (durable app state changed in the same commits as the transcript),
  background tasks with restart-surviving timers, background compaction.
- Clients: HTTP/SSE API, Telegram, Web UI.
- Security posture: LAN-only, sandboxed execution for untrusted/generated code, secrets hygiene.

**Invariants that both projects must preserve** (these *are* engram's philosophy):
1. **Durability & exactly-once** — crash-safe, no duplicate side effects.
2. **Human is the control boundary** — external side effects are approval-gated; no self-approval.
3. **Isolation** — untrusted/generated code is sandboxed; secrets never leak into transcripts.
4. **Local-first, LAN-only** exposure (until a project explicitly re-decides this).

Anything in A or B that weakens an invariant is a **drift** and must be called out (§4/§5).

### The one new primitive both projects need: the *instance + board* abstraction
The core unit today is self-contained; it has no notion of *other instances*. Both A and B need
a thin, shared layer on top of the core:
- **Instance identity** — a stable id per engram unit (name, endpoint/address, trust level).
- **A durable board** — a shared document surface for *discovery, tasks, requests, statuses*
  (maps directly onto existing `documents` + `submissions` + `watch`).
- **Cross-instance delegation** — a tool to post a task to another instance and read back its
  status/answer (reuses `submit`/`requestId`/`watch`; the current `send_message` stub is the seam).

This shared layer is effectively **"Project 0"** — the composable core. A and B are then two
different *policies* over the same instance+board substrate (§6). The board itself is designed
in its own thread: [board.md](board.md).

---

## 2. Option A — The Collective (N named engrams, one human)

**Vision.** One person gets a **standing team** of persistent specialist brains that coordinate
through a shared board. Not throwaway subagents — each member is a long-lived, named engram with
its own identity, workspace, model, and domain memory. The human reads the board, assigns work,
and approves; the members do the work and hand off to one another.

**Operating model.**
- **Members:** named standing conversations (or instances), each with its own `cwd`/workspace,
  optional model, and durable memory of its domain. Persists across days/weeks.
- **Board = coordination substrate:** discovery (who's here + their status), tasks (assignments),
  requests (approval/help escalations to the human), statuses (live progress).
- **Peer handoff in the receiver's context:** when `code` asks `infra` to deploy, `infra` acts
  using *its own* memory of the runbook — not just the caller's transcript. This is what a
  subagent cannot do.
- **Bounded autonomy:** members may coordinate on work already assigned by the human; any
  action with an external side effect still routes to the human for approval. The human is the
  single authority.

**Why this is distinct from today's subagents.** Subagents are task-scoped and die when the task
ends, running in the parent's context. Collective members **persist**, retain **domain memory**,
and coordinate **laterally** across sessions. That persistence + lateral handoff is the whole
point of "a collective" vs. "fan-out."

### Example use cases (bounded team, one human)
1. **Standing domain specialists.** Named engrams on fixed beats — `infra` (server/deploy/monitor),
   `code` (a repo/app), `research` (open threads + KB). Each remembers its domain for weeks; the
   board is how they discover each other and hand off.
2. **Triage front-desk + escalation.** A `router` member watches inbound signals (Telegram, email,
   webhooks, cron), routes each to the right specialist, tracks statuses, and escalates to the
   human **only** when a decision is needed. One calm feed: "what's happening + what needs me."
3. **Long-horizon pipeline with memory-carrying handoffs.** research → build → review → deploy as
   distinct persistent members; each gets smarter at its stage across *many* projects (reviewer
   remembers patterns, deployer remembers the runbook and past failures). All statuses on the board.
4. **Always-on monitoring & incident response.** A `watch` member runs 24/7 scheduled checks; on a
   failure it opens an incident task, pokes the relevant specialist to diagnose/fix in its own
   workspace, and escalates to the human only if a fix needs approval. Morning digest: "what I
   watched / fixed / what needs you."
5. **Independent review council (think tank).** For a big/risky decision, several members each give
   an independent assessment from their own domain memory; the human reads all vantage points and
   decides. Peer independence as a feature; human stays final authority.

### Gaps (what doesn't exist yet)
- **Instance identity / discovery** — no notion of "another engram" today.
- **Shared board primitive** — no durable task/status/request surface shared across members.
- **Standing member persistence** — subagents are ephemeral; need persistent named members with
  cross-task domain memory.
- **Peer trust/authorization tier** — the control boundary is human→root→worker; peer-to-peer
  actions aren't modeled.
- **Untrusted peer input handling** — web/email content is handled (delimited data, no-shell roles);
  *peer-agent* input is not yet a defined trust tier.

### Drifts from current philosophy (must be managed, not violated)
- Center of gravity shifts from "one brain serving me" to "a team serving me" — **acceptable**,
  the human remains the sole operator/approver.
- Lateral (peer-to-peer) autonomy is introduced where today's model is strictly top-down —
  **bounded** in A by keeping external side effects human-gated.
- Security surface widens modestly (inter-member traffic + discovery registry) — **manageable** if
  LAN-only, token-authed, per-member sandbox, no cross-member secrets.

### Feasibility: **High**
Composes existing primitives almost entirely (documents, submissions, `watch`, subagents,
approvals). Main new work is small: instance identity + board doc + a cross-instance delegation
tool + a peer trust tier. Can start as **named standing conversations inside one harness** (no
multi-process needed) → very low risk; scale to separate instances/boxes later if isolation
demands it. Security delta is small while LAN-only + human-gated.

### Open questions (A)
- Is a "member" a named conversation in one harness, or a separate process/instance? *(lean: start
  in-harness, abstract so it can become multi-instance)*
- One shared board vs. per-domain boards? Who may post/assign?
- Autonomy boundary: may a member initiate work on another member without the human, or only on
  work the human already posted? *(lean: coordinate on assigned work; new external effects gated)*
- How is a compromised/malicious member contained (per-member sandbox, no shared secrets)?

---

## 3. Option B — The Society (open agent population)

**Vision.** Beyond a bounded team: an **open population** of agents with more lateral autonomy —
roles and relations that can emerge over time, agents that **self-initiate** work within a shared
charte, form task dependencies, allocate/negotiate work, and maintain their own goals. The board
becomes a public **commons/marketplace** rather than a private team channel. This is closer to the
Hermes gateway / Agent Zero A2A models in `INVESTIGATION.md` §10.

**Operating model (sketch — much less defined than A).**
- **Population:** many agents, possibly unbounded; new agents can be created/retired dynamically.
- **Autonomy:** agents may initiate work, not just receive it; they pursue standing goals within a
  charter the human sets.
- **Trust/identity becomes first-class:** dynamic trust levels, reputation, provenance of tasks.
- **Governance:** rules for what agents may do autonomously vs. what escalates to the human(s);
  possibly an "economy" of task allocation (who does what, at what cost/effort).
- **Humans:** start as one, but the model anticipates **multiple humans** later (a governance layer,
  not a single operator).

**Why it's a separate project (not just "A at scale").**
A assumes *known, human-vetted peers* and *bounded autonomy*. B requires a **society substrate**
that A does not have: dynamic trust/reputation, governance of self-initiated action, and safety
guarantees for an open population. These are qualitatively new problems, not more instances.

### Gaps (what doesn't exist yet)
- Everything in A's gap list, **plus**:
- **Dynamic trust / identity / reputation** — no notion of "how much can this agent do on its own."
- **Governance of self-initiated action** — the control boundary today is human-triggered; B needs a
  policy layer for agent-initiated work.
- **Safety guarantees at scale** — loss-of-control is engram's #1 constraint (`brainstorm` E2); an
  open society maximizes that exposure.
- **Multi-human model** — explicitly relaxes the "1 human at a time" decision (deferred, but core to B).
- **Local-model capacity** — an open population of always-on agents is a large local-inference load
  under the "no cloud spend" constraint.

### Drifts from current philosophy (the largest of the two options)
- **Human role changes** from sole operator/approver to one participant in a governance layer —
  a fundamental shift, not an extension.
- **Autonomy becomes self-initiated/emergent**, directly against the "human is the control
  boundary" invariant. This is the single biggest drift and the main reason B is riskier.
- **Security surface grows substantially** (open inter-agent traffic, dynamic peers, emergent
  behavior) — stresses §5 hard.
- **Single-human assumption is relaxed** (multi-human later) — an explicit, deferred re-decision.

### Feasibility: **Medium / lower near-term**
Feasible as a *research direction*, but not advisable to build before A's core pieces exist. It
needs the society substrate (identity, dynamic trust, governance, possibly task economy) and much
harder safety guarantees. Natural sequencing: **A first → B builds on A's instance+board core** and
adds the autonomy/trust/governance layer.

### Open questions (B)
- What is the *charte* — the standing rules that bound agent autonomy? Who enforces it?
- Trust model: static named allowlist (like A) vs. dynamic trust/reputation?
- How do we keep "no loss of control" (`E2`) true for an open population? (containment, budgets,
  kill-switches, per-agent sandboxes, audit.)
- When/whether multi-human is in scope, and what the governance model looks like.
- Local-model capacity: how many always-on agents can the box serve; role/model pooling.

---

## 4. Comparison & decision framework

| Dimension | **A — Collective** | **B — Society** |
|---|---|---|
| Scale | Bounded team (~3–8 named members) | Open population (unbounded) |
| Human role | Sole operator + approver | Participant in a governance layer (multi-human later) |
| Autonomy | Delegated / bounded | Self-initiated / emergent |
| Trust model | Known, human-vetted named peers | Dynamic trust / reputation / provenance |
| Board role | Private team channel | Public commons / marketplace |
| Security delta | Modest (manageable LAN-only) | Substantial (stresses §5 hard) |
| New substrate needed | Instance id + board + delegation tool + peer trust tier | All of A **+** governance, dynamic trust, safety-at-scale |
| Feasibility now | **High** | **Medium / later** |

**Shared core (Project 0):** the instance+board abstraction (§1) — identity, durable board,
cross-instance delegation. Both projects are **policies over this same substrate**.

**Decision criteria for sequencing:**
1. Does it preserve the four invariants (§1)? A: yes. B: partially — autonomy + human-role drift.
2. Is the new work a composition of existing primitives (A) or a new substrate (B)?
3. Security delta vs. the #1 constraint (no loss of control).
4. Reuse: does it build on what the other already needs? (B builds on A.)

**Working recommendation (to confirm, not decided):** treat **Project 0 → A → B** as the path.
A is the safe, high-feasibility special case; it produces the shared core and most of the pieces
B needs, while keeping the human firmly in control. B stays a research track that reuses A's core
and adds the autonomy/trust/governance layer only if/when A proves out.

---

## 5. Consolidated gaps & drifts register

**Gaps (build needed for both, unless noted):**
- [ ] Instance identity + discovery (A, B)
- [ ] Durable board primitive: discovery / tasks / requests / statuses (A, B)
- [ ] Cross-instance delegation tool (reuses `submit`/`requestId`/`watch`; seam = `send_message`) (A, B)
- [ ] Standing member persistence + cross-task domain memory (A; more so B)
- [ ] Peer trust / authorization tier (A bounded; B dynamic)
- [ ] Untrusted peer-input handling as a defined trust tier (A, B)
- [ ] Governance of self-initiated action (B only)
- [ ] Dynamic trust / reputation / provenance (B only)
- [ ] Multi-human governance model (B only, deferred)

**Drifts (philosophy shifts to manage):**
- Center of gravity: one brain → team (A, acceptable) / → society (B, major).
- Autonomy: top-down → bounded lateral (A) / → self-initiated emergent (B, largest drift).
- Human role: sole operator (A preserved) / governance participant (B changed).
- Security surface: modestly widened (A) / substantially widened (B).
- Single-human assumption: preserved (A) / relaxed later (B).

---

## 6. Proposed project structure (to confirm)

- **Project 0 — Composable core.** Add the instance+board abstraction to engram without changing
  existing behavior: instance identity, a durable board doc, and a cross-instance delegation tool.
  This is shared by both directions and changes nothing about the current single-brain product.
- **Project A — Collective.** Bounded standing team serving one human (use cases §2). Builds on P0.
- **Project B — Society.** Open agent population with autonomy/trust/governance. Builds on P0 + A;
  research track until A proves out.

Each is a **separate project** (own plan doc, own branch) that depends on the same core unit and,
for B, on A's pieces. Nothing here commits engram to one direction yet.

---

## 7. Next steps / decisions needed

1. Confirm the **three-way framing** (P0 shared core → A → B) and that A is "B's bounded special case."
2. Decide the **member model** for A: named conversation in one harness vs. separate instance/box.
3. Define the **board schema** minimally (discovery / tasks / requests / statuses) — this unblocks
   P0. See [board.md](board.md) for the component breakdown + data-model sketch.
4. Set the **A autonomy boundary** (may members initiate peer work, or only on human-posted tasks?).
5. Agree the **peer trust model** for A (static named allowlist?) and containment of a bad member.
6. Name the projects (working names: "Collective" / "Society"; tentative).
7. When confirmed, split this thread into `docs/plans/project-0-core.md`, `docs/plans/collective.md`,
   and `docs/plans/society.md`.
