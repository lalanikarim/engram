// Live board approval test (Phase 0d): a standing member calls a gated tool (send_message);
// the global approval hook blocks it and leaves a marker in the MEMBER's transcript, which is
// discoverable across all conversations (what GET /approvals + GET /board use). The human's
// decision is durable, and on retry the action executes. Requires OPENAI_BASE_URL; skips cleanly
// when no local endpoint is available. Run with: node test/board-approval-live.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry, defineExtension, Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildCatalog } from "../src/model.ts";
import { boardExtension, createMemberInTx } from "../src/extensions/board.ts";
import { approvalHook, ApprovalDoc, parseApprovalMarker, sendMessageTool } from "../src/extensions/approvals.ts";
import { compileGates, type GatesConfig } from "../src/extensions/gates.ts";

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

/** Text of an entry's model messages (+ data), mirroring server.ts for marker discovery. */
function entryTexts(e: EntryRecord): string[] {
  const texts: string[] = [];
  for (const m of e.model ?? []) {
    if (typeof m.content === "string") texts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content) if (c.type === "text") texts.push(c.text);
    }
  }
  if (e.data !== undefined && e.data !== null) texts.push(JSON.stringify(e.data));
  return texts;
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
  console.log("board-approval-live: no OPENAI_BASE_URL/OPENAI_API_KEY — skipping live member approval test");
  process.exit(0);
}

const ctx = BACKGROUND_CONTEXT;
const base = mkdtempSync(path.join(tmpdir(), "engram-board-appr-"));
const dataDir = path.join(base, "data");
const workDir = path.join(base, "work");
const agentDir = path.join(base, "agent");
for (const d of [dataDir, workDir, agentDir]) mkdirSync(d, { recursive: true });

async function main() {
  const { models, envModel } = await buildCatalog({ agentDir, env: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: apiKey } });
  if (!envModel) throw new Error("no loaded model discovered on the endpoint");
  const modelRef = envModel;

  // Registry mirrors main.ts: coding tools + board + a gated send_message (prompt tier).
  const gates: GatesConfig = { tiers: [{ tool: "send_message", default: "prompt" }] };
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(boardExtension());
  registry.install(defineExtension({ name: "sensitive", tools: [sendMessageTool()], hooks: [approvalHook(compileGates(gates))] }));

  const memberTools = registry.snapshot().installed().flatMap((e) => e.tools ?? []).filter((t) => t.name === "send_message");

  const h = await Harness.open(
    await openNodeSqliteStorage(path.join(dataDir, "board-appr.sqlite")),
    { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ? path.join(workDir, target.cwd) : workDir }) },
    ctx,
  );
  h.resume();

  const workerConv = await h.commit((tx) => createMemberInTx(tx, { name: "worker", model: modelRef, tools: memberTools }), ctx);
  const worker = await h.conversation(workerConv, ctx);
  if (!worker) throw new Error("worker conversation handle not found");

  // Run 1: the member calls a gated tool → blocked, marker left in ITS transcript.
  const t0 = Date.now();
  const sub1 = await worker.submit(
    { type: "input", content: `Use the send_message tool to send the message "hello" to "alice". If it is blocked pending human approval, report the approval key and stop — do not retry.`, requestId: "ap-1" },
    ctx,
  );
  const settled1 = await sub1.wait(ctx);
  console.log(`  worker run 1: status=${settled1.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Discover the marker across ALL conversations (what GET /approvals + GET /board rely on).
  const found = await h.commit(async (tx) => {
    const convs = await tx.scanConversations({ order: "descending" }, 100);
    for (const c of convs.items) {
      const entries = await tx.scanEntries({ conversationId: c.id, order: "ascending" }, 200);
      for (const e of entries.items) {
        for (const text of entryTexts(e)) {
          const marker = parseApprovalMarker(text);
          if (marker && marker.tool === "send_message") return marker;
        }
      }
    }
    return null;
  }, ctx);

  console.log("member approval routing");
  check("member's gated action discovered across conversations", found !== null);

  const key = found!.key;
  // Human decision: durable approve.
  await h.commit(async (tx) => {
    const d = await tx.doc(ApprovalDoc, key, {});
    d.decision = "approved";
    d.decidedBy = "test";
    d.decidedAt = Date.now();
  }, ctx);
  const rec = await h.snapshot(ApprovalDoc, key, ctx);
  check("approval decision is durable", rec?.decision === "approved");

  // Run 2: retry with the same args → now executes.
  const sub2 = await worker.submit(
    { type: "input", content: `The human has APPROVED action key ${key}. Retry send_message with the exact same arguments (to "alice", message "hello").`, requestId: "ap-2" },
    ctx,
  );
  await sub2.wait(ctx);

  const workerEntries = await h.commit(async (tx) => {
    const entries = await tx.scanEntries({ conversationId: workerConv, order: "ascending" }, 200);
    return entries.items;
  }, ctx);
  const texts = workerEntries.flatMap(entryTexts);
  check("member's send_message was blocked pending approval", texts.some((t) => t.includes("BLOCKED")));
  check("send_message executed after approval", texts.some((t) => t.includes("ACTION EXECUTED")));

  await h.close(ctx);
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("board-approval-live test error:", err);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
