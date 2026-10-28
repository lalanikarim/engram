// M2.2 board client — the thin extension installed on a REMOTE instance so its brain can
// participate in another instance's board (the board owner is the system of record).
//
// The tools mirror the local board tools (board_jobs / claim_job / report_status /
// route_message) but are wired to the board owner's HTTP API instead of local docs. The
// remote instance keeps its own store; it never touches the owner's SQLite. Identity is
// per-instance (BOARD_MEMBER_ID): one remote member per instance for now.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export type BoardClientConfig = {
  /** Base URL of the board-owner instance (e.g. http://host:8791). */
  ownerUrl: string;
  /** Bearer token the board owner expects from this instance (its BOARD_PEER_TOKENS value). */
  token: string;
  /** This instance's member id on the owner's board. */
  memberId: string;
};

type JobView = {
  id: string;
  title: string;
  requester: string;
  assignee: string | null;
  payload: Record<string, unknown>;
  status: "open" | "claimed" | "done" | "failed";
  claimedBy: string | null;
  result: unknown;
};

async function ownerFetch(cfg: BoardClientConfig, method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${cfg.ownerUrl.replace(/\/+$/, "")}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
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

function text(out: string) {
  return { output: [{ type: "text" as const, text: out }] };
}

export function boardClientExtension(cfg: BoardClientConfig) {
  const boardJobsTool = defineTool({
    name: "board_jobs",
    description: "List the jobs on your board that concern you: open unclaimed work (claimable) plus jobs you have claimed.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, _api, _ctx) => {
      const { status, json } = await ownerFetch(cfg, "GET", "/board/jobs");
      if (status !== 200) return text(`board request failed: HTTP ${status} ${json?.error ?? ""}`.trim());
      const jobs: JobView[] = json.jobs ?? [];
      if (jobs.length === 0) return text("no visible jobs on the board");
      const lines = jobs.map((j) => `- ${j.id} [${j.status}] ${j.title}${j.assignee ? ` (assigned to ${j.assignee})` : ""}`);
      return text(`visible jobs:\n${lines.join("\n")}`);
    },
  });

  const claimJobTool = defineTool({
    name: "claim_job",
    description: "Claim an open job on your board (atomic — exactly one member wins).",
    parameters: Type.Object({ jobId: Type.String() }),
    replay: "unsafe",
    execute: async (args, _api, _ctx) => {
      const { status, json } = await ownerFetch(cfg, "POST", "/board/jobs/claim", { jobId: args.jobId });
      if (status === 200) return text(`claimed ${json.job.id}: ${json.job.title}`);
      return text(`claim failed: HTTP ${status} ${json?.error ?? ""}`.trim());
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
    execute: async (args, _api, _ctx) => {
      const { status, json } = await ownerFetch(cfg, "POST", `/board/jobs/${encodeURIComponent(args.jobId)}/status`, {
        status: args.status,
        result: args.result ?? null,
      });
      if (status === 200) return text(`job ${args.jobId} -> ${args.status}`);
      return text(`report failed: HTTP ${status} ${json?.error ?? ""}`.trim());
    },
  });

  const routeMessageTool = defineTool({
    name: "route_message",
    description: "Send a message to another member or channel on your board (delivered as untrusted data).",
    parameters: Type.Object({
      to: Type.String({ description: "Target member id or channel id." }),
      content: Type.String({ description: "Message body (plain text)." }),
    }),
    replay: "unsafe", // delivery is a side effect; exactly-once via the owner's stable requestId
    execute: async (args, _api, _ctx) => {
      const { status, json } = await ownerFetch(cfg, "POST", "/board/route", { to: args.to, content: args.content });
      if (status === 200) return text(json.message ?? `routed message to ${args.to}`);
      return text(`route failed: HTTP ${status} ${json?.error ?? ""}`.trim());
    },
  });

  return defineExtension({ name: "board-client", tools: [boardJobsTool, claimJobTool, reportStatusTool, routeMessageTool] });
}
