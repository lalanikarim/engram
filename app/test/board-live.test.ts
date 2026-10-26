// Live board test (Phase 0b): a standing member actually runs the work loop in its own
// workspace — claim_job (self-identity, no meId param) → write a file → report_status —
// and the job doc durably reflects done + result. Requires OPENAI_BASE_URL; skips cleanly
// when no local endpoint is available (so `npm test` stays green without a model).
// Run with: node test/board-live.test.ts
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
import { boardExtension, createMemberInTx, postJobInTx, readJobInTx, claimJobInTx } from "../src/extensions/board.ts";

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

// Endpoint from env or poc/.env (same source api.test.ts uses).
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
if (!baseUrl || !apiKey) {
  console.log("board-live: no OPENAI_BASE_URL/OPENAI_API_KEY — skipping live member work-loop test");
  process.exit(0);
}

const ctx = BACKGROUND_CONTEXT;
const base = mkdtempSync(path.join(tmpdir(), "engram-board-live-"));
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

  // Members get board member tools + file/shell (not coordinator-only register/post_job).
  const wanted = new Set(["claim_job", "report_status", "board_status", "read", "write", "bash"]);
  const memberTools = registry.snapshot().installed().flatMap((e) => e.tools ?? []).filter((t) => wanted.has(t.name));

  const h = await Harness.open(
    await openNodeSqliteStorage(path.join(dataDir, "board-live.sqlite")),
    { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ? path.join(workDir, target.cwd) : workDir }) },
    ctx,
  );
  h.resume();

  const alphaConv = await h.commit((tx) => createMemberInTx(tx, { name: "alpha", model: modelRef, tools: memberTools }), ctx);
  await h.commit((tx) => createMemberInTx(tx, { name: "beta", model: modelRef, tools: memberTools }), ctx);

  await h.commit(
    (tx) => postJobInTx(tx, { id: "job-2", title: "write a file", requester: "coordinator", assignee: null, payload: {}, status: "open", claimedBy: null, result: null }),
    ctx,
  );

  // Drive alpha. Note: the brief gives NO member id — claim_job resolves "alpha" from
  // alpha's own conversation identity doc (req 5).
  const alpha = await h.conversation(alphaConv, ctx);
  if (!alpha) throw new Error("alpha conversation handle not found");
  const brief =
    `Do EXACTLY these steps, in order:\n` +
    `1) call claim_job with jobId "job-2";\n` +
    `2) using the write tool, create a file named board-done.txt in your working directory containing exactly: from-alpha\n` +
    `3) call report_status with jobId "job-2", status "done", and result "created board-done.txt".\n` +
    `Then stop.`;
  const t0 = Date.now();
  const sub = await alpha.submit({ type: "input", content: brief, requestId: "board-alpha-job2" }, ctx);
  const settled = await sub.wait(ctx);
  console.log(`  alpha run: status=${settled.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const fileOk = existsSync(path.join(workDir, "alpha", "board-done.txt")) && readFileSync(path.join(workDir, "alpha", "board-done.txt"), "utf8").trim() === "from-alpha";
  const job = await h.commit(async (tx) => readJobInTx(tx, "job-2"), ctx);

  console.log("member work loop");
  check("alpha run settled done", settled.status === "done");
  check("file written in alpha's own workspace", fileOk);
  check("job doc status done", job?.status === "done");
  check("job assignee is alpha (self-identity)", job?.assignee === "alpha");
  check("job result recorded", job?.result != null);

  // beta cannot claim a job that's no longer open.
  const betaTry = await h.commit((tx) => claimJobInTx(tx, "job-2", "beta"), ctx);
  check("beta re-claim blocked (single-winner)", betaTry === null);

  await h.close(ctx);
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("board-live test error:", err);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
