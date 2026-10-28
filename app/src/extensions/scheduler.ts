// Scheduled checks (issue #58): cron-driven proactive runs with durable state and delivery.
//
// A ScheduleDoc (session-scoped singleton) holds every schedule. An in-kernel tick loop fires
// due schedules by durably submitting their prompt to the target conversation. Runs are durable
// (pi-durable semantics): a crash mid-run resumes on reopen. Success is delivered by the existing
// Telegram ProgressWatcher when the conversation has a binding; a run that settles `unanswered`
// triggers an injected onFailure hook (wired to a Telegram ping in main.ts).
//
// Correctness anchors (robust even if a doc commit is transiently lost):
//   - The durable submission record, keyed by a deterministic per-slot requestId, is the proof a
//     slot fired. Firing is idempotent: we only submit when no submission with that requestId
//     exists yet, so a re-processed slot never double-runs (pi-durable dedups by requestId).
//   - nextRunAt is advanced after each handled slot; if that commit is lost, the next tick sees
//     the slot still due, finds the existing submission, and simply advances again (self-heals).
//
// Missed-firing policy: a slot whose time passed while the process was down is "missed". The
// default policy ("skip") advances past it without firing stale jobs; "catch-up" fires it once.
import { Cron } from "croner";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import type { ScheduleSpec } from "../config.ts";
import { ConversationMeta } from "../meta.ts";

export type MissedFiringPolicy = "skip" | "catch-up";

/** One durable schedule. */
export type ScheduleEntry = {
  /** Stable id (from config, or generated for ad-hoc). */
  id: string;
  conversationId: number;
  prompt: string;
  cron: string;
  enabled: boolean;
  source: "config" | "ad-hoc";
  createdAt: number;
  /** When the schedule last fired (a durable submit was admitted). Informational. */
  lastRunAt?: number;
  /** Next scheduled fire time (epoch ms); strictly in the future after each handled slot. */
  nextRunAt: number;
};

/** A failed run's terminal record, handed to onFailure. */
export type FailedScheduleSettle = Extract<SubmissionRecord, { status: "unanswered" }>;

/** Session-scoped singleton holding every schedule (one doc, not a family — pi-durable has no doc-family scan). */
export const ScheduleDoc = defineDoc({
  scope: "session",
  kind: "mvp.schedules",
  version: 1,
  initial: (): { schedules: ScheduleEntry[] } => ({ schedules: [] }),
});

const ctx = BACKGROUND_CONTEXT;
const cid = (n: number): ConversationId => n as ConversationId;

/** Deterministic idempotency key for one firing of one slot (stable across crash-retries). */
export function firingRequestId(entryId: string, slotMs: number): string {
  return `sched:${entryId}:${slotMs}`;
}

// Cron instances are cheap and hold no timer; cache per pattern to avoid re-parsing each tick.
const cronCache = new Map<string, Cron>();
function cronFor(pattern: string): Cron {
  let c = cronCache.get(pattern);
  if (!c) {
    c = new Cron(pattern); // throws on an invalid pattern
    cronCache.set(pattern, c);
  }
  return c;
}

/** Next fire time (epoch ms) strictly after `from`. Throws on an invalid cron. */
export function nextCronDate(cron: string, from: Date): number {
  const d = cronFor(cron).enumerate(from).next().value as Date;
  return d.getTime();
}

export type SchedulerOptions = {
  harness: Harness;
  rootConversationId: number;
  /** Declarative schedules to seed idempotently at start (from schedules.json). */
  declarative?: readonly ScheduleSpec[];
  /** Tick interval in ms. Default 30_000. */
  tickMs?: number;
  /** What to do with a slot that passed while the process was down. Default "skip". */
  missedFiringPolicy?: MissedFiringPolicy;
  /** Failure delivery hook for runs that settle `unanswered`. */
  onFailure?: (entry: ScheduleEntry, settled: FailedScheduleSettle) => Promise<void> | void;
  log?: (msg: string) => void;
};

