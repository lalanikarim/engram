// M2.2 board RPC — live integration (two real instances on one box).
//
// Instance A is the board owner; instance B is a REMOTE member of A's board (BOARD_OWNER_URL +
// BOARD_MEMBER_ID → board-client extension). Deterministic checks cover peer auth, job
// visibility, atomic claim over HTTP, report authorization, and route-back delivery. One
// model step drives B's brain through the client tools (claim + report a posted job), with a
// corrective retry for drift.
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, killPortSquatter, Stream } from "./helpers.ts";

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
const BASE_URL = process.env.OPENAI_BASE_URL ?? pocEnv.OPENAI_BASE_URL;
if (!BASE_URL) {
  console.error("OPENAI_BASE_URL not set (poc/.env or environment) — cannot run model tests");
  process.exit(2);
}

// Pin DEFAULT_MODEL to whatever the endpoint is actually serving (app/.env may pin a stale one).
let LOADED_MODEL: string | null = null;
for (let attempt = 1; attempt <= 5 && !LOADED_MODEL; attempt++) {
  try {
    const modelsRes = await fetch(`${BASE_URL.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? pocEnv.OPENAI_API_KEY}` } });
    const modelList = (((await modelsRes.json().catch(() => null)) as any)?.data ?? []) as Array<Record<string, unknown>>;
    const loadedModel = modelList.find((m) => m.loaded === true);
    if (loadedModel) LOADED_MODEL = String(loadedModel.id);
  } catch {
    // endpoint unreachable this attempt
  }
  if (!LOADED_MODEL && attempt < 5) await new Promise((r) => setTimeout(r, 10_000));
}
if (!LOADED_MODEL) {
  console.error("no model is currently loaded on the local endpoint (or it is unreachable) — skipping board-federation live test");
  process.exit(2);
}
console.log(`using loaded model: ${LOADED_MODEL}`);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const base = mkdtempSync(path.join(tmpdir(), "engram-board-federation-"));
function dirsFor(name: string) {
  const d = { data: path.join(base, name, "data"), work: path.join(base, name, "work"), kb: path.join(base, name, "kb"), config: path.join(base, name, "config") };
  for (const x of Object.values(d)) mkdirSync(x, { recursive: true });
  return d;
}

const PORT_A = 18972; // board owner
const PORT_B = 18973; // remote member instance
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const RUN_TIMEOUT = 420_000;

interface Monitor {
  alive(): boolean;
  log(): string;
  exitInfo(): string;
}

interface Instance {
  proc: ChildProcess;
  monitor: Monitor;
}

