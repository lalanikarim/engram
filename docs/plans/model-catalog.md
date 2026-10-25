# Model catalog — multi-provider model discovery & switching

Status: **implemented** (branch `feature/model-catalog`, 2026-10-25 — unit 20/20, live api 55/55, telegram 18/18)

## Goal

Let the agent discover and switch models across **all pi-supported providers plus custom
models**, reusing the global pi configuration as the single source of truth. A conversation's
model is a durable, per-conversation choice with a configurable global default.

## Requirements

1. **Catalog** — every built-in pi-ai provider (opencode-go, openrouter, …) plus custom
   providers declared in `~/.pi/agent/models.json` (e.g. `spark`, `aurora`) are registered in
   one pi-ai `Models` catalog handed to the harness.
2. **Credentials** — resolved from the global pi config, no key duplication:
   - `~/.pi/agent/auth.json` via a small **read-only `CredentialStore`** (pi-ai interface;
     `modify`/`delete` serve an in-memory view, never persist).
   - Custom-provider `apiKey` from `models.json`: literal or `$ENV_NAME` interpolation.
   - `PI_AGENT_DIR` env override (default `~/.pi/agent`) for tests and future containers.
3. **Back-compat** — when no custom providers are declared, the legacy env-driven
   OpenAI-compatible provider (`OPENAI_BASE_URL` + `/v1/models` discovery) still works, so
   existing `.env` setups and the test suites are unchanged. If `models.json` declares a
   provider whose id matches the env provider's id, the `models.json` entry wins.
4. **Model ref format** — canonical string `<provider>:<modelId>` (split on the **first**
   colon; model ids may contain `/`). A bare model id is accepted when it resolves uniquely
   across the catalog; ambiguous/unknown refs are rejected with a helpful error.
5. **Global default** — `DEFAULT_MODEL=<provider>:<modelId>` env var. Resolution order for a
   conversation with no explicit model:
   1. explicit model on the request/conversation
   2. `DEFAULT_MODEL`
   3. fallback: loaded model on the local OpenAI-compatible endpoint (current behavior)

   No provider is preferred out of the box — the default is whatever the operator sets.
6. **Per-conversation ("project") model** — durable via pi-durable `configure({agent:{model}})`:
   - `POST /conversations {model?: "<provider>:<modelId>"}` at creation
   - `PATCH /conversations/:id {model?: "<ref>" | null}` — `null` resets to the global default
     (never leaves a conversation without a resolvable model)
   - works on the root conversation too
7. **API surface** —
   - `GET /models` → `{ models: [{provider, id, name, contextWindow}], default: "<ref>" }`
   - `GET /conversations` includes each conversation's current model ref
8. **Context-window guard** — switching a conversation to a model whose `contextWindow` is
   smaller than ~90% of the current transcript estimate (chars/4 over visible messages) is
   rejected with HTTP 409 and a message suggesting compaction first.
9. **Roles** — optional `model` field per role in `roles.json`. Worker resolution:
   role's model > calling conversation's model (via `ToolExecutionApi.agent()`) > global default
   chain. Fixes the hardcoded `provider: "aurora"` in `extensions/subagents.ts`.
10. **Telegram** — `/model` command on a bound conversation: no arg → current model + list of
    available models; with arg (`<ref>`) → switch that conversation (same guard as the API).

## Non-goals

- No OAuth/login flows (api-key providers only; read-only credential store).
- No Web UI dropdown in this pass (the API surface is ready for it).
- No per-conversation compaction tuning (global `reserveTokens` stays as-is; the guard above
  is the overflow protection).
- Auto model-loading on inference hosts (Unsloth load step) — deferred.

## Design notes / verified facts

- pi-durable's `ModelRef = { provider, modelId }` is per-conversation (`AgentState.model`) and
  mutable via durable `configure()` — switching survives restarts.
- pi-ai ships a static catalog for built-in providers (opencode-go: 29 models with context
  windows); `builtinModels({credentials})` registers all of them. Auth is resolved at request
  time from the credential store / env — no discovery needed for built-ins.
- `~/.pi/agent/models.json` schema: `{providers: {<id>: {baseUrl, apiKey, api?, models: [{id, name?, contextWindow?, maxTokens?, ...}]}}}`;
  validated against pi-ai's provider/model schemas.
- pi-durable does **not** read the global pi config itself — the app wires it in explicitly
  (this is by design: "app-owned credential storage").

## Test plan

- Unit-ish (no live model): catalog builder over a temp `PI_AGENT_DIR` (custom provider +
  auth.json entry), ref parsing (`a:b/c`, bare id, ambiguous, unknown), default resolution order.
- Live suite additions (`api.test.ts` or new `models.test.ts` against the local endpoint):
  - `GET /models` lists the env-discovered model and the configured default
  - create conversation with explicit model; `GET /conversations` shows it
  - `PATCH` switch + reset-to-default round trip (same local model → durable, survives restart)
  - unknown/ambiguous ref → 400
- Existing suites must stay green (back-compat requirement 3).

## Decision log

- Out-of-the-box default is operator-configured (`DEFAULT_MODEL`), not a hardcoded provider.
- Ref format `<provider>:<modelId>` (first-colon split) because model ids contain `/`.
- Using hosted providers (e.g. opencode-go) relaxes PLAN §1 "local models only" — deliberate,
  operator's choice per conversation.
