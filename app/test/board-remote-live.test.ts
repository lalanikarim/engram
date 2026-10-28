// M2 remote member transport — live integration (two real instances on one box).
//
// Instance A is the board owner; instance B hosts a member conversation. A registers B's
// conversation as a REMOTE member (endpoint + tokenRef from BOARD_PEER_TOKENS), then its
// coordinator routes a message to it over HTTP. The peer must receive the untrusted-wrapped
// message in its own transcript. Deterministic checks cover registration, validation, and the
// dashboard; one model step drives route_message (with one corrective retry for drift).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, Stream } from "./helpers.ts";

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
// A few retries: the local inference box can blip while it swaps models.
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
  console.error("no model is currently loaded on the local endpoint (or it is unreachable) — skipping board-remote live test");
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

const base = mkdtempSync(path.join(tmpdir(), "engram-board-remote-live-"));
function dirsFor(name: string) {
  const d = { data: path.join(base, name, "data"), work: path.join(base, name, "work"), kb: path.join(base, name, "kb"), config: path.join(base, name, "config") };
  for (const x of Object.values(d)) mkdirSync(x, { recursive: true });
  return d;
}

const PORT_A = 18970; // board owner
const PORT_B = 18971; // peer instance hosting the remote member
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const RUN_TIMEOUT = 420_000;

function spawnInstance(name: string, dirs: { data: string; work: string; kb: string; config: string }, port: number, token: string, extra: Record<string, string> = {}): ChildProcess {
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
  (proc as any).__log = () => log;
  return proc;
}

const dirsA = dirsFor("a");
const dirsB = dirsFor("b");
// B first (A needs B's URL + token to exist conceptually, though startup order doesn't matter).
const procB = spawnInstance("b", dirsB, PORT_B, TOKEN_B);
const procA = spawnInstance("a", dirsA, PORT_A, TOKEN_A, { BOARD_PEER_TOKENS: `peer-b:${TOKEN_B}` });

const cleanup = () => {
  for (const p of [procA, procB]) {
    try {
      p.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  rmSync(base, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitReady(port: number, token: string): Promise<boolean> {
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 200 && ((await res.json().catch(() => null)) as any)?.ready === true) return true;
    } catch {
      // not up yet
    }
  }
  return false;
}

// ---- boot both instances ----
const [readyA, readyB] = await Promise.all([waitReady(PORT_A, TOKEN_A), waitReady(PORT_B, TOKEN_B)]);
check("board owner (A) ready", readyA, (procA as any).__log().slice(-2000));
check("peer instance (B) ready", readyB, (procB as any).__log().slice(-2000));
if (!readyA || !readyB) process.exit(1);

// ---- create the member conversation on B ----
const created = await api(PORT_B, TOKEN_B, "POST", "/conversations", { name: "remote-member" });
check("member conversation created on B", created.status === 201 && typeof created.json?.id === "number", JSON.stringify(created.json));
if (created.status !== 201) process.exit(1);
const remoteConvId = created.json.id as number;

// ---- deterministic: registration + validation + dashboard ----
const reg = await api(PORT_A, TOKEN_A, "POST", "/board/members", {
  id: "remote-1",
  name: "Remote One",
  endpoint: `http://127.0.0.1:${PORT_B}`,
  tokenRef: "peer-b",
  conversationId: remoteConvId,
});
check("remote member registered (201)", reg.status === 201 && reg.json?.id === "remote-1", JSON.stringify(reg.json));

const board = await api(PORT_A, TOKEN_A, "GET", "/board");
const listed = (board.json?.members ?? []).find((m: any) => m.id === "remote-1");
check("dashboard lists the remote member with endpoint + untrusted tier", Boolean(listed) && listed.endpoint === `http://127.0.0.1:${PORT_B}` && listed.trustLevel === "untrusted", JSON.stringify(listed));

check("register without tokenRef → 400", (await api(PORT_A, TOKEN_A, "POST", "/board/members", { id: "x1", name: "X", endpoint: `http://127.0.0.1:${PORT_B}`, conversationId: 1 })).status === 400);
check("register with bad endpoint → 400", (await api(PORT_A, TOKEN_A, "POST", "/board/members", { id: "x2", name: "X", endpoint: "not a url", tokenRef: "peer-b", conversationId: 1 })).status === 400);

// ---- model step: coordinator routes to the remote member (one corrective retry) ----
const streamA = new Stream(PORT_A, TOKEN_A, 1);
let delivered = false;
for (let round = 1; round <= 2 && !delivered; round++) {
  const content =
    'Use the route_message tool to send the message "hello from the board" to remote-1. You must actually invoke the route_message tool.' +
    (round > 1 ? "\nReminder: your previous reply did not call route_message. Call it now." : "");
  const subRes = await api(PORT_A, TOKEN_A, "POST", "/tasks", { content, requestId: `board-remote-${round}` });
  if (subRes.status !== 202) {
    check(`run ${round} submitted`, false, JSON.stringify(subRes.json));
    continue;
  }
  check(`run ${round} completes`, await streamA.waitForRunEnd(subRes.json.submissionId as number, RUN_TIMEOUT));
  delivered = streamA.toolResultTexts("route_message").some((t) => t.includes("routed message to remote member"));
  if (!delivered) console.log(`(round ${round}: no successful route_message — ${round < 2 ? "retrying" : "giving up"})`);
}
check("coordinator routed the message to the remote member", delivered, streamA.toolResultTexts("route_message").join(" | ").slice(0, 300));

// ---- the peer received it, untrusted-wrapped, in its own transcript ----
// (The exact phrasing is model-controlled; the load-bearing facts are that a
// coordinator-sourced, untrusted-delimited input landed in B's member conversation.)
let seen = false;
let bEntryTexts: string[] = [];
for (let i = 0; i < 30 && !seen; i++) {
  await sleep(2000);
  const entries = ((await api(PORT_B, TOKEN_B, "GET", `/conversations/${remoteConvId}/entries?after=0&limit=300`)).json?.entries ?? []) as any[];
  bEntryTexts = entries.flatMap((e) => (Array.isArray(e.model) ? e.model : []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))));
  seen = bEntryTexts.some((t) => t.includes('<untrusted from="coordinator">') && /board/i.test(t));
}
check("peer transcript contains the coordinator-sourced, untrusted-wrapped message", seen, seen ? undefined : "B entry texts: " + bEntryTexts.map((t) => t.slice(0, 300)).join("\n"));

streamA.close();
if (fail > 0) {
  console.error("\n--- A log tail ---\n" + (procA as any).__log().slice(-3000));
  console.error("\n--- B log tail ---\n" + (procB as any).__log().slice(-3000));
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
