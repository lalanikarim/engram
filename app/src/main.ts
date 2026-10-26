// Product composition (engram the app): core instance + board + Telegram + shutdown wiring.
// The composable core lives in src/core.ts (issue #42); this file is what makes the
// standalone engram product — its CLI/env behavior is unchanged by that split.
import path from "node:path";
import { loadDotEnv } from "./dotenv.ts";
import { loadConfig } from "./config.ts";
import { boardExtension, registerMemberInTx } from "./extensions/board.ts";
import { ConversationMeta } from "./meta.ts";
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
    rootAgent: { model: defaultRef, thinkingLevel: "medium", instructions: ROOT_INSTRUCTIONS },
    rootInit: async (tx, conversationId) => {
      const d = await tx.doc(ConversationMeta, conversationId);
      if (!d.name) d.name = "root";
      d.createdAt = Date.now();
      // Register the coordinator as a board member (deterministic, at creation).
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
