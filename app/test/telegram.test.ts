// Telegram client integration tests (PLAN §4 D8–9): a real app server + an in-process
// TelegramClient pointed at a mock Bot API. Exercises:
//   T1 chat binding → task → progress edits → final answer
//   T2 access control (foreign user rejected)
//   T3 gated action → inline approval button → callback → settle UI → retry → executed once
//   T4 forum topic → fork of root conversation, answered in the topic thread
//   T5 durable state file (bindings + offset)
//   T6 /model picker: provider buttons → model buttons → durable switch
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "../src/telegram.ts";

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
if (!process.env.OPENAI_BASE_URL && !pocEnv.OPENAI_BASE_URL) {
  console.error("OPENAI_BASE_URL not set (poc/.env or environment) — cannot run model tests");
  process.exit(2);
}

const base = mkdtempSync(path.join(tmpdir(), "engram-tg-"));
const dirs = { data: path.join(base, "data"), work: path.join(base, "work"), kb: path.join(base, "kb"), config: path.join(base, "config") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
// Hermetic agent dir for the model catalog: one deterministic custom provider
// (T6 exercises it without depending on the global ~/.pi/agent config).
const agentDir = path.join(base, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({ providers: { testbox: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", models: [{ id: "model-a" }, { id: "model-b" }] } } }),
);

const TOKEN = "tg-test-token";
const APP_PORT = 18950;
const MOCK_PORT = 18960;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const RUN_TIMEOUT_MS = 180_000;

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

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ---- mock Telegram Bot API ----

interface MockUpdate {
  update_id: number;
  message?: Record<string, unknown>;
  callback_query?: Record<string, unknown>;
}

const queue: MockUpdate[] = [];
const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
let nextMessageId = 1000;

function enqueue(update: MockUpdate): void {
  queue.push(update);
}

const mock = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", `http://localhost:${MOCK_PORT}`);
  const method = u.pathname.replace(/^\//, "");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const payload = body ? JSON.parse(body) : {};
    if (method === "getUpdates") {
      // Real Bot API: return waiting updates, else block until timeout. We just drain or wait briefly.
      if (queue.length > 0) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: queue.splice(0) }));
      } else {
        await new Promise((r) => setTimeout(r, 1500));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: [] }));
      }
      return;
    }
    sent.push({ method, payload });
    const result = method === "sendMessage" ? { message_id: ++nextMessageId } : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  });
});

