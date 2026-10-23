// Entry point: load config → discover local model → open harness over SQLite → resume → serve.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type ModelRef } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadDotEnv } from "./dotenv.ts";
import { loadConfig } from "./config.ts";
import { ConversationMeta } from "./meta.ts";
import { loadModelConfig, localModels, modelId } from "./model.ts";
import { buildRegistry, ROOT_INSTRUCTIONS } from "./registry.ts";
import { createServer } from "./server.ts";

const ctx = BACKGROUND_CONTEXT;

async function main() {
  loadDotEnv();
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.workRoot, { recursive: true });
  mkdirSync(config.kbDir, { recursive: true });

  console.log(`[pidurable] discovering local model at ${process.env.OPENAI_BASE_URL} …`);
  const discovered = await loadModelConfig();
  const models = await localModels();
  const id = await modelId();
  console.log(`[pidurable] model: ${id} (window ${discovered.models[0].contextWindow})`);

  const registry = buildRegistry(config, id);
  const dbPath = path.join(config.dataDir, "agent.sqlite");

  // Per-conversation execution environment: the conversation's agent cwd maps into the work root.
  // The root conversation (no cwd) gets the work root itself; project conversations get subdirs.
  const envFor = (target: { conversationId: number; cwd?: string }) => {
    const dir = target.cwd ? path.join(config.workRoot, target.cwd) : config.workRoot;
    mkdirSync(dir, { recursive: true });
    return new NodeExecutionEnv({ cwd: dir });
  };

  console.log(`[pidurable] opening harness at ${dbPath}`);
  const harness = await Harness.open(
    await openNodeSqliteStorage(dbPath),
    {
      models,
      registry,
      env: envFor,
      settings: {
        compaction: {
          enabled: true,
          // reserveTokens must exceed pi-ai's 4096-token safety margin (POC-FINDINGS Phase 6).
          reserveTokens: config.reserveTokens,
          keepRecentTokens: config.keepRecentTokens,
          backgroundTokens: config.backgroundTokens,
        },
      },
    },
    ctx,
  );
  harness.resume();

  const modelRef: ModelRef = { provider: "aurora", modelId: id };
  const root = await harness.root(ctx, {
    agent: {
      model: modelRef,
      thinkingLevel: "medium",
      instructions: ROOT_INSTRUCTIONS,
    },
    init: async (tx, conversationId) => {
      const d = await tx.doc(ConversationMeta, conversationId);
      if (!d.name) d.name = "root";
      d.createdAt = Date.now();
      return undefined;
    },
  });

  const server = createServer({ harness, root, config, modelRef });
  server.listen(config.port, config.host, () => {
    console.log(`[pidurable] ready — API on http://${config.host}:${config.port} (conversation ${root.id})`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[pidurable] ${signal} received — closing harness`);
    server.close();
    try {
      await harness.close(ctx);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[pidurable] fatal:", err);
  process.exit(1);
});
