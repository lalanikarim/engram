// Core instance seam tests (issue #42): prove createCoreInstance is a composable,
// deterministic building block — consumer extensions reach the root conversation,
// close() tears down fully and idempotently, and two instances coexist in one process.
// Requires the same local model endpoint as the other live suites (poc/.env or env).
import assert from "node:assert";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");
const ctx: Context = BACKGROUND_CONTEXT;

// ---- env: same source as api.test.ts (poc/.env or ambient) ----
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
if (!process.env.OPENAI_BASE_URL && !pocEnv.OPENAI_BASE_URL) {
  console.error("OPENAI_BASE_URL not set (poc/.env or environment) — cannot run core instance tests");
  process.exit(2);
}
for (const k of ["OPENAI_BASE_URL", "OPENAI_API_KEY"]) {
  if (!process.env[k] && pocEnv[k]) process.env[k] = pocEnv[k];
}
process.env.API_TOKEN ??= "core-test-token";

// ---- helpers ----
let checkCount = 0;
function check(name: string): void {
  checkCount += 1;
  console.log(`  ok ${checkCount} - ${name}`);
}

function makeDirs(tag: string) {
  const base = mkdtempSync(path.join(tmpdir(), `engram-core-${tag}-`));
  const dirs = { data: path.join(base, "data"), work: path.join(base, "work"), kb: path.join(base, "kb"), config: path.join(base, "config") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return { base, dirs };
}

function health(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", headers: { authorization: `Bearer ${process.env.API_TOKEN}` } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
  });
}

