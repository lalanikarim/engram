# M2 — Remote member transport (federated boards)

Status: **M2.1 outbound dispatch implemented** (2026-10-27); M2.2 board RPC API + client pending.
Builds on the complete Project 0 board + Collective A1–A4 (`docs/plans/collective.md`). Framing:
[`../ecosystem-flows.md`](../ecosystem-flows.md) §2 (M1 vs M2), §5.3 (this work).

## What M2 is

The member abstraction was built M2-ready: `route_message` addresses a target **by id**, and
`resolveRouteInTx` resolves that id. In M1 the resolution lands on a local pi-durable
conversation; in M2 it can land on **another engram instance** — its own process, store, and box.
The board owner (one instance) remains the single system of record for member registry, jobs,
channels, and knowledge. Cross-instance coordination is RPC to that owner — never shared SQLite
(the "one process owns one store" invariant).

## Design decisions (2026-10-27, with the owner)

| Question | Decision |
|---|---|
| Peer credentials | **Env-referenced**: the board owner's `BOARD_PEER_TOKENS` env holds `name:token` pairs; a remote member profile stores only the **name** (`tokenRef`). Bearer tokens never land in the durable SQLite docs (consistent with A3 "no shared secrets"). |
| Scope of M2.1 | **Outbound dispatch only**: board owner → remote member. Remote participation (claim/report/route-back) is M2.2. |
| Delivery semantics | **Fire-and-forget on 202**. The dispatcher does not wait for the remote run — waiting would couple the instances' lifecycles. The peer processes the message in its own loop. |
| Exactly-once | Reuses the M1 mechanism: stable `requestId = msg-<sha1(sender\|to\|content)>`; the receiving instance's `POST /tasks` is exactly-once per requestId, so crash-retries of the dispatch de-duplicate on the peer side. |
| Trust | Remote members default to `trustLevel: "untrusted"`; inbound content is delivered through the existing `<untrusted from="…">` wrapping; the A2 allowlist (`canRouteInTx`) governs remote targets exactly as it governs local ones. |
| Live-test topology | Two instances on one box (board owner + peer), same pattern as the other board live tests. |

## Data model

`EngramProfile` gains two optional fields (doc version unchanged — old records simply lack them):

```ts
endpoint?: string | null;  // base URL of the member's instance ⇒ remote member when set
tokenRef?: string | null;  // name in BOARD_PEER_TOKENS (the token itself is never stored)
```

`conversationId` keeps its meaning shift: for a remote member it is the id **on the remote
instance**. `resolveRouteInTx` returns a `RouteTarget` with `endpoint`/`tokenRef` set only for
remote members; everything above that seam (trust tier, untrusted wrapping, allowlists) is
unchanged.

## M2.1 — outbound dispatch (done)

- `board.ts`: remote fields on the profile + registration; `RouteTarget`; `parsePeerTokens(env)`;
  `messageRequestId(sender, to, content)` (extracted from the tool for testability);
  `dispatchRemoteMessage({endpoint, token, conversationId, content, requestId})` — bearer-auth
  `POST {endpoint}/tasks`, throws on non-202/unreachable (the tool reports the failure; no partial state).
- `route_message`: local branch unchanged; remote branch resolves the token from
  `BOARD_PEER_TOKENS` and dispatches. Missing credentials or a failed delivery return a clear,
  retryable error to the agent (stable requestId ⇒ retry is safe).
- Registration: the coordinator's `register` tool accepts optional `endpoint` + `tokenRef`
  (validated: http(s) URL; tokenRef required for remote members), and a human-facing
  **`POST /board/members`** app-registered route on the board owner (`main.ts`) with the same
  validation. Idempotent on id; re-registering without `endpoint` clears the remote fields.
- Surfaces: Web board panel shows a `remote` badge; `GET /board` carries `endpoint`.
- Fix found along the way: the app's `rootInit` now also writes the coordinator's
  `MemberIdDoc`, so messages routed from the root are labeled `coordinator` (previously they
  fell back to the `human` label — functionally fine via the human bypass, wrong as provenance).

### Verification

- `test/board-remote.test.ts` — **14/14** unit: token parsing, endpoint validation, request-id
  stability, remote registration + resolution, allowlist interaction (allowed/barred/coordinator),
  idempotent re-registration clearing remote fields, and dispatch against a stub peer server
  (auth header, body shape, non-202 throws, unreachable throws).
- `test/board-remote-live.test.ts` — **10/10** live: two real instances; member conversation on the
  peer; remote registration + validation + dashboard; coordinator routes over HTTP; the peer's
  transcript contains the coordinator-sourced, untrusted-wrapped message.
- Regression: `board.test.ts` 66/66, `board-live.test.ts` 6/6 (no M1 behavior change).

## M2.2 — board RPC API + client (next)

Remote members should participate in the board's work loop, not just receive messages:

- **Board-owner HTTP API** (app-registered routes, bearer-auth with the peer's token): scoped
  `claim` / `report` / `route-back` against the board store — a remote member claims an open job,
  reports done/failed, and routes messages back to local members or the coordinator.
- **Client extension** (thin, installed on the remote instance): gives that brain tools mirroring
  `claim_job` / `report_status` / `route_message`, wired to the owner API instead of local docs.
  The remote instance keeps its own store; it never touches the owner's SQLite.

Open questions for M2.2 (decide when starting):
- Job visibility: does a remote member see *all* open jobs or only ones assigned/allowed to it?
- Approval routing for a remote member's gated actions: they stay on the **remote** instance's own
  approval surface (its human is the same human) — confirm, no owner-side proxying.
- Reconnect/backlog semantics if the owner is down while a remote member works (jobs are durable
  on the owner; nothing to backfill beyond re-claiming).

## Non-goals (for now)

- Multi-board / many-to-many federation (one board owner per collective).
- Automatic discovery of peer instances (registration is explicit, human/coordinator-driven).
- Cross-instance knowledge/channels sync (M2.1 routes messages only; knowledge stays per-board).
