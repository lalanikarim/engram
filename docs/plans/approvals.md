# Smarter approvals — risk tiers, persistent rules, destructive guard

Status: **all phases implemented** — phases 1–4 (2026-10-25), phase 5 classifier scoring (2026-10-26, fail-safe design below). Decisions recorded from discussion with the owner.

## Current state (what works, what's dumb)

Today (`src/extensions/approvals.ts`): a static `GATED_TOOLS` list blocks any call to a
gated tool name until a human decision is stored durably. Key = `sha1(tool + canonical
args)` → per-exact-action, idempotent across crash-retries; only the API driver writes
decisions (the agent cannot self-approve). Pending requests are discovered from transcript
markers via `GET /approvals`.

Weaknesses this plan addresses:

1. **Coarse granularity** — all-or-nothing per tool name. Gating `bash` would mean
   approving every command; not gating it leaves shell unchecked.
2. **Approval fatigue** — N distinct actions = N interruptions; no batching, no "approve all".
3. **No persistent rules** — approval is per *exact* args; same recipient with a different
   message prompts forever.
4. **Pending requests live forever** — no TTL, no expiry, no escalation.
5. **Thin decision context** — raw JSON args only; the human sees *what*, not *why*; denial
   has no reason channel so the agent can't adapt.

## Decisions (2026-10-25)

| Question | Decision |
|---|---|
| Which tools get gated? | Proposed defaults: `bash` with safe-pattern auto-tier, `send_message`/future email prompt, writes outside `/work` confirm — **plus a destructive-action guard that always wins** (see below) |
| Persistent rule scope | **Global** (all conversations) for now |
| TTL | **24 h** → auto-deny, for now |
| Denial reasons | **Yes** — UI surface in Web UI + Telegram + API |
| Scope ordering | **A (tiers) + B (rules) + E (rich prompts)** first, then D (TTL), then C (batching); F (classifier scoring) deferred |

## Design

### Tiers (A) — config-driven risk evaluation

New `app/gates.json` (validated at startup like `tools.json`):

```json
{
  "tiers": [
    { "tool": "bash",
      "autoPatterns": ["^ls( |$)", "^cat ", "^git (status|diff|log|show)( |$)", "^pwd$", "^echo "],
      "default": "prompt" },
    { "tool": "send_message", "default": "prompt" }
  ],
  "destructivePatterns": [
    "rm -rf", "rm -fr", "mkfs", "dd if=", ":(){", "git push --force",
    "git push -f", "DROP TABLE", "DROP DATABASE", "TRUNCATE ", "> /dev/", "shutdown", "reboot"
  ]
}
```

Hook evaluation order (first match wins):

1. **Destructive guard** — any gated call whose args match a `destructivePattern`
   is tier `destructive`: always prompts, with an explicit acknowledgement button
   ("I understand the risk — run it"). **Destructive actions can never be auto-approved and
   can never be covered by persistent allow-rules** — one-shot approvals only. This is the
   hard safety floor; it beats everything else.
2. **Persistent allow-rule match** (B, below) → auto-approve (logged to transcript).
3. **Tool tier from config**: `auto` pattern match → pass with a logged remark; otherwise the
   tool's `default` tier (`prompt`) → current block-and-wait flow.
4. Ungated tools: unchanged.

