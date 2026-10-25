// Board spike (P0): standing members + atomic job claim + member work loop on a live model.
//
// Validates two assumptions from docs/research/board.md:
//   1) an atomic single-winner job claim via commit + tx.doc (deterministic, no model), and
//   2) a standing named member can pick up a job and complete it in its own workspace,
//      reporting status durably (live model).
//
// Run: cd poc && npm install && node 11-board.mjs   (auto-loads poc/.env)
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  defineDocFamily,
  defineDoc,
  configure,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { localModels, providerId, modelId } from "./lib/model.mjs";
import { loadDotEnv } from "./lib/env.mjs";
loadDotEnv();

const ctx = BACKGROUND_CONTEXT;
const WORK = fileURLToPath(new URL("./work", import.meta.url));
mkdirSync(WORK, { recursive: true });

// ---- Board doc families (session-scoped → shared by all members + coordinator) ----
const JobDoc = defineDocFamily({
  family: true,
  scope: "session",
  kind: "poc.board.job",
  version: 1,
  initial: () => ({ id: "", title: "", body: "", requester: null, assignee: null, status: "open", result: null, updatedAt: 0 }),
});
const JobIndex = defineDoc({ scope: "session", kind: "poc.board.jobIndex", version: 1, initial: () => ({ open: [] }) });

// Atomic single-winner claim of a SPECIFIC job: verify it's still open, credit meId, remove from index.
async function claimJobInTx(tx, jobId, meId) {
  const d = await tx.doc(JobDoc, jobId, {});
  if (d.status !== "open") return null; // already claimed / not open → single-winner guard
  const idx = await tx.doc(JobIndex);
  d.assignee = meId;
  d.status = "claimed";
  d.updatedAt = Date.now();
  idx.open = idx.open.filter((x) => x !== jobId);
  return { id: d.id, title: d.title, body: d.body };
}

// ---- Board tools (shared; caller supplies identity explicitly — self-identity is a build-phase detail) ----
const claimJobTool = defineTool({
  name: "claim_job",
  description: "Claim a specific open job on the board. Pass the job id and your member id. Returns the job, or 'not open' if already claimed.",
  parameters: Type.Object({ jobId: Type.String(), meId: Type.String() }),
  replay: "unsafe",
  execute: async (args, api) => {
    const res = await api.commit((tx) => claimJobInTx(tx, args.jobId, args.meId), ctx);
    return { output: [{ type: "text", text: res ? JSON.stringify(res) : "not open" }] };
  },
});

const reportStatusTool = defineTool({
  name: "report_status",
  description: "Report the status and result of a job you are working on.",
  parameters: Type.Object({
    jobId: Type.String(),
    status: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
    result: Type.Optional(Type.String()),
  }),
  replay: "unsafe",
  execute: async (args, api) => {
    await api.commit(async (tx) => {
      const d = await tx.doc(JobDoc, args.jobId, {});
      d.status = args.status;
      d.result = args.result ?? null;
      d.updatedAt = Date.now();
    }, ctx);
    return { output: [{ type: "text", text: `job ${args.jobId} -> ${args.status}` }] };
  },
});

// ---- Registry ----
const registry = createRegistry();
registry.install(CodingTools);
registry.install(defineExtension({ name: "board", tools: [claimJobTool, reportStatusTool] }));

const allTools = registry.snapshot().installed().flatMap((e) => e.tools ?? []);
const byName = (names) => allTools.filter((t) => names.includes(t.name));
const memberTools = [claimJobTool, reportStatusTool, ...byName(["read", "write", "bash"])];

// ---- Harness ----
const h = await Harness.open(
  await openNodeSqliteStorage("./data/board-spike.sqlite"),
  {
    models: await localModels(),
    registry,
    env: (target) => new NodeExecutionEnv({ cwd: target.cwd ? `${WORK}/${target.cwd}` : WORK }),
  },
  ctx,
);
h.resume();

const modelRef = { provider: await providerId(), modelId: await modelId() };

