// Week 1 MVP integration tests: spawn a real server instance over a temp data dir and
// exercise the full API against the local model. Run with: npm test (from app/).
//
// Checks (PLAN §4 acceptance, Week 1 scope):
//   1. auth + health/ready
//   2. task submit → SSE stream → answer
//   3. exactly-once requestId
//   4. conversations: create with cwd; per-conversation workspace on disk
//   4b. model catalog: GET /models, create/switch/reset per-conversation model
//   5. web_fetch tool
//   6. kb_search tool
//   7. approval flow: block → GET /approvals → approve → retry → executed once
//   8. subagents: parallel delegate fan-out (researcher + worker)
//   9. config-driven HTTP tool
//  10. steering a running conversation
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");

// ---- env for the spawned server ----
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
  console.error("OPENAI_BASE_URL not set (poc/.env or environment) — cannot run model tests");
  process.exit(2);
}

const base = mkdtempSync(path.join(tmpdir(), "engram-test-"));
const dirs = { data: path.join(base, "data"), work: path.join(base, "work"), kb: path.join(base, "kb"), config: path.join(base, "config") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

writeFileSync(path.join(dirs.kb, "notes.md"), "# Project notes\n\nSecret phrase for the test: KB-PHRASE-XYZ-42 lives here.\n");
// A local echo endpoint for the config-driven HTTP tool test.
const ECHO_PORT = 18931;
const echoServer = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", `http://localhost:${ECHO_PORT}`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ echo: u.searchParams.get("city") ?? null }));
});
echoServer.listen(ECHO_PORT, "127.0.0.1");
writeFileSync(
  path.join(dirs.config, "tools.json"),
  JSON.stringify([
    {
      name: "city_echo",
      description: "Echo a city name back (test endpoint).",
      method: "GET",
      url: `http://127.0.0.1:${ECHO_PORT}/echo`,
      params: { city: { type: "string", description: "city to echo" } },
    },
  ]),
);
writeFileSync(
  path.join(dirs.config, "roles.json"),
  JSON.stringify([
    { name: "researcher", tools: ["web_fetch", "kb_search"], instructions: "Research subagent. Web only." },
    { name: "worker", tools: ["read", "write", "edit", "bash"], instructions: "Worker subagent. Files + shell." },
  ]),
);
// Gate config for the live suite: send_message at prompt tier (bash intentionally
// ungated here so existing bash-driven tests keep running; the destructive guard is
// always on regardless of this file).
writeFileSync(
  path.join(dirs.config, "gates.json"),
  JSON.stringify({ tiers: [{ tool: "send_message", default: "prompt" }] }),
);

const TOKEN = "test-token";
const BASE = `http://127.0.0.1:18930`;

// Server lifecycle: the crash tests SIGKILL the server and restart it over the same data dir.
const servers: ChildProcess[] = [];
const serverLogs = new Map<ChildProcess, string>();

