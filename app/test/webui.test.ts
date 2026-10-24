// Web UI integration tests (PLAN §4 D10–11, acceptance criterion #4):
// list conversations → open any → continue with live streaming; steering box;
// pending-approvals panel; live tool output. Drives the real SPA in headless Chromium
// against a real server + local model. Playwright is imported from the shared
// headless-browser-checker skill install (no repo dependency).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLAYWRIGHT = "/Users/karim/.pi/agent/skills/headless-browser-checker/node_modules/playwright/index.mjs";
const { chromium } = await import(PLAYWRIGHT);

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

const base = mkdtempSync(path.join(tmpdir(), "pidurable-webui-"));
const dirs = { data: path.join(base, "data"), work: path.join(base, "work"), kb: path.join(base, "kb"), config: path.join(base, "config") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const TOKEN = "webui-test-token";
const PORT = 18970;
const BASE = `http://127.0.0.1:${PORT}`;
const LONG_TIMEOUT = 240_000;

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

async function api(path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ---- server ----
const proc = spawn("node", [path.join(APP_ROOT, "src", "main.ts")], {
  env: {
    ...process.env,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? pocEnv.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? pocEnv.OPENAI_API_KEY,
    API_TOKEN: TOKEN,
    HOST: "127.0.0.1",
    PORT: String(PORT),
    DATA_DIR: dirs.data,
    WORK_ROOT: dirs.work,
    KB_DIR: dirs.kb,
    CONFIG_DIR: dirs.config,
    GATED_TOOLS: "send_message",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
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
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error(`server spawn died early (code ${proc.exitCode}) — port conflict?`);
    try {
      const r = await api("/ready");
      if (r.status === 200 && r.json?.ready) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err: Error) => console.error("page error:", err.message));
  const jsErrors: string[] = [];
  page.on("console", (msg: { type(): string; text(): string }) => {
    if (msg.type() === "error") jsErrors.push(msg.text());
  });

  // ---- token gate ----
  console.log("\n[W1] token gate");
  await page.goto(BASE);
  const tokenVisible = await page.waitForSelector('[data-testid="token-input"]', { timeout: 10_000 }).then(() => true).catch(() => false);
  check("token screen shown without a token", tokenVisible);
  if (!tokenVisible) return;
  await page.fill('[data-testid="token-input"]', TOKEN);
  await page.keyboard.press("Enter");
  const listVisible = await page.waitForSelector('[data-testid="conv-item"]', { timeout: 30_000 }).then(() => true).catch(() => false);
  check("conversation list appears after login", listVisible);
  if (!listVisible) return;

  // ---- open root conversation + task → live answer ----
  console.log("\n[W2] open a conversation, send a task, watch the stream");
  await page.click('[data-testid="conv-item"]');
  const composerVisible = await page.waitForSelector('[data-testid="composer"]', { timeout: 10_000 }).then(() => true).catch(() => false);
  check("chat view with composer", composerVisible);
  if (!composerVisible) return;
  await page.fill('[data-testid="composer"]', "Say exactly WEB-OK and nothing else.");
  await page.keyboard.press("Enter");
  const answerOk = await page
    .waitForFunction(() => document.querySelector('[data-testid="messages"]')?.textContent.includes("WEB-OK"), undefined, { timeout: LONG_TIMEOUT })
    .then(() => true)
    .catch(() => false);
  check("live-streamed answer rendered in chat", answerOk);

  // ---- steering a running conversation ----
  console.log("\n[W3] steering box steers a running turn");
  await page.fill('[data-testid="composer"]', "Run the bash command `sleep 10 && echo DONE-SLOW`. Then say exactly SLOW-WEB.");
  await page.keyboard.press("Enter");
  const runBadge = await page.waitForSelector('[data-testid="run-badge"]', { timeout: LONG_TIMEOUT }).then(() => true).catch(() => false);
  check("running badge appears while the turn runs", runBadge);
  if (runBadge) {
    await page.fill('[data-testid="composer"]', "When you finish, also include the word WEB-STEERED in your final answer.");
    await page.keyboard.press("Enter");
  }
  const steeredOk = await page
    .waitForFunction(
      () => {
        const t = document.querySelector('[data-testid="messages"]')?.textContent ?? "";
        return t.includes("SLOW-WEB") && t.includes("WEB-STEERED");
      },
      undefined,
      { timeout: LONG_TIMEOUT },
    )
    .then(() => true)
    .catch(() => false);
  check("steered final answer contains both markers", steeredOk);
  const toolOutputRendered = await page
    .waitForFunction(() => (document.querySelector('[data-testid="messages"]')?.textContent ?? "").includes("DONE-SLOW"), undefined, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check("live tool output rendered in chat", toolOutputRendered);

  // ---- approvals panel: gated action → approve → executed once ----
  console.log("\n[W4] pending-approvals panel");
  await page.fill(
    '[data-testid="composer"]',
    'Use the send_message tool to send the message "web test" to "carol". If it is blocked pending human approval, report the key and stop — do not retry.',
  );
  await page.keyboard.press("Enter");
  const banner = await page.waitForSelector('[data-testid="approve-btn"]', { timeout: LONG_TIMEOUT }).then(() => true).catch(() => false);
  check("approval request appears in the panel", banner);
  if (banner) {
    await page.click('[data-testid="approve-btn"]');
    const executedInChat = await page
      .waitForFunction(
        () => {
          const t = document.querySelector('[data-testid="messages"]')?.textContent ?? "";
          return t.includes("ACTION EXECUTED") && t.includes("carol");
        },
        undefined,
        { timeout: LONG_TIMEOUT },
      )
      .then(() => true)
      .catch(() => false);
    check("approved action result rendered in chat", executedInChat);
    const e = await api("/conversations/1/entries?after=0&limit=200");
    const results = (e.json?.entries ?? []).flatMap((en: any) => en.model ?? []).filter((m: any) => m.role === "toolResult" && m.toolName === "send_message");
    check(
      "approved action executed exactly once",
      results.filter((m: any) => JSON.stringify(m).includes("ACTION EXECUTED") && JSON.stringify(m).includes("carol")).length === 1,
      `count=${results.length}`,
    );
    const bannerGone = await page.waitForFunction(() => !document.querySelector('[data-testid="approvals"]'), undefined, { timeout: 30_000 }).then(() => true).catch(() => false);
    check("approval panel clears after decision", bannerGone);
  }

  // ---- new conversation from the sidebar ----
  console.log("\n[W5] create a new conversation and use it");
  await page.fill('input[placeholder="Name (optional)"]', "web-conv");
  await page.click('[data-testid="new-conv-btn"]');
  const listed = await page
    .waitForFunction(() => [...document.querySelectorAll('[data-testid="conv-item"]')].some((el) => el.textContent?.includes("web-conv")), undefined, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check("new conversation listed", listed);
  if (listed) {
    await page.click(`[data-testid="conv-item"]:has-text("web-conv")`);
    await page.fill('[data-testid="composer"]', "Say exactly WEB-CONV and nothing else.");
    await page.keyboard.press("Enter");
    const convAnswer = await page
      .waitForFunction(() => document.querySelector('[data-testid="messages"]')?.textContent.includes("WEB-CONV"), undefined, { timeout: LONG_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    check("task answered in the new conversation", convAnswer);
  }

  // ---- no JS errors ----
  const realJsErrors = jsErrors.filter((t) => !t.includes("401") && !t.includes("Failed to load resource"));
  check("no unexpected page JS errors", realJsErrors.length === 0, realJsErrors.slice(0, 3).join(" | "));

  await browser.close();
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
