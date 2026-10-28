// Scheduled checks (issue #58): durable cron-driven runs with delivery + failure pings.
// In-process live suite (same local-model endpoint as core-instance.test.ts). Proves:
//   - declarative schedules.json seeds idempotently into the durable ScheduleDoc
//   - a due schedule durably submits its prompt to the target conversation
//   - a fired slot never double-runs across a restart (idempotent requestId)
//   - a slot that passed while down is skipped by default (no stale jobs)
//   - a run that settles `unanswered` triggers the injected failure hook
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, SubmissionRecord } from "@earendil-works/pi-durable";
import type { CoreInstance } from "../src/core.ts";
import type { ScheduleEntry, FailedScheduleSettle } from "../src/extensions/scheduler.ts";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");
const ctx: Context = BACKGROUND_CONTEXT;

// ---- env: same source as the other live suites (poc/.env or ambient) ----
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
  console.error("OPENAI_BASE_URL not set (poc/.env or environment) — cannot run scheduler tests");
  process.exit(2);
}
for (const k of ["OPENAI_BASE_URL", "OPENAI_API_KEY"]) {
  if (!process.env[k] && pocEnv[k]) process.env[k] = pocEnv[k];
}
process.env.API_TOKEN ??= "scheduler-test-token";

let checkCount = 0;
function check(name: string): void {
  checkCount += 1;
  console.log(`  ok ${checkCount} - ${name}`);
}

