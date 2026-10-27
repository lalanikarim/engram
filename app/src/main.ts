// The Collective app: the flagship composition of the engram core — board extension +
// coordinator registration, the GET /board route, Telegram client, and shutdown wiring.
// The composable core lives in src/core.ts (issue #42); ecosystem framing (kernel vs. apps,
// solo/collective/society flows) is in docs/ecosystem-flows.md.
import path from "node:path";
import { loadDotEnv } from "./dotenv.ts";
import { loadConfig } from "./config.ts";
import { boardExtension, readBoardDashboard, registerMemberInTx, setMemberIdentityInTx, validateEndpoint } from "./extensions/board.ts";
import { ConversationMeta } from "./meta.ts";
import { readJsonBody } from "./server.ts";
import { defaultModelRef, formatModelRef, loadModelsConfig } from "./model.ts";
import { ROOT_INSTRUCTIONS } from "./registry.ts";
import { createCoreInstance } from "./core.ts";
import { TelegramClient } from "./telegram.ts";

async function main() {
  loadDotEnv();
  const config = loadConfig();

  console.log(`[engram] building model catalog (agent dir ${process.env.PI_AGENT_DIR ?? "~/.pi/agent"}) …`);
  const modelsConfig = await loadModelsConfig();
  const defaultRef = await defaultModelRef(modelsConfig);
  console.log(`[engram] default model: ${formatModelRef(defaultRef)}`);

  const instance = await createCoreInstance({
    config,
    modelsConfig,
    // Product surface: the shared board (Project 0). Consumers of the core don't get it.
    extraExtensions: [boardExtension()],
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
    ],
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