Pattern matching is regex over the canonical arg rendering (bash: the command string),
**reduced to simple commands first** (issue #53, 2026-10-28): a bash line is split on `&&`,
`||`, `|`, `;`, `&`, and newlines (quote-aware); `/dev/*` redirections are dropped
(discarding output is not a write); quoted string literals are masked — data positions can't
perform actions — except when the simple command's head is a shell interpreter or `eval`,
where quoted text is live code and is tested as its own candidate. `reboot`/`shutdown`
count only as the command being run (head position, after env assignments/`sudo`), never
as a mentioned word — `grep reboot src/` does not block. Non-bash tools keep conservative
canonical-JSON matching. Patterns are deliberately conservative — when in doubt, prompt.

**Containment-gated floor suppression** (issue #53): a tier may declare
`"containment": "sandbox"`. When that conversation runs sandboxed
(`ConversationMeta.sandbox === true`), the tool is ungated there — neither the destructive
floor nor the declared tier applies, because the sealed container is the protection. This is
declarable and loud: `compileGates` warns at startup listing every containment-declared tool,
and each suppression logs once per conversation/tool. **Uncontained conversations keep the
absolute floor** — the invariant above survives wherever there is no declared containment.

### Persistent rules (B) — "always allow this"

- Session-scoped singleton doc `ApprovalRulesDoc` holding `{ rules: [{ id, tool, match: {argName: value}, createdAt, source }] }`
  (a single doc rather than a family — pi-durable has no doc-family scan API, and one
  read per gated call is cheaper). A rule matches when every `match` field equals the call's
  arg for that field. Rule id = sha1(tool + canonical match) → creating the same rule twice is a no-op.
- Checked **after** the destructive guard, **before** tier evaluation → matching calls pass
  silently. (No per-call transcript remark: hooks can't append entries; auditability comes from
  the rule doc itself — id, tool, match, createdAt, source.)
- Created from the approval prompt: an **"Always allow"** button alongside Approve/Deny
  (never offered for `destructive`-tier calls; the API rejects `alwaysAllow` on destructive items).
  Decision recorded as approved *and* rule written in one commit. Rule scope is derived server-side:
  `send_message` → recipient only (`{to}`); any other tool → all top-level scalar args (exact-action rule).
- Management: `GET /approval-rules`, `DELETE /approval-rules/:id`. Scope is **global** per the
  decision — trust in "sending to bob" survives across conversations/projects.
- Crash-safety: rule write + approval decision land in the same commit (no approve-without-rule
  or rule-without-approve splits).

### Richer prompts + denial reasons (E)

- The approval prompt (Telegram buttons, Web UI panel, API) renders human-readable context:
  - **Why**: the agent's immediately preceding assistant message (truncated).
  - **What**: tool-specific rendering — `bash` → the command line; `send_message` → recipient +
    body; generic tools → pretty-printed args. Tier badge (`prompt` / `destructive`).
- **Denial reason**: `POST /approvals/:key` accepts `{decision, reason?}`. Web UI gets a
  text field on deny; Telegram keeps the text fallback extended to `deny <key> because …`.
  The feedback instruction fed back to the agent includes the reason when present
  ("DENIED because: use staging, not prod") so it can adapt instead of dead-ending.
- `ApprovalDoc` gains `reason: string | null`, `createdAt` (for D), and `tier` for UI display.

### TTL + escalation (D) — phase 3

- Pending approvals older than `APPROVAL_TTL_HOURS` (default **24**) auto-deny: the hook treats
  an expired pending record as denied, writing `decidedBy: "ttl"` durably (idempotent), and
  `GET /approvals` stops listing it. The agent is told it expired.
- Optional follow-up: Telegram re-ping at ~50% of TTL. Deferred unless felt.

### Batching (C) — phase 4

- When N actions are pending in one conversation, the client shows them as one grouped prompt
  with per-item Approve/Deny plus "Approve all" (each item still gets its own durable decision;
  destructive items stay separate and explicit). API: `POST /approvals/batch {keys, decision}`.

### Classifier scoring (F) — phase 5, built 2026-10-26

A small local model scores each **prompt-tier** action before the human sees it:

- `gates.json` gains an optional `classifier` block: `{ enabled, model?, timeoutMs? (default
  60000), destructiveThreshold? (default 0.7) }`. `model` is `"<provider>:<modelId>"`; unset →
  the catalog default model.
- The hook calls the classifier **after** the allow-rule check and **before** writing the
  pending marker. Verdict = `{ score: 0..1, destructive: bool, note: ≤200 chars }` parsed from
  the model's first JSON object (robust to prose/markdown wrapping).
- **Escalation only**: `destructive: true` or `score ≥ threshold` promotes the action to the
  destructive tier (explicit acknowledgement UI). The score + note ride on the approval marker
  → `GET /approvals` → Web UI risk line, Telegram prompt line.
- **Fail-safe invariants** (must survive any future change):
  - The classifier NEVER approves, auto-passes, or suppresses a prompt — only humans write
    decisions; allow-rules stay human-driven.
  - Any failure (timeout, missing model, malformed output) degrades to the plain prompt tier;
    classification can never block the gate or let an action through.
  - The approval key is unchanged (`sha1(tool + canonical args)`); classifier output never
    feeds it, so crash-retry idempotency is unaffected.
- `src/extensions/classifier.ts` holds the prompt, parsing, and escalation rule (unit-tested);
  `makeClassifyAction(models, modelRef, timeoutMs)` builds the live classifier from the catalog.

## Phases & acceptance

| Phase | Scope | Acceptance | Status |
|---|---|---|---|
| 1 | Tiers + destructive guard (A) + rich prompts & denial reasons (E) | safe `bash` command runs without prompt; `rm -rf` blocked with destructive UI even if an allow-rule exists for that tool; denial reason reaches the agent's next turn | ✅ done — gates unit suite 19/19; live api suite 63/63 incl. `[7b]` (destructive block + tier badge + why + denial reason round-trip) |
| 2 | Persistent rules (B) | "Always allow" on a `send_message` → identical-recipient sends pass silently thereafter; rule listed/deleted via API; destructive call never auto-passes | ✅ done — rules unit suite 14/14; live api `[7c]` (approve+alwaysAllow → rule stored, second send silent, destructive alwaysAllow rejected, delete); telegram T7 (button → settle + persisted rule) |
| 3 | TTL (D) | pending approval past 24 h auto-denies durably and disappears from `/approvals`; agent notified | ✅ done — rules/TTL unit suites; live api `[7d]` (blocked → lapsed → gone from list → durable `ttl` denial → notified) |
| 4 | Batching (C) | grouped prompt for N pending; "approve all" records N distinct durable decisions | ✅ done — api `[7e]` (batch approve → 200 all decided, not-pending cleared, retry executes both; destructive batch → 400; empty/unknown keys → 400/not_found); telegram grouped ballot + web grouped banner |
| 5 | Classifier scoring (F) | gated prompt-tier action carries `riskScore` + `riskNote`; high-risk verdict escalates to destructive tier; classification failure degrades to plain prompt tier | ✅ done — unit suite 13/13 (parsing, escalation rule, config validation); live suite 9/9 (classified pending approval, no false escalation, approve → retry → executed) |

Test additions: unit tests for tier evaluation order (destructive > rule > tier), pattern
matching, TTL expiry, rule matching; live checks in `api.test.ts` / `telegram.test.ts` for the
acceptance rows above.

## Non-goals

- No per-conversation rules (global only for now).
- No classifier scoring (F) until proven necessary.
- No changes to the self-approval safety property: only the API driver writes decisions;
  allow-rules are data written by human-driven endpoints, never by agent tools.