export class Scheduler {
  private harness: Harness;
  private rootConversationId: number;
  private declarative: readonly ScheduleSpec[];
  private tickMs: number;
  private policy: MissedFiringPolicy;
  private onFailure?: (entry: ScheduleEntry, settled: FailedScheduleSettle) => Promise<void> | void;
  private log: (msg: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  // In-memory only: undefined after (re)start, so the first slot observed due is "missed".
  // A continuously-running process updates it every tick, keeping the gap small.
  private lastTickAt: number | undefined;
  // Entry id → submission id of its in-flight fired slot, awaiting a terminal settle for failure pings.
  private pendingFailure = new Map<string, SubmissionId>();
  private ticking = false;
  private closed = false;

  constructor(opts: SchedulerOptions) {
    this.harness = opts.harness;
    this.rootConversationId = opts.rootConversationId;
    this.declarative = opts.declarative ?? [];
    this.tickMs = opts.tickMs ?? 30_000;
    this.policy = opts.missedFiringPolicy ?? "skip";
    this.onFailure = opts.onFailure;
    this.log = opts.log ?? ((m) => console.log(`[scheduler] ${m}`));
  }

  /** Seed declarative schedules (idempotent by id), then start the tick loop. */
  async start(): Promise<void> {
    if (this.declarative.length > 0) await this.seedDeclarative();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // Don't let the scheduler alone keep the process alive during tests/shutdown.
    this.timer.unref();
    void this.tick(); // first pass immediately (catches an already-due slot on boot)
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Idempotently reconcile declarative specs into the doc (create or update by id). */
  private async seedDeclarative(): Promise<void> {
    const now = Date.now();
    // Resolve + validate up front so a bad declarative schedule fails fast at boot.
    const resolved = await Promise.all(
      this.declarative.map(async (spec) => ({ spec, conversationId: await this.resolveConversationRef(spec.conversation) })),
    );
    for (const { spec } of resolved) nextCronDate(spec.cron, new Date(now)); // throws on invalid cron
    await this.harness.commit(async (tx) => {
      const d = await tx.doc(ScheduleDoc);
      for (const { spec, conversationId } of resolved) {
        const existing = d.schedules.find((s) => s.id === spec.id);
        if (existing) {
          const changed =
            existing.cron !== spec.cron ||
            existing.prompt !== spec.prompt ||
            existing.conversationId !== conversationId ||
            existing.enabled !== (spec.enabled ?? true);
          existing.cron = spec.cron;
          existing.prompt = spec.prompt;
          existing.conversationId = conversationId;
          existing.enabled = spec.enabled ?? true;
          if (changed) existing.nextRunAt = nextCronDate(spec.cron, new Date(now));
        } else {
          d.schedules.push({
            id: spec.id,
            conversationId,
            prompt: spec.prompt,
            cron: spec.cron,
            enabled: spec.enabled ?? true,
            source: "config",
            createdAt: now,
            nextRunAt: nextCronDate(spec.cron, new Date(now)),
          });
        }
      }
    }, ctx);
  }

  /** Resolve a declarative conversation reference ("root" | name | numeric id) to an id. */
  private async resolveConversationRef(ref: string | number): Promise<number> {
    if (typeof ref === "number") return ref;
    if (ref === "root") return this.rootConversationId;
    // Name lookup: scan conversations, match ConversationMeta.name (same pattern as GET /conversations).
    const page = await this.harness.commit((tx) => tx.scanConversations({ order: "ascending" }, 10_000), ctx);
    for (const c of page.items) {
      const meta = await this.harness.snapshot(ConversationMeta, cid(c.id), ctx);
      if (meta?.name === ref) return c.id;
    }
    throw new Error(`schedule conversation "${ref}" not found (no conversation with that name)`);
  }

  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      await this.doTick();
    } finally {
      this.ticking = false;
    }
  }

