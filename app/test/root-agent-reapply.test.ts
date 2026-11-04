// Issue #65: options.agent handed to createCoreInstance() must be applied idempotently and
// unconditionally — on EVERY start, not only when the root conversation is created. pi-durable's
// Harness.root() returns early for an existing root and silently discards `agent`, so the core
// re-asserts it after root(). This suite boots the same data directory three times and reads back
// what the root agent actually offers: a new capability must become reachable, a revoked one must
// disappear, and a re-pinned model/instructions must hold. No live model needed — an offline
// catalog with two models on a fake provider.
// Run with: node test/root-agent-reapply.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";

const ctx: Context = BACKGROUND_CONTEXT;

process.env.API_TOKEN ??= "root-reapply-test-token";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

async function main() {
  const base = mkdtempSync(path.join(tmpdir(), "engram-root-reapply-"));
  try {
    // Offline model catalog: one fake provider with two models (no discovery, no env endpoint).
    const agentDir = path.join(base, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          testbox: {
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "k",
            models: [{ id: "model-a" }, { id: "model-b" }],
          },
        },
      }),
    );

    const dirs = {
      data: path.join(base, "data"),
      work: path.join(base, "work"),
      kb: path.join(base, "kb"),
      config: path.join(base, "config"),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

    const { buildCatalog } = await import("../src/model.ts");
    const { loadConfig } = await import("../src/config.ts");
    const { createCoreInstance } = await import("../src/core.ts");

    const { models } = await buildCatalog({ agentDir, env: {} });
    const modelsConfig = {
      models,
      agentDir,
      configuredDefault: { provider: "testbox", modelId: "model-a" },
      envModel: null,
    };
    const config = loadConfig({ dataDir: dirs.data, workRoot: dirs.work, kbDir: dirs.kb, configDir: dirs.config });

    // Two no-op probe tools standing in for capabilities policy can grant or revoke.
    const keepTool = defineTool({
      name: "probe_keep",
      description: "Test probe (no-op), stays offered.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => ({ output: [{ type: "text" as const, text: "keep" }] }),
    });
    const dropTool = defineTool({
      name: "probe_drop",
      description: "Test probe (no-op), revoked on the second boot.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => ({ output: [{ type: "text" as const, text: "drop" }] }),
    });

    // The probes live in a consumer extension so the registry knows them; the per-boot
    // `rootAgent.tools` filter selects which of them the root agent is offered.
    const probeExt = defineExtension({ name: "probe", tools: [keepTool, dropTool] });

    const rootAgentOf = async (inst: { harness: Awaited<ReturnType<typeof createCoreInstance>>["harness"]; rootConversationId: number }) => {
      const conv = await inst.harness.conversation(inst.rootConversationId as ConversationId, ctx);
      if (!conv) throw new Error("root conversation missing");
      return conv.agent(ctx);
    };

    // ---- 1. Fresh data directory: the agent options are applied at creation ----
    console.log("first boot (fresh data dir)");
    const inst1 = await createCoreInstance({
      config,
      modelsConfig,
      port: 0,
      extraExtensions: [probeExt],
      rootAgent: { tools: [keepTool, dropTool], instructions: "BOOT-ONE" },
    });
    const agent1 = await rootAgentOf(inst1);
    const names1 = agent1.tools.map((t) => t.name);
    check("fresh boot offers both probe tools", names1.includes("probe_keep") && names1.includes("probe_drop"));
    check("fresh boot applies instructions", agent1.instructions === "BOOT-ONE");
    check("fresh boot uses the configured default model", agent1.model?.modelId === "model-a");
    await inst1.close();

    // ---- 2. Second boot of the SAME directory: options must be re-applied, not discarded ----
    console.log("second boot (existing data dir) — issue #65");
    const inst2 = await createCoreInstance({
      config,
      modelsConfig,
      port: 0,
      extraExtensions: [probeExt],
      rootAgent: { tools: [keepTool], model: { provider: "testbox", modelId: "model-b" }, instructions: "BOOT-TWO" },
    });
    const agent2 = await rootAgentOf(inst2);
    const names2 = agent2.tools.map((t) => t.name);
    check("revoked tool is no longer offered (no silent stale capability)", !names2.includes("probe_drop"));
    check("kept tool remains offered", names2.includes("probe_keep"));
    check("re-pinned model reaches the existing root", agent2.model?.modelId === "model-b");
    check("changed instructions reach the existing root", agent2.instructions === "BOOT-TWO");
    await inst2.close();

    // ---- 3. Third boot without rootAgent: core defaults still asserted unconditionally ----
    console.log("third boot (existing data dir, no rootAgent)");
    const inst3 = await createCoreInstance({ config, modelsConfig, port: 0, extraExtensions: [probeExt] });
    const agent3 = await rootAgentOf(inst3);
    check("core default model re-asserted without rootAgent", agent3.model?.modelId === "model-a");
    check("core default thinking level re-asserted without rootAgent", agent3.thinkingLevel === "medium");
    await inst3.close();

    console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("test harness error:", err);
  process.exit(1);
});
