// M2 remote member transport — unit tests (no live model).
// Covers: peer-token env parsing, endpoint validation, stable message request ids,
// remote registration + route resolution + trust-tier interaction, and the HTTP dispatch
// against a local stub server (auth header, body shape, status handling).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildCatalog } from "../src/model.ts";
import type { Models } from "@earendil-works/pi-ai";
import {
  boardExtension,
  canRouteInTx,
  dispatchRemoteMessage,
  messageRequestId,
  parsePeerTokens,
  readBoardDashboard,
  registerMemberInTx,
  resolveRouteInTx,
  validateEndpoint,
  visibleJobsFor,
  type Job,
} from "../src/extensions/board.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ctx = BACKGROUND_CONTEXT;
const base = mkdtempSync(path.join(tmpdir(), "engram-board-remote-"));
const dataDir = path.join(base, "data");
const workDir = path.join(base, "work");
const agentDir = path.join(base, "agent");
for (const d of [dataDir, workDir, agentDir]) mkdirSync(d, { recursive: true });

// A dead custom provider — member registration never generates, so it is never hit.
writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      localbox: {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "local-key",
        api: "openai-completions",
        models: [{ id: "m-a", contextWindow: 4000, maxTokens: 500 }],
      },
    },
  }),
);

// ---- pure helpers ----
{
  const m = parsePeerTokens({ BOARD_PEER_TOKENS: "peer-a:tokA, peer-b: tokB" });
  check("parsePeerTokens parses name:token pairs", m.get("peer-a") === "tokA" && m.get("peer-b") === "tokB" && m.size === 2);
}
{
  const m = parsePeerTokens({ BOARD_PEER_TOKENS: "no-colon,:empty-token,ok:t, ,good:g" });
  check("parsePeerTokens skips malformed parts", m.size === 2 && m.get("ok") === "t" && m.get("good") === "g");
}
check("parsePeerTokens empty/unset → empty map", parsePeerTokens({}).size === 0 && parsePeerTokens({ BOARD_PEER_TOKENS: "" }).size === 0);
check(
  "validateEndpoint accepts http(s), rejects others",
  validateEndpoint("http://host:8791") === null &&
    validateEndpoint("https://h.example") === null &&
    validateEndpoint("ftp://x") !== null &&
    validateEndpoint("not a url") !== null,
);
{
  const a = messageRequestId("coordinator", "remote-1", "hello");
  const b = messageRequestId("coordinator", "remote-1", "hello");
  const c = messageRequestId("coordinator", "remote-1", "hello!");
  check("messageRequestId is stable and content-sensitive", a === b && a !== c && a.startsWith("msg-"));
}

{
  const mk = (id: string, status: Job["status"], assignee: string | null): Job => ({ id, title: id, requester: "coordinator", assignee, payload: {}, status, claimedBy: assignee, result: null });
  const jobs = [mk("a", "open", null), mk("b", "claimed", "peer-b"), mk("c", "claimed", "other"), mk("d", "done", "peer-b")];
  const visible = visibleJobsFor(jobs, "peer-b").map((j) => j.id).sort();
  check("visibleJobsFor: peers see open-unassigned + their own claimed jobs only", visible.join(",") === "a,b");
}

// ---- harness-backed: registration, resolution, trust tier ----
async function openHarness(dbPath: string, models: Models) {
  const registry = createRegistry();
  registry.install(boardExtension());
  const h = await Harness.open(
    await openNodeSqliteStorage(dbPath),
    {
      models,
      registry,
      env: (target) => new NodeExecutionEnv({ cwd: target.cwd ? path.join(workDir, target.cwd) : workDir }),
    },
    ctx,
  );
  h.resume();
  return h;
}