function spawnInstance(name: string, dirs: { data: string; work: string; kb: string; config: string }, port: number, token: string, extra: Record<string, string> = {}): Instance {
  const proc = spawn("node", [path.join(APP_ROOT, "src", "main.ts")], {
    env: {
      ...process.env,
      OPENAI_BASE_URL: BASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? pocEnv.OPENAI_API_KEY,
      DEFAULT_MODEL: `aurora:${LOADED_MODEL}`,
      API_TOKEN: token,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dirs.data,
      WORK_ROOT: dirs.work,
      KB_DIR: dirs.kb,
      CONFIG_DIR: dirs.config,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout?.on("data", (d) => (log += String(d)));
  proc.stderr?.on("data", (d) => (log += String(d)));
  const monitor: Monitor = {
    alive: () => proc.exitCode === null && proc.signalCode === null,
    log: () => log,
    exitInfo: () => `exit=${proc.exitCode} signal=${proc.signalCode}`,
  };
  (proc as any).__log = monitor.log;
  return { proc, monitor };
}

killPortSquatter(PORT_A);
killPortSquatter(PORT_B);

const dirsA = dirsFor("a");
const dirsB = dirsFor("b");
let instA = spawnInstance("a", dirsA, PORT_A, TOKEN_A, { BOARD_PEER_TOKENS: `peer-b:${TOKEN_B}` });
let instB = spawnInstance("b", dirsB, PORT_B, TOKEN_B, {
  BOARD_OWNER_URL: `http://127.0.0.1:${PORT_A}`,
  BOARD_MEMBER_ID: "peer-b",
  BOARD_PEER_TOKENS: `peer-b:${TOKEN_B}`, // its own copy of the peer token it presents to A
});

const cleanup = () => {
  heartbeat.stop();
  for (const inst of [instA, instB]) {
    try {
      inst.proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  rmSync(base, { recursive: true, force: true });
};

// ---- defensive boot monitoring ----
// The local inference box doubles as a shared endpoint, so model discovery can stall and
// processes can die mid-boot. We monitor liveness in real time, fail fast on early death,
// restart (up to 2 times) with a guaranteed port-free check before rebinding, and print a
// heartbeat every 15s so stalls are visible instead of silent.
const MAX_RESTARTS = 2;
// Model discovery against the shared local box can take several minutes under load, so a
// live process gets up to 10 minutes per attempt. Restarts only trigger on death or stall.
const BOOT_DEADLINE_MS = 10 * 60_000; // hard wall-clock cap for the boot phase

interface InstanceSlot {
  name: string;
  port: number;
  token: string;
  current: ReturnType<typeof spawnInstance>;
  restarts: number;
}

const heartbeat = (() => {
  let timer: NodeJS.Timeout | null = null;
  return {
    start(slots: InstanceSlot[]) {
      if (timer) return;
      timer = setInterval(() => {
        const bits = slots.map((s) => `${s.name}:${s.port} ${s.current.monitor.alive() ? "alive" : `DEAD(${s.current.monitor.exitInfo()})`}`).join(" ");
        console.log(`[heartbeat] ${bits}`);
      }, 15_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
})();

// Hard global deadline: if the whole test exceeds this, dump logs and exit — never hang silently.
const GLOBAL_DEADLINE_MS = 35 * 60_000;
const globalTimer = setTimeout(() => {
  console.error("\n--- global deadline exceeded — dumping instance logs ---");
  for (const s of [slotA, slotB]) {
    console.error(`\n--- ${s.name} log tail ---\n` + s.current.monitor.log().slice(-3000));
  }
  process.exit(1);
}, GLOBAL_DEADLINE_MS);
globalTimer.unref?.();

function portFree(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/ready`).then(
    () => false, // something is listening
    () => true, // connection refused → free
  );
}

async function stopInstance(proc: ChildProcess) {
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  for (let i = 0; i < 15; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    await sleep(1000);
    if (i === 4) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

// Boot can legitimately take minutes (model discovery retries against a shared local endpoint),
// so give a live process up to 3 minutes. A dead process fails fast via the monitor check.
async function waitReady(port: number, token: string, monitor: Monitor): Promise<boolean> {
  const aliveAtEntry = monitor.alive();
  for (let i = 0; i < 600; i++) {
    await sleep(1000);
    if (!monitor.alive()) {
      // Only count as boot failure if this wait round started with a live process — otherwise
      // the death is from our own restart cycle and the caller will respawn anyway.
      if (aliveAtEntry) {
        console.log(`[boot] instance on ${port} died during boot — ${monitor.exitInfo()}`);
        console.log(`[boot] last output: ${monitor.log().slice(-500)}`);
        return false;
      }
      break;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 200 && ((await res.json().catch(() => null)) as any)?.ready === true) return true;
    } catch {
      // not up yet
    }
  }
  return false;
}

const slotA: InstanceSlot = { name: "a", port: PORT_A, token: TOKEN_A, current: instA, restarts: 0 };
const slotB: InstanceSlot = { name: "b", port: PORT_B, token: TOKEN_B, current: instB, restarts: 0 };

async function ensureReady(slot: InstanceSlot, respawn: () => ReturnType<typeof spawnInstance>): Promise<boolean> {
  const deadline = Date.now() + BOOT_DEADLINE_MS;
  for (;;) {
    if (await waitReady(slot.port, slot.token, slot.current.monitor)) return true;
    if (Date.now() > deadline) return false;
    if (slot.restarts >= MAX_RESTARTS) return false;
    console.log(`[boot] ${slot.name}:${slot.port} not ready (${slot.current.monitor.alive() ? "stalled" : `dead ${slot.current.monitor.exitInfo()}`}) — restart ${slot.restarts + 1}/${MAX_RESTARTS}`);
    slot.restarts++;
    await stopInstance(slot.current.proc);
    // Clear any squatter (including orphans we don't track) before rebinding.
    killPortSquatter(slot.port);
    for (let i = 0; i < 30 && !(await portFree(slot.port)); i++) {
      if (i === 10) killPortSquatter(slot.port);
      await sleep(1000);
    }
    if (!(await portFree(slot.port))) {
      console.log(`[boot] ${slot.name}:${slot.port} still occupied after 30s — giving up`);
      return false;
    }
    slot.current = respawn();
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---- boot instances sequentially (monitored) ----
// Sequential, not parallel: concurrent model discovery against the shared local endpoint is
// exactly what stalls startup, and A must be up before B's board-client can talk to it.
heartbeat.start([slotA, slotB]);
const readyA = await ensureReady(slotA, () => spawnInstance("a", dirsA, PORT_A, TOKEN_A, { BOARD_PEER_TOKENS: `peer-b:${TOKEN_B}` }));
const readyB = readyA ? await ensureReady(slotB, () => spawnInstance("b", dirsB, PORT_B, TOKEN_B, { BOARD_OWNER_URL: `http://127.0.0.1:${PORT_A}`, BOARD_MEMBER_ID: "peer-b", BOARD_PEER_TOKENS: `peer-b:${TOKEN_B}` })) : false;
heartbeat.stop();
check("board owner (A) ready", readyA, slotA.current.monitor.log().slice(-2000));
check("remote member instance (B) ready", readyB, slotB.current.monitor.log().slice(-2000));
if (!readyA || !readyB) process.exit(1);

// ---- register B's root conversation on A's board as a remote member ----
try {
const created = await api(PORT_B, TOKEN_B, "POST", "/conversations", { name: "remote-member" });
check("member conversation created on B", created.status === 201 && typeof created.json?.id === "number", JSON.stringify(created.json));
if (created.status !== 201) process.exit(1);
const remoteConvId = created.json.id as number;

// A2 routing is allowlist-gated: grant peer-b the right to route back to the coordinator.
const reg = await api(PORT_A, TOKEN_A, "POST", "/board/members", {
  id: "peer-b",
  name: "Peer B",
  endpoint: `http://127.0.0.1:${PORT_B}`,
  tokenRef: "peer-b",
  conversationId: remoteConvId,
  allowedTargets: ["coordinator"],
});
check("remote member registered on A", reg.status === 201 && reg.json?.id === "peer-b", JSON.stringify(reg.json));

// ---- deterministic: peer auth + job visibility over HTTP ----
const post = (jobId: string, title: string) => api(PORT_A, TOKEN_A, "POST", "/board/jobs", { id: jobId, title, requester: "coordinator" });
check("jobs posted on A", (await post("job-1", "first job")).status === 201 && (await post("job-2", "second job")).status === 201);

const visB = await fetch(`http://127.0.0.1:${PORT_A}/board/jobs`, { headers: { authorization: `Bearer ${TOKEN_B}` } }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));
check("peer sees both open jobs", visB.status === 200 && (visB.json?.jobs ?? []).every((j: any) => j.id === "job-1" || j.id === "job-2") && (visB.json?.jobs ?? []).length === 2, JSON.stringify(visB.json));

check("unknown bearer → 401", (await api(PORT_A, "tok-rogue", "GET", "/board/jobs")).status === 401);
check("no bearer → 401", (await fetch(`http://127.0.0.1:${PORT_A}/board/jobs`).then((r) => r.status)) === 401);

// ---- deterministic: atomic claim over HTTP + report authorization ----
const claimB = await api(PORT_A, TOKEN_B, "POST", "/board/jobs/claim", { jobId: "job-1" });
check("peer claims job-1 over HTTP (200)", claimB.status === 200 && claimB.json?.job?.assignee === "peer-b", JSON.stringify(claimB.json));

const visB2 = await fetch(`http://127.0.0.1:${PORT_A}/board/jobs`, { headers: { authorization: `Bearer ${TOKEN_B}` } }).then((r) => r.json().catch(() => null)) as any;
check(
  "claimed job-1 still visible to its assignee; open pool intact",
  (visB2?.jobs ?? []).some((j: any) => j.id === "job-1" && j.status === "claimed" && j.assignee === "peer-b") &&
    (visB2?.jobs ?? []).some((j: any) => j.id === "job-2" && j.status === "open") &&
    (visB2?.jobs ?? []).length === 2,
  JSON.stringify(visB2),
);

const claimA = await api(PORT_A, TOKEN_A, "POST", "/board/jobs/claim", { jobId: "job-1" });
check("second claim rejected (single-winner over HTTP)", claimA.status === 409, JSON.stringify(claimA.json));

// Report authorization: peer-b may report job-1 (its own) but not job-2 (unassigned).
check("peer reports done on its own job", (await api(PORT_A, TOKEN_B, "POST", "/board/jobs/job-1/status", { status: "done", result: "via http" })).status === 200);
check("peer cannot report on a job it does not own", (await api(PORT_A, TOKEN_B, "POST", "/board/jobs/job-2/status", { status: "done" })).status === 403);

const boardA = await api(PORT_A, TOKEN_A, "GET", "/board");
check("owner dashboard shows job-1 done with result", (boardA.json?.openJobs ?? []).every((j: any) => j.id !== "job-1") && JSON.stringify(boardA.json).includes('"result":"via http"'));

// ---- deterministic: route-back from the peer to a local member on A ----
const streamA = new Stream(PORT_A, TOKEN_A, 1); // A's root (coordinator) conversation
const routeBack = await api(PORT_A, TOKEN_B, "POST", "/board/route", { to: "coordinator", content: "hello back from the peer" });
check("peer routes a message back to the coordinator (200)", routeBack.status === 200, JSON.stringify(routeBack.json));

let sawRouteBack = false;
for (let i = 0; i < 30 && !sawRouteBack; i++) {
  await sleep(2000);
  const entries = ((await api(PORT_A, TOKEN_A, "GET", "/conversations/1/entries?after=0&limit=300")).json?.entries ?? []) as any[];
  sawRouteBack = entries.flatMap((e) => (Array.isArray(e.model) ? e.model : [])).some((m: any) => typeof m.content === "string" && m.content.includes('<untrusted from="peer-b">') && m.content.includes("hello back from the peer"));
}
check("coordinator transcript contains the peer's untrusted-wrapped message", sawRouteBack);

// Auth is checked before resolution (same order as the local route_message tool): a barred
// target answers 403 even when it does not exist.
check("peer cannot route to a barred target", (await api(PORT_A, TOKEN_B, "POST", "/board/route", { to: "no-such-member", content: "x" })).status === 403);

// ---- model step: B's brain uses the board-client tools (claim + report job-2) ----
const streamB = new Stream(PORT_B, TOKEN_B, 1); // B's root conversation hosts the client tools
let modelDone = false;
for (let round = 1; round <= 2 && !modelDone; round++) {
  const content =
    'Use your board tools: call board_jobs to list jobs, then claim_job on job-2, then report_status with status "done" and result "done by peer brain". You must actually invoke all three tools.' +
    (round > 1 ? "\nReminder: your previous reply did not complete the sequence. Continue with the missing calls." : "");
  const subRes = await api(PORT_B, TOKEN_B, "POST", "/tasks", { content, requestId: `federation-${round}` });
  if (subRes.status !== 202) {
    check(`run ${round} submitted`, false, JSON.stringify(subRes.json));
    continue;
  }
  check(`run ${round} completes`, await streamB.waitForRunEnd(subRes.json.submissionId as number, RUN_TIMEOUT));
  modelDone = streamB.toolResultTexts("claim_job").some((t) => t.includes("claimed job-2")) && streamB.toolResultTexts("report_status").some((t) => t.includes("job-2 -> done"));
  if (!modelDone) console.log(`(round ${round}: model sequence incomplete — ${round < 2 ? "retrying" : "giving up"})`);
}
check("peer brain claimed + reported job-2 via the board-client tools", modelDone, streamB.toolResultTexts().join(" | ").slice(0, 400));

const boardFinal = await api(PORT_A, TOKEN_A, "GET", "/board");
check("owner dashboard shows job-2 done (reported over HTTP by the peer brain)", JSON.stringify(boardFinal.json).includes('"id":"job-2"') && !String(JSON.stringify(boardFinal.json?.openJobs ?? [])).includes("job-2"));

streamA.close();
streamB.close();
if (fail > 0) {
  console.error("\n--- A log tail ---\n" + slotA.current.monitor.log().slice(-3000));
  console.error("\n--- B log tail ---\n" + slotB.current.monitor.log().slice(-3000));
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error("\n--- unhandled error ---\n" + String(err));
  if (fail === 0 && pass === 0) process.exit(1);
  throw err;
}