async function httpJson(port: number, method: string, reqPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method, headers: { authorization: `Bearer ${process.env.API_TOKEN}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let body: unknown;
          try { body = JSON.parse(data); } catch { body = data; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Bind a plain server to prove a port was released.
function bindPlain(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const s = http.createServer(() => {});
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

async function main() {
  const { loadConfig } = await import("../src/config.ts");
  const { createCoreInstance } = await import("../src/core.ts");

  // Trivial consumer extension: a no-op tool that must reach the root conversation.
  const probeTool = defineTool({
    name: "noop_probe",
    description: "Test probe (no-op).",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => ({ output: [{ type: "text" as const, text: "probe-ok" }] }),
  });
  const probe = defineExtension({ name: "probe", tools: [probeTool] });

  // ---- 1. Seam: extraExtensions installed before Harness.open reach the root agent ----
  console.log("core instance: seam");
  const a = makeDirs("a");
  const configA = loadConfig({ dataDir: a.dirs.data, workRoot: a.dirs.work, kbDir: a.dirs.kb, configDir: a.dirs.config });
  // App-registered route seam: the product/consumer layer can add its own endpoints.
  const probeRoute = {
    method: "GET",
    path: "/probe-route",
    handle: async (_req: http.IncomingMessage, res: http.ServerResponse, rc: { json: (r: http.ServerResponse, s: number, b: unknown) => void }) =>
      rc.json(res, 200, { ok: true }),
  };
  const instA = await createCoreInstance({ config: configA, extraExtensions: [probe], routes: [probeRoute], port: 0 });
  assert(instA.actualPort > 0, "ephemeral port must be allocated");
  check("instance boots with ephemeral port (port: 0)");

  const rootA = await instA.harness.conversation(instA.rootConversationId as ConversationId, ctx);
  assert(rootA, "root conversation exists");
  const agentA = await rootA.agent(ctx);
  const toolNames = agentA.tools.map((t) => t.name);
  assert(toolNames.includes("noop_probe"), `probe tool not offered to root (got ${toolNames.join(", ")})`);
  check("extraExtension tool is visible to the root conversation");

  // Core tools still present alongside the consumer extension.
  for (const expected of ["bash", "web_fetch", "kb_search"]) {
    assert(toolNames.includes(expected), `core tool ${expected} missing from root agent`);
  }
  check("core tools remain installed alongside consumer extensions");

  // Board is NOT a core default: it belongs to the product layer (main.ts).
  assert(!toolNames.includes("board_status"), "board tools must not leak into the bare core");
  check("product-only board tools are absent from the bare core");

  // Route seam: app-registered routes are served after core routes…
  const probed = await httpJson(instA.actualPort, "GET", "/probe-route");
  assert.strictEqual(probed.status, 200, `probe route should answer 200 (got ${probed.status})`);
  assert.deepStrictEqual(probed.body, { ok: true }, "probe route body mismatch");
  check("app-registered route is served on the instance server");

  // …matched by exact method + path; wrong method falls through to 404.
  const wrongMethod = await httpJson(instA.actualPort, "POST", "/probe-route");
  assert.strictEqual(wrongMethod.status, 404, `wrong-method probe route should 404 (got ${wrongMethod.status})`);
  check("route match is exact method + path (wrong method → 404)");

  // The kernel is board-free: /board is a product route, not a core endpoint.
  const noBoard = await httpJson(instA.actualPort, "GET", "/board");
  assert.strictEqual(noBoard.status, 404, `bare core must not serve /board (got ${noBoard.status})`);
  check("kernel is board-free: bare core returns 404 for /board");

  assert.strictEqual(await health(instA.actualPort), 200, "/health should answer on actualPort");
  check("HTTP server answers /health on the bound port");

  // ---- 2. Teardown: close() is idempotent and releases the port ----
  console.log("core instance: teardown");
  await instA.close();
  await instA.close(); // idempotent second call must be a no-op, not an error
  check("close() is idempotent");

  const rebind = await bindPlain(instA.actualPort);
  rebind.close();
  check("port released after close (rebind succeeds)");

  // ---- 3. Fleet shape: two instances in one process, distinct stores ----
  console.log("core instance: two instances in one process");
  const b = makeDirs("b");
  const c = makeDirs("c");
  const configB = loadConfig({ dataDir: b.dirs.data, workRoot: b.dirs.work, kbDir: b.dirs.kb, configDir: b.dirs.config });
  const configC = loadConfig({ dataDir: c.dirs.data, workRoot: c.dirs.work, kbDir: c.dirs.kb, configDir: c.dirs.config });
  const instB = await createCoreInstance({ config: configB, port: 0 });
  const instC = await createCoreInstance({ config: configC, extraExtensions: [probe], port: 0 });
  assert(instB.actualPort !== instC.actualPort, "two instances must bind distinct ports");
  check("two instances coexist with distinct ephemeral ports");

  // No cross-instance state leak: B's store has its own root; C's probe tool is not in B.
  const rootB = await instB.harness.conversation(instB.rootConversationId as ConversationId, ctx);
  assert(rootB, "root B conversation exists");
  const agentB = (await rootB.agent(ctx)).tools.map((t) => t.name);
  assert(!agentB.includes("noop_probe"), "probe tool leaked across instances");
  check("no cross-instance extension leak");

  // Routes are per-instance: B registered none, so A's probe path is a 404 on B.
  const noRouteB = await httpJson(instB.actualPort, "GET", "/probe-route");
  assert.strictEqual(noRouteB.status, 404, `instance B must not serve A's route (got ${noRouteB.status})`);
  check("routes are per-instance (no cross-instance route leak)");

  assert.strictEqual(await health(instB.actualPort), 200, "instance B /health");
  assert.strictEqual(await health(instC.actualPort), 200, "instance C /health");
  check("both instances serve HTTP concurrently");

  await instB.close();
  await instC.close();
  check("both instances close cleanly");

  rmSync(a.base, { recursive: true, force: true });
  rmSync(b.base, { recursive: true, force: true });
  rmSync(c.base, { recursive: true, force: true });
  console.log(`\ncore-instance: ${checkCount} checks passed`);
}

main().catch((err) => {
  console.error("core-instance FAILED:", err);
  process.exit(1);
});
