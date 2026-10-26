// Board store tests (Phases 0a/0b) — deterministic, no live model needed.
// Opens a Harness over a temp SQLite file and exercises the commit-level helpers:
// standing member creation + self-identity, post_job, atomic single-winner claim,
// report_status, board_status, and durability across restart. The live member work
// loop (a member actually running tools in its workspace) is covered by board-live.test.ts.
// Run with: node test/board.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildCatalog } from "../src/model.ts";
import {
  boardExtension,
  claimJobInTx,
  createChannelInTx,
  createMemberInTx,
  memberIdentityOf,
  postJobInTx,
  publishKnowledgeInTx,
  readBoardStatusInTx,
  readJobInTx,
  readKnowledgeInTx,
  renderKnowledgeUntrusted,
  reportStatusInTx,
  resolveRouteInTx,
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

const ctx = BACKGROUND_CONTEXT;
const base = mkdtempSync(path.join(tmpdir(), "engram-board-"));
const dataDir = path.join(base, "data");
const workDir = path.join(base, "work");
const agentDir = path.join(base, "agent");
for (const d of [dataDir, workDir, agentDir]) mkdirSync(d, { recursive: true });

// An available custom provider so member creation has a valid model ref. We never
// generate in this test, so the dead endpoint is never actually hit.
writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      localbox: {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "local-key",
        api: "openai-completions",
        models: [{ id: "m-a", contextWindow: 4000, maxTokens: 500 }],
      },
    },
  }),
);
const memberModel = { provider: "localbox", modelId: "m-a" };

async function openHarness(dbPath: string) {
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

  console.log("standing members + self-identity");
  const alphaConv = await h.commit((tx) => createMemberInTx(tx, { name: "alpha", model: memberModel }), ctx);
  const betaConv = await h.commit((tx) => createMemberInTx(tx, { name: "beta", model: memberModel }), ctx);
  check("two distinct member conversations created", alphaConv !== undefined && betaConv !== undefined && alphaConv !== betaConv);
  let status = await h.commit(async (tx) => readBoardStatusInTx(tx), ctx);
  check("both members listed on the board", status.members.some((m) => m.id === "alpha") && status.members.some((m) => m.id === "beta"));
  check("member self-identity resolves for alpha", (await memberIdentityOf(h, alphaConv, ctx)) === "alpha");
  check("member self-identity resolves for beta", (await memberIdentityOf(h, betaConv, ctx)) === "beta");

  console.log("post_job + atomic claim (single-winner)");
  await h.commit(
    (tx) => postJobInTx(tx, { id: "job-1", title: "do X", requester: "coordinator", assignee: null, payload: {}, status: "open", claimedBy: null, result: null }),
    ctx,
  );
  status = await h.commit(async (tx) => readBoardStatusInTx(tx), ctx);
  check("job is open before claim", status.openJobs.some((j) => j.id === "job-1"));
  const first = await h.commit((tx) => claimJobInTx(tx, "job-1", "alpha"), ctx);
  const second = await h.commit((tx) => claimJobInTx(tx, "job-1", "beta"), ctx);
  check("first claim wins (alpha)", first !== null && first.assignee === "alpha" && first.status === "claimed");
  check("second claim blocked (single-winner)", second === null);
  status = await h.commit(async (tx) => readBoardStatusInTx(tx), ctx);
  check("claimed job no longer open", !status.openJobs.some((j) => j.id === "job-1"));

  console.log("report_status");
  const done = await h.commit((tx) => reportStatusInTx(tx, "job-1", "done", "result-x"), ctx);
  check("job marked done with result", done.status === "done" && done.result === "result-x" && done.assignee === "alpha");

  console.log("channels + routing resolution (Phase 0c)");
  const chanConv = await h.commit((tx) => createChannelInTx(tx, { id: "general", name: "General", purpose: "team chatter" }), ctx);
  check("channel created with its own conversation", chanConv !== undefined && chanConv !== alphaConv && chanConv !== betaConv);
  const rMember = await h.commit((tx) => resolveRouteInTx(tx, "alpha"), ctx);
  check("route resolves a member target", rMember !== null && rMember.kind === "member" && rMember.conversationId === alphaConv);
  const rChannel = await h.commit((tx) => resolveRouteInTx(tx, "general"), ctx);
  check("route resolves a channel target", rChannel !== null && rChannel.kind === "channel" && rChannel.conversationId === chanConv);
  check("unknown route target resolves to null", (await h.commit((tx) => resolveRouteInTx(tx, "nope"), ctx)) === null);

  console.log("knowledge + untrusted rendering (Phase 0c)");
  await h.commit(
    (tx) =>
      publishKnowledgeInTx(tx, { id: "k1", title: "Notes", body: "peer said X", authorType: "engram", authorId: "alpha", source: "web", trustTier: "untrusted", createdAt: Date.now() }),
    ctx,
  );
  const k = await h.commit((tx) => readKnowledgeInTx(tx, "k1"), ctx);
  check("knowledge stored with provenance + trust tier", k !== null && k.source === "web" && k.trustTier === "untrusted" && k.authorId === "alpha");
  const rendered = k ? renderKnowledgeUntrusted(k) : "";
  check("knowledge body rendered as delimited untrusted data", rendered.includes("<untrusted") && rendered.includes("peer said X") && rendered.includes("</untrusted>"));

  console.log("durability across restart");
  await h.close(ctx);
  const h2 = await openHarness(dbPath); // same file → resume existing state
  status = await h2.commit(async (tx) => readBoardStatusInTx(tx), ctx);
  check("members survive restart", status.members.some((m) => m.id === "alpha") && status.members.some((m) => m.id === "beta"));
  const doneJob = await h2.commit(async (tx) => readJobInTx(tx, "job-1"), ctx);
  check("done job survives restart", doneJob !== null && doneJob.status === "done" && doneJob.result === "result-x");
  check("member self-identity survives restart", (await memberIdentityOf(h2, alphaConv, ctx)) === "alpha");
  check("channel route survives restart", (await h2.commit((tx) => resolveRouteInTx(tx, "general"), ctx))?.kind === "channel");
  check("knowledge post survives restart", (await h2.commit((tx) => readKnowledgeInTx(tx, "k1"), ctx))?.source === "web");
  await h2.close(ctx);

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness error:", err);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
