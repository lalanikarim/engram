// Week 2 D12–13 sandbox integration tests: spawn a real server over temp dirs and verify
// that conversations flagged sandbox=true execute code in a disposable Podman sidecar.
// Requires Podman + the sandbox image (pulled already on this machine). Run with:
//   node test/sandbox.test.ts
//
// Checks (PLAN §4 D12–13 + acceptance criterion 5):
//   1. create conversation with sandbox=true → flagged in list
//   2. code runs in the container: no host secrets, egress blocked, host FS not mounted,
//      workspace bind-mounted at /sandbox (deterministic podman exec probes during a live run)
//   3. agent writes + cats a file in the sandbox conversation → file lands on the host workspace
//   4. containment guard: write tool cannot escape the workspace (permission_denied, no host file)
//   5. container is disposed when the run ends (disposable per task) and a fresh one works for the next run
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");

// ---- podman availability (fail fast with a clear message) ----
function runPodman(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("error", () => resolve({ code: 127, out: "podman not found" }));
    child.on("close", (code) => resolve({ code: code ?? 1, out: (out + errOut).trim() }));
  });
}

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

// Base under $HOME (not os.tmpdir()): on macOS the Podman VM only shares the home
// directory, so sandbox bind-mount sources must live there.
const base = mkdtempSync(path.join(homedir(), ".pidurable-sbx-test-"));
const dirs = { data: path.join(base, "data"), work: path.join(base, "work"), kb: path.join(base, "kb"), config: path.join(base, "config") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
mkdirSync(path.join(dirs.work, "sbx-proj"), { recursive: true });

writeFileSync(path.join(dirs.config, "roles.json"), "[]");
writeFileSync(path.join(dirs.config, "tools.json"), "[]");

const TOKEN = "sbx-test-token";
const PORT = 18940;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE = path.join(dirs.work, "sbx-proj");

let proc: ChildProcess | undefined;

function spawnServer(): ChildProcess {
  const p = spawn("node", [path.join(APP_ROOT, "src", "main.ts")], {
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
  let log = "";
  p.stdout?.on("data", (d) => (log += String(d)));
  p.stderr?.on("data", (d) => (log += String(d)));
  p.on("exit", () => console.log(`[server exited code=${p.exitCode}]`));
  return p;
}

async function waitReady(p: ChildProcess): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (p.exitCode !== null) throw new Error(`server spawn died early (code ${p.exitCode}) — port conflict?`);
    try {
      const r = await fetch(`${BASE}/ready`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (r.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

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
    // non-JSON
  }
  return { status: res.status, json };
}

/** Submit a task and wait for its run to end. Returns the submission id. */
async function submitAndAwait(convId: number, text: string, timeoutMs = 240_000): Promise<number> {
  const sub = await api("POST", "/tasks", { conversationId: convId, content: text, requestId: `sbx-${Date.now()}-${Math.random().toString(16).slice(2)}` });
  if (sub.status !== 200 && sub.status !== 201 && sub.status !== 202) {
    throw new Error(`task submit failed: ${sub.status} ${JSON.stringify(sub.json)}`);
  }
  const submissionId = sub.json.submissionId as number;
  // Poll the conversation's last entry until no run is in flight: use /stream snapshot via entries count growth + task settle.
  // Simplest robust wait: poll GET /conversations until openSubmissions for convId drops to 0.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await api("GET", "/conversations");
    const conv = list.json.conversations.find((c: any) => c.id === convId);
    if (conv && conv.openSubmissions === 0) return submissionId;
    if (Date.now() > deadline) throw new Error(`run did not settle within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Find the live sandbox container whose /sandbox mount points at WORKSPACE. */
async function findSandboxContainer(): Promise<string | undefined> {
  const ps = await runPodman(["ps", "--filter", "name=pi-sbx-", "--format", "{{.Names}}"]);
  if (ps.code !== 0) return undefined;
  for (const name of ps.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const inspect = await runPodman(["inspect", name, "--format", "{{json .Mounts}}"]);
    if (inspect.code !== 0) continue;
    try {
      const mounts = JSON.parse(inspect.out) as Array<{ Source: string; Destination: string }>;
      if (mounts.some((m) => m.Destination === "/sandbox" && m.Source === WORKSPACE)) return name;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Wait until the run's container is gone (disposal after run_end), or timeout. */
async function waitForDisposal(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await findSandboxContainer()) === undefined) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(): Promise<void> {
  const podmanCheck = await runPodman(["version", "--format", "{{.Client.Version}}"]);
  if (podmanCheck.code !== 0) {
    console.error("Podman is not available — sandbox suite requires it. Skipping.");
    process.exit(2);
  }
  console.log(`sandbox suite: podman ${podmanCheck.out}, workspace ${WORKSPACE}`);

  proc = spawnServer();
  if (!(await waitReady(proc!))) throw new Error("server did not become ready");
  console.log("server ready");

  // ---- 1. create sandboxed conversation ----
  const created = await api("POST", "/conversations", { cwd: "sbx-proj", sandbox: true, name: "sandbox-test" });
  check("create sandboxed conversation → 201 + sandbox:true", created.status === 201 && created.json.sandbox === true, JSON.stringify(created.json));
  const convId = created.json.id as number;

  const list = await api("GET", "/conversations");
  const listed = (list.json.conversations ?? []).find((c: any) => c.id === convId);
  check("conversation list shows sandbox:true", listed?.sandbox === true, JSON.stringify(listed));

  // ---- 2. deterministic container probes during a live run ----
  // Submit a long task and probe the container WHILE it is running.
  console.log("submitting keep-alive task (sleep 40) …");
  const keepAlive = api("POST", "/tasks", { conversationId: convId, content: "Use the bash tool to run exactly this command: sleep 40 && echo SLEPT2\nWhen it finishes, reply with the single word SLEPT2.", requestId: `sbx-keepalive-${Date.now()}` });
  const container = await waitFor(() => findSandboxContainer(), 90_000);
  check("sandbox container is running during a task", container !== undefined, "no pi-sbx-* container with the workspace mount found");

  if (container) {
    // No host secrets: none of our env vars may be visible inside the container.
    const envScan = await runPodman(["exec", container, "sh", "-c", "env | grep -cE 'OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|^API_TOKEN=' || true"]);
    check("no host secrets in container env", envScan.code === 0 && envScan.out.trim() === "0", `count=${envScan.out.trim()}`);

    // Host FS not mounted.
    const lsUsers = await runPodman(["exec", container, "sh", "-c", "ls /Users"]);
    check("host filesystem not mounted in container", lsUsers.code !== 0, `exit=${lsUsers.code} out=${lsUsers.out.slice(0, 120)}`);

    // Egress blocked (network=none): even loopback to the host API must fail.
    const egress = await runPodman(["exec", container, "python", "-c", `import urllib.request; urllib.request.urlopen('http://127.0.0.1:${PORT}', timeout=3)`]);
    check("egress blocked (network none)", egress.code !== 0, `exit=${egress.code} out=${egress.out.slice(0, 160)}`);

    // Workspace is bind-mounted at /sandbox and writable from inside.
    const mountWrite = await runPodman(["exec", container, "sh", "-c", "echo MOUNT-OK > /sandbox/mount-probe.txt && cat /sandbox/mount-probe.txt"]);
    check("workspace mounted at /sandbox (write+read from container)", mountWrite.code === 0 && mountWrite.out.includes("MOUNT-OK"), mountWrite.out.slice(0, 120));
    if (existsSync(path.join(WORKSPACE, "mount-probe.txt"))) {
      rmSync(path.join(WORKSPACE, "mount-probe.txt"));
    }
  }

  // Let the keep-alive task finish, then verify disposal.
  await keepAlive;
  const settled = await waitSettled(convId, 120_000);
  check("keep-alive run settled", settled);
  const disposed = await waitForDisposal();
  check("container disposed after run end (disposable per task)", disposed, "container still present after run_end");

  // ---- 3. agent writes + cats a file; it lands on the host workspace ----
  await submitAndAwait(convId, "Write a file named hello.txt containing exactly HELLO-SANDBOX (no quotes). Then use the bash tool to run: cat hello.txt\nTell me what the file contained.");
  const hostFile = path.join(WORKSPACE, "hello.txt");
  check("file written in sandbox lands on host workspace", existsSync(hostFile));
  let content = "";
  if (existsSync(hostFile)) content = readFileSync(hostFile, "utf8").trim();
  check("host file content is HELLO-SANDBOX", content === "HELLO-SANDBOX", `content=${JSON.stringify(content)}`);

  // ---- 4. containment guard: escape attempts fail and create nothing on the host ----
  await submitAndAwait(convId, "Use the write tool to create a file at the relative path ../../escape.txt containing ESCAPE. Then tell me whether the write succeeded or what error you got.");
  check("containment: no escape file created outside workspace", !existsSync(path.join(dirs.work, "escape.txt")) && !existsSync(path.join(base, "escape.txt")));

  // ---- 5. fresh container for the next run (respawn after disposal) ----
  await submitAndAwait(convId, "Write a file named second.txt containing exactly ROUND-TWO. Then use the bash tool to run: cat second.txt\nTell me what the file contained.");
  const secondFile = path.join(WORKSPACE, "second.txt");
  check("next run works with a fresh container (respawn)", existsSync(secondFile) && readFileSync(secondFile, "utf8").trim() === "ROUND-TWO");

  // ---- summary + teardown ----
  console.log(`\nsandbox suite: ${passed} passed, ${failed} failed`);
  try {
    proc?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 3000));
    if (proc && proc.exitCode === null) proc.kill("SIGKILL");
  } catch {
    // best effort
  }
  rmSync(base, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

/** Poll until the conversation has no open submissions. */
async function waitSettled(convId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await api("GET", "/conversations");
    const conv = (list.json.conversations ?? []).find((c: any) => c.id === convId);
    if (conv && conv.openSubmissions === 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Poll a predicate until truthy or timeout. */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((err) => {
  console.error("sandbox suite fatal:", err);
  try {
    proc?.kill("SIGKILL");
  } catch {
    // best effort
  }
  process.exit(1);
});
