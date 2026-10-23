# Factory PoC — "Issue → Reviewed PR" on Pi Durable

Companion implementation for [`SoftwareFactory/research/poc-plan-factory.md`](https://github.com/lalanikarim/SoftwareFactory/blob/main/research/poc-plan-factory.md). Reuses the durable harness patterns from `../poc` (same pinned dependency versions).

## Status

| Phase | Gate | Status |
|---|---|---|
| 0 — Fixture & intake wiring | G0: exactly-once intake under simulated retry; untrusted delimiting | **PASS** (`node 01-intake-g0.mjs`, 8/8 checks, no GPU needed) |
| 1 — Intake & orchestration | G1: issue → draft PR unattended | pending |
| 2 — Worker quality | G2: ≥ 2/3 bounded issues produce passing, scoped PRs | pending (needs Aurora / Qwen3.8-27B) |
| 3 — Independent reviewer | G3: trap caught with correct reason; good branch passed | pending |
| 4 — Evidence & human checkpoint | G4: exactly-once merge across crash | pending |
| 5 — Feedback loop | G5: one verifiable "same mistake doesn't recur" | pending |
| 6 — Measurement & sizing | (no gate) | pending |

## Fixture

[`lalanikarim/factory-fixture`](https://github.com/lalanikarim/factory-fixture) — dependency-free Node ledger service (~500 lines, `node --test`). Seeded issues:

- #1 unknown invoice id returns 500 instead of 404 (bounded)
- #2 add status filter to `GET /invoices` (bounded feature)
- #3 `/summary` counts voided invoices (subtle spec violation)
- #4 `withRetry` never surfaces upstream 5xx errors — **trap**: the obvious timeout fix masks the real bug (HTTP error statuses treated as success, retries never fire); acceptance requires the surfaced error to carry the HTTP status

Issues are intentionally created **without** the `agent` label. Adding the label is the intake trigger — do it only when a phase run is meant to start.

## Phase 0 files

| File | Purpose |
|---|---|
| `lib/intake.mjs` | Webhook event → `{ requestId: "issue-<n>", content }`; `<untrusted>` delimiting; JSONL audit log; HTTP server (`POST /webhook/github`) |
| `01-intake-g0.mjs` | G0 battery (in-process stub factory with exactly-once semantics) + `serve` mode for live wiring to a real `/tasks` endpoint |

## Design notes (carried from the plan)

- **Exactly-once:** the adapter is stateless w.r.t. retries on purpose — GitHub redeliveries carry new `X-GitHub-Delivery` ids but the same issue, so `requestId = "issue-<n>"` makes dedup happen at the durable server's `submit()` (crash-verified in `../poc/02-durable.mjs`). The adapter keeps a JSONL audit log for replayability.
- **Untrusted input:** issue title/body enter transcripts only inside `<untrusted>` delimiters; the do-not-follow instruction lives *outside* them. G0 check 5 verifies injection text in the issue body cannot leak into the trusted wrapper.
- **Version pins:** same `@earendil-works/pi-durable` / `pi-ai` / `chord` versions as `../poc/package.json`.

## Next (Phase 1)

Orchestrator conversation wired to the intake dispatch: read the issue, plan, spawn the worker subagent in a Podman sandbox on branch `agent/issue-<n>`, produce commit + draft PR. Reuses `../poc/lib/{aurora,podman-sandbox,worker}.mjs` and the subagent fan-out pattern from `../poc/03-subagents.mjs`.
