// Phase 4a test — SSE cursor reconnect: no lost or duplicated durable entries.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const PORT = 8791;
const TOKEN = "dev-test-token";
const BASE = `http://127.0.0.1:${PORT}`;

rmSync("./data/sse.sqlite", { force: true });
rmSync("./work/sse.txt", { force: true });
rmSync("/tmp/sse-a.log", { force: true });
rmSync("/tmp/sse-b.log", { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectSSE(cursor) {
  const entries = [];
  const events = [];
  let raw = "";
  let runEndSeen = false;
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/events?conversation=1&cursor=${cursor}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evLine = frame.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!evLine || !dataLine) continue;
          const type = evLine.slice(6).trim();
          const data = JSON.parse(dataLine.slice(5));
          raw += `${type} ${JSON.stringify(data)}\n`;
          if (type === "entry") entries.push({ id: data.id, kind: data.kind });
          if (type === "event") events.push(data);
          if (type === "event" && data.type === "run_end") runEndSeen = true;
        }
      }
    } catch {
      /* aborted or closed */
    }
  })();
  return {
    entries,
    events,
    raw: () => raw,
    get runEnd() {
      return runEndSeen;
    },
    stop() {
      ctrl.abort();
    },
  };
}

// --- start server ---
const server = spawn("node", ["05-sse.mjs"], {
  env: { ...process.env, SSE_PORT: String(PORT), SSE_TOKEN: TOKEN },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
await sleep(2000);
if (!serverLog.includes("SSE server on")) {
  console.log("SERVER FAILED:\n" + serverLog);
  server.kill();
  process.exit(1);
}
console.log("server up");

// --- client A: cursor 0, dropped mid-run ---
const A = connectSSE(0);
await sleep(1500); // attach + baseline

const submitRes = await fetch(`${BASE}/submit`, {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({
    content: "Create a file sse.txt containing exactly hello-sse, then confirm in one sentence.",
    requestId: "ph4-sse",
  }),
});
console.log("submit:", submitRes.status, (await submitRes.text()).trim());

// duplicate submit with same requestId must be idempotent
const dupRes = await fetch(`${BASE}/submit`, {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({
    content: "Create a file sse.txt containing exactly hello-sse, then confirm in one sentence.",
    requestId: "ph4-sse",
  }),
});
console.log("dup submit:", dupRes.status);

await sleep(2500); // let the run get in flight
const lastA = A.entries.length ? A.entries[A.entries.length - 1].id : 0;
writeFileSync("/tmp/sse-a.log", A.raw());
A.stop();
console.log(`client A dropped mid-run with ${A.entries.length} entries (last id ${lastA})`);

// --- client B: reconnect from lastA, wait for run_end ---
const B = connectSSE(lastA);
for (let i = 0; i < 60 && !B.runEnd; i++) await sleep(1000);
writeFileSync("/tmp/sse-b.log", B.raw());
B.stop();
console.log(`client B captured ${B.entries.length} entries after cursor, runEnd=${B.runEnd}`);

// --- client C: full transcript from cursor 0 (ground truth) ---
const C = connectSSE(0);
for (let i = 0; i < 5 && C.entries.length === 0; i++) await sleep(500);
await sleep(1000);
C.stop();
const full = [...C.entries].sort((x, y) => x.id - y.id).map((e) => e.id);

// --- verify: A ∪ B (deduped) equals full, in order, no gaps ---
const seen = new Map();
for (const e of [...A.entries, ...B.entries]) if (!seen.has(e.id)) seen.set(e.id, e.kind);
const merged = [...seen.entries()].sort((x, y) => x[0] - y[0]).map((x) => x[0]);
const noDupes = seen.size === A.entries.length + B.entries.length - (B.entries.filter((e) => A.entries.some((a) => a.id === e.id)).length);
const sameSet = JSON.stringify(merged) === JSON.stringify(full);
let inOrderNoGaps = true;
for (let i = 0; i < merged.length; i++) if (!full.includes(merged[i]) || full.indexOf(merged[i]) !== i) { inOrderNoGaps = false; break; }

const fileOk = existsSync("./work/sse.txt") && readFileSync("./work/sse.txt", "utf8").trim() === "hello-sse";
console.log(`full transcript ids: ${JSON.stringify(full)}`);
console.log(`merged A∪B ids:      ${JSON.stringify(merged)}`);
console.log(`file sse.txt: ${fileOk ? "OK" : "MISSING/WRONG"}`);

const pass = sameSet && inOrderNoGaps && B.runEnd && fileOk;
console.log(pass ? "PHASE4-SSE: PASS — reconnect from cursor lost nothing, duplicated nothing" : "PHASE4-SSE: FAIL");
server.kill();
process.exitCode = pass ? 0 : 1;
