// Token-auth HTTP/SSE API over the durable harness (PLAN §4, D3–D4).
//   GET  /health                  liveness
//   GET  /ready                   readiness (true once the harness is open + resumed)
//   POST /tasks                   {content, requestId, conversationId?} → exactly-once submit
//   GET  /stream?conversationId&cursor   SSE: durable entries (cursor-addressable) + lifecycle events
//   GET  /models                  catalog: all provider models + availability + default ref
//   GET  /providers               all providers (built-in + custom-registered)
//   GET  /providers/:id/models    all models of one provider
//   GET  /conversations           list all conversations (name, cwd, activity, model)
//   POST /conversations           {cwd?, name?, model?} → new ownerless conversation with its own workspace
//   PATCH /conversations/:id      {model?: "<provider>:<modelId>" | null} → durable per-conversation model switch
//   POST /steer                   {content, requestId, conversationId?} → steer a running conversation
//   GET  /approvals               pending approval requests (discovered from transcript markers)
//   POST /approvals/:key          {decision: "approved"|"denied"} → durable decision
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Conversation, ConversationId, EntryRecord, EntryId, Harness, ModelRef } from "@earendil-works/pi-durable";
import { AgentDoc, watchEvents } from "@earendil-works/pi-durable";
import type { AppConfig } from "./config.ts";
import {
  defaultModelRef,
  formatModelRef,
  listCatalogModels,
  listProviderModels,
  listProviders,
  parseModelRef,
  type ModelsConfig,
} from "./model.ts";
import {
  ApprovalDoc,
  ApprovalRulesDoc,
  defaultRuleMatch,
  isApprovalExpired,
  parseApprovalMarker,
  ruleIdFor,
  type ApprovalRule,
} from "./extensions/approvals.ts";
import { ConversationMeta } from "./meta.ts";

const ctx = BACKGROUND_CONTEXT;
const MAX_BODY_BYTES = 1_000_000;

// Public static assets for the Web UI (PLAN §4 D10–11). Only exact paths are served —
// no user-controlled path segments. All data routes remain bearer-authenticated.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(APP_ROOT, "web");
const VENDOR_FILES: Record<string, { file: string; type: string }> = {
  "/vendor/preact.mjs": { file: "node_modules/preact/dist/preact.mjs", type: "text/javascript" },
  "/vendor/hooks.mjs": { file: "node_modules/preact/hooks/dist/hooks.mjs", type: "text/javascript" },
  "/vendor/htm.mjs": { file: "node_modules/htm/dist/htm.mjs", type: "text/javascript" },
  "/vendor/htm-preact.mjs": { file: "node_modules/htm/preact/index.mjs", type: "text/javascript" },
};

function serveStatic(pathname: string): { data: Buffer; type: string } | null {
  try {
    if (pathname === "/" || pathname === "/index.html") {
      return { data: readFileSync(path.join(WEB_ROOT, "index.html")), type: "text/html; charset=utf-8" };
    }
    if (pathname === "/app.js") {
      return { data: readFileSync(path.join(WEB_ROOT, "app.js")), type: "text/javascript" };
    }
    const v = VENDOR_FILES[pathname];
    if (v) return { data: readFileSync(path.join(APP_ROOT, v.file)), type: v.type };
  } catch {
    return null;
  }
  return null;
}

// IDs are branded at the type level but plain numbers at runtime.
const cid = (n: number): ConversationId => n as ConversationId;
const eid = (n: number): EntryId => n as EntryId;

export interface ServerDeps {
  harness: Harness;
  root: Conversation;
  config: AppConfig;
  /** Multi-provider catalog + global default (DEFAULT_MODEL / local fallback). */
  modelsConfig: ModelsConfig;
  /** App-registered routes, tried after the core routes (product/consumer endpoints). */
  routes?: readonly AppRoute[];
  /**
   * Additional bearer tokens accepted by the auth gate (M2.2: this instance's peer tokens,
   * so remote members can reach the board RPC routes). They still only unlock what the
   * app-registered peer routes expose — identity is re-resolved per route.
   */
  extraTokens?: () => readonly string[];
}

