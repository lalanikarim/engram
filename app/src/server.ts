// Token-auth HTTP/SSE API over the durable harness (PLAN §4, D3–D4).
//   GET  /health                  liveness
//   GET  /ready                   readiness (true once the harness is open + resumed)
//   POST /tasks                   {content, requestId, conversationId?} → exactly-once submit
//   GET  /stream?conversationId&cursor   SSE: durable entries (cursor-addressable) + lifecycle events
//   GET  /conversations           list all conversations (name, cwd, activity)
//   POST /conversations           {cwd?, name?} → new ownerless conversation with its own workspace
//   POST /steer                   {content, requestId, conversationId?} → steer a running conversation
//   GET  /approvals               pending approval requests (discovered from transcript markers)
//   POST /approvals/:key          {decision: "approved"|"denied"} → durable decision
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, EntryRecord, EntryId, Harness, ModelRef } from "@earendil-works/pi-durable";
import { AgentDoc, watchEvents } from "@earendil-works/pi-durable";
import type { AppConfig } from "./config.ts";
import { ApprovalDoc, parseApprovalMarker } from "./extensions/approvals.ts";
import { ConversationMeta } from "./meta.ts";

const ctx = BACKGROUND_CONTEXT;
const MAX_BODY_BYTES = 1_000_000;

// IDs are branded at the type level but plain numbers at runtime.
const cid = (n: number): ConversationId => n as ConversationId;
const eid = (n: number): EntryId => n as EntryId;

export interface ServerDeps {
  harness: Harness;
  root: Conversation;
  config: AppConfig;
  /** Deployment default model for newly created conversations. */
  modelRef: ModelRef;
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"] ?? "";
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
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
  const { harness, root, config, modelRef } = deps;

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req, config.token)) {
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
          createdAt: number | null;
          openSubmissions: number;
        };
        const list = await harness.commit(async (tx) => {
          const page = await tx.scanConversations({ order: "descending" }, 100);
          const out: Array<Omit<ConvSummary, "name" | "cwd" | "createdAt" | "openSubmissions">> = [];
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
            createdAt: meta?.createdAt || null,
            openSubmissions: open.get(item.id) ?? 0,
          });
        }
        sendJson(res, 200, { conversations });
        return;
      }

      if (req.method === "POST" && pathname === "/conversations") {
        const body = await readJsonBody(req);
        const cwd = typeof body.cwd === "string" ? sanitizeCwd(body.cwd) : undefined;
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : undefined;
        if (cwd === null) {
          sendJson(res, 400, { error: 'cwd must be a relative directory without ".."' });
          return;
        }
        const conv = await harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: { cwd, model: modelRef, thinkingLevel: "medium" },
            init: async (tx, conversationId) => {
              const d = await tx.doc(ConversationMeta, conversationId);
              d.name = name ?? (cwd ? `project-${cwd}` : `conversation-${conversationId}`);
              d.createdAt = Date.now();
              return undefined;
            },
          },
          ctx,
        );
        sendJson(res, 201, { id: conv.id, cwd: cwd ?? null, name: name ?? null });
        return;
      }

      if (req.method === "GET" && pathname === "/approvals") {
        const found = await harness.commit(async (tx) => {
          const convs = await tx.scanConversations({ order: "descending" }, 100);
          const pending = new Map<string, Record<string, unknown>>();
          for (const c of convs.items) {
            const entries = await tx.scanEntries({ conversationId: c.id, order: "descending" }, 200);
            for (const e of entries.items) {
              for (const text of entryTexts(e)) {
                const marker = parseApprovalMarker(text);
                if (marker && !pending.has(marker.key)) {
                  pending.set(marker.key, {
                    key: marker.key,
                    tool: marker.tool,
                    args: marker.args,
                    conversationId: c.id,
                    entryId: e.id,
                  });
                }
              }
            }
          }
          return [...pending.values()];
        }, ctx);

        const items = [];
        for (const p of found) {
          const rec = await harness.snapshot(ApprovalDoc, p.key as string, ctx);
          if (!rec || rec.decision === "pending") items.push(p);
        }
        sendJson(res, 200, { approvals: items });
        return;
      }

      const approvalMatch = pathname.match(/^\/approvals\/([a-f0-9]{12})$/);
      if (req.method === "POST" && approvalMatch) {
        const key = approvalMatch[1];
        const body = await readJsonBody(req);
        const decision = body.decision;
        if (decision !== "approved" && decision !== "denied") {
          sendJson(res, 400, { error: 'body must be {decision: "approved" | "denied"}' });
          return;
        }
        await harness.commit(async (tx) => {
          const d = await tx.doc(ApprovalDoc, key, {});
          d.decision = decision;
          d.decidedBy = "api";
          d.decidedAt = Date.now();
          return undefined;
        }, ctx);
        sendJson(res, 200, { key, decision });
        return;
      }

      if (req.method === "GET" && pathname === "/stream") {
        await handleStream(req, res, searchParams);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJson(res, msg === "invalid JSON body" || msg === "body too large" ? 400 : 500, { error: msg });
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
