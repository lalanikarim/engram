// The Collective app: the flagship composition of the engram core — board extension +
// coordinator registration, the GET /board route, Telegram client, and shutdown wiring.
// The composable core lives in src/core.ts (issue #42); ecosystem framing (kernel vs. apps,
// solo/collective/society flows) is in docs/ecosystem-flows.md.
import path from "node:path";
import { loadDotEnv } from "./dotenv.ts";
import { loadConfig } from "./config.ts";
import {
  boardExtension,
  canPostJobInTx,
  canRouteInTx,
  claimJobInTx,
  dispatchRemoteMessage,
  isDisabledInTx,
  messageRequestId,
  postJobInTx,
  parsePeerTokens,
  readBoardDashboard,
  readBoardStatusInTx,
  readJobInTx,
  registerMemberInTx,
  renderPeerMessageUntrusted,
  reportStatusInTx,
  resolveRouteInTx,
  setMemberIdentityInTx,
  validateEndpoint,
  visibleJobsFor,
} from "./extensions/board.ts";
import { boardClientExtension } from "./extensions/boardClient.ts";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { ConversationMeta } from "./meta.ts";
import { readJsonBody } from "./server.ts";
import { defaultModelRef, formatModelRef, loadModelsConfig } from "./model.ts";
import { ROOT_INSTRUCTIONS } from "./registry.ts";
import { createCoreInstance } from "./core.ts";
import { TelegramClient } from "./telegram.ts";

// ---- M2.2 board RPC routes (peer-authenticated) -----------------------------

/**
 * Resolve the caller's board identity from its bearer token: the owner's API token acts as the
 * coordinator; any value in BOARD_PEER_TOKENS is that peer's member id; anything else is unknown.
 */
function peerIdentity(req: import("node:http").IncomingMessage, ownerToken: string): string | null {
  const header = req.headers["authorization"] ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  if (token === ownerToken) return "coordinator";
  for (const [name, value] of parsePeerTokens(process.env)) if (value === token) return name;
  return null;
}

