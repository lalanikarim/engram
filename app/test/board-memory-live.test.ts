// Live domain-memory test (Collective A1): a standing member records durable domain facts with
// remember() in one session, then in a later session consults its memory (recall) and answers
// from it without being re-told. The memory doc's durability + restart-safety is proven by the
// deterministic board.test.ts; this proves the end-to-end remember/recall tool flow on a live model.
// Requires OPENAI_BASE_URL; skips cleanly when no local endpoint is available (so `npm test`
// stays green without a model). Run with: node test/board-memory-live.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildCatalog } from "../src/model.ts";
import { boardExtension, createMemberInTx, recallInTx } from "../src/extensions/board.ts";

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
if (!baseUrl || !apiKey) {
  console.log("board-memory-live: no OPENAI_BASE_URL/OPENAI_API_KEY — skipping live domain-memory test");
  process.exit(0);
}

const ctx = BACKGROUND_CONTEXT;
const base = mkdtempSync(path.join(tmpdir(), "engram-board-mem-"));
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

  // arch only needs recall/remember (+ board_status to see the directory).
  const wanted = new Set(["recall", "remember", "board_status"]);
  const memberTools = registry.snapshot().installed().flatMap((e) => e.tools ?? []).filter((t) => wanted.has(t.name));

  const h = await Harness.open(
    await openNodeSqliteStorage(path.join(dataDir, "board-memory.sqlite")),
    { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ? path.join(workDir, target.cwd) : workDir }) },
    ctx,
  );
  h.resume();

  const archConv = await h.commit((tx) => createMemberInTx(tx, { name: "arch", model: modelRef, tools: memberTools }), ctx);
  const arch = await h.conversation(archConv, ctx);
  if (!arch) throw new Error("arch conversation handle not found");

  // Session 1: teach durable domain facts; the member records each with remember().
  const brief1 =
    `You are "arch", our deployment specialist. These are durable conventions for your domain:\n` +
    `- Deploy strategy: blue-green.\n` +
    `- Staging host: staging.internal\n` +
    `Record EACH one durably by calling remember(<note>) — two separate calls, one per fact, including the exact value. Then stop.`;
  const t0 = Date.now();
  const sub1 = await arch.submit({ type: "input", content: brief1, requestId: "mem-arch-s1" }, ctx);
  const settled1 = await sub1.wait(ctx);
  console.log(`  session 1 (record): status=${settled1.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Deterministic read: the memory doc durably holds both facts, independent of the transcript.
  const mem1 = await h.commit((tx) => recallInTx(tx, "arch"), ctx);
  const hasStrategy = mem1.entries.some((e) => e.note.toLowerCase().includes("blue-green"));
  const hasHost = mem1.entries.some((e) => e.note.includes("staging.internal"));

  // Session 2 (a later invocation): ask for the facts WITHOUT restating them, and require the member
  // to consult its memory first. brief2 contains neither fact, so a correct answer must come from recall().
  const q2 = `Q2MARKER-${Date.now()}`;
  const brief2 =
    `${q2}\nUsing your domain memory, state our deploy strategy and staging host on one line. First call recall(), then answer only from what it returns.`;
  const t1 = Date.now();
  const sub2 = await arch.submit({ type: "input", content: brief2, requestId: "mem-arch-s2" }, ctx);
  const settled2 = await sub2.wait(ctx);
  console.log(`  session 2 (recall): status=${settled2.status} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // The transcript portion after the session-2 marker is that run's output. If it surfaces both
  // facts (absent from brief2), the member consulted its memory and used it without being re-told.
  const page = await arch.entries({ order: "ascending" }, 500, undefined, ctx);
  const blob = JSON.stringify(page);
  const idx = blob.indexOf(q2);
  const s2 = idx >= 0 ? blob.slice(idx) : "";

  console.log("member domain memory across sessions (Collective A1)");
  check("session 1 settled done", settled1.status === "done");
  check("memory doc durably holds the deploy strategy (remember tool)", hasStrategy);
  check("memory doc durably holds the staging host (remember tool)", hasHost);
  check("session 2 settled done", settled2.status === "done");
  check("session 2 surfaced the remembered deploy strategy (not restated in brief)", idx >= 0 && s2.includes("blue-green"));
  check("session 2 surfaced the remembered staging host (not restated in brief)", idx >= 0 && s2.includes("staging.internal"));

  await h.close(ctx);
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("board-memory-live test error:", err);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