async function main() {
  const { models } = await buildCatalog({ agentDir, env: {} });
  const h = await openHarness(path.join(dataDir, "board.sqlite"), models);

  // A local member (as before) and a remote member.
  await h.commit(
    (tx) => registerMemberInTx(tx, { id: "local-1", name: "Local One", kind: "member", conversationId: 42, trustLevel: "trusted", capabilities: [], allowedTargets: ["remote-1"], status: "active", description: "" }),
    ctx,
  );
  await h.commit(
    (tx) => registerMemberInTx(tx, { id: "remote-1", name: "Remote One", kind: "member", conversationId: 7, trustLevel: "untrusted", capabilities: [], allowedTargets: [], status: "active", description: "", endpoint: "http://peer.example:8791", tokenRef: "peer-a" }),
    ctx,
  );

  const rLocal = await h.commit((tx) => resolveRouteInTx(tx, "local-1"), ctx);
  check("local member resolves without endpoint", rLocal !== null && rLocal.kind === "member" && rLocal.conversationId === 42 && rLocal.endpoint === undefined);

  const rRemote = await h.commit((tx) => resolveRouteInTx(tx, "remote-1"), ctx);
  check("remote member resolves with endpoint + tokenRef", rRemote !== null && rRemote.kind === "member" && rRemote.endpoint === "http://peer.example:8791" && rRemote.tokenRef === "peer-a" && rRemote.conversationId === 7);

  const dash = await readBoardDashboard(h, ctx);
  const remoteDash = dash.members.find((m) => m.id === "remote-1");
  check("dashboard carries the remote endpoint", remoteDash?.endpoint === "http://peer.example:8791" && remoteDash?.trustLevel === "untrusted");

  // Trust tier still governs remote targets exactly like local ones.
  check("allowlisted member may route to a remote target", (await h.commit((tx) => canRouteInTx(tx, "local-1", "remote-1"), ctx)) === true);
  const remoteSender = await h.commit(
    (tx) => registerMemberInTx(tx, { id: "remote-2", name: "Remote Two", kind: "member", conversationId: 8, trustLevel: "untrusted", capabilities: [], allowedTargets: [], status: "active", description: "", endpoint: "http://peer2.example:8791", tokenRef: "peer-b" }),
    ctx,
  );
  void remoteSender;
  check("barred member may not route to a remote target", (await h.commit((tx) => canRouteInTx(tx, "remote-2", "remote-1"), ctx)) === false);

  // Re-registering the same id as local clears the remote fields (idempotent update).
  await h.commit(
    (tx) => registerMemberInTx(tx, { id: "remote-1", name: "Remote One", kind: "member", conversationId: 7, trustLevel: "untrusted", capabilities: [], allowedTargets: [], status: "active", description: "" }),
    ctx,
  );
  const rAgain = await h.commit((tx) => resolveRouteInTx(tx, "remote-1"), ctx);
  check("re-registration without endpoint clears remote fields", rAgain !== null && rAgain.endpoint === undefined);

  await h.close(ctx);

  // ---- dispatch against a stub peer server ----
  const received: Array<{ auth: string; body: any }> = [];
  const stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      received.push({ auth: req.headers.authorization ?? "", body: JSON.parse(raw || "{}") });
      if (process.env.STUB_STATUS === "500") res.writeHead(500);
      else res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ submissionId: 1 }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const port = (stub.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${port}`;

  await dispatchRemoteMessage({ endpoint, token: "tok-a", conversationId: 7, content: "hello remote", requestId: "msg-abc123" });
  check("dispatch POSTs /tasks with bearer auth + full body", received.length === 1 && received[0].auth === "Bearer tok-a" && received[0].body.content === "hello remote" && received[0].body.requestId === "msg-abc123" && received[0].body.conversationId === 7);

  process.env.STUB_STATUS = "500";
  let threw = false;
  try {
    await dispatchRemoteMessage({ endpoint, token: "tok-a", conversationId: 7, content: "x", requestId: "msg-def" });
  } catch (e) {
    threw = String((e as Error).message).includes("500");
  }
  check("non-202 peer response throws with the status", threw);

  process.env.STUB_STATUS = "";
  let netThrew = false;
  try {
    await dispatchRemoteMessage({ endpoint: "http://127.0.0.1:9", token: "t", conversationId: 1, content: "x", requestId: "msg-ghi" });
  } catch {
    netThrew = true;
  }
  check("unreachable peer throws (fail-safe for the caller)", netThrew);

  stub.close();
  rmSync(base, { recursive: true, force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
