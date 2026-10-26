// Live board comms test (Phase 0c): a standing member actually calls route_message to a
// channel, and the routed message durably appears in that channel's transcript. Requires
// OPENAI_BASE_URL; skips cleanly when no local endpoint is available.
// Run with: node test/board-comms-live.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildCatalog } from "../src/model.ts";
import { boardExtension, createChannelInTx, createMemberInTx } from "../src/extensions/board.ts";

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
  console.log("board-comms-live: no OPENAI_BASE_URL/OPENAI_API_KEY — skipping live routing test");
  process.exit(0);
}

const ctx = BACKGROUND_CONTEXT;
const base = mkdtempSync(path.join(tmpdir(), "engram-board-comms-"));
const dataDir = path.join(base, "data");
const workDir = path.join(base, "work");
const agentDir = path.join(base, "agent");
for (const d of [dataDir, workDir, agentDir]) mkdirSync(d, { recursive: true });

async function main() {
  const { models, envModel } = await buildCatalog({ agentDir, env: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: apiKey } });
  if (!envModel) throw new Error("no loaded model discovered on the endpoint");
  const modelRef = envModel;

  const registry = createRegistry();
  registry.install(boardExtension());

  // alpha only needs route_message (+ board_status to see the directory).
  const wanted = new Set(["route_message", "board_status"]);
  const memberTools = registry.snapshot().installed().flatMap((e) => e.tools ?? []).filter((t) => wanted.has(t.name));

  const h = await Harness.open(
    await openNodeSqliteStorage(path.join(dataDir, "board-comms.sqlite")),
    { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ? path.join(workDir, target.cwd) : workDir }) },
    ctx,
  );
  h.resume();

  // A2: routing is now allowlist-gated — grant alpha the right to route to "general".
  const alphaConv = await h.commit((tx) => createMemberInTx(tx, { name: "alpha", model: modelRef, tools: memberTools, allowedTargets: ["general"] }), ctx);
  const chanConv = await h.commit((tx) => createChannelInTx(tx, { id: "general", name: "General", purpose: "team chatter" }), ctx);

  const alpha = await h.conversation(alphaConv, ctx);
  if (!alpha) throw new Error("alpha conversation handle not found");
  const marker = `ROUTED-MARK-${Date.now()}`;
  const t0 = Date.now();
  const sub = await alpha.submit(
    { type: "input", content: `Call route_message with to "general" and content exactly "${marker}". Then stop.`, requestId: "comm-alpha-route" },
    ctx,
  );
  const settled = await sub.wait(ctx);
  console.log(`  alpha run: status=${settled.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const chan = await h.conversation(chanConv, ctx);
  if (!chan) throw new Error("channel conversation handle not found");
  const page = await chan.entries({ order: "ascending" }, 200, undefined, ctx);
  const blob = JSON.stringify(page);

  console.log("routing delivery");
  check("alpha run settled done", settled.status === "done");
  check("routed message appears in the channel transcript", blob.includes(marker));
  check("channel transcript attributes the sender", blob.includes("alpha -> channel:general"));

  await h.close(ctx);
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("board-comms-live test error:", err);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
