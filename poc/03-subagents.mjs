// Phase 3a — subagents (A5): orchestrator delegates two parallel jobs to worker
// subagents with per-role tool restrictions; verifies results + side effects.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { localModels, providerId, modelId } from "./lib/model.mjs";
import { webFetchTool } from "./lib/web-fetch.mjs";
import { delegateTool, workerTask } from "./lib/worker.mjs";
import { loadDotEnv } from "./lib/env.mjs";
loadDotEnv();

const ctx = BACKGROUND_CONTEXT;
const WORK = fileURLToPath(new URL("./work", import.meta.url));

const registry = createRegistry();
registry.install(CodingTools);
registry.install(defineExtension({ name: "web", tools: [webFetchTool()] }));
const dTool = delegateTool();
// tasks: registers the worker task definition so the scheduler can run poc.worker
registry.install(defineExtension({ name: "delegate", tools: [dTool], tasks: [workerTask] }));

const h = await Harness.open(
  await openNodeSqliteStorage("./data/subagents.sqlite"),
  {
    models: await localModels(),
    registry,
    env: () => new NodeExecutionEnv({ cwd: WORK }),
  },
  ctx,
);
h.resume();

const root = await h.root(ctx, {
  agent: {
    model: { provider: await providerId(), modelId: await modelId() },
    thinkingLevel: "medium",
    tools: [dTool], // orchestrator gets ONLY delegate — workers get their role tools
  },
});

const TASK =
  "Use the delegate tool to run these two jobs IN PARALLEL in a single delegate call: " +
  "(1) role researcher — fetch https://example.com and describe in one sentence what the page is about; " +
  "(2) role worker — create a file subagent.txt containing exactly the word from-worker. " +
  "When both jobs finish, report each job's result in one line.";

const t0 = Date.now();
const sub = await root.submit({ type: "input", content: TASK, requestId: "ph3-sub" }, ctx);
const settled = await sub.wait(ctx);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`status=${settled.status} in ${secs}s`);

let pass = settled.status === "done";
if (pass) {
  const a = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
  const text = (a?.model ?? []).flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text)).join("\n");
  console.log(`final answer:\n${"  " + text.slice(0, 800).split("\n").join("\n  ")}`);

  // verify worker side effect
  const f = WORK + "/subagent.txt";
  const fileOk = existsSync(f) && readFileSync(f, "utf8").trim() === "from-worker";
  console.log(`subagent.txt: ${fileOk ? `OK ("${readFileSync(f, "utf8").trim()}")` : "MISSING/WRONG"}`);

  // count worker conversations created (owned by tasks)
  const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 200), ctx);
  const kinds = {};
  for (const item of page.items) kinds[item.kind ?? "?"] = (kinds[item.kind ?? "?"] ?? 0) + 1;
  console.log("root transcript kinds:", JSON.stringify(kinds));

  pass = fileOk && /example/i.test(text);
}
console.log(pass ? "PHASE3-SUBAGENTS: PASS" : "PHASE3-SUBAGENTS: FAIL");
process.exitCode = pass ? 0 : 1;
await h.close(ctx);