function makeDirs(tag: string) {
  const base = mkdtempSync(path.join(tmpdir(), `engram-sched-${tag}-`));
  const dirs = { data: path.join(base, "data"), work: path.join(base, "work"), kb: path.join(base, "kb"), config: path.join(base, "config") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return { base, dirs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { loadConfig } = await import("../src/config.ts");
  const { createCoreInstance } = await import("../src/core.ts");
  const { ScheduleDoc } = await import("../src/extensions/scheduler.ts");

  const cid = (n: number): ConversationId => n as ConversationId;

  // Read the durable schedule doc for an instance.
  async function readSchedules(inst: CoreInstance): Promise<ScheduleEntry[]> {
    const doc = await inst.harness.snapshot(ScheduleDoc, ctx);
    return doc?.schedules ?? [];
  }
  // White-box: force a schedule's nextRunAt to a specific (past) timestamp so it is due.
  async function forceDue(inst: CoreInstance, id: string, ts: number): Promise<void> {
    await inst.harness.commit(async (tx) => {
      const d = await tx.doc(ScheduleDoc);
      const e = d.schedules.find((s) => s.id === id);
      if (!e) throw new Error(`schedule ${id} not found`);
      e.nextRunAt = ts;
    }, ctx);
  }
  // All submissions for one schedule (by its deterministic requestId prefix).
  async function subsFor(inst: CoreInstance, id: string): Promise<SubmissionRecord[]> {
    const all = (await inst.harness.inspect(ctx)).submissions;
    return all.filter((s) => s.requestId?.startsWith(`sched:${id}:`));
  }

  const failures: Array<{ id: string; reason: string }> = [];
  const onScheduledFailure = async (_entry: ScheduleEntry, settled: FailedScheduleSettle) => {
    failures.push({ id: _entry.id, reason: settled.reason });
  };

  // ======================================================================
  console.log("scheduler: seed + fire");
  const a = makeDirs("a");
  writeFileSync(
    path.join(a.dirs.config, "schedules.json"),
    JSON.stringify([
      { id: "daily-briefing", conversation: "root", prompt: "Give me my daily briefing.", cron: "0 0 1 1 *" },
    ]),
  );
  const configA = loadConfig({ dataDir: a.dirs.data, workRoot: a.dirs.work, kbDir: a.dirs.kb, configDir: a.dirs.config, schedulerTickMs: 500 });
  const instA = await createCoreInstance({ config: configA, port: 0, onScheduledFailure });

  // ---- seed: declarative schedule lands in the durable doc with a future nextRunAt ----
  const seeded = (await readSchedules(instA)).find((s) => s.id === "daily-briefing");
  assert(seeded, "declarative schedule must be seeded into ScheduleDoc");
  assert.strictEqual(seeded.source, "config", "seeded schedule source must be 'config'");
  assert.strictEqual(seeded.conversationId, instA.rootConversationId, "conversation 'root' must resolve to the root id");
  assert.strictEqual(seeded.prompt, "Give me my daily briefing.", "prompt must round-trip");
  assert.strictEqual(seeded.enabled, true, "enabled defaults to true");
  assert(seeded.nextRunAt > Date.now(), "nextRunAt must be in the future after seeding");
  check("declarative schedule seeds into ScheduleDoc (root resolved, future nextRunAt)");

  // Let at least one clean tick run so lastTickAt is set (a due slot then fires, not "missed").
  await sleep(1200);

  // ---- fire: force the slot due; the tick durably submits and advances nextRunAt ----
  // Count how many times the prompt appears in the root transcript (each fire adds one user entry).
  async function countPrompt(inst: CoreInstance, text: string): Promise<number> {
    const r = await inst.harness.conversation(cid(inst.rootConversationId), ctx);
    if (!r) return 0;
    const page = await r.entries({ order: "ascending" }, 500, undefined, ctx);
    let n = 0;
    for (const e of page.items) if (JSON.stringify(e).includes(text)) n++;
    return n;
  }

  const forcedSlot = Date.now() - 1000;
  await forceDue(instA, "daily-briefing", forcedSlot);

  // Fire detection: nextRunAt advances to the future AND the prompt landed in the transcript.
  let fired: ScheduleEntry | undefined;
  for (let i = 0; i < 60; i++) {
    const s = (await readSchedules(instA)).find((x) => x.id === "daily-briefing");
    if (s && s.nextRunAt > Date.now() && (await countPrompt(instA, "Give me my daily briefing.")) > 0) { fired = s; break; }
    await sleep(250);
  }
  assert(fired, "schedule must fire: nextRunAt advances to the future and the prompt lands in the transcript");
  check("due schedule durably submits its prompt and advances nextRunAt");

  const countAfterFire = await countPrompt(instA, "Give me my daily briefing.");
  assert(countAfterFire >= 1, "the scheduled prompt must appear in the root transcript");
  check("scheduled prompt is present in the target conversation's transcript");

  // ======================================================================
  console.log("scheduler: idempotent across restart (no double-run)");
  await instA.close();

  // Reopen over the same store. The already-fired slot must not fire again.
  const instA2 = await createCoreInstance({ config: configA, port: 0, onScheduledFailure });
  await sleep(1500); // a few ticks
  const afterRestart = (await readSchedules(instA2)).find((s) => s.id === "daily-briefing")!;
  assert(afterRestart.nextRunAt > Date.now(), "nextRunAt must remain in the future after restart");
  const countAfterRestart = await countPrompt(instA2, "Give me my daily briefing.");
  assert.strictEqual(countAfterRestart, countAfterFire, "restart must not re-fire the already-fired slot (prompt count unchanged)");
  check("restart does not re-fire an already-fired slot (no duplicate prompt in transcript)");
  await instA2.close();

  // ======================================================================
  console.log("scheduler: skip a missed slot (default policy)");
  const b = makeDirs("b");
  writeFileSync(
    path.join(b.dirs.config, "schedules.json"),
    JSON.stringify([
      { id: "missed", conversation: "root", prompt: "Should not fire.", cron: "0 0 1 1 *" },
    ]),
  );
  // Large tick so no live tick fires the forced-due slot before we close (simulates downtime).
  const configB = loadConfig({ dataDir: b.dirs.data, workRoot: b.dirs.work, kbDir: b.dirs.kb, configDir: b.dirs.config, schedulerTickMs: 60_000 });
  const instB = await createCoreInstance({ config: configB, port: 0, onScheduledFailure });

  // Simulate: the process was down across this slot (nextRunAt in the past).
  await forceDue(instB, "missed", Date.now() - 5000);
  await instB.close(); // no live tick in between (60 s interval) → the run never started

  // Reopen: first tick sees due + missed → skip policy advances without firing.
  const configB2 = loadConfig({ dataDir: b.dirs.data, workRoot: b.dirs.work, kbDir: b.dirs.kb, configDir: b.dirs.config, schedulerTickMs: 500 });
  const instB2 = await createCoreInstance({ config: configB2, port: 0, onScheduledFailure });
  await sleep(1500);
  const missedEntry = (await readSchedules(instB2)).find((s) => s.id === "missed")!;
  assert.strictEqual(missedEntry.lastRunAt, undefined, "a missed slot must NOT fire under skip policy");
  assert(missedEntry.nextRunAt > Date.now(), "a missed slot must advance to a future nextRunAt");
  const missedSubs = await subsFor(instB2, "missed");
  assert.strictEqual(missedSubs.length, 0, "no submission may exist for a skipped (missed) slot");
  check("missed slot is skipped by default (no stale run, nextRunAt advanced)");
  await instB2.close();

  // ======================================================================
  console.log("scheduler: failure ping on unanswered run");
  const c = makeDirs("c");
  writeFileSync(path.join(c.dirs.config, "schedules.json"), "[]");
  const configC = loadConfig({ dataDir: c.dirs.data, workRoot: c.dirs.work, kbDir: c.dirs.kb, configDir: c.dirs.config, schedulerTickMs: 500 });
  const instC = await createCoreInstance({ config: configC, port: 0, onScheduledFailure });

  // A conversation whose model is not in the catalog → runs settle `unanswered/no_model`.
  const badConv = await instC.harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: { provider: "bogusprov", modelId: "nope" }, thinkingLevel: "low" } },
    ctx,
  );
  // Ad-hoc schedule targeting it, forced due.
  await instC.harness.commit(async (tx) => {
    const d = await tx.doc(ScheduleDoc);
    d.schedules.push({
      id: "doomed",
      conversationId: badConv.id,
      prompt: "This will fail.",
      cron: "0 0 1 1 *",
      enabled: true,
      source: "ad-hoc",
      createdAt: Date.now(),
      nextRunAt: Date.now() - 1000,
    });
  }, ctx);

  let failed = false;
  for (let i = 0; i < 60 && !failed; i++) {
    failed = failures.some((f) => f.id === "doomed");
    if (!failed) await sleep(250);
  }
  assert(failed, "the failure hook must fire for a run that settles unanswered");
  const doomFail = failures.find((f) => f.id === "doomed")!;
  assert.strictEqual(doomFail.reason, "no_model", "failure reason should be 'no_model' for an unknown model ref");
  check("unanswered scheduled run triggers the failure hook (reason no_model)");

  await instC.close();

  // ---- cleanup temp dirs ----
  for (const t of [a.base, b.base, c.base]) {
    try { rmSync(t, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  console.log(`\nscheduler: ${checkCount} checks passed`);
}

main().catch((err) => {
  console.error("scheduler test failed:", err);
  process.exit(1);
});
