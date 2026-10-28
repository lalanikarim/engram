// Core instance bootstrap — the public composable seam (issue #42).
//
// createCoreInstance() assembles engram's core: config dirs → model catalog →
// registry (+ consumer extensions) → harness over SQLite → root conversation →
// HTTP server. The Collective app (src/main.ts) composes the board extension,
// coordinator registration, its own routes (e.g. GET /board), the Telegram client,
// and shutdown wiring on top of it. Everything else in src/ is internal to the core.
//
// Stability contract: this module is a public surface for consumers that pin
// engram as a component (e.g. drydock). The instance lifecycle (open/resume/close)
// and the extraExtensions/route injection points are stable; options and config fields are additive.
// Breaking changes require a major version bump with a deprecation window.
//
// Trust note: extraExtensions run with full core privilege — same trust tier as the
// core's own extensions (they can touch any doc in this instance's store).
// Consequential consumer actions should register their own approval-gated tools
// through the existing gates mechanism, not bypass it.
import http from "node:http";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  Harness,
  type AgentChange,
  type ConversationId,
  type EnvTarget,
  type Extension,
  type Tx,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppConfig } from "./config.ts";
import { defaultModelRef, loadModelsConfig, type ModelsConfig } from "./model.ts";
import { buildRegistry } from "./registry.ts";
import { createServer, type AppRoute } from "./server.ts";
import { SandboxManager } from "./sandbox.ts";
import { Scheduler, type FailedScheduleSettle, type ScheduleEntry } from "./extensions/scheduler.ts";

export interface CoreInstanceOptions {
  config: AppConfig;
  /** Model catalog. Omit to load internally (local discovery + PI_AGENT_DIR). */
  modelsConfig?: ModelsConfig;
  /** Consumer extensions, installed into the registry after the core set, before Harness.open. */
  extraExtensions?: readonly Extension[];
  /** Bind host. Defaults to config.host. */
  host?: string;
  /** Bind port. Defaults to config.port. 0 = ephemeral (see actualPort). */
  port?: number;
  /** Root conversation agent. Defaults: catalog default model, thinking "medium". */
  rootAgent?: AgentChange;
  /** Runs inside the root-creation commit (e.g. product board registration). */
  rootInit?: (tx: Tx, conversationId: ConversationId) => Promise<void>;
  /** App-registered HTTP routes (product/consumer endpoints), tried after core routes. */
  routes?: readonly AppRoute[];
  /** Additional bearer tokens accepted by the server's auth gate (M2.2: peer tokens for board RPC). */
  extraTokens?: () => readonly string[];
  /** Failure delivery hook for scheduled runs that settle `unanswered` (issue #58). */
  onScheduledFailure?: (entry: ScheduleEntry, settled: FailedScheduleSettle) => Promise<void> | void;
}

/** Minimal stable sandbox surface exposed on CoreInstance (issue #44). */
export interface SandboxSupervision {
  /** Per-conversation container info; null when the conversation has no live sandbox. */
  lookup(conversationId: ConversationId): { containerId: string; workspace: string; image: string } | null;
  /** Tear down every live sandbox (idempotent). */
  disposeAll(context: Context): Promise<void>;
  /** Remove orphaned containers left by a crashed previous run. */
  sweepOrphans(context: Context): Promise<string[]>;
}

export interface CoreInstance {
  harness: Harness;
  server: http.Server;
  /** The port actually bound (differs from the requested one when port is 0). */
  actualPort: number;
  rootConversationId: number;
  /** Sandbox supervision surface for consumers (issue #44): lookup + teardown only. */
  sandbox: SandboxSupervision;
  /** Deterministic, idempotent teardown: server, sandbox containers, harness. */
  close: () => Promise<void>;
}

const ctx = BACKGROUND_CONTEXT;

export async function createCoreInstance(opts: CoreInstanceOptions): Promise<CoreInstance> {
  const config = opts.config;
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.workRoot, { recursive: true });
  mkdirSync(config.kbDir, { recursive: true });

  const modelsConfig = opts.modelsConfig ?? (await loadModelsConfig());
  const registry = await buildRegistry(config, modelsConfig, opts.extraExtensions);
  const dbPath = path.join(config.dataDir, "agent.sqlite");

  // Per-conversation execution environment: the conversation's agent cwd maps into the work root.
  // The root conversation (no cwd) gets the work root itself; project conversations get subdirs.
  // Conversations flagged sandbox=true route code execution into a disposable Podman sidecar
  // (D12–13): no host env vars, egress-limited, files land in the same workspace dir.
  const sandbox = new SandboxManager({
    workRoot: config.workRoot,
    image: config.sandbox.image,
    network: config.sandbox.network,
    allowImages: config.sandbox.allowImages,
    allowMountRoot: config.sandbox.allowMountRoot,
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
    agent: { model: await defaultModelRef(modelsConfig), thinkingLevel: "medium", ...(opts.rootAgent ?? {}) },
    init: opts.rootInit,
  });

  const host = opts.host ?? config.host;
  const port = opts.port ?? config.port;
  const server = createServer({ harness, root, config, modelsConfig, routes: opts.routes, extraTokens: opts.extraTokens });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const bound = server.address();
  const actualPort = typeof bound === "object" && bound !== null ? bound.port : port;

  // Scheduled checks (issue #58): durable cron-driven runs. Inert when no schedules exist.
  const scheduler = new Scheduler({
    harness,
    rootConversationId: root.id,
    declarative: config.schedules,
    tickMs: config.schedulerTickMs,
    missedFiringPolicy: config.missedFiringPolicy,
    onFailure: opts.onScheduledFailure,
  });
  await scheduler.start();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await scheduler.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await sandbox.disposeAll(ctx);
      await harness.close(ctx);
    } catch (e) {
      console.error("[engram] teardown error:", (e as Error).message);
      throw e;
    }
  };

  return {
    harness,
    server,
    actualPort,
    rootConversationId: root.id,
    sandbox: {
      lookup: (id) => sandbox.lookup(id),
      disposeAll: (c) => sandbox.disposeAll(c),
      sweepOrphans: (c) => sandbox.sweepOrphans(c),
    },
    close,
  };
}

// ---- Public surface for apps that compose the kernel (issue #42) -----------------
// Apps import from "engram" (this module) and "engram/telegram". Keep this list small:
// only what an app needs to build its own executable on top of createCoreInstance().
export { loadConfig } from "./config.ts";
export { loadDotEnv } from "./dotenv.ts";
export { ConversationMeta } from "./meta.ts";
export {
  buildCatalog,
  defaultModelRef,
  formatModelRef,
  loadModelsConfig,
  parseModelRef,
  type ModelsConfig,
} from "./model.ts";
export { ROOT_INSTRUCTIONS } from "./registry.ts";
export {
  readJsonBody,
  type AppRoute,
  type RouteContext,
} from "./server.ts";
// Approval machinery — exported for apps that compose custom gate setups or run
// white-box tests against the kernel's approval docs (e.g. the Collective's suites).
export {
  approvalHook,
  ApprovalDoc,
  parseApprovalMarker,
  sendMessageTool,
} from "./extensions/approvals.ts";
export { compileGates, type GatesConfig } from "./extensions/gates.ts";