function findSent(method: string, pred: (p: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  return sent.find((s) => s.method === method && pred(s.payload))?.payload;
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = RUN_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---- app server ----

const proc = spawn("node", [path.join(APP_ROOT, "src", "main.ts")], {
  env: {
    ...process.env,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? pocEnv.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? pocEnv.OPENAI_API_KEY,
    API_TOKEN: TOKEN,
    HOST: "127.0.0.1",
    PORT: String(APP_PORT),
    DATA_DIR: dirs.data,
    WORK_ROOT: dirs.work,
    KB_DIR: dirs.kb,
    CONFIG_DIR: dirs.config,
    GATED_TOOLS: "send_message",
    PI_AGENT_DIR: agentDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
proc.stdout?.on("data", (d) => (serverLog += String(d)));
proc.stderr?.on("data", (d) => (serverLog += String(d)));

let cleaned = false;
const cleanup = (removeData: boolean) => {
  if (cleaned) return;
  cleaned = true;
  try {
    proc.kill("SIGKILL");
  } catch {
    // already dead
  }
  if (removeData) rmSync(base, { recursive: true, force: true });
};
process.on("exit", () => cleanup(false));

async function main() {
  mock.listen(MOCK_PORT, "127.0.0.1");
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error(`server spawn died early (code ${proc.exitCode}) — port conflict?`);
    try {
      const r = await api("GET", "/ready");
      if (r.status === 200 && r.json?.ready) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const client = new TelegramClient({
    botToken: "mock-token",
    apiBase: `http://127.0.0.1:${MOCK_PORT}`,
    allowedIds: [111],
    stateFile: path.join(dirs.data, "telegram-state.json"),
    apiBaseUrl: BASE,
    apiToken: TOKEN,
    rootConversationId: 1,
  });
  await client.start();

  const CHAT = 555;
  const USER = { id: 111, first_name: "Test" };

  // ---- T1: binding + task → progress → final answer ----
  console.log("\n[T1] chat binding → task → progress → final answer");
  enqueue({
    update_id: 100,
    message: { message_id: 1, chat: { id: CHAT }, from: USER, text: "Say exactly TG-OK and nothing else." },
  });
  check(
    "binding greeting posted",
    await waitFor(() => Boolean(findSent("sendMessage", (p) => p.chat_id === CHAT && String(p.text).includes("Project brain online"))), 15_000),
  );
  check(
    "final answer posted with TG-OK",
    await waitFor(() => Boolean(findSent("sendMessage", (p) => p.chat_id === CHAT && !p.message_thread_id && String(p.text).includes("TG-OK")))),
  );
  const entries = await api("GET", "/conversations/1/entries?after=0&limit=200");
  const userTexts = (entries.json?.entries ?? [])
    .flatMap((e: any) => e.model ?? [])
    .filter((m: any) => m.role === "user")
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  check("task landed in root conversation transcript", userTexts.some((t: string) => t.includes("TG-OK")));

  // ---- T2: access control ----
  console.log("\n[T2] access control");
  enqueue({ update_id: 101, message: { message_id: 2, chat: { id: 556 }, from: { id: 999, first_name: "Stranger" }, text: "hello" } });
  check(
    "foreign user rejected",
    await waitFor(() => Boolean(findSent("sendMessage", (p) => p.chat_id === 556 && String(p.text).includes("private"))), 15_000),
  );

  // ---- T3: approval button → callback → settle → retry → executed once ----
  console.log("\n[T3] gated action → inline approval → callback → retry");
  enqueue({
    update_id: 102,
    message: {
      message_id: 3,
      chat: { id: CHAT },
      from: USER,
      text: 'Use the send_message tool to send the message "tg test" to "bob". If it is blocked pending human approval, report the approval key and stop — do not retry.',
    },
  });
  const button = await waitFor(() => Boolean(findSent("sendMessage", (p) => p.chat_id === CHAT && p.reply_markup !== undefined)));
  check("approval button posted", button);
  if (!button) { console.log("cannot continue without approval button"); process.exit(1); }
  const callbackData = String((findSent("sendMessage", (p) => p.reply_markup !== undefined)?.reply_markup as any).inline_keyboard[0][0].callback_data);
  const key = callbackData.split(":")[1];

  const plainMsgCountBefore = sent.filter((s) => s.method === "sendMessage" && s.payload.chat_id === CHAT && !s.payload.message_thread_id).length;
  enqueue({ update_id: 103, callback_query: { id: "cb-1", from: USER, data: `approve:${key}` } });
  check(
    "callback acknowledged",
    await waitFor(() => Boolean(sent.find((s) => s.method === "answerCallbackQuery")), 15_000),
  );
  check(
    "approval UI settled (buttons edited away)",
    await waitFor(() => Boolean(findSent("editMessageText", (p) => String(p.text).includes("APPROVED"))), 15_000),
  );
  const retryOk = await waitFor(async () => {
      const e = await api("GET", "/conversations/1/entries?after=0&limit=200");
      return (e.json?.entries ?? []).flatMap((en: any) => en.model ?? []).some((m: any) => m.role === "user" && String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes(`APPROVED action key ${key}`));
    },
  );
  check("retry instruction submitted to conversation", retryOk);

  // The approved action must execute exactly once.
  const executedOnce = await waitFor(async () => {
      const e = await api("GET", "/conversations/1/entries?after=0&limit=200");
      const results = (e.json?.entries ?? []).flatMap((en: any) => en.model ?? []).filter((m: any) => m.role === "toolResult" && m.toolName === "send_message");
      return results.filter((m: any) => JSON.stringify(m).includes("ACTION EXECUTED") && JSON.stringify(m).includes("bob")).length === 1;
    },
  );
  check("approved action executed exactly once", executedOnce);
  check(
    "post-approval final answer posted",
    await waitFor(() => sent.filter((s) => s.method === "sendMessage" && s.payload.chat_id === CHAT && !s.payload.message_thread_id).length > plainMsgCountBefore),
  );

  // ---- T4: forum topic → fork of root, answered in the thread ----
  console.log("\n[T4] forum topic → fork");
  enqueue({
    update_id: 104,
    message: {
      message_id: 4,
      chat: { id: CHAT },
      from: USER,
      text: "Say exactly TG-TOPIC and nothing else.",
      message_thread_id: 777,
      message_topic: { name: "ops" },
    },
  });
  const topicNotice = await waitFor(() => Boolean(findSent("sendMessage", (p) => p.chat_id === CHAT && p.message_thread_id === 777 && String(p.text).includes("Topic started"))));
  check("topic notice posted in the thread", topicNotice);
  if (!topicNotice) return;
  const convMatch = String(findSent("sendMessage", (p) => p.message_thread_id === 777 && String(p.text).includes("Topic started"))?.text).match(/conversation (\d+)/);
  check("fork conversation id reported", Boolean(convMatch));
  if (!convMatch) { console.log("cannot continue without fork id"); process.exit(1); }
  const topicConvId = Number(convMatch[1]);
  const convList = await api("GET", "/conversations");
  const topicConv = (convList.json?.conversations ?? []).find((c: any) => c.id === topicConvId);
  check("fork listed with topic name", Boolean(topicConv && topicConv.name === "ops"), topicConv ? `name=${topicConv.name}` : "missing");
  check(
    "final answer posted in the topic thread",
    await waitFor(() => Boolean(findSent("sendMessage", (p) => p.chat_id === CHAT && p.message_thread_id === 777 && String(p.text).includes("TG-TOPIC")))),
  );

  // ---- T5: durable state file ----
  console.log("\n[T5] durable state file");
  const stateFile = path.join(dirs.data, "telegram-state.json");
  check("state file exists", existsSync(stateFile));
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    check("root chat bound in state", state.chats?.[String(CHAT)]?.conversationId === 1);
    check("topic binding in state", state.chats?.["555:777"]?.conversationId === topicConvId);
    check("polling offset advanced", typeof state.offset === "number" && state.offset > 104);
  }

  // ---- T6: /model picker — provider buttons → model buttons → durable switch ----
  console.log("\n[T6] /model picker: provider buttons → model buttons → switch");
  enqueue({ update_id: 105, message: { message_id: 5, chat: { id: CHAT }, from: USER, text: "/model" } });
  const menu = await waitFor(() => Boolean(findSent("sendMessage", (p) => p.chat_id === CHAT && String(p.text).includes("Pick a provider") && p.reply_markup !== undefined)));
  check("provider menu posted with buttons", menu);
  let provButtons: string[] = [];
  if (menu) {
    const kb = ((findSent("sendMessage", (p) => String(p.text).includes("Pick a provider"))?.reply_markup as any)?.inline_keyboard ?? []) as Array<Array<{ callback_data: string }>>;
    provButtons = kb.flat().map((b) => b.callback_data);
  }
  check("menu offers the custom testbox provider", provButtons.includes("mprov:testbox"), JSON.stringify(provButtons));

  const PICKER_MSG_ID = 901;
  enqueue({ update_id: 106, callback_query: { id: "cb-m1", from: USER, data: "mprov:testbox", message: { chat: { id: CHAT }, message_id: PICKER_MSG_ID } } });
  const modelMenu = await waitFor(
    () => Boolean(findSent("editMessageText", (p) => p.message_id === PICKER_MSG_ID && String(p.text).includes("Models on testbox") && p.reply_markup !== undefined)),
    15_000,
  );
  check("model menu rendered on provider click", modelMenu);
  let modelButtons: string[] = [];
  if (modelMenu) {
    const kb = ((findSent("editMessageText", (p) => p.message_id === PICKER_MSG_ID && String(p.text).includes("Models on testbox"))?.reply_markup as any)?.inline_keyboard ?? []) as Array<Array<{ callback_data: string }>>;
    modelButtons = kb.flat().map((b) => b.callback_data);
  }
  check(
    "model menu lists both models + back button",
    modelButtons.includes("mmodel:testbox:model-a") && modelButtons.includes("mmodel:testbox:model-b") && modelButtons.includes("mlist"),
    JSON.stringify(modelButtons),
  );

  enqueue({ update_id: 107, callback_query: { id: "cb-m2", from: USER, data: "mmodel:testbox:model-a", message: { chat: { id: CHAT }, message_id: PICKER_MSG_ID } } });
  check(
    "switch confirmation settles the picker message",
    await waitFor(() => Boolean(findSent("editMessageText", (p) => p.message_id === PICKER_MSG_ID && String(p.text).includes("Model switched to testbox:model-a") && p.reply_markup === undefined)), 15_000),
  );
  const rootConv = ((await api("GET", "/conversations")).json?.conversations ?? []).find((c: any) => c.id === 1);
  check("root conversation now runs testbox:model-a", rootConv?.model === "testbox:model-a", `model=${rootConv?.model}`);

  await client.stop();
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) console.log(`data dir kept for post-mortem: ${base}`);
  else cleanup(true);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("fatal:", err);
  cleanup(false);
  process.exit(1);
});
