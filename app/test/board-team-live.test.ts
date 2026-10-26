// Live end-to-end team test (Collective A4): a small standing team with a coordinator that TRIAGES
// inbound work and routes it to the right specialist, who does the work in its own workspace using
// its domain memory and reports back — status lands on the board + dashboard. Heterogeneous models
// are proven deterministically by board.test.ts (the store is model-agnostic); here every member uses
// the single model loaded on the local endpoint. Requires OPENAI_BASE_URL; skips cleanly without it.
// Run with: node test/board-team-live.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildCatalog } from "../src/model.ts";
import {
  boardExtension,
  createMemberInTx,
  postJobInTx,
  readBoardStatusInTx,
  readJobInTx,
  registerMemberInTx,
} from "../src/extensions/board.ts";

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

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");

function readPocEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, "poc", ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // rely on ambient env
  }
  return out;
}

const pocEnv = readPocEnv();
const baseUrl = process.env.OPENAI_BASE_URL ?? pocEnv.OPENAI_BASE_URL;
const apiKey = process.env.OPENAI_API_KEY ?? pocEnv.OPENAI_API_KEY;

// Generation resolves the env provider's key from process.env (pi-ai envApiKeyAuth),
// so the vars must be ambient even when sourced from poc/.env — keeps the suite hermetic.
process.env.OPENAI_BASE_URL ??= baseUrl;
process.env.OPENAI_API_KEY ??= apiKey;
if (!baseUrl || !apiKey) {
  console.log("board-team-live: no OPENAI_BASE_URL/OPENAI_API_KEY — skipping live team test");
  process.exit(0);
}

const ctx = BACKGROUND_CONTEXT;
const base = mkdtempSync(path.join(tmpdir(), "engram-board-team-"));
const dataDir = path.join(base, "data");
const workDir = path.join(base, "work");
const agentDir = path.join(base, "agent");
for (const d of [dataDir, workDir, agentDir]) mkdirSync(d, { recursive: true });

async function main() {
  const { models, envModel } = await buildCatalog({ agentDir, env: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: apiKey } });
  if (!envModel) throw new Error("no loaded model discovered on the endpoint");
  const modelRef = envModel;

  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(boardExtension());
  const allTools = registry.snapshot().installed().flatMap((e) => e.tools ?? []);
  // The coordinator only triages/routes (no file/shell tools, so it can't do specialist work itself).
  const coordTools = allTools.filter((t) => ["board_status", "route_message", "post_job", "create_member"].includes(t.name));
  const coderTools = allTools.filter((t) => ["claim_job", "report_status", "board_status", "recall", "remember", "read", "write", "edit", "bash"].includes(t.name));
  const researcherTools = allTools.filter((t) => ["claim_job", "report_status", "board_status", "recall", "remember", "read"].includes(t.name));

  const h = await Harness.open(
    await openNodeSqliteStorage(path.join(dataDir, "board-team.sqlite")),
    { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ? path.join(workDir, target.cwd) : workDir }) },
    ctx,
  );
  h.resume();

  // Two specialist members. Same model here — only one is loaded on the endpoint; heterogeneous models
  // are proven deterministically in board.test.ts (the store is model-agnostic).
  const coderConv = await h.commit(
    (tx) =>
      createMemberInTx(tx, {
        name: "coder",
        model: modelRef,
        tools: coderTools,
        capabilities: ["code"],
        instructions: `You are "coder", the software engineering specialist on this team. You write and edit code. When routed a job, claim it with claim_job, do the work in your own workspace using your file/shell tools, then report_status done with a short result. Call recall() at task start.`,
      }),
    ctx,
  );
  await h.commit(
    (tx) =>
      createMemberInTx(tx, {
        name: "researcher",
        model: modelRef,
        tools: researcherTools,
        capabilities: ["research"],
        instructions: `You are "researcher", the research specialist on this team. You gather and summarize information; you do not write code.`,
      }),
    ctx,
  );

  // The coordinator (the root conversation) triages inbound work and routes it to the right member.
  const coordinator = await h.root(ctx, {
    agent: {
      model: modelRef,
      thinkingLevel: "medium",
      tools: coordTools,
      instructions: `You are "coordinator", the standing coordinator for a small team of specialist members on the shared board (members: coder [code], researcher [research]). Your job is to TRIAGE inbound work: call board_status to see open jobs, decide which member is best suited for each based on its domain, and route it to that member with route_message — instructing that member to claim the job and complete it in their own workspace. You do not do specialist work yourself.`,
    },
    init: async (tx, conversationId) => {
      await registerMemberInTx(tx, { id: "coordinator", name: "coordinator", kind: "coordinator", conversationId, trustLevel: "trusted", capabilities: ["coordinate"], allowedTargets: [], status: "active", description: "The standing coordinator." });
    },
  });

  // Post an open coding job (deterministically) for the coordinator to triage.
  await h.commit(
    (tx) => postJobInTx(tx, { id: "job-triage", title: "write add.py", requester: "coordinator", assignee: null, payload: { task: "Write a Python function add(a, b) that returns a + b, and save it to a file named add.py in your working directory." }, status: "open", claimedBy: null, result: null }),
    ctx,
  );

  // Drive the coordinator to triage + route.
  const t0 = Date.now();
  const subCoord = await coordinator.submit({ type: "input", content: `An open job "job-triage" is on the board. Call board_status to see it, then route it to the member best suited for that work using route_message — tell that member to claim job-triage and complete it in their own workspace.`, requestId: "team-coord-triage" }, ctx);
  const settledCoord = await subCoord.wait(ctx);

  // Drive the coder to settle (its routed message runs first, then this follow-up) for a clean signal.
  const t1 = Date.now();
  const coder = await h.conversation(coderConv, ctx);
  if (!coder) throw new Error("coder handle not found");
  const subCoder = await coder.submit({ type: "input", content: `If you have completed job-triage, reply DONE; otherwise claim it and complete it now (write add.py in your working directory), then report_status done.`, requestId: "team-coder-followup" }, ctx);
  const settledCoder = await subCoder.wait(ctx);
  console.log(`  coordinator run: ${settledCoord.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s; coder run: ${settledCoder.status} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // Verify: the coordinator routed to the right member, who did the work and reported.
  const job = await h.commit((tx) => readJobInTx(tx, "job-triage"), ctx);
  const status = await h.commit(async (tx) => readBoardStatusInTx(tx), ctx);
  const addPy = path.join(workDir, "coder", "add.py");

  console.log("standing team + coordinator triage (Collective A4)");
  check("coordinator run settled done", settledCoord.status === "done");
  check("coder run settled done", settledCoder.status === "done");
  check("job was claimed by the coder (the right member)", job?.claimedBy === "coder" && job?.assignee === "coder");
  check("job is reported done", job?.status === "done");
  check("coder wrote add.py in its own workspace", existsSync(addPy));
  check("board no longer lists the job as open", !status.openJobs.some((j) => j.id === "job-triage"));

  await h.close(ctx);
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("board-team-live test error:", err);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
