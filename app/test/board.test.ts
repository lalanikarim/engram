// Phase 0a board store tests — deterministic, no live model needed.
// Opens a Harness over a temp SQLite file and exercises the commit-level helpers
// (register / post_job / board_status), then verifies durability across a restart.
// Run with: node test/board.test.ts
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildCatalog } from "../src/model.ts";
import { boardExtension, postJobInTx, readBoardStatusInTx, registerMemberInTx } from "../src/extensions/board.ts";

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

const ctx = BACKGROUND_CONTEXT;
const base = mkdtempSync(path.join(tmpdir(), "engram-board-"));
const dataDir = path.join(base, "data");
const workDir = path.join(base, "work");
const agentDir = path.join(base, "agent");
for (const d of [dataDir, workDir, agentDir]) mkdirSync(d, { recursive: true });

async function openHarness(dbPath: string) {
  // Empty agent dir + no env → built-in providers only, no live endpoint call.
  const { models } = await buildCatalog({ agentDir, env: {} });
  const registry = createRegistry();
  registry.install(boardExtension());
  const h = await Harness.open(
    await openNodeSqliteStorage(dbPath),
    {
      models,
      registry,
      env: (target) => new NodeExecutionEnv({ cwd: target.cwd ? path.join(workDir, target.cwd) : workDir }),
    },
    ctx,
  );
  h.resume();
  return h;
}

async function main() {
  const dbPath = path.join(dataDir, "board.sqlite");
  const h = await openHarness(dbPath);

  console.log("register + post_job");
  await h.commit(
    (tx) =>
      registerMemberInTx(tx, {
        id: "alpha",
        name: "alpha",
        kind: "member",
        conversationId: 1,
        trustLevel: "trusted",
        capabilities: ["files"],
        description: "worker",
      }),
    ctx,
  );
  await h.commit(
    (tx) =>
      postJobInTx(tx, {
        id: "job-1",
        title: "do X",
        requester: "coordinator",
        assignee: null,
        payload: { x: 1 },
        status: "open",
        claimedBy: null,
        result: null,
      }),
    ctx,
  );

  let status = await h.commit(async (tx) => readBoardStatusInTx(tx), ctx);
  check("member registered and listed", status.members.some((m) => m.id === "alpha" && m.kind === "member"));
  check("open job listed", status.openJobs.some((j) => j.id === "job-1" && j.status === "open"));

  console.log("idempotency");
  // Re-registering the same id updates in place and does not duplicate the index.
  await h.commit(
    (tx) =>
      registerMemberInTx(tx, {
        id: "alpha",
        name: "alpha-renamed",
        kind: "member",
        conversationId: 1,
        trustLevel: "trusted",
        capabilities: ["files"],
        description: "worker",
      }),
    ctx,
  );
  status = await h.commit(async (tx) => readBoardStatusInTx(tx), ctx);
  check("register idempotent on id (exactly one alpha)", status.members.filter((m) => m.id === "alpha").length === 1);
  check("re-register updated the profile", status.members.find((m) => m.id === "alpha")?.name === "alpha-renamed");

  console.log("durability across restart");
  await h.close(ctx);
  const h2 = await openHarness(dbPath); // same file → resume existing state
  status = await h2.commit(async (tx) => readBoardStatusInTx(tx), ctx);
  check("member survives restart", status.members.some((m) => m.id === "alpha"));
  check("open job survives restart", status.openJobs.some((j) => j.id === "job-1"));
  await h2.close(ctx);

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness error:", err);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
