// Phase 5 — sandbox execution env (A7): per-conversation Podman container,
// no host secrets, egress-limited; coexists with a local env in one harness.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { auroraModels, auroraModelId } from "./lib/aurora.mjs";
import { PodmanSandboxEnv } from "./lib/podman-sandbox.mjs";

const ctx = BACKGROUND_CONTEXT;
const WORK = fileURLToPath(new URL("./work", import.meta.url));
const SBX_WS = fileURLToPath(new URL("./sandbox-test/ws", import.meta.url));

rmSync(SBX_WS, { recursive: true, force: true });

const registry = createRegistry();
registry.install(CodingTools);

const sandbox = new PodmanSandboxEnv({ workspace: SBX_WS, network: "none" });
await sandbox.init(ctx);
console.log(`sandbox container: ${sandbox.containerId} (network=${sandbox.network})`);

let sandboxConvId;
const h = await Harness.open(
  await openNodeSqliteStorage("./data/sandbox.sqlite"),
  {
    models: auroraModels(),
    registry,
    env: (target) => {
      if (target.conversationId === sandboxConvId) return sandbox;
      return new NodeExecutionEnv({ cwd: WORK });
    },
  },
  ctx,
);
h.resume();

const root = await h.root(ctx, {
  agent: { model: { provider: "aurora", modelId: auroraModelId() }, thinkingLevel: "medium" },
});

// second conversation routed to the sandbox
const b = await h.createConversation({ ownership: { kind: "ownerless" } }, ctx);
sandboxConvId = b.id;
await b.configure(
  { model: { provider: "aurora", modelId: auroraModelId() }, thinkingLevel: "medium" },
  ctx,
);

let pass = true;
const check = (label, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) pass = false;
};

// --- direct env security checks (deterministic, no model involved) ---
const envRun = async (cmd) => {
  const r = await sandbox.exec(cmd, undefined, ctx);
  return r.ok ? { code: r.value.exitCode, out: "" } : { code: -1, err: r.error.message };
};

// capture output properly for assertions
const envOut = async (cmd) => {
  let out = "";
  const r = await sandbox.exec(cmd, { onOutput: (t) => (out += t) }, ctx);
  return { ok: r.ok, code: r.ok ? r.value.exitCode : -1, out };
};

// 1. no host secrets in the container environment
const envCheck = await envOut("env");
check("no host secrets in container env", !/API_KEY|TOKEN|SECRET|UNSLOTH/i.test(envCheck.out));

// 2. egress blocked (--network none)
const net = await envOut("python3 -c \"import urllib.request;urllib.request.urlopen('https://example.com',timeout=4);print('NET-OK')\" 2>&1");
check("egress blocked (network=none)", !net.out.includes("NET-OK"));

// 3. host filesystem not visible inside the container
const hostFs = await envOut("ls /Users 2>&1 || true");
check("host FS not mounted in container", !hostFs.out.includes("karim"));

// 4. file tools cannot escape the workspace (containment guard)
const escape = await sandbox.readTextFile("../../data/sandbox.sqlite", ctx);
check("file read outside workspace denied", !escape.ok && escape.error.code === "permission_denied");
const existsOutside = await sandbox.exists("../agent.sqlite", ctx);
check("exists() outside workspace → false", existsOutside.ok && existsOutside.value === false);

// --- agent task in the sandbox conversation: tools route into the container ---
const sub = await b.submit(
  {
    type: "input",
    content: "Create a file hello.txt containing exactly from-sandbox, then run `cat hello.txt` with bash and show me its output.",
    requestId: "ph5-sbx",
  },
  ctx,
);
const settled = await sub.wait(ctx);
check("sandbox agent task done", settled.status === "done");

const fileOnHost = existsSync(SBX_WS + "/hello.txt") && readFileSync(SBX_WS + "/hello.txt", "utf8").includes("from-sandbox");
check("bash write landed in /sandbox (host workspace)", fileOnHost);

if (settled.status === "done") {
  const a = await b.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
  const text = (a?.model ?? []).flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text)).join("\n");
  console.log(`sandbox agent answer: ${text.slice(0, 200).replace(/\n/g, " ")}`);
}

// --- local conversation still works (coexistence) ---
const subLocal = await root.submit(
  { type: "input", content: "Create a file local.txt containing exactly from-local and confirm.", requestId: "ph5-local" },
  ctx,
);
const settledLocal = await subLocal.wait(ctx);
const localOk = existsSync(WORK + "/local.txt") && readFileSync(WORK + "/local.txt", "utf8").includes("from-local");
check("local conversation writes to poc/work (coexistence)", settledLocal.status === "done" && localOk);

await sandbox.cleanup(ctx);
const gone = await envRun("true"); // should fail: container removed
check("container removed on cleanup", !sandbox.ready);

console.log(pass ? "\nPHASE5-SANDBOX: PASS" : "\nPHASE5-SANDBOX: FAIL");
process.exitCode = pass ? 0 : 1;
await h.close(ctx);