  private async doTick(): Promise<void> {
    const now = Date.now();
    let entries: ScheduleEntry[];
    try {
      const doc = await this.harness.snapshot(ScheduleDoc, ctx);
      entries = doc?.schedules ?? [];
    } catch (e) {
      this.log(`tick read failed: ${(e as Error).message}`);
      this.lastTickAt = now;
      return;
    }

    // Pass 1: settle in-flight fired slots for failure pings (best-effort, in-memory).
    await this.settleFailures(entries);

    const due = entries.filter((e) => e.enabled && e.nextRunAt <= now);
    if (due.length > 0) {
      // A large gap since the last tick (or no prior tick this life) means we were down across the slot.
      const missed = this.lastTickAt === undefined || now - this.lastTickAt > this.tickMs * 3;
      for (const entry of due) {
        try {
          if (!(missed && this.policy === "skip")) await this.fire(entry, now);
          else this.log(`skipping missed slot ${new Date(entry.nextRunAt).toISOString()} for "${entry.id}"`);
          // Advance to the next future slot. If this commit is lost, the next tick re-processes
          // the same slot: the idempotent fire finds the existing submission and advances again.
          entry.nextRunAt = nextCronDate(entry.cron, new Date(now));
        } catch (e) {
          this.log(`handling "${entry.id}" failed: ${(e as Error).message}`);
          // Leave nextRunAt as-is so the next tick retries (a transient error shouldn't deschedule it).
        }
      }
      await this.advanceNextRun(entries, due);
    }
    this.lastTickAt = now;
  }

  /**
   * Durable submit of one firing. Idempotent by the deterministic per-slot requestId: re-processing
   * an already-fired slot returns the existing submission and never starts a second run.
   */
  private async fire(entry: ScheduleEntry, now: number): Promise<void> {
    const conv = await this.harness.conversation(cid(entry.conversationId), ctx);
    if (!conv) throw new Error(`conversation ${entry.conversationId} not found`);
    const requestId = firingRequestId(entry.id, entry.nextRunAt);
    const sub = await conv.submit({ type: "input", content: entry.prompt, requestId }, ctx);
    entry.lastRunAt = now;
    this.pendingFailure.set(entry.id, sub.id);
    this.log(`fired "${entry.id}" → conversation ${entry.conversationId} (submission ${sub.id})`);
  }

  /** One commit advancing nextRunAt (and lastRunAt) for every due entry handled this tick. */
  private async advanceNextRun(all: ScheduleEntry[], due: ScheduleEntry[]): Promise<void> {
    const byId = new Map(due.map((e) => [e.id, e]));
    await this.harness.commit(async (tx) => {
      const d = await tx.doc(ScheduleDoc);
      for (const s of d.schedules) {
        const updated = byId.get(s.id);
        if (updated) {
          // Only touch lastRunAt when we actually fired it (a skipped slot keeps its prior value).
          if (updated.lastRunAt !== undefined) s.lastRunAt = updated.lastRunAt;
          s.nextRunAt = updated.nextRunAt;
        }
      }
    }, ctx);
  }

  /** Check in-flight fired slots; ping onFailure for any that settled `unanswered`. */
  private async settleFailures(entries: ScheduleEntry[]): Promise<void> {
    if (this.pendingFailure.size === 0) return;
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const [entryId, subId] of [...this.pendingFailure]) {
      let rec: SubmissionRecord | undefined;
      try {
        const sub = await this.harness.submission(subId, ctx);
        rec = sub ? await sub.status(ctx) : undefined;
      } catch {
        continue; // submission gone / harness closing — drop it
      }
      if (!rec || (rec.status !== "done" && rec.status !== "unanswered")) continue; // still in flight
      this.pendingFailure.delete(entryId);
      if (rec.status === "unanswered") {
        const entry = byId.get(entryId);
        this.log(`run for "${entryId}" settled unanswered (${rec.reason})`);
        if (entry) await this.onFailure?.(entry, rec);
      }
    }
  }

  /** Read every schedule (for tests / future API). */
  async list(): Promise<ScheduleEntry[]> {
    const doc = await this.harness.snapshot(ScheduleDoc, ctx);
    return doc?.schedules ?? [];
  }
}