/** Context handed to app-registered routes (see {@link AppRoute}). */
export interface RouteContext {
  harness: Harness;
  config: AppConfig;
  /** Durable background context for commits/snapshots from the route handler. */
  ctx: Context;
  /** Send a JSON response (no-op if headers were already sent). */
  json: (res: http.ServerResponse, status: number, body: unknown) => void;
  /** Pending approval requests (same shape as GET /approvals). */
  pendingApprovals: () => Promise<Record<string, unknown>[]>;
}

/**
 * App-registered HTTP route — the product/consumer seam for custom endpoints.
 * Matched by exact method + pathname and tried after the core routes, before the
 * 404 fallback. The kernel knows nothing about what apps serve; this is how e.g.
 * the product's GET /board or a consumer's webhook intake reach the instance server.
 */
export interface AppRoute {
  method: string;
  path: string;
  handle: (req: http.IncomingMessage, res: http.ServerResponse, routeCtx: RouteContext) => Promise<void>;
}

/** Route-level error with an HTTP status (bad model refs → 400, overflow guard → 409). */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Parse a request's `model` field; undefined passes through (use the default chain). */
function resolveModelParam(modelsConfig: ModelsConfig, model: unknown): ModelRef | undefined {
  if (model === undefined) return undefined;
  if (typeof model !== "string" || model.trim() === "") {
    throw new HttpError(400, 'model must be a non-empty "<provider>:<modelId>" string');
  }
  try {
    return parseModelRef(modelsConfig.models, model);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/**
 * Pending approval requests across conversations, each attributed with the agent's most
 * recent assistant message before its marker (the "why" shown to the human) and the
 * marker entry's timestamp (`pendingSince`, for TTL expiry).
 */
async function pendingApprovals(harness: Harness): Promise<Record<string, unknown>[]> {
  const found = await harness.commit(async (tx) => {
    const convs = await tx.scanConversations({ order: "descending" }, 100);
    const pending = new Map<string, Record<string, unknown>>();
    for (const c of convs.items) {
      const entries = await tx.scanEntries({ conversationId: c.id, order: "ascending" }, 200);
      let why: string | undefined;
      for (const e of entries.items) {
        let sawAssistant = false;
        for (const m of e.model ?? []) {
          if (m.role !== "assistant") continue;
          sawAssistant = true;
          const text = (typeof m.content === "string" ? [m.content] : m.content.filter((c) => c.type === "text").map((c) => c.text)).join(" ").trim();
          if (text) why = text.slice(0, 300);
        }
        for (const text of entryTexts(e)) {
          const marker = parseApprovalMarker(text);
          if (marker && !pending.has(marker.key)) {
            pending.set(marker.key, {
              key: marker.key,
              tool: marker.tool,
              args: marker.args,
              tier: marker.tier ?? "prompt",
              riskScore: marker.riskScore,
              riskNote: marker.riskNote,
              why: sawAssistant ? undefined : why,
              conversationId: c.id,
              entryId: e.id,
              pendingSince: e.model?.[0]?.timestamp,
            });
          }
        }
      }
    }
    return [...pending.values()];
  }, ctx);

  const items: Record<string, unknown>[] = [];
  for (const p of found) {
    const rec = await harness.snapshot(ApprovalDoc, p.key as string, ctx);
    if (!rec || rec.decision === "pending") items.push(p);
  }
  return items;
}

/**
 * TTL sweep (phase 3): durably deny every pending request older than `ttlMs`
 * (`decidedBy: "ttl"`, idempotent) and notify each affected conversation exactly once
 * (requestId keyed on the approval key). Returns the requests denied by THIS sweep.
 */
async function sweepExpiredApprovals(harness: Harness, ttlMs: number): Promise<Array<{ key: string; tool: string }>> {
  const now = Date.now();
  const expiredItems = (await pendingApprovals(harness)).filter((a) =>
    isApprovalExpired(a.pendingSince as number | undefined, now, ttlMs),
  );
  const denied: Array<{ key: string; tool: string; conversationId: number }> = [];
  for (const item of expiredItems) {
    const wasPending = await harness.commit(async (tx) => {
      const d = await tx.doc(ApprovalDoc, item.key as string, {});
      if (d.decision !== "pending") return false;
      d.decision = "denied";
      d.decidedBy = "ttl";
      d.decidedAt = now;
      return true;
    }, ctx);
    if (wasPending) denied.push({ key: item.key as string, tool: item.tool as string, conversationId: item.conversationId as number });
  }
  for (const e of denied) {
    const conv = await harness.conversation(cid(e.conversationId), ctx);
    if (!conv) continue;
    try {
      // Exactly-once per key: a re-sweep after the notice already landed is a no-op.
      await conv.submit(
        { type: "input", content: `⏰ Approval \`${e.key}\` for \`${e.tool}\` expired after the approval TTL with no decision — treat it as denied. Do not retry that action; tell the user it lapsed.`, requestId: `ttl-expired-${e.key}` },
        ctx,
      );
    } catch (err) {
      console.error(`[server] TTL notice for ${e.key}: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
  return denied.map(({ key, tool }) => ({ key, tool }));
}

/** Rough transcript size in tokens (chars/4 over the visible model context). */
async function estimateTranscriptTokens(conv: Conversation): Promise<number> {
  const view = await conv.context(ctx);
  let chars = 0;
  for (const m of view.messages) {
    const c = m.content;
    if (typeof c === "string") chars += c.length;
    else if (Array.isArray(c)) for (const part of c) if (part.type === "text") chars += part.text.length;
  }
  return Math.ceil(chars / 4);
}

function authorized(req: http.IncomingMessage, tokens: readonly string[]): boolean {
  const header = req.headers["authorization"] ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7));
  let ok = false;
  for (const token of tokens) {
    const expected = Buffer.from(`Bearer ${token}`);
    // Compare every candidate so the timing does not reveal which token matched.
    if (presented.length === expected.length && timingSafeEqual(presented, expected.slice(7))) ok = true;
  }
  return ok;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Read a JSON request body (bounded). Exported for app-registered routes. */
export async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("invalid JSON body");
  }
}

/** All text visible in an entry: model message text plus the raw data payload. */
function entryTexts(e: EntryRecord): string[] {
  const texts: string[] = [];
  for (const m of e.model ?? []) {
    if (typeof m.content === "string") texts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content) if (c.type === "text") texts.push(c.text);
    }
  }
  if (e.data !== undefined && e.data !== null) texts.push(JSON.stringify(e.data));
  return texts;
}

function entrySummary(e: EntryRecord) {
  const m = e.model?.[0];
  if (!m) return { kind: e.kind };
  if (m.role === "assistant") {
    const calls = (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.name);
    const text = (m.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ")
      .slice(0, 200);
    return { role: "assistant", toolCalls: calls, textPreview: text };
  }
  if (m.role === "toolResult") {
    const text = (m.content ?? [])
      .map((c) => (c.type === "text" ? c.text : ""))
      .join(" ")
      .slice(0, 200);
    return { role: "toolResult", toolName: m.toolName, isError: Boolean(m.isError), textPreview: text };
  }
  if (m.role === "user") {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return { role: "user", textPreview: text.slice(0, 200) };
  }
  return { kind: e.kind };
}

export function createServer(deps: ServerDeps): http.Server {
  const { harness, root, config, modelsConfig, routes } = deps;

  // Context for app-registered routes (deps.routes); built once, shared per request.
  const routeCtx: RouteContext = {
    harness,
    config,
    ctx,
    json: (res, status, body) => sendJson(res, status, body),
    pendingApprovals: () => pendingApprovals(harness),
  };

  // TTL sweeper: an initial pass after startup plus a periodic one. The period is bounded
  // so tiny test TTLs still sweep within seconds; production (24 h) sweeps every 5 min.
  const ttlMs = config.approvalTtlHours * 3_600_000;
  let disposed = false;
  const sweep = () => {
    if (disposed) return; // server closed (core close()); the interval is only unref'd, not cleared
    sweepExpiredApprovals(harness, ttlMs).catch((err) =>
      console.error(`[server] TTL sweep: ${String(err instanceof Error ? err.message : err)}`),
    );
  };
  const sweepTimer = setInterval(sweep, Math.max(5_000, Math.min(300_000, ttlMs / 4)));
  sweepTimer.unref?.();
  setTimeout(sweep, 2_000); // initial pass shortly after ready

  const server = http.createServer(async (req, res) => {
    try {
      // Public UI bootstrap assets (no auth); the data plane below stays token-gated.
      if (req.method === "GET") {
        const staticFile = serveStatic(new URL(req.url ?? "/", "http://localhost").pathname);
        if (staticFile) {
          res.writeHead(200, { "content-type": staticFile.type });
          res.end(staticFile.data);
          return;
        }
      }
      if (!authorized(req, [config.token, ...(deps.extraTokens?.() ?? [])])) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const { pathname, searchParams } = url;

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      if (req.method === "GET" && pathname === "/ready") {
        sendJson(res, 200, { ready: true });
        return;
      }

      if (req.method === "GET" && pathname === "/models") {
        const models = await listCatalogModels(modelsConfig);
        const def = await defaultModelRef(modelsConfig);
        sendJson(res, 200, { models, default: formatModelRef(def) });
        return;
      }

      if (req.method === "GET" && pathname === "/providers") {
        sendJson(res, 200, { providers: await listProviders(modelsConfig) });
        return;
      }

      const providerModelsMatch = pathname.match(/^\/providers\/([^/]+)\/models$/);
      if (req.method === "GET" && providerModelsMatch) {
        try {
          const models = await listProviderModels(modelsConfig, decodeURIComponent(providerModelsMatch[1]));
          sendJson(res, 200, { provider: providerModelsMatch[1], models });
        } catch (e) {
          throw new HttpError(404, (e as Error).message);
        }
        return;
      }

      if (req.method === "POST" && pathname === "/tasks") {
        const body = await readJsonBody(req);
        const content = typeof body.content === "string" ? body.content : "";
        const requestId = typeof body.requestId === "string" ? body.requestId : "";
        if (!content || !requestId) {
          sendJson(res, 400, { error: 'body must be {content: string, requestId: string[, conversationId: number]}' });
          return;
        }
        const conv = await resolveConversation(body.conversationId);
        if (!conv) {
          sendJson(res, 404, { error: `conversation ${String(body.conversationId)} not found` });
          return;
        }
        const sub = await conv.submit({ type: "input", content, requestId }, ctx);
        sendJson(res, 202, { submissionId: sub.id });
        return;
      }

      if (req.method === "POST" && pathname === "/steer") {
        const body = await readJsonBody(req);
        const content = typeof body.content === "string" ? body.content : "";
        const requestId = typeof body.requestId === "string" ? body.requestId : "";
        if (!content || !requestId) {
          sendJson(res, 400, { error: 'body must be {content: string, requestId: string[, conversationId: number]}' });
          return;
        }
        const conv = await resolveConversation(body.conversationId);
        if (!conv) {
          sendJson(res, 404, { error: `conversation ${String(body.conversationId)} not found` });
          return;
        }
        // whenBusy: "steer" injects the input into the running turn; idle conversations just run it.
        const sub = await conv.submit({ type: "input", content, requestId, whenBusy: "steer" }, ctx);
        sendJson(res, 202, { submissionId: sub.id });
        return;
      }

      if (req.method === "GET" && pathname === "/conversations") {
        type ConvSummary = {
          id: number;
          isRoot: boolean;
          ownedByTask: boolean;
          lastEntryId: number | null;
          name: string;
          cwd: string | null;
          sandbox: boolean;
          createdAt: number | null;
          model: string | null;
          openSubmissions: number;
        };
        const list = await harness.commit(async (tx) => {
          const page = await tx.scanConversations({ order: "descending" }, 100);
          const out: Array<Omit<ConvSummary, "name" | "cwd" | "sandbox" | "createdAt" | "model" | "openSubmissions">> = [];
          for (const c of page.items) {
            const last = await tx.scanEntries({ conversationId: c.id, order: "descending" }, 1);
            out.push({
              id: c.id,
              isRoot: c.id === root.id,
              ownedByTask: c.owner !== undefined,
              lastEntryId: last.items[0]?.id ?? null,
            });
          }
          return out;
        }, ctx);

        const open = new Map<number, number>();
        for (const s of (await harness.inspect(ctx)).submissions) {
          if (s.status !== "done" && s.status !== "unanswered") {
            open.set(s.conversationId, (open.get(s.conversationId) ?? 0) + 1);
          }
        }

        // Enrich with agent cwd + display name (separate reads; fine at personal-agent scale).
        const conversations: ConvSummary[] = [];
        for (const item of list) {
          const [agentState, meta] = await Promise.all([
            harness.snapshot(AgentDoc, cid(item.id), ctx),
            harness.snapshot(ConversationMeta, cid(item.id), ctx),
          ]);
          conversations.push({
            ...item,
            name: meta?.name || `conversation-${item.id}`,
            cwd: agentState?.cwd ?? null,
            sandbox: meta?.sandbox === true,
            createdAt: meta?.createdAt || null,
            model: agentState?.model ? formatModelRef(agentState.model) : null,
            openSubmissions: open.get(item.id) ?? 0,
          });
        }
        sendJson(res, 200, { conversations });
        return;
      }

      if (req.method === "POST" && pathname === "/conversations") {
        const body = await readJsonBody(req);
        const cwd = typeof body.cwd === "string" ? sanitizeCwd(body.cwd) : undefined;
        const sandboxed = body.sandbox === true;
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : undefined;
        const model = resolveModelParam(modelsConfig, body.model);
        if (cwd === null) {
          sendJson(res, 400, { error: 'cwd must be a relative directory without ".."' });
          return;
        }
        const conv = await harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: { cwd, model: model ?? (await defaultModelRef(modelsConfig)), thinkingLevel: "medium" },
            init: async (tx, conversationId) => {
              const d = await tx.doc(ConversationMeta, conversationId);
              d.name = name ?? (cwd ? `project-${cwd}` : `conversation-${conversationId}`);
              d.createdAt = Date.now();
              if (sandboxed) d.sandbox = true;
              return undefined;
            },
          },
          ctx,
        );
        sendJson(res, 201, {
          id: conv.id,
          cwd: cwd ?? null,
          name: name ?? null,
          sandbox: sandboxed,
          model: formatModelRef(model ?? (await defaultModelRef(modelsConfig))),
        });
        return;
      }

      // Durable per-conversation model switch. `model: null` resets to the global default.
      const patchMatch = pathname.match(/^\/conversations\/(\d+)$/);
      if (req.method === "PATCH" && patchMatch) {
        const convId = Number(patchMatch[1]);
        const conv = await harness.conversation(cid(convId), ctx);
        if (!conv) {
          sendJson(res, 404, { error: `conversation ${convId} not found` });
          return;
        }
        const body = await readJsonBody(req);
        let target: ModelRef;
        if (body.model === null || body.model === undefined) {
          target = await defaultModelRef(modelsConfig);
        } else {
          target = resolveModelParam(modelsConfig, body.model)!;
        }
        // Overflow guard: don't move a long transcript onto a smaller context window.
        const modelEntry = modelsConfig.models.getModel(target.provider, target.modelId);
        if (modelEntry) {
          const est = await estimateTranscriptTokens(conv);
          if (est > modelEntry.contextWindow * 0.9) {
            throw new HttpError(
              409,
              `transcript is ~${est} tokens; ${formatModelRef(target)} has a ${modelEntry.contextWindow}-token window — compact the conversation first`,
            );
          }
        }
        await conv.configure({ model: target }, ctx);
        sendJson(res, 200, { id: convId, model: formatModelRef(target) });
        return;
      }

      // Full transcript entries after a cursor (Telegram final answers, Web UI history).
      const entriesMatch = pathname.match(/^\/conversations\/(\d+)\/entries$/);
      if (req.method === "GET" && entriesMatch) {
        const convId = Number(entriesMatch[1]);
        const after = Number(searchParams.get("after") ?? 0);
        const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 100), 1), 200);
        if (!Number.isInteger(after) || after < 0) {
          sendJson(res, 400, { error: "after must be a non-negative integer" });
          return;
        }
        const conv = await harness.conversation(cid(convId), ctx);
        if (!conv) {
          sendJson(res, 404, { error: `conversation ${convId} not found` });
          return;
        }
        const page = await harness.commit(
          (tx) => tx.scanEntries({ conversationId: cid(convId), minEntryId: eid(after + 1), order: "ascending" }, limit),
          ctx,
        );
        sendJson(res, 200, { conversationId: convId, entries: page.items, hasMore: Boolean(page.next) });
        return;
      }

      // Fork a conversation at its current head (e.g. Telegram forum topics → forks of the root chat).
      const forkMatch = pathname.match(/^\/conversations\/(\d+)\/fork$/);
      if (req.method === "POST" && forkMatch) {
        const parentId = Number(forkMatch[1]);
        const parent = await harness.conversation(cid(parentId), ctx);
        if (!parent) {
          sendJson(res, 404, { error: `conversation ${parentId} not found` });
          return;
        }
        const body = await readJsonBody(req).catch((): Record<string, unknown> => ({}));
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : undefined;
        const forked = await harness.commit(async (tx) => {
          const last = await tx.scanEntries({ conversationId: cid(parentId), order: "descending" }, 1);
          if (!last.items[0]) return null; // empty parent — nothing to fork at
          const rec = await tx.forkConversation(cid(parentId), eid(last.items[0].id), {
            ownership: { kind: "ownerless" },
          });
          if (name) {
            const d = await tx.doc(ConversationMeta, rec.id);
            d.name = name;
          }
          return rec.id;
        }, ctx);
        if (forked === null) {
          // Parent has no entries yet: fall back to a fresh sibling conversation.
          const conv = await harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: { model: await defaultModelRef(modelsConfig), thinkingLevel: "medium" },
              init: async (tx, conversationId) => {
                const d = await tx.doc(ConversationMeta, conversationId);
                d.name = name ?? `conversation-${conversationId}`;
                d.createdAt = Date.now();
                return undefined;
              },
            },
            ctx,
          );
          sendJson(res, 201, { id: conv.id, forkedFrom: parentId, fresh: true });
          return;
        }
        sendJson(res, 201, { id: forked, forkedFrom: parentId, fresh: false });
        return;
      }

      if (req.method === "GET" && pathname === "/approvals") {
        // Sweep first so the list never contains already-expired requests.
        await sweepExpiredApprovals(harness, config.approvalTtlHours * 3_600_000);
        const items = await pendingApprovals(harness);
        sendJson(res, 200, { approvals: items });
        return;
      }

      // Batch decision (phase 4): N pending keys → one commit, per-key durable decisions.
      // Destructive-tier items are never batchable — they must be approved individually.
      if (req.method === "POST" && pathname === "/approvals/batch") {
        const body = await readJsonBody(req);
        const keys = Array.isArray(body.keys)
          ? [...new Set(body.keys.filter((k): k is string => typeof k === "string" && /^[a-f0-9]{12}$/.test(k)))]
          : [];
        if (keys.length === 0 || keys.length > 50) {
          sendJson(res, 400, { error: 'body must be {keys: string[1..50], decision: "approved" | "denied"[, reason?: string]}' });
          return;
        }
        const decision = body.decision;
        if (decision !== "approved" && decision !== "denied") {
          sendJson(res, 400, { error: 'decision must be "approved" or "denied"' });
          return;
        }
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
        const pending = await pendingApprovals(harness);
        const byKey = new Map(pending.map((a) => [a.key as string, a]));
        const destructiveKeys = keys.filter((k) => byKey.get(k)?.tier === "destructive");
        if (destructiveKeys.length > 0) {
          sendJson(res, 400, { error: "destructive actions must be approved individually", keys: destructiveKeys });
          return;
        }
        const results = await harness.commit(async (tx) => {
          const out: Array<{ key: string; status: string }> = [];
          for (const key of keys) {
            if (!byKey.has(key)) {
              out.push({ key, status: "not_found" }); // unknown key — do not create a phantom decision
              continue;
            }
            const d = await tx.doc(ApprovalDoc, key, {});
            if (d.decision !== "pending") {
              out.push({ key, status: `already_${d.decision}` });
              continue;
            }
            d.decision = decision;
            d.decidedBy = "api";
            d.decidedAt = Date.now();
            if (reason) d.reason = reason;
            out.push({ key, status: "decided" });
          }
          return out;
        }, ctx);
        sendJson(res, 200, { decision, results });
        return;
      }

      const approvalKeyMatch = pathname.match(/^\/approvals\/([a-f0-9]{12})$/);
      if (req.method === "GET" && approvalKeyMatch) {
        // Decision state for one approval key (404 until a decision is recorded).
        const rec = await harness.snapshot(ApprovalDoc, approvalKeyMatch[1], ctx);
        if (!rec) sendJson(res, 404, { error: `no decision recorded for ${approvalKeyMatch[1]}` });
        else sendJson(res, 200, { key: approvalKeyMatch[1], decision: rec.decision, decidedBy: rec.decidedBy, decidedAt: rec.decidedAt, reason: rec.reason ?? null });
        return;
      }

      if (req.method === "GET" && pathname === "/approval-rules") {
        const doc = await harness.snapshot(ApprovalRulesDoc, ctx);
        sendJson(res, 200, { rules: doc?.rules ?? [] });
        return;
      }

      const ruleMatch = pathname.match(/^\/approval-rules\/([a-f0-9]{12})$/);
      if (req.method === "DELETE" && ruleMatch) {
        const id = ruleMatch[1];
        const result = await harness.commit(async (tx) => {
          const d = await tx.doc(ApprovalRulesDoc);
          const before = d.rules.length;
          d.rules = d.rules.filter((r) => r.id !== id);
          return d.rules.length < before;
        }, ctx);
        if (!result) sendJson(res, 404, { error: `rule ${id} not found` });
        else sendJson(res, 200, { id, deleted: true });
        return;
      }

      const approvalMatch = pathname.match(/^\/approvals\/([a-f0-9]{12})$/);
      if (req.method === "POST" && approvalMatch) {
        const key = approvalMatch[1];
        const body = await readJsonBody(req);
        const decision = body.decision;
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
        if (decision !== "approved" && decision !== "denied") {
          sendJson(res, 400, { error: 'body must be {decision: "approved" | "denied"[, reason?: string]}' });
          return;
        }
        // "Always allow" writes a persistent rule in the SAME commit as the approval.
        const alwaysAllow = body.alwaysAllow === true;
        if (alwaysAllow && decision !== "approved") {
          sendJson(res, 400, { error: 'alwaysAllow requires decision "approved"' });
          return;
        }
        let rule: ApprovalRule | null = null;
        if (alwaysAllow) {
          const item = (await pendingApprovals(harness)).find((a) => a.key === key);
          if (!item) {
            sendJson(res, 404, { error: `approval ${key} not found` });
            return;
          }
          if (item.tier === "destructive") {
            sendJson(res, 400, { error: "destructive actions can never be allow-listed" });
            return;
          }
          const match = defaultRuleMatch(item.tool as string, item.args);
          rule = { id: ruleIdFor(item.tool as string, match), tool: item.tool as string, match, createdAt: Date.now(), source: "approval" };
        }
        // Idempotent: a key may be decided twice in a race (double-tap, button + text).
        const result = await harness.commit(async (tx) => {
          const d = await tx.doc(ApprovalDoc, key, {});
          if (d.decision !== "pending") return { already: true as const, decision: d.decision };
          d.decision = decision;
          d.decidedBy = "api";
          d.decidedAt = Date.now();
          if (reason) d.reason = reason;
          if (rule) {
            const rules = await tx.doc(ApprovalRulesDoc);
            if (!rules.rules.some((r) => r.id === rule!.id)) rules.rules.push(rule!);
          }
          return { already: false as const, decision, reason };
        }, ctx);
        if (result.already) {
          sendJson(res, 409, { key, error: `already ${result.decision}` });
          return;
        }
        // Clients (Telegram/Web) feed the decision back to the agent; the endpoint
        // only records it. The reason travels in the response so clients can relay it.
        sendJson(res, 200, { key, decision, reason: result.reason ?? null, rule: rule?.id ?? null });
        return;
      }

      if (req.method === "GET" && pathname === "/stream") {
        await handleStream(req, res, searchParams);
        return;
      }

      // App-registered routes (product/consumer endpoints) — after core routes, before 404.
      for (const route of routes ?? []) {
        if (route.method === req.method && route.path === pathname) {
          await route.handle(req, res, routeCtx);
          return;
        }
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        const status = err instanceof HttpError ? err.status : msg === "invalid JSON body" || msg === "body too large" ? 400 : 500;
        sendJson(res, status, { error: msg });
      }
    }
  });

  // ---- helpers bound to this server instance ----

  async function resolveConversation(conversationId: unknown): Promise<Conversation | undefined> {
    if (conversationId === undefined) return root;
    const id = Number(conversationId);
    if (!Number.isInteger(id)) throw new Error("conversationId must be an integer");
    return harness.conversation(cid(id), ctx);
  }

  async function handleStream(req: http.IncomingMessage, res: http.ServerResponse, params: URLSearchParams) {
    const conversationId = Number(params.get("conversationId") ?? root.id);
    if (!Number.isInteger(conversationId)) {
      sendJson(res, 400, { error: "conversationId must be an integer" });
      return;
    }
    const conv = await harness.conversation(cid(conversationId), ctx);
    if (!conv) {
      sendJson(res, 404, { error: `conversation ${conversationId} not found` });
      return;
    }
    const cursor = Number(params.get("cursor") ?? 0);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const stream = await watchEvents(harness, cid(conversationId), ctx);
    let lastSentId = cursor;
    const sendSSE = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const sendEntries = (entries: readonly EntryRecord[]) => {
      for (const e of entries) {
        if (e.id > lastSentId) {
          sendSSE("entry", { id: e.id, kind: e.kind, summary: entrySummary(e) });
          lastSentId = e.id;
        }
      }
    };

    // Baseline: everything after the cursor (covers reconnects).
    sendEntries(stream.snapshot.entries);
    sendSSE("ready", { conversationId, from: cursor });

    let closed = false;
    stream.start(async (events, _ctx) => {
      if (closed) return;
      for (const ev of events) {
        try {
          if (ev.type === "snapshot") sendEntries(ev.entries); // overflow recovery
          else if (ev.type === "message_end" && ev.entry) sendEntries([ev.entry]);
          else if (ev.type === "tool_execution_end" && ev.entry) sendEntries([ev.entry]);
          else if (ev.type === "submission" && ev.record.status === "placed") {
            const entryId = ev.record.entry as EntryId;
            const entry = await harness.commit((tx) => tx.entry(eid(entryId)), ctx);
            if (entry) sendEntries([entry]);
            sendSSE("event", { type: "submission", id: ev.record.id, status: ev.record.status });
          } else if (["run_start", "run_end", "tool_execution_start", "message_update"].includes(ev.type)) {
            const slim =
              ev.type === "message_update"
                ? { type: ev.type, usage: ev.usage }
                : Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "changes"));
            sendSSE("event", slim);
          }
        } catch {
          // client gone — stop the stream
          closed = true;
          await stream.stop();
          return;
        }
      }
    });

    req.on("close", () => {
      closed = true;
      void stream.stop();
    });
  }

  server.on("close", () => {
    disposed = true;
    clearInterval(sweepTimer);
  });
  return server;
}

/** cwd must stay inside the work root: relative, no traversal. Returns undefined when absent, null when invalid. */
function sanitizeCwd(value: string): string | undefined | null {
  const v = value.trim();
  if (v === "") return undefined;
  if (v.startsWith("/") || v.includes("\\") || v.split("/").some((seg) => seg === ".." || seg === "")) {
    return null;
  }
  if (!/^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/.test(v)) return null;
  return v;
}
