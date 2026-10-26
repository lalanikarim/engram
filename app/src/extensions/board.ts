// The shared board store (Project 0, Phase 0a).
//
// A session-scoped coordination store any conversation can read/write through
// atomic `api.commit` transactions: member profiles, jobs, and index singletons
// that make the families enumerable (pi-durable has no doc-family scan). This is
// the "broker" half of the board — the durable system of record. The coordinator
// conversation (the engram brain) sits on top; see docs/research/board.md and
// docs/plans/project-0-board.md.
//
// Phase 0a delivers the store + register/post_job/board_status. claim/report,
// standing members, routing, and knowledge come in Phases 0b–0d.
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineDocFamily, defineExtension, defineTool, type JsonObject, type Tx } from "@earendil-works/pi-durable";

// ---- Board doc definitions (session-scoped) ----------------------------------

/** A board member: the coordinator or a standing engram. */
export type EngramProfile = {
  id: string;
  name: string;
  kind: "coordinator" | "member";
  /** The pi-durable conversation that is this member (M1: in-harness). */
  conversationId: number;
  trustLevel: "trusted" | "untrusted";
  capabilities: string[];
  description: string;
};

/** A unit of work posted to the board. */
export type Job = {
  id: string;
  title: string;
  requester: string;
  assignee: string | null;
  payload: JsonObject;
  status: "open" | "claimed" | "done" | "failed";
  claimedBy: string | null;
  result: JsonValue | null;
};

export type BoardStatus = { members: EngramProfile[]; openJobs: Job[] };

const EngramDoc = defineDocFamily<EngramProfile, JsonValue>({
  family: true,
  scope: "session",
  kind: "board.engram",
  version: 1,
  initial: () => ({ id: "", name: "", kind: "member", conversationId: 0, trustLevel: "untrusted", capabilities: [], description: "" }),
});

const JobDoc = defineDocFamily<Job, JsonValue>({
  family: true,
  scope: "session",
  kind: "board.job",
  version: 1,
  initial: () => ({ id: "", title: "", requester: "", assignee: null, payload: {}, status: "open", claimedBy: null, result: null }),
});

// Index singletons — the only way to enumerate a family (no doc-family scan API).
const EngramIndexDoc = defineDoc<{ ids: string[] }>({
  scope: "session",
  kind: "board.engramIndex",
  version: 1,
  initial: () => ({ ids: [] }),
});

const JobIndexDoc = defineDoc<{ open: string[] }>({
  scope: "session",
  kind: "board.jobIndex",
  version: 1,
  initial: () => ({ open: [] }),
});

// ---- Commit-level helpers (the core logic; testable without a model) --------

/** Register (or update) a member and index it. Idempotent on id. */
export async function registerMemberInTx(tx: Tx, profile: EngramProfile): Promise<void> {
  const d = await tx.doc(EngramDoc, profile.id, {});
  d.id = profile.id;
  d.name = profile.name;
  d.kind = profile.kind;
  d.conversationId = profile.conversationId;
  d.trustLevel = profile.trustLevel;
  d.capabilities = profile.capabilities;
  d.description = profile.description;
  const idx = await tx.doc(EngramIndexDoc);
  if (!idx.ids.includes(profile.id)) idx.ids.push(profile.id);
}

/** Post a job and index it as open. */
export async function postJobInTx(tx: Tx, job: Job): Promise<void> {
  const d = await tx.doc(JobDoc, job.id, {});
  d.id = job.id;
  d.title = job.title;
  d.requester = job.requester;
  d.assignee = job.assignee;
  d.payload = job.payload;
  d.status = job.status;
  d.claimedBy = job.claimedBy;
  d.result = job.result;
  const idx = await tx.doc(JobIndexDoc);
  if (!idx.open.includes(job.id)) idx.open.push(job.id);
}

/** Read the board summary: registered members + currently-open jobs. */
export async function readBoardStatusInTx(tx: Tx): Promise<BoardStatus> {
  const engIdx = await tx.doc(EngramIndexDoc);
  const members: EngramProfile[] = [];
  for (const id of engIdx.ids) members.push({ ...(await tx.doc(EngramDoc, id, {})) });
  const jobIdx = await tx.doc(JobIndexDoc);
  const openJobs: Job[] = [];
  for (const id of jobIdx.open) {
    const j = await tx.doc(JobDoc, id, {});
    if (j.status === "open") openJobs.push({ ...j });
  }
  return { members, openJobs };
}

// ---- Tools -------------------------------------------------------------------

const registerTool = defineTool({
  name: "register",
  description: "Register an engram member on the shared board (coordinator only). Idempotent on id.",
  parameters: Type.Object({
    id: Type.String({ description: "Stable member id (unique)." }),
    name: Type.String({ description: "Human-readable member name." }),
    kind: Type.Union([Type.Literal("member"), Type.Literal("coordinator")]),
    conversationId: Type.Number({ description: "The pi-durable conversation that is this member." }),
    trustLevel: Type.Union([Type.Literal("trusted"), Type.Literal("untrusted")]),
    capabilities: Type.Array(Type.String()),
  }),
  replay: "unsafe",
  execute: async (args, api, ctx) => {
    await api.commit(
      async (tx) =>
        registerMemberInTx(tx, {
          id: args.id,
          name: args.name,
          kind: args.kind,
          conversationId: args.conversationId,
          trustLevel: args.trustLevel,
          capabilities: args.capabilities,
          description: "",
        }),
      ctx,
    );
    const text = `Registered ${args.kind} "${args.name}" (${args.id}).`;
    return { output: [{ type: "text" as const, text }] };
  },
});

const postJobTool = defineTool({
  name: "post_job",
  description: "Post a unit of work to the board as open (coordinator/human). Members claim it with claim_job.",
  parameters: Type.Object({
    id: Type.String({ description: "Stable job id (unique)." }),
    title: Type.String({ description: "Short title." }),
    requester: Type.String({ description: "Member id of who requested the work." }),
    assignee: Type.Optional(Type.String({ description: "Optional target member id (else any eligible claimer)." })),
    payload: Type.Record(Type.String(), Type.Any(), { description: "Free-form work payload." }),
  }),
  replay: "unsafe",
  execute: async (args, api, ctx) => {
    await api.commit(
      async (tx) =>
        postJobInTx(tx, {
          id: args.id,
          title: args.title,
          requester: args.requester,
          assignee: args.assignee ?? null,
          payload: args.payload ?? {},
          status: "open",
          claimedBy: null,
          result: null,
        }),
      ctx,
    );
    const text = `Posted open job "${args.id}" — ${args.title}.`;
    return { output: [{ type: "text" as const, text }] };
  },
});

const boardStatusTool = defineTool({
  name: "board_status",
  description: "Read the shared board: registered members and currently-open jobs.",
  parameters: Type.Object({}),
  replay: "safe", // read-only — safe to rerun after a crash
  execute: async (_args, api, ctx) => {
    const status = await api.commit(async (tx) => readBoardStatusInTx(tx), ctx);
    const lines: string[] = [];
    lines.push(`Members (${status.members.length}):`);
    for (const m of status.members) lines.push(`  - ${m.name} [${m.kind}, ${m.trustLevel}] (${m.id})`);
    lines.push(`Open jobs (${status.openJobs.length}):`);
    for (const j of status.openJobs) lines.push(`  - ${j.id}: ${j.title} (requester ${j.requester}${j.assignee ? `, assignee ${j.assignee}` : ""})`);
    return { output: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});

/** The board extension: installs the Phase 0a tools. */
export function boardExtension() {
  return defineExtension({ name: "board", tools: [registerTool, postJobTool, boardStatusTool] });
}