/** The board-owner's RPC surface: job visibility/claim/report + route-back for remote members. */
function peerBoardRoutes(ownerToken: string): Array<import("./server.ts").AppRoute> {
  const guard = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, rc: import("./server.ts").RouteContext): string | null => {
    const id = peerIdentity(req, ownerToken);
    if (!id) rc.json(res, 401, { error: "unauthorized — bearer token is not a known peer" });
    return id;
  };

  return [
    {
      method: "POST",
      path: "/board/jobs",
      handle: async (req, res, rc) => {
        const me = guard(req, res, rc);
        if (!me) return;
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch {
          rc.json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : "";
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "";
        if (!id || !title) {
          rc.json(res, 400, { error: "body must be {id, title[, payload]}" });
          return;
        }
        const existing = await rc.harness.commit((tx) => readJobInTx(tx, id), rc.ctx);
        if (existing) {
          rc.json(res, 409, { error: `job "${id}" already exists` });
          return;
        }
        // A2: only the coordinator/human may post new work — members don't self-initiate.
        const mayPost = await rc.harness.commit((tx) => canPostJobInTx(tx, me), rc.ctx);
        if (!mayPost) {
          rc.json(res, 403, { error: `member "${me}" cannot post jobs (coordinator/human only)` });
          return;
        }
        const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? (body.payload as JsonObject) : {};
        await rc.harness.commit(
          (tx) => postJobInTx(tx, { id, title, requester: me, assignee: null, payload, status: "open", claimedBy: null, result: null }),
          rc.ctx,
        );
        rc.json(res, 201, { id });
      },
    },
    {
      method: "GET",
      path: "/board/jobs",
      handle: async (req, res, rc) => {
        const me = guard(req, res, rc);
        if (!me) return;
        const status = await rc.harness.commit((tx) => readBoardStatusInTx(tx), rc.ctx);
        // Claimable pool (open, unassigned) + the caller's own claimed jobs.
        rc.json(res, 200, { jobs: visibleJobsFor([...status.openJobs, ...status.claimedJobs], me) });
      },
    },
    {
      method: "POST",
      path: "/board/jobs/claim",
      handle: async (req, res, rc) => {
        const me = guard(req, res, rc);
        if (!me) return;
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch {
          rc.json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const jobId = typeof body.jobId === "string" && body.jobId.trim() ? body.jobId.trim() : "";
        if (!jobId) {
          rc.json(res, 400, { error: "body must be {jobId}" });
          return;
        }
        const job = await rc.harness.commit((tx) => claimJobInTx(tx, jobId, me), rc.ctx);
        if (job) {
          rc.json(res, 200, { job });
          return;
        }
        const existing = await rc.harness.commit((tx) => readJobInTx(tx, jobId), rc.ctx);
        if (!existing) rc.json(res, 404, { error: `unknown job "${jobId}"` });
        else rc.json(res, 409, { error: `job "${jobId}" is not open (already claimed or closed)` });
      },
    },
    {
      method: "POST",
      path: "/board/jobs/:id/status",
      pattern: /^\/board\/jobs\/[^/]+\/status$/,
      handle: async (req, res, rc) => {
        const me = guard(req, res, rc);
        if (!me) return;
        // /board/jobs/:id/status → the job id is the second-to-last path segment.
        const segments = (req.url ?? "").split("?")[0].split("/").filter(Boolean);
        const jobId = decodeURIComponent(segments[segments.length - 2] ?? "");
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch {
          rc.json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const status = body.status === "done" || body.status === "failed" ? body.status : null;
        if (!status) {
          rc.json(res, 400, { error: "body must be {status: 'done' | 'failed', result?}" });
          return;
        }
        const existing = await rc.harness.commit((tx) => readJobInTx(tx, jobId), rc.ctx);
        if (!existing) {
          rc.json(res, 404, { error: `unknown job "${jobId}"` });
          return;
        }
        if (existing.assignee !== me) {
          rc.json(res, 403, { error: `only the assignee (${existing.assignee ?? "n/a"}) may report on this job` });
          return;
        }
        const result = typeof body.result === "string" ? (body.result as string) : null;
        const updated = await rc.harness.commit((tx) => reportStatusInTx(tx, jobId, status, result), rc.ctx);
        rc.json(res, 200, { job: updated });
      },
    },
    {
      method: "POST",
      path: "/board/route",
      handle: async (req, res, rc) => {
        const me = guard(req, res, rc);
        if (!me) return;
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch {
          rc.json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const to = typeof body.to === "string" && body.to.trim() ? body.to.trim() : "";
        const content = typeof body.content === "string" && body.content.trim() ? body.content : null;
        if (!to || !content) {
          rc.json(res, 400, { error: "body must be {to, content}" });
          return;
        }
        const allowed = await rc.harness.commit((tx) => canRouteInTx(tx, me, to), rc.ctx);
        if (!allowed) {
          rc.json(res, 403, { error: `member "${me}" is not allowed to route to "${to}"` });
          return;
        }
        const route = await rc.harness.commit((tx) => resolveRouteInTx(tx, to), rc.ctx);
        if (!route) {
          rc.json(res, 404, { error: `unknown target "${to}"` });
          return;
        }
        // Same exactly-once id + untrusted wrapping as the local route_message tool.
        const requestId = messageRequestId(me, to, content);
        const text = `[${me} -> ${route.kind}:${to}] ${renderPeerMessageUntrusted(me, content)}`;
        if (route.endpoint) {
          const token = parsePeerTokens(process.env).get(route.tokenRef ?? "");
          if (!token) {
            rc.json(res, 502, { error: `no peer credentials for target "${to}"` });
            return;
          }
          try {
            await dispatchRemoteMessage({ endpoint: route.endpoint, token, conversationId: route.conversationId, content: text, requestId });
          } catch (e) {
            rc.json(res, 502, { error: `remote delivery to "${to}" failed: ${(e as Error).message}` });
            return;
          }
        } else {
          const target = await rc.harness.conversation(route.conversationId as ConversationId, rc.ctx);
          if (!target) {
            rc.json(res, 404, { error: `target "${to}" has no conversation` });
            return;
          }
          await target.submit({ type: "input", content: text, requestId }, rc.ctx);
        }
        rc.json(res, 200, { message: `routed message to ${route.kind} "${to}"` });
      },
    },
  ];
}

async function main() {
  loadDotEnv();
  const config = loadConfig();

  console.log(`[engram] building model catalog (agent dir ${process.env.PI_AGENT_DIR ?? "~/.pi/agent"}) …`);
  const modelsConfig = await loadModelsConfig();
  const defaultRef = await defaultModelRef(modelsConfig);
  console.log(`[engram] default model: ${formatModelRef(defaultRef)}`);

  // M2.2: when this instance is a remote member of another instance's board, install the
  // thin board-client extension (HTTP tools against the owner — no local board docs).
  const peerTokens = parsePeerTokens(process.env);
  const clientMemberId = process.env.BOARD_MEMBER_ID ?? "";
  const clientToken = clientMemberId ? peerTokens.get(clientMemberId) : undefined;
  const clientOwnerUrl = process.env.BOARD_OWNER_URL ?? "";
  let extraExtensions: ReturnType<typeof boardExtension>[] = [boardExtension()];
  if (clientMemberId && clientToken && clientOwnerUrl) {
    console.log(`[engram] board-client: member "${clientMemberId}" on ${clientOwnerUrl}`);
    extraExtensions.push(boardClientExtension({ ownerUrl: clientOwnerUrl, token: clientToken, memberId: clientMemberId }));
  } else if (clientMemberId || clientToken || clientOwnerUrl) {
    console.warn("[engram] board-client config incomplete — need BOARD_OWNER_URL + BOARD_MEMBER_ID + a matching BOARD_PEER_TOKENS entry; skipping");
  }

  const instance = await createCoreInstance({
    config,
    modelsConfig,
    // Product surface: the shared board (Project 0). Consumers of the core don't get it.
    extraExtensions,
    // Product endpoint: the board dashboard. The kernel is board-free; this route
    // is how the product exposes its own surface on the instance server.
    routes: [
      {
        method: "GET",
        path: "/board",
        handle: async (_req, res, rc) => {
          const dashboard = await readBoardDashboard(rc.harness, rc.ctx);
          const approvals = await rc.pendingApprovals();
          rc.json(res, 200, { ...dashboard, pendingApprovals: approvals });
        },
      },
      // M2: register a member (local or remote) on this instance's board. Human surface —
      // the coordinator does the same through the `register` tool.
      {
        method: "POST",
        path: "/board/members",
        handle: async (req, res, rc) => {
          let body: Record<string, unknown>;
          try {
            body = await readJsonBody(req);
          } catch {
            rc.json(res, 400, { error: "invalid JSON body" });
            return;
          }
          const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : "";
          const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "";
          const endpoint = typeof body.endpoint === "string" && body.endpoint.trim() ? body.endpoint.trim() : null;
          const tokenRef = typeof body.tokenRef === "string" && body.tokenRef.trim() ? body.tokenRef.trim() : null;
          const conversationId = Number.isInteger(body.conversationId) && (body.conversationId as number) > 0 ? (body.conversationId as number) : null;
          const trustLevel = body.trustLevel === "trusted" || body.trustLevel === "untrusted" ? body.trustLevel : "untrusted";
          const capabilities = Array.isArray(body.capabilities) ? (body.capabilities as unknown[]).filter((c): c is string => typeof c === "string") : [];
          const allowedTargets = Array.isArray(body.allowedTargets) ? (body.allowedTargets as unknown[]).filter((t): t is string => typeof t === "string") : [];
          if (!id || !name || conversationId === null) {
            rc.json(res, 400, { error: "body must be {id, name, conversationId[, endpoint, tokenRef, trustLevel, capabilities, allowedTargets]}" });
            return;
          }
          if (endpoint) {
            const err = validateEndpoint(endpoint);
            if (err) {
              rc.json(res, 400, { error: err });
              return;
            }
            if (!tokenRef) {
              rc.json(res, 400, { error: "remote member needs a tokenRef (a name in this instance's BOARD_PEER_TOKENS env)" });
              return;
            }
          }
          await rc.harness.commit(
            (tx) =>
              registerMemberInTx(tx, {
                id,
                name,
                kind: "member",
                conversationId,
                trustLevel,
                capabilities,
                allowedTargets,
                status: "active",
                description: "",
                endpoint,
                tokenRef,
              }),
            rc.ctx,
          );
          rc.json(res, 201, { id, endpoint });
        },
      },
      // ---- M2.2 board RPC API — peer-authenticated (the caller's bearer token must be the
      // owner token or a value in this instance's BOARD_PEER_TOKENS; the name is its member id)
      // ----
      ...peerBoardRoutes(config.token),
    ],
    // M2.2: peer tokens pass the auth gate so remote members can reach the board RPC routes
    // (identity is re-resolved per route from the token; they unlock nothing else).
    extraTokens: () => [...peerTokens.values()],
    rootAgent: { model: defaultRef, thinkingLevel: "medium", instructions: ROOT_INSTRUCTIONS },
    rootInit: async (tx, conversationId) => {
      const d = await tx.doc(ConversationMeta, conversationId);
      if (!d.name) d.name = "root";
      d.createdAt = Date.now();
      // Register the coordinator as a board member (deterministic, at creation) and give
      // the root conversation its self-identity so routed messages are labeled "coordinator".
      await registerMemberInTx(tx, {
        id: "coordinator",
        name: "coordinator",
        kind: "coordinator",
        conversationId,
        trustLevel: "trusted",
        capabilities: ["coordinate"],
        allowedTargets: [],
        status: "active",
        description: "The standing coordinator brain.",
      });
      await setMemberIdentityInTx(tx, conversationId, "coordinator");
      return undefined;
    },
  });

  console.log(`[engram] ready — API on http://${config.host}:${instance.actualPort} (conversation ${instance.rootConversationId})`);

  // Telegram client (optional): long polling, outbound only.
  let telegram: TelegramClient | undefined;
  if (config.telegram) {
    telegram = new TelegramClient({
      botToken: config.telegram.botToken,
      apiBase: config.telegram.apiBase,
      allowedIds: config.telegram.allowedIds,
      stateFile: path.join(config.dataDir, "telegram-state.json"),
      apiBaseUrl: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${instance.actualPort}`,
      apiToken: config.token,
      rootConversationId: instance.rootConversationId,
    });
    await telegram.start();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[engram] ${signal} received — closing harness`);
    try {
      await telegram?.stop();
      await instance.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[engram] fatal:", err);
  process.exit(1);
});
