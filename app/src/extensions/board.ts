// The shared board store (Project 0).
//
// A session-scoped coordination store any conversation can read/write through
// atomic `api.commit` transactions: member profiles, jobs, and index singletons
// that make the families enumerable (pi-durable has no doc-family scan). This is
// the "broker" half of the board — the durable system of record. The coordinator
// conversation (the engram brain) sits on top; see docs/research/board.md and
// docs/plans/project-0-board.md.
//
// Phase 0a: store + register/post_job/board_status. Phase 0b adds claim_job/
// report_status, standing named members (per-member workspace), and member
// self-identity. Routing/comms and knowledge come in Phases 0c–0d.
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  configure,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTool,
  type AgentChange,
  type ConversationId,
  type DocumentReader,
  type JsonObject,
  type ModelRef,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";

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

// Member self-identity (req 5): a conversation-scoped doc mapping each member's
// conversation to its board id, so claim/report resolve "me" without the caller
// passing it by hand. Absent/empty → the conversation is not a registered member.
const MemberIdDoc = defineDoc({
  scope: "conversation",
  history: "latest",
  fork: "current",
  kind: "board.memberId",
  version: 1,
  initial: () => ({ memberId: "" }),
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

/** Atomic single-winner claim of an open job. Returns the claimed job, or null if not open. */
export async function claimJobInTx(tx: Tx, jobId: string, meId: string): Promise<Job | null> {
  const d = await tx.doc(JobDoc, jobId, {});
  if (d.status !== "open") return null; // already claimed / unknown → single-winner guard
  d.assignee = meId;
  d.status = "claimed";
  d.claimedBy = meId;
  const idx = await tx.doc(JobIndexDoc);
  idx.open = idx.open.filter((x) => x !== jobId);
  return { ...d };
}

/** Durable status update for a job (done/failed) with an optional result. */
export async function reportStatusInTx(tx: Tx, jobId: string, status: "done" | "failed", result: JsonValue | null): Promise<Job> {
  const d = await tx.doc(JobDoc, jobId, {});
  d.status = status;
  d.result = result;
  return { ...d };
}

/** Read a job by id (null if never posted). */
export async function readJobInTx(tx: Tx, jobId: string): Promise<Job | null> {
  const d = await tx.doc(JobDoc, jobId, {});
  return d.id === "" ? null : { ...d };
}

/** A standing member to create: its own conversation + workspace (cwd) + tools. */
export type CreateMemberSpec = {
  name: string;
  model: ModelRef;
  /** Omit → the member gets every installed extension by default. */
  tools?: readonly ToolRegistration[];
  capabilities?: string[];
  trustLevel?: "trusted" | "untrusted";
  instructions?: string;
};

/**
 * Create a standing named member in one commit: an ownerless conversation with its own
 * workspace (cwd = name) + tools, registered on the board, and given self-identity.
 * Returns the new conversation id.
 */
export async function createMemberInTx(tx: Tx, spec: CreateMemberSpec): Promise<ConversationId> {
  const agent: AgentChange = {
    model: spec.model,
    thinkingLevel: "medium",
    cwd: spec.name, // harness env maps this to workRoot/<name> (per-member workspace)
    instructions:
      spec.instructions ??
      `You are "${spec.name}", a standing member on the shared board. Claim open jobs that fit you, do the work in your own workspace, and report the result with report_status.`,
    ...(spec.tools ? { tools: spec.tools } : {}),
  };
  const rec = await tx.createConversation({ ownership: { kind: "ownerless" } });
  await configure(tx, rec.id, agent);
  await registerMemberInTx(tx, {
    id: spec.name,
    name: spec.name,
    kind: "member",
    conversationId: rec.id,
    trustLevel: spec.trustLevel ?? "trusted",
    capabilities: spec.capabilities ?? [],
    description: "",
  });
  const ident = await tx.doc(MemberIdDoc, rec.id);
  ident.memberId = spec.name;
  return rec.id;
}

/** Resolve a member id from a conversation's identity doc (null if not a registered member). */
export async function memberIdentityOf(reader: DocumentReader, conversationId: ConversationId, ctx: Context): Promise<string | null> {
  const d = await reader.snapshot(MemberIdDoc, conversationId, ctx);
  return d && d.memberId ? d.memberId : null;
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

const claimJobTool = defineTool({
  name: "claim_job",
  description: "Claim an open job on the board (atomic — exactly one member wins). Your identity is resolved from this conversation.",
  parameters: Type.Object({ jobId: Type.String() }),
  replay: "unsafe",
  execute: async (args, api, ctx) => {
    const me = await memberIdentityOf(api, api.conversationId, ctx);
    if (!me) return { output: [{ type: "text" as const, text: "not a registered member — cannot claim" }] };
    const job = await api.commit((tx) => claimJobInTx(tx, args.jobId, me), ctx);
    const text = job ? `claimed ${job.id}: ${job.title}` : "not open (already claimed or unknown)";
    return { output: [{ type: "text" as const, text }] };
  },
});

const reportStatusTool = defineTool({
  name: "report_status",
  description: "Report the outcome of a job you claimed (done/failed) with an optional result.",
  parameters: Type.Object({
    jobId: Type.String(),
    status: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
    result: Type.Optional(Type.String()),
  }),
  replay: "unsafe",
  execute: async (args, api, ctx) => {
    const me = await memberIdentityOf(api, api.conversationId, ctx);
    if (!me) return { output: [{ type: "text" as const, text: "not a registered member — cannot report" }] };
    const job = await api.commit((tx) => reportStatusInTx(tx, args.jobId, args.status, args.result ?? null), ctx);
    return { output: [{ type: "text" as const, text: `job ${job.id} -> ${args.status}` }] };
  },
});

const createMemberTool = defineTool({
  name: "create_member",
  description: "Create a standing named member (own conversation + workspace) and register it on the board. Coordinator only.",
  parameters: Type.Object({
    name: Type.String({ description: "Unique member name/id." }),
    capabilities: Type.Optional(Type.Array(Type.String())),
    instructions: Type.Optional(Type.String()),
  }),
  replay: "unsafe",
  execute: async (args, api, ctx) => {
    const agent = await api.agent(ctx);
    const model = agent.model;
    if (!model) return { output: [{ type: "text" as const, text: "no model available to give the member" }] };
    // Default member tool set: board member tools + file/shell (not coordinator-only register/post_job).
    const wanted = new Set(["claim_job", "report_status", "board_status", "read", "write", "edit", "bash"]);
    const tools = api.registry.tools().map((t) => t.tool).filter((t) => wanted.has(t.name));
    const conversationId = await api.commit(
      (tx) => createMemberInTx(tx, { name: args.name, model, tools, capabilities: args.capabilities ?? [], instructions: args.instructions }),
      ctx,
    );
    return { output: [{ type: "text" as const, text: `created member "${args.name}" (conversation ${conversationId})` }] };
  },
});

/** The board extension: installs the Phase 0a + 0b tools. */
export function boardExtension() {
  return defineExtension({ name: "board", tools: [registerTool, postJobTool, boardStatusTool, claimJobTool, reportStatusTool, createMemberTool] });
}
