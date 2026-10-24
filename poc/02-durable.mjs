// Phase 2 — durability (A3): crash recovery + exactly-once submissions.
// Modes:
//   kill   — start a slow task, print SUBMITTED id, wait (parent kills -9 mid-run)
//   resume — reopen same SQLite, re-acquire the unsettled submission, wait, verify transcript
//   dup    — submit the same requestId twice; expect one user entry / one execution
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { localModels, providerId, modelId } from "./lib/model.mjs";
import { loadDotEnv } from "./lib/env.mjs";
loadDotEnv();

const mode = process.argv[2];
if (!["kill", "resume", "dup"].includes(mode)) {
  console.error("usage: node 02-durable.mjs <kill|resume|dup>");
  process.exit(2);
}

const DB = mode === "dup" ? "./data/dup.sqlite" : "./data/durable.sqlite";
const WORK = fileURLToPath(new URL("./work", import.meta.url));
const ctx = BACKGROUND_CONTEXT;

const registry = createRegistry();
registry.install(CodingTools);

const h = await Harness.open(
  await openNodeSqliteStorage(DB),
  {
    models: await localModels(),
    registry,
    env: () => new NodeExecutionEnv({ cwd: WORK }),
  },
  ctx,
);
h.resume();

const KILL_TASK =
  "Do exactly this, in order: (1) run the bash command `sleep 15 && echo SLEPT` and wait for it to finish; " +
  "(2) then create a file done.txt containing the single word finished. Do not do anything else.";

if (mode === "kill") {
  const root = await h.root(ctx, {
    agent: { model: { provider: await providerId(), modelId: await modelId() } },
  });
  const sub = await root.submit({ type: "input", content: KILL_TASK, requestId: "ph2-kill" }, ctx);
  console.log(`SUBMITTED id=${sub.id}`);
  const settled = await sub.wait(ctx);
  console.log("SETTLED", settled.status);
  await h.close(ctx);
}

if (mode === "resume") {
  const subId = Number(process.env.SUB_ID);
  if (!Number.isInteger(subId)) {
    console.error("SUB_ID env var required");
    process.exit(2);
  }
  const sub = await h.submission(subId, ctx);
  if (sub === undefined) {
    console.log("submission not found — inspecting state");
    console.log(JSON.stringify(await h.inspect(ctx)).slice(0, 1000));
    process.exit(1);
  }
  const t0 = Date.now();
  const settled = await sub.wait(ctx);
  console.log(`resumed wait: status=${settled.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const root = await h.root(ctx);
  const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 200), ctx);
  const kinds = {};
  let bashResults = 0;
  for (const item of page.items) {
    const k = item.kind ?? "unknown";
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (k === "pi.tool-result") {
      const s = JSON.stringify(item);
      if (s.includes('"bash"')) bashResults++;
    }
  }
  console.log("entries:", page.items.length, "kinds:", JSON.stringify(kinds), "bash tool-results:", bashResults);
  const donePath = WORK + "/done.txt";
  console.log("done.txt exists:", existsSync(donePath), existsSync(donePath) ? `content="${readFileSync(donePath, "utf8").trim()}"` : "");

  if (settled.status === "done" && bashResults === 1 && existsSync(donePath)) {
    console.log("PHASE2-KILL: PASS — recovered after SIGKILL; bash ran exactly once; work completed");
  } else {
    console.log("PHASE2-KILL: FAIL — see details above");
    process.exitCode = 1;
  }
  await h.close(ctx);
}

if (mode === "dup") {
  const root = await h.root(ctx, {
    agent: { model: { provider: await providerId(), modelId: await modelId() } },
  });
  const content = "Say exactly: DUP-OK.";
  const s1 = await root.submit({ type: "input", content, requestId: "dup-1" }, ctx);
  await s1.wait(ctx);
  const s2 = await root.submit({ type: "input", content, requestId: "dup-1" }, ctx);
  const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 50), ctx);
  const users = page.items.filter((i) => (i.kind ?? "") === "pi.user");
  console.log(`s1.id=${s1.id} s2.id=${s2.id} user entries=${users.length}`);
  if (s1.id === s2.id && users.length === 1) {
    console.log("PHASE2-DUP: PASS — same requestId re-submitted returned the same submission; one execution");
  } else {
    console.log("PHASE2-DUP: FAIL — expected identical submission id and exactly one user entry");
    process.exitCode = 1;
  }
  await h.close(ctx);
}