// Create two STANDING named member conversations (persistent, own workspace + tools), unlike ephemeral subagents.
async function makeMember(name) {
  const id = await h.commit(async (tx) => {
    const rec = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, rec.id, {
      model: modelRef,
      thinkingLevel: "medium",
      tools: memberTools,
      cwd: name, // per-member workspace under WORK/<name>
      instructions: `You are "${name}", a standing worker on a shared job board. Do exactly what the task says using only your tools.`,
    });
    return rec.id;
  }, ctx);
  return h.conversation(id, ctx);
}

const alpha = await makeMember("alpha");
const beta = await makeMember("beta"); // created to demonstrate the claim guard + as a second standing member

// Post a job directly at the commit level (same tx.doc path post_job uses).
async function postJob(id, title, body) {
  await h.commit(async (tx) => {
    const d = await tx.doc(JobDoc, id, {});
    d.id = id;
    d.title = title;
    d.body = body;
    d.status = "open";
    d.updatedAt = Date.now();
    const idx = await tx.doc(JobIndex);
    idx.open.push(id);
  }, ctx);
}

let pass = true;

// ---- Part 1: atomic single-winner claim (deterministic, no model) ----
console.log("== Part 1: atomic single-winner claim ==");
await postJob("job-1", "first job", "placeholder");
const c1 = await h.commit((tx) => claimJobInTx(tx, "job-1", "alpha"), ctx);
const c2 = await h.commit((tx) => claimJobInTx(tx, "job-1", "beta"), ctx); // must fail: already claimed
const j1 = await h.snapshot(JobDoc, "job-1", ctx);
console.log(`alpha claim: ${c1 ? `OK (${c1.id}, assignee=${j1.assignee})` : "FAIL"}`);
console.log(`beta  re-claim: ${c2 === null ? "blocked (correct)" : `WRONG — got ${JSON.stringify(c2)}`}`);
const p1 = Boolean(c1) && c1.id === "job-1" && c2 === null && j1.assignee === "alpha" && j1.status === "claimed";
console.log(`PART1: ${p1 ? "PASS" : "FAIL"}`);
pass = pass && p1;

// ---- Part 2: standing member picks up + completes work in its own workspace (live model) ----
console.log("\n== Part 2: member work loop (live model) ==");
await postJob("job-2", "write a file", "Create board-done.txt containing exactly: from-alpha");
const brief =
  `Your job id is "job-2" and your member id is "alpha". Do EXACTLY these steps, in order:\n` +
  `1) call claim_job with jobId "job-2" and meId "alpha";\n` +
  `2) using the write tool, create a file named board-done.txt in your working directory containing exactly: from-alpha\n` +
  `3) call report_status with jobId "job-2", status "done", and result "created board-done.txt".\n` +
  `Then stop.`;
const t0 = Date.now();
const sub = await alpha.submit({ type: "input", content: brief, requestId: "board-alpha-job2" }, ctx);
const settled = await sub.wait(ctx);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`alpha run: status=${settled.status} in ${secs}s`);

const f = `${WORK}/alpha/board-done.txt`;
const fileOk = existsSync(f) && readFileSync(f, "utf8").trim() === "from-alpha";
const j2 = await h.snapshot(JobDoc, "job-2", ctx);
console.log(`board-done.txt: ${fileOk ? `OK ("${readFileSync(f, "utf8").trim()}")` : "MISSING/WRONG"}`);
console.log(`job-2 doc: status=${j2.status} assignee=${j2.assignee} result=${JSON.stringify(j2.result)}`);
const p2 = settled.status === "done" && fileOk && j2.status === "done" && j2.assignee === "alpha" && j2.result != null;
console.log(`PART2: ${p2 ? "PASS" : "FAIL"}`);
pass = pass && p2;

// ---- Summary ----
console.log("\n== Board job summary ==");
for (const id of ["job-1", "job-2"]) {
  const j = await h.snapshot(JobDoc, id, ctx);
  console.log(`  ${id}: status=${j.status} assignee=${j.assignee} result=${JSON.stringify(j.result)}`);
}

console.log(pass ? "\nBOARD-SPIKE: PASS" : "\nBOARD-SPIKE: FAIL");
process.exitCode = pass ? 0 : 1;
await h.close(ctx);