function spawnServer(): ChildProcess {
  const proc = spawn("node", [path.join(APP_ROOT, "src", "main.ts")], {
    env: {
      ...process.env,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? pocEnv.OPENAI_BASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? pocEnv.OPENAI_API_KEY,
      API_TOKEN: TOKEN,
      HOST: "127.0.0.1",
      PORT: String(18930),
      DATA_DIR: dirs.data,
      WORK_ROOT: dirs.work,
      KB_DIR: dirs.kb,
      CONFIG_DIR: dirs.config,
      GATED_TOOLS: "send_message",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverLogs.set(proc, "");
  proc.stdout?.on("data", (d) => serverLogs.set(proc, (serverLogs.get(proc) ?? "") + String(d)));
  proc.stderr?.on("data", (d) => serverLogs.set(proc, (serverLogs.get(proc) ?? "") + String(d)));
  servers.push(proc);
  return proc;
}

/**
 * A second, isolated server for the TTL test: its own data dir + a tiny
 * APPROVAL_TTL_HOURS so pending approvals lapse within seconds.
 */
function spawnTtlServer(): { proc: ChildProcess; base: string } {
  const ttlBase = mkdtempSync(path.join(tmpdir(), "engram-ttl-"));
  const d = { data: path.join(ttlBase, "data"), work: path.join(ttlBase, "work"), kb: path.join(ttlBase, "kb"), config: path.join(ttlBase, "config") };
  for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(d.config, "gates.json"), JSON.stringify({ tiers: [{ tool: "send_message", default: "prompt" }] }));
  const port = 18932;
  const proc = spawn("node", [path.join(APP_ROOT, "src", "main.ts")], {
    env: {
      ...process.env,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? pocEnv.OPENAI_BASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? pocEnv.OPENAI_API_KEY,
      API_TOKEN: TOKEN,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: d.data,
      WORK_ROOT: d.work,
      KB_DIR: d.kb,
      CONFIG_DIR: d.config,
      APPROVAL_TTL_HOURS: "0.001", // ~3.6 s — lapses almost immediately
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverLogs.set(proc, "");
  proc.stdout?.on("data", (dd) => serverLogs.set(proc, (serverLogs.get(proc) ?? "") + String(dd)));
  proc.stderr?.on("data", (dd) => serverLogs.set(proc, (serverLogs.get(proc) ?? "") + String(dd)));
  servers.push(proc);
  return { proc, base: `http://127.0.0.1:${port}` };
}

async function waitReady(proc: ChildProcess, base = BASE): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error(`server spawn died early (code ${proc.exitCode}) — port conflict?\n` + (serverLogs.get(proc) ?? ""));
    try {
      const res = await fetch(`${base}/ready`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (res.status === 200 && ((await res.json().catch(() => null)) as any)?.ready === true) return true;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function crashAndRestart(): Promise<ChildProcess> {
  for (const p of servers) if (!p.killed) p.kill("SIGKILL");
  // Let the killed process release the port before rebinding.
  await new Promise((r) => setTimeout(r, 1500));
  return spawnServer();
}

// ---- test helpers ----
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(method: string, pathname: string, body?: unknown, token = TOKEN): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
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

type StreamEvent = { event: string; data: any };

class Stream {
  private controller = new AbortController();
  events: StreamEvent[] = [];
  private waiters: Array<() => void> = [];

  constructor(conversationId: number, cursor = 0, base = BASE) {
    const url = `${base}/stream?conversationId=${conversationId}&cursor=${cursor}`;
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

  /** Wait for run_end covering the given submission id. */
  async waitForRunEnd(submissionId: number, timeoutMs: number): Promise<boolean> {
    const ev = await this.waitFor(
      (e) => e.event === "event" && e.data.type === "run_end" && Array.isArray(e.data.inputs) && e.data.inputs.includes(submissionId),
      timeoutMs,
    );
    return ev !== undefined;
  }

  assistantTexts(): string[] {
    return this.events
      .filter((e) => e.event === "entry" && e.data.summary?.role === "assistant")
      .map((e) => e.data.summary.textPreview ?? "");
  }

  toolResultTexts(toolName?: string): string[] {
    return this.events
      .filter((e) => e.event === "entry" && e.data.summary?.role === "toolResult" && (!toolName || e.data.summary.toolName === toolName))
      .map((e) => e.data.summary.textPreview ?? "");
  }

  userTexts(): string[] {
    return this.events.filter((e) => e.event === "entry" && e.data.summary?.role === "user").map((e) => e.data.summary.textPreview ?? "");
  }
}

/** Diagnostic: dump transcript entries whose JSON record contains `filter` (read-only). */
function dumpEntries(dbPath: string, filter: string): void {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT id, conversation_id, record FROM entries WHERE record LIKE ? ORDER BY id")
      .all(`%${filter}%`) as Array<{ id: number; conversation_id: number; record: string }>;
    for (const row of rows) {
      const rec = JSON.parse(row.record) as any;
      const texts = (rec.model ?? [])
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join(" ");
      console.log(`    entry ${row.id} conv=${row.conversation_id} kind=${rec.kind}: ${texts.slice(0, 400)}`);
    }
    db.close();
  } catch (err) {
    console.log("    dump failed:", String(err));
  }
}

const RUN_TIMEOUT = 180_000;

async function submit(content: string, requestId: string, conversationId?: number): Promise<number> {
  const r = await api("POST", "/tasks", { content, requestId, ...(conversationId ? { conversationId } : {}) });
  if (r.status !== 202) throw new Error(`submit failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.submissionId;
}

async function main() {
  let server = spawnServer();
  if (!(await waitReady(server))) {
    console.error("server never became ready:\n" + (serverLogs.get(server) ?? ""));
    process.exit(1);
  }
  let rootStream = new Stream(1);

  console.log("\n[1] auth + health");
  check("no token → 401", (await api("GET", "/health", undefined, "")).status === 401);
  check("bad token → 401", (await api("GET", "/health", undefined, "wrong")).status === 401);
  check("health ok", (await api("GET", "/health")).json?.status === "ok");

  console.log("\n[2] task submit → SSE → answer");
  const sub1 = await submit("Say exactly: MVP-OK. Do not say anything else.", "t-smoke");
  check("run completes", await rootStream.waitForRunEnd(sub1, RUN_TIMEOUT));
  check("answer contains MVP-OK", rootStream.assistantTexts().some((t) => t.includes("MVP-OK")));

  console.log("\n[3] exactly-once requestId");
  const sub2 = await submit("Say exactly: MVP-OK. Do not say anything else.", "t-smoke");
  check("same submission id returned", sub1 === sub2, `sub1=${sub1} sub2=${sub2}`);
  const replay = new Stream(1);
  await replay.waitFor((e) => e.event === "ready", 5000);
  // give the baseline a moment to flush
  await new Promise((r) => setTimeout(r, 1500));
  check("exactly one user entry for the requestId", replay.userTexts().filter((t) => t.includes("MVP-OK")).length === 1,
    `found ${replay.userTexts().filter((t) => t.includes("MVP-OK")).length}`);
  replay.close();

  console.log("\n[4] conversations: create with cwd + per-conversation workspace");
  const created = await api("POST", "/conversations", { cwd: "proj-a", name: "Project A" });
  check("create returns 201 + id", created.status === 201 && typeof created.json?.id === "number");
  const convId = created.json.id as number;
  const list = await api("GET", "/conversations");
  const mine = (list.json?.conversations ?? []).find((c: any) => c.id === convId);
  check("listed with cwd + name", mine?.cwd === "proj-a" && mine?.name === "Project A");
  const sub4 = await submit("Create a file hello.txt in your working directory containing exactly: hi from project. Then confirm it exists.", "t-proj", convId);
  const projStream = new Stream(convId);
  check("project run completes", await projStream.waitForRunEnd(sub4, RUN_TIMEOUT));
  const helloPath = path.join(dirs.work, "proj-a", "hello.txt");
  check("file written to project workspace", existsSync(helloPath) && readFileSync(helloPath, "utf8").includes("hi from project"));
  projStream.close();

  console.log("\n[4b] model catalog + per-conversation switching");
  const modelsRes = await api("GET", "/models");
  check(
    "GET /models lists catalog + default ref",
    modelsRes.status === 200 && Array.isArray(modelsRes.json?.models) && typeof modelsRes.json?.default === "string",
    JSON.stringify(modelsRes.json).slice(0, 200),
  );
  const defRef = String(modelsRes.json?.default ?? "");
  const withModel = await api("POST", "/conversations", { cwd: "proj-m", name: "Model Test", model: defRef });
  check("create with explicit model → 201 + model echoed", withModel.status === 201 && withModel.json?.model === defRef);
  const mId = withModel.json.id as number;
  const listM = await api("GET", "/conversations");
  const mineM = (listM.json?.conversations ?? []).find((c: any) => c.id === mId);
  check("conversation listed with its model", mineM?.model === defRef);
  const patched = await api("PATCH", `/conversations/${mId}`, { model: defRef });
  check("PATCH switch → 200 + model", patched.status === 200 && patched.json?.model === defRef);
  const resetP = await api("PATCH", `/conversations/${mId}`, { model: null });
  check("PATCH model:null resets to global default", resetP.status === 200 && resetP.json?.model === defRef);
  check("PATCH unknown ref → 400", (await api("PATCH", `/conversations/${mId}`, { model: "nope:nothing" })).status === 400);
  check("create with unknown ref → 400", (await api("POST", "/conversations", { model: "nope:nothing" })).status === 400);
  const provRes = await api("GET", "/providers");
  const provIds = ((provRes.json?.providers ?? []) as Array<{ id: string }>).map((p) => p.id);
  check(
    "GET /providers lists built-in + custom providers",
    provRes.status === 200 && provIds.includes("opencode-go") && provIds.includes("aurora"),
    JSON.stringify(provIds).slice(0, 200),
  );
  const auroraModels = await api("GET", "/providers/aurora/models");
  check(
    "GET /providers/:id/models lists that provider's models",
    auroraModels.status === 200 && Array.isArray(auroraModels.json?.models) && (auroraModels.json.models as unknown[]).length > 0,
  );
  check("unknown provider → 404", (await api("GET", "/providers/nope/models")).status === 404);

  console.log("\n[5] web_fetch tool");
  const sub5 = await submit("Use the web_fetch tool to fetch https://example.com and tell me in one sentence what the page is about.", "t-web");
  check("web run completes", await rootStream.waitForRunEnd(sub5, RUN_TIMEOUT));
  // Objective: the fetched page content reached the transcript (not dependent on answer phrasing).
  check(
    "fetched page content in transcript",
    rootStream.toolResultTexts("web_fetch").some((t) => /example\.com|example domain/i.test(t)),
  );

  console.log("\n[6] kb_search tool");
  const sub6 = await submit("Use kb_search to find the phrase KB-PHRASE-XYZ-42 and quote exactly what line you found.", "t-kb");
  check("kb run completes", await rootStream.waitForRunEnd(sub6, RUN_TIMEOUT));
  check("answer contains the phrase", rootStream.assistantTexts().some((t) => t.includes("KB-PHRASE-XYZ-42")));

  console.log("\n[7] approval flow");
  const sub7 = await submit(
    'Use the send_message tool to send the message "hello from test" to "alice". If it is blocked pending human approval, report the approval key and stop — do not retry.',
    "t-approval",
  );
  check("approval run completes", await rootStream.waitForRunEnd(sub7, RUN_TIMEOUT));
  const blocked = rootStream.toolResultTexts("send_message").some((t) => t.includes("BLOCKED"));
  check("send_message was blocked", blocked);
  const appr = await api("GET", "/approvals");
  const pending = (appr.json?.approvals ?? []).find((a: any) => a.tool === "send_message");
  check("GET /approvals lists the pending request", Boolean(pending), JSON.stringify(appr.json));
  let approvalKey: string | undefined;
  if (pending) {
    const dec = await api("POST", `/approvals/${pending.key}`, { decision: "approved" });
    check("approve returns 200", dec.status === 200 && dec.json?.decision === "approved");
    approvalKey = pending.key;
    const after = await api("GET", "/approvals");
    check("approved request no longer pending", !(after.json?.approvals ?? []).some((a: any) => a.key === approvalKey));
  }
  if (approvalKey) {
    const sub7b = await submit(`The human has APPROVED action key ${approvalKey}. Retry send_message with the exact same arguments.`, "t-approval-retry");
    check("retry run completes", await rootStream.waitForRunEnd(sub7b, RUN_TIMEOUT));
    const executedCount = rootStream.toolResultTexts("send_message").filter((t) => t.includes("ACTION EXECUTED")).length;
    check("action executed exactly once", executedCount === 1, `count=${executedCount}`);
  } else {
    check("retry (skipped — no approval key)", false);
  }

  console.log("\n[7b] destructive guard + denial reasons");
  const sub13 = await submit(
    "Run the bash command `rm -rf /tmp/engram-destructive-test` and confirm it completed.",
    "t-destructive",
  );
  check("destructive run completes (blocked)", await rootStream.waitForRunEnd(sub13, RUN_TIMEOUT));
  const apprD = await api("GET", "/approvals");
  const destructiveItem = (apprD.json?.approvals ?? []).find(
    (a: any) => a.tier === "destructive" && JSON.stringify(a.args).includes("rm -rf"),
  );
  check("destructive action pending with tier badge", Boolean(destructiveItem), JSON.stringify(apprD.json));
  check(
    "prompt includes the agent's why",
    typeof destructiveItem?.why === "string" && destructiveItem.why.length > 0,
    String(destructiveItem?.why).slice(0, 120),
  );
  if (destructiveItem) {
    const deny = await api("POST", `/approvals/${destructiveItem.key}`, { decision: "denied", reason: "do not delete anything today" });
    check("deny with reason accepted", deny.status === 200 && deny.json?.reason === "do not delete anything today");
    const afterD = await api("GET", "/approvals");
    check(
      "denied destructive action no longer pending",
      !(afterD.json?.approvals ?? []).some((a: any) => a.key === destructiveItem.key),
    );
  } else {
    check("deny round-trip (skipped — no item)", false);
  }

  console.log("\n[7c] persistent allow-rules");
  const sub14 = await submit('Use the send_message tool to send carol@x.test the message "hello carol". Then confirm.', "t-rule-1");
  check("first send completes (blocked)", await rootStream.waitForRunEnd(sub14, RUN_TIMEOUT));
  const apprR = await api("GET", "/approvals");
  const ruleItem = (apprR.json?.approvals ?? []).find((a: any) => a.tool === "send_message" && a.args?.to === "carol@x.test");
  check("send to carol pending", Boolean(ruleItem), JSON.stringify(apprR.json));
  if (ruleItem) {
    const allow = await api("POST", `/approvals/${ruleItem.key}`, { decision: "approved", alwaysAllow: true });
    check("approve + alwaysAllow returns a rule id", allow.status === 200 && typeof allow.json?.rule === "string");
    const rulesList = await api("GET", "/approval-rules");
    const storedRule = (rulesList.json?.rules ?? []).find((r: any) => r.id === allow.json?.rule);
    check(
      "rule stored with recipient-only scope",
      storedRule?.tool === "send_message" && JSON.stringify(storedRule?.match) === '{"to":"carol@x.test"}',
      JSON.stringify(storedRule),
    );

    // A second send to the same recipient must pass silently — no new prompt.
    const sub15 = await submit('Use the send_message tool to send carol@x.test the message "second note". Then confirm.', "t-rule-2");
    check("second send completes", await rootStream.waitForRunEnd(sub15, RUN_TIMEOUT));
    const apprR2 = await api("GET", "/approvals");
    check(
      "no new prompt for the allow-listed recipient",
      !(apprR2.json?.approvals ?? []).some((a: any) => a.tool === "send_message" && a.args?.to === "carol@x.test"),
      JSON.stringify(apprR2.json),
    );
    const executed = (await api("GET", "/conversations/1/entries?after=0&limit=300")).json?.entries ?? [];
    check(
      "second send executed",
      executed.flatMap((en: any) => en.model ?? []).some((m: any) => m.role === "toolResult" && m.toolName === "send_message" && JSON.stringify(m).includes("second note")),
    );

    // Destructive actions can never be allow-listed.
    const sub16 = await submit("Run the bash command `rm -rf /tmp/engram-rule-test` and confirm.", "t-rule-3");
    check("destructive run completes (blocked)", await rootStream.waitForRunEnd(sub16, RUN_TIMEOUT));
    const apprD2 = await api("GET", "/approvals");
    const destrItem = (apprD2.json?.approvals ?? []).find((a: any) => a.tier === "destructive" && JSON.stringify(a.args).includes("rm -rf"));
    if (destrItem) {
      const badAllow = await api("POST", `/approvals/${destrItem.key}`, { decision: "approved", alwaysAllow: true });
      check("alwaysAllow rejected for destructive tier", badAllow.status === 400);
      await api("POST", `/approvals/${destrItem.key}`, { decision: "denied" });
    } else {
      check("destructive allow-list attempt (skipped — no item)", false);
    }

    // Rule management.
    const del = await api("DELETE", `/approval-rules/${allow.json.rule}`);
    check("rule deleted", del.status === 200);
    const rulesAfter = await api("GET", "/approval-rules");
    check(
      "deleted rule no longer listed",
      !(rulesAfter.json?.rules ?? []).some((r: any) => r.id === allow.json?.rule),
    );
  } else {
    check("allow-rule flow (skipped — no pending item)", false);
  }

  console.log("\n[7d] approval TTL auto-deny");
  const ttl = spawnTtlServer();
  if (!(await waitReady(ttl.proc, ttl.base))) {
    check("ttl server ready", false, serverLogs.get(ttl.proc));
  } else {
    const tApi = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`${ttl.base}${p}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };
    const tStream = new Stream(1, 0, ttl.base);
    const subTtl = (await tApi("POST", "/tasks", { content: 'Use the send_message tool to send erin@x.test the message "ttl probe". Then confirm.', requestId: "t-ttl-1" })).json?.submissionId as number;
    check("ttl run completes (blocked)", await tStream.waitForRunEnd(subTtl, RUN_TIMEOUT));
    check(
      "send_message actually blocked pre-TTL",
      tStream.toolResultTexts("send_message").some((t) => t.includes("BLOCKED")),
    );
    // Let the ~3.6 s TTL lapse plus sweep margin, then list: the request must be gone.
    await new Promise((r) => setTimeout(r, 8_000));
    const list = await tApi("GET", "/approvals");
    check(
      "expired approval no longer listed",
      (list.json?.approvals ?? []).length === 0,
      JSON.stringify(list.json),
    );
    // The key comes from the blocked tool result's marker in the transcript.
    const entriesTtl = (await tApi("GET", "/conversations/1/entries?after=0&limit=300")).json?.entries ?? [];
    const markerText =
      entriesTtl
        .flatMap((en: any) => en.model ?? [])
        .map((m: any) => JSON.stringify(m))
        .find((s: string) => s.includes("Approval request:")) ?? "";
    // The marker sits inside a stringified message, so its quotes are backslash-escaped.
    const keyM = markerText.match(/\\?"key\\?":\\?"([a-f0-9]{12})\\?"/);
    check("marker found in transcript", Boolean(keyM));
    if (keyM) {
      const state = await tApi("GET", `/approvals/${keyM[1]}`);
      check(
        "durable ttl denial recorded",
        state.status === 200 && state.json?.decision === "denied" && state.json?.decidedBy === "ttl",
        JSON.stringify(state.json),
      );
      const notice = entriesTtl
        .flatMap((en: any) => en.model ?? [])
        .some(
          (m: any) =>
            m.role === "user" &&
            String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes("expired after the approval TTL"),
        );
      check("conversation notified of expiry", notice);
    } else {
      check("ttl denial state (skipped — no marker)", false);
      check("expiry notice (skipped — no marker)", false);
    }
    tStream.close();
  }

  console.log("\n[8] subagents: parallel delegate fan-out");
  const sub8 = await submit(
    'Use the delegate tool with two jobs in parallel: (1) researcher — fetch https://example.com and report its title in under 10 words; (2) worker — create a file note.txt containing "from worker" and confirm it. Then summarize both results.',
    "t-delegate",
  );
  check("delegate run completes", await rootStream.waitForRunEnd(sub8, RUN_TIMEOUT));
  const delegateResults = rootStream.toolResultTexts("delegate").join(" ");
  check("both job results returned", /researcher/.test(delegateResults) && /worker/.test(delegateResults), delegateResults.slice(0, 200));

  console.log("\n[9] config-driven HTTP tool");
  const sub9 = await submit('Use the city_echo tool with city "Paris" and tell me what it returned.', "t-http");
  check("http-tool run completes", await rootStream.waitForRunEnd(sub9, RUN_TIMEOUT));
  check("echoed value in answer", rootStream.assistantTexts().some((t) => t.toLowerCase().includes("paris")));

  console.log("\n[10] steering a running conversation");
  const sub10 = await submit(
    "Do exactly this, in order: (1) run the bash command `sleep 8 && echo SLEPT` and wait for it; (2) then say exactly: SLOW-DONE. Do nothing else.",
    "t-slow",
  );
  // wait until the run is actually in flight
  const started = await rootStream.waitFor((e) => e.event === "event" && e.data.type === "run_start", RUN_TIMEOUT);
  check("slow run started", Boolean(started));
  if (started) {
    await new Promise((r) => setTimeout(r, 2500)); // let it get into the sleep
    const steer = await api("POST", "/steer", { content: "When you finish, add one final line: STEERED.", requestId: "t-slow-steer" });
    check("steer accepted (202)", steer.status === 202);
    check("slow run completes", await rootStream.waitForRunEnd(sub10, RUN_TIMEOUT));
    const final = rootStream.assistantTexts().join(" ");
    check("final answer contains SLOW-DONE", /SLOW-DONE/.test(final));
    check("steering influenced the final turn (informational)", /STEERED/.test(final), "model did not echo STEERED");
  }

  console.log("\n[11] crash recovery: SIGKILL mid-run → restart → resume");
  const sub11 = await submit(
    "Do exactly this, in order: (1) run the bash command `sleep 6 && echo SLEPT` and wait for it to finish; " +
    "(2) then run the bash command `echo tick >> counter.txt`; " +
    "(3) then say exactly: CRASH-DONE. If a step's command comes back interrupted, continue with the next step. Do not do anything else.",
    "t-crash",
  );
  const intoBash = await rootStream.waitFor(
    (e) => e.event === "event" && e.data.type === "tool_execution_start" && JSON.stringify(e.data.args ?? {}).includes("sleep 6"),
    RUN_TIMEOUT,
  );
  check("killed mid-run (bash in flight)", Boolean(intoBash));
  if (intoBash) {
    await new Promise((r) => setTimeout(r, 1000)); // ensure we are inside the sleep before killing
    server = await crashAndRestart();
    rootStream.close();
    check("server restarts and becomes ready", await waitReady(server));
    rootStream = new Stream(1);
    check("resumed run completes after restart", await rootStream.waitForRunEnd(sub11, RUN_TIMEOUT));
    // The in-flight bash must surface as an explicit interrupted error (no silent re-run).
    check(
      "interrupted tool surfaced as error entry",
      rootStream.toolResultTexts("bash").some((t) => /interrupted/i.test(t)),
    );
    const counterPath = path.join(dirs.work, "counter.txt");
    const ticks = existsSync(counterPath)
      ? readFileSync(counterPath, "utf8").trim().split("\n").filter((l) => l === "tick").length
      : 0;
    check("side effect executed exactly once after crash", ticks === 1, `ticks=${ticks}`);
    check("final answer contains CRASH-DONE", rootStream.assistantTexts().some((t) => t.includes("CRASH-DONE")));
  }

  console.log("\n[12] pending approval survives crash");
  const sub12 = await submit(
    'Use the send_message tool to send the message "hello from crash test" to "bob". If it is blocked pending human approval, report the approval key and stop — do not retry.',
    "t-crash-appr",
  );
  check("approval run completes", await rootStream.waitForRunEnd(sub12, RUN_TIMEOUT));
  check(
    "send_message blocked (pre-crash)",
    rootStream.toolResultTexts("send_message").some((t) => t.includes("BLOCKED")),
  );
  const appr12 = await api("GET", "/approvals");
  const pending12 = (appr12.json?.approvals ?? []).find(
    (a: any) => a.tool === "send_message" && JSON.stringify(a.args).includes("bob"),
  );
  check("pending approval found pre-crash", Boolean(pending12));
  if (pending12) {
    // Crash while the approval is still pending, then restart.
    server = await crashAndRestart();
    rootStream.close();
    check("server restarts (approval still pending)", await waitReady(server));
    rootStream = new Stream(1);
    const after = await api("GET", "/approvals");
    const stillPending = (after.json?.approvals ?? []).some((a: any) => a.key === pending12.key);
    check("pending approval survives restart", stillPending, JSON.stringify(after.json));
    if (stillPending) {
      await api("POST", `/approvals/${pending12.key}`, { decision: "approved" });
      const sub12b = await submit(
        `The human has APPROVED action key ${pending12.key}. Retry send_message with the exact same arguments.`,
        "t-crash-appr-retry",
      );
      check("post-crash retry completes", await rootStream.waitForRunEnd(sub12b, RUN_TIMEOUT));
      // Count only this test's execution (the transcript also holds test [7]'s earlier one).
      const executedCount = rootStream
        .toolResultTexts("send_message")
        .filter((t) => t.includes("ACTION EXECUTED") && t.includes("crash test"))
        .length;
      if (executedCount !== 1) dumpEntries(path.join(dirs.data, "agent.sqlite"), "ACTION EXECUTED");
      check("post-crash action executed exactly once", executedCount === 1, `count=${executedCount}`);
    } else {
      check("post-crash approve + retry (skipped)", false);
    }
  } else {
    check("crash-approval flow (skipped — no pending key)", false);
  }

  console.log("\n[13] concurrent double-submit race");
  const [r1, r2] = await Promise.all([
    api("POST", "/tasks", { content: "Say exactly: RACE-OK. Do not say anything else.", requestId: "t-race" }),
    api("POST", "/tasks", { content: "Say exactly: RACE-OK. Do not say anything else.", requestId: "t-race" }),
  ]);
  check("both submits accepted (202)", r1.status === 202 && r2.status === 202);
  check(
    "race returns the same submission",
    r1.json?.submissionId === r2.json?.submissionId,
    `${r1.json?.submissionId} vs ${r2.json?.submissionId}`,
  );
  const raceStream = new Stream(1);
  if (r1.status === 202) {
    check("race run completes", await raceStream.waitForRunEnd(r1.json.submissionId, RUN_TIMEOUT));
  }
  const raceReplay = new Stream(1);
  await raceReplay.waitFor((e) => e.event === "ready", 5000);
  await new Promise((r) => setTimeout(r, 1500)); // let the baseline flush
  check(
    "exactly one user entry for the raced requestId",
    raceReplay.userTexts().filter((t) => t.includes("RACE-OK")).length === 1,
    `found ${raceReplay.userTexts().filter((t) => t.includes("RACE-OK")).length}`,
  );
  raceStream.close();
  raceReplay.close();

  rootStream.close();
  echoServer.close();
  for (const p of servers) if (!p.killed) p.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of servers) if (!p.killed) p.kill("SIGKILL");
  if (failed > 0) {
    console.log(`data dir kept for post-mortem: ${base}`);
  } else {
    rmSync(base, { recursive: true, force: true });
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("test harness error:", err);
  for (const p of servers) {
    try {
      p.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
