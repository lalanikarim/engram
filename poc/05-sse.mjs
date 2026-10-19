// Phase 4a — SSE client endpoint (A8).
// GET  /events?conversation=1&cursor=<entryId>   SSE stream; durable entries are
//      cursor-addressable (id > cursor), ephemeral progress events are best-effort.
// POST /submit  {content, requestId}             exactly-once submit to root conversation.
// Auth: Authorization: Bearer <token from SSE_TOKEN env or default dev token>.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, watchEvents } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { auroraModels, auroraModelId } from "./lib/aurora.mjs";
import { loadDotEnv } from "./lib/env.mjs";
loadDotEnv();

const ctx = BACKGROUND_CONTEXT;
const TOKEN = process.env.SSE_TOKEN ?? "dev-token";
const PORT = Number(process.env.SSE_PORT ?? 8790);
const WORK = fileURLToPath(new URL("./work", import.meta.url));

const registry = createRegistry();
registry.install(CodingTools);

const h = await Harness.open(
  await openNodeSqliteStorage("./data/sse.sqlite"),
  { models: await auroraModels(), registry, env: () => new NodeExecutionEnv({ cwd: WORK }) },
  ctx,
);
h.resume();
const root = await h.root(ctx, {
  agent: { model: { provider: "aurora", modelId: await auroraModelId() }, thinkingLevel: "medium" },
});

function authorized(req) {
  return req.headers["authorization"] === `Bearer ${TOKEN}`;
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/submit") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { content, requestId } = JSON.parse(body || "{}");
    if (!content || !requestId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "content and requestId required" }));
      return;
    }
    const sub = await root.submit({ type: "input", content, requestId }, ctx);
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ submissionId: sub.id }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const conversationId = Number(url.searchParams.get("conversation") ?? root.id);
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const stream = await watchEvents(h, conversationId, ctx);
    let lastSentId = cursor;
    const sendEntries = (entries) => {
      for (const e of entries) {
        if (e.id > lastSentId) {
          sendSSE(res, "entry", { id: e.id, kind: e.kind, summary: entrySummary(e) });
          lastSentId = e.id;
        }
      }
    };

    // Baseline: everything after the cursor (covers reconnects).
    sendEntries(stream.snapshot.entries);
    sendSSE(res, "ready", { conversationId, from: cursor });

    let closed = false;
    stream.start(async (events) => {
      if (closed) return;
      for (const ev of events) {
        try {
          // Durable entries arrive via: attach/overflow snapshots, message_end.entry,
          // tool_execution_end.entry, and placed user submissions (fetched by id).
          if (ev.type === "snapshot") sendEntries(ev.entries); // overflow recovery
          else if (ev.type === "message_end" && ev.entry) sendEntries([ev.entry]);
          else if (ev.type === "tool_execution_end" && ev.entry) sendEntries([ev.entry]);
          else if (ev.type === "submission" && ev.record.status === "placed" && ev.record.entry !== undefined) {
            const entry = await h.commit((tx) => tx.entry(ev.record.entry), ctx);
            if (entry) sendEntries([entry]);
            sendSSE(res, "event", { type: "submission", id: ev.record.id, status: ev.record.status });
          } else if (["tool_execution_start", "message_update", "run_end"].includes(ev.type)) {
            const slim =
              ev.type === "message_update"
                ? { type: ev.type, usage: ev.usage }
                : Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "changes"));
            sendSSE(res, "event", slim);
          }
        } catch {
          // client gone — stop the stream
          closed = true;
          await stream.stop();
          return;
        }
      }
    }, ctx);

    req.on("close", () => {
      closed = true;
      stream.stop();
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`SSE server on http://127.0.0.1:${PORT} (conversation ${root.id})`);
});

function entrySummary(e) {
  const m = e.model?.[0];
  if (!m) return {};
  if (m.role === "assistant") {
    const calls = (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.name);
    const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 200);
    return { role: "assistant", toolCalls: calls, textPreview: text };
  }
  if (m.role === "toolResult") {
    const text = (m.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(" ").slice(0, 200);
    return { role: "toolResult", toolName: m.toolName, isError: Boolean(m.isError), textPreview: text };
  }
  if (m.role === "user") {
    const content = m.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return { role: "user", textPreview: text.slice(0, 200) };
  }
  return { kind: e.kind };
}
