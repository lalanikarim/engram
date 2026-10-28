// The engram solo executable: a single project-brain agent on the composable core —
// chat + Web UI + optional Telegram client. No board, no fleet machinery; that lives in
// apps built on the kernel (the flagship is lalanikarim/collective). Ecosystem framing
// (kernel vs. apps, solo/collective/society flows) is in docs/ecosystem-flows.md.
import path from "node:path";
import { loadDotEnv } from "./dotenv.ts";
import { loadConfig } from "./config.ts";
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

  // Late-bound: the Telegram client is created after the instance (it needs actualPort),
  // so scheduled-failure pings route through this holder once it's set.
  let telegramRef: TelegramClient | undefined;

  const instance = await createCoreInstance({
    config,
    modelsConfig,
    rootAgent: { model: defaultRef, thinkingLevel: "medium", instructions: ROOT_INSTRUCTIONS },
    rootInit: async (tx, conversationId) => {
      const d = await tx.doc(ConversationMeta, conversationId);
      if (!d.name) d.name = "root";
      d.createdAt = Date.now();
      return undefined;
    },
    onScheduledFailure: async (entry, settled) => {
      if (!telegramRef) return; // no Telegram → nothing to deliver a failure ping to
      const text = `⚠️ Scheduled check "${entry.id}" failed (${settled.reason}). See the conversation for details.`;
      await telegramRef.notifyConversation(entry.conversationId, text).catch(() => {});
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
    telegramRef = telegram;
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
