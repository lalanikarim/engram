// Entry point: load config → discover local model → open harness over SQLite → resume → serve.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type EnvTarget } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadDotEnv } from "./dotenv.ts";
import { loadConfig } from "./config.ts";
import { ConversationMeta } from "./meta.ts";
import { defaultModelRef, formatModelRef, loadModelsConfig } from "./model.ts";
import { buildRegistry, ROOT_INSTRUCTIONS } from "./registry.ts";
import { createServer } from "./server.ts";
import { SandboxManager } from "./sandbox.ts";
import { TelegramClient } from "./telegram.ts";

const ctx = BACKGROUND_CONTEXT;

async function main() {
  loadDotEnv();
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.workRoot, { recursive: true });
  mkdirSync(config.kbDir, { recursive: true });

  console.log(`[engram] building model catalog (agent dir ${process.env.PI_AGENT_DIR ?? "~/.pi/agent"}) …`);
  const modelsConfig = await loadModelsConfig();
  const defaultRef = await defaultModelRef(modelsConfig);
  console.log(`[engram] default model: ${formatModelRef(defaultRef)}`);

  const registry = buildRegistry(config, modelsConfig);
  const dbPath = path.join(config.dataDir, "agent.sqlite");

  // Per-conversation execution environment: the conversation's agent cwd maps into the work root.
  // The root conversation (no cwd) gets the work root itself; project conversations get subdirs.
  // Conversations flagged sandbox=true route code execution into a disposable Podman sidecar
  // (D12–13): no host env vars, egress-limited, files land in the same workspace dir.
  const sandbox = new SandboxManager({
    workRoot: config.workRoot,
    image: config.sandbox.image,
    network: config.sandbox.network,
  });
  const envFor = async (target: EnvTarget, context: Context) => {
    const dir = target.cwd ? path.join(config.workRoot, target.cwd) : config.workRoot;
    mkdirSync(dir, { recursive: true });
    return (await sandbox.envFor(target, context)) ?? new NodeExecutionEnv({ cwd: dir });
  };

  console.log(`[engram] opening harness at ${dbPath}`);
  const harness = await Harness.open(
    await openNodeSqliteStorage(dbPath),
    {
      models: modelsConfig.models,
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
  sandbox.attach(harness);

  // Remove sandbox containers orphaned by a previous crashed run (name-prefix sweep).
  try {
    const orphans = await sandbox.sweepOrphans(ctx);
    if (orphans.length > 0) {
      console.log(`[engram] removed ${orphans.length} orphaned sandbox container(s): ${orphans.join(", ")}`);
    }
  } catch (e) {
    console.error("[engram] sandbox orphan sweep failed:", (e as Error).message);
  }

  const root = await harness.root(ctx, {
    agent: {
      model: defaultRef,
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

  const server = createServer({ harness, root, config, modelsConfig });
  server.listen(config.port, config.host, () => {
    console.log(`[engram] ready — API on http://${config.host}:${config.port} (conversation ${root.id})`);
  });

  // Telegram client (optional): long polling, outbound only.
  let telegram: TelegramClient | undefined;
  if (config.telegram) {
    telegram = new TelegramClient({
      botToken: config.telegram.botToken,
      apiBase: config.telegram.apiBase,
      allowedIds: config.telegram.allowedIds,
      stateFile: path.join(config.dataDir, "telegram-state.json"),
      apiBaseUrl: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`,
      apiToken: config.token,
      rootConversationId: root.id,
    });
    await telegram.start();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[engram] ${signal} received — closing harness`);
    server.close();
    try {
      await telegram?.stop();
      await sandbox.disposeAll(ctx);
      await harness.close(ctx);
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
