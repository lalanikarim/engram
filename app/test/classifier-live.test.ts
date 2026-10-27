// Phase 5 live integration: classifier-assisted risk scoring end-to-end against the local model.
//
// A bash-gated instance (no auto patterns) with the classifier enabled: a gated bash call must
// produce a pending approval carrying `riskScore` (0..1) and a one-line `riskNote`, and the
// normal approve → retry → executed flow must still work. Classification failures are fail-safe
// (plain prompt tier), so this suite asserts the happy path; if the loaded model drifts and
// answers without calling bash, one corrective round is retried.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Pin DEFAULT_MODEL to whatever the endpoint is ACTUALLY serving. app/.env may pin a stale
// model (loadDotEnv never overwrites existing vars, so this wins), and the Unsloth box can
// swap its loaded model between runs.
const modelsRes = await fetch(`${BASE_URL.replace(/\/+$/, "")}/models`, {
  headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? pocEnv.OPENAI_API_KEY}` },
});
const modelList = (((await modelsRes.json().catch(() => null)) as any)?.data ?? []) as Array<Record<string, unknown>>;
const loadedModel = modelList.find((m) => m.loaded === true);
if (!loadedModel) {
  console.error("no model is currently loaded on the local endpoint — skipping classifier live test");
  process.exit(2);
}
const LOADED_MODEL = String(loadedModel.id);
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

const base = mkdtempSync(path.join(tmpdir(), "engram-classifier-"));
const dirs = { data: path.join(base, "data"), work: path.join(base, "work"), kb: path.join(base, "kb"), config: path.join(base, "config") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

// bash at prompt tier with NO auto patterns → every bash call goes through the classifier.
writeFileSync(
  path.join(dirs.config, "gates.json"),
  JSON.stringify({ tiers: [{ tool: "bash", default: "prompt" }], classifier: { enabled: true, timeoutMs: 60_000 } }),
);

const TOKEN = "test-token";
const BASE = "http://127.0.0.1:18940";
const RUN_TIMEOUT = 300_000;

async function api(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON response
  }
  return { status: res.status, json };
}

async function submit(content: string, requestId: string): Promise<number> {
  const r = await api("POST", "/tasks", { content, requestId });
  if (r.status !== 202) throw new Error(`submit failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.submissionId;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

type StreamEvent = { event: string; data: any };
class Stream {
  private controller = new AbortController();
  events: StreamEvent[] = [];
  private waiters: Array<() => void> = [];

  constructor(conversationId: number) {
    const url = `${BASE}/stream?conversationId=${conversationId}&cursor=0`;
    (async () => {
      const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` }, signal: this.controller.signal });
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
      let buf = "";
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) {
            try {
              this.events.push({ event, data: JSON.parse(data) });
            } catch {
              // keep raw frames out of the typed stream
            }
            for (const w of this.waiters.splice(0)) w();
          }
        }
      }
    })().catch(() => {});
  }

  close(): void {
    this.controller.abort();
  }

  async waitFor(pred: (e: StreamEvent) => boolean, timeoutMs: number): Promise<StreamEvent | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) return undefined;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async waitForRunEnd(submissionId: number, timeoutMs: number): Promise<boolean> {
    const ev = await this.waitFor(
      (e) => e.event === "event" && e.data.type === "run_end" && Array.isArray(e.data.inputs) && e.data.inputs.includes(submissionId),
      timeoutMs,
    );
    return ev !== undefined;
  }

  toolResultTexts(toolName?: string): string[] {
    return this.events
      .filter((e) => e.event === "entry" && e.data.summary?.role === "toolResult" && (!toolName || e.data.summary.toolName === toolName))
      .map((e) => e.data.summary.textPreview ?? "");
  }
}

const proc = spawn("node", [path.join(APP_ROOT, "src", "main.ts")], {
  env: {
    ...process.env,
    OPENAI_BASE_URL: BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? pocEnv.OPENAI_API_KEY,
    DEFAULT_MODEL: `aurora:${LOADED_MODEL}`,
    API_TOKEN: TOKEN,
    HOST: "127.0.0.1",
    PORT: "18940",
    DATA_DIR: dirs.data,
    WORK_ROOT: dirs.work,
    KB_DIR: dirs.kb,
    CONFIG_DIR: dirs.config,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
proc.stdout?.on("data", (d) => (serverLog += String(d)));
proc.stderr?.on("data", (d) => (serverLog += String(d)));

const cleanup = () => {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already gone
  }
  rmSync(base, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

// ---- wait for ready ----
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(1000);
  try {
    const res = await fetch(`${BASE}/ready`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (res.status === 200 && ((await res.json().catch(() => null)) as any)?.ready === true) ready = true;
  } catch {
    // not up yet
  }
}
check("server ready", ready, serverLog.slice(-2000));
if (!ready) process.exit(1);

const stream = new Stream(1);

// ---- gated bash call → classified pending approval (one corrective retry for model drift) ----
let item: any = undefined;
for (let round = 1; round <= 2 && !item; round++) {
  const content =
    "Use the bash tool to run exactly this command: `date +%Y`. You must actually invoke the bash tool — do not answer from memory. Reply with only its output." +
    (round > 1 ? "\nReminder: your previous reply did not call the bash tool. Call it now." : "");
  const sub = await submit(content, `classifier-live-${round}`);
  check(`run ${round} completes`, await stream.waitForRunEnd(sub, RUN_TIMEOUT));
  const blockedBash = stream.toolResultTexts("bash").some((t) => t.includes("BLOCKED"));
  if (!blockedBash) {
    console.log(`(round ${round}: no gated bash call — model drift; ${round < 2 ? "retrying" : "giving up"})`);
    continue;
  }
  const appr = await api("GET", "/approvals");
  item = (appr.json?.approvals ?? []).find((a: any) => a.tool === "bash");
}
check("gated bash call produced a pending approval", Boolean(item), JSON.stringify(item));
if (!item) {
  console.error("\n--- server log tail ---\n" + serverLog.slice(-3000));
  process.exit(1);
}

check("classifier attached a risk score in [0,1]", typeof item.riskScore === "number" && item.riskScore >= 0 && item.riskScore <= 1, `riskScore=${String(item.riskScore)}`);
check("classifier attached a one-line risk note", typeof item.riskNote === "string" && item.riskNote.length > 0, `riskNote=${String(item.riskNote).slice(0, 200)}`);
check("benign command stayed at prompt tier (no false escalation)", item.tier === "prompt", `tier=${item.tier}`);

// ---- approve → retry → executed once ----
const dec = await api("POST", `/approvals/${item.key}`, { decision: "approved" });
check("approval recorded", dec.status === 200, JSON.stringify(dec.json));

const subRetry = await submit(
  `The human has APPROVED action key ${item.key}. Retry bash with the exact same arguments (date +%Y) and reply with only its output.`,
  "classifier-live-retry",
);
check("retry run completes", await stream.waitForRunEnd(subRetry, RUN_TIMEOUT));
check(
  "command executed after approval (output in transcript)",
  stream.toolResultTexts("bash").some((t) => t.includes("2026")),
);

stream.close();
if (fail > 0) console.error("\n--- server log tail ---\n" + serverLog.slice(-4000));
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
