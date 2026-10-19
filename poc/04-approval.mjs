// Phase 3b — approval hook + durable decision (A6).
// Modes:
//   happy   — block → driver approves → model retries → action executes
//   crash   — submit, print SUBMITTED, keep waiting (parent kills -9 while pending)
//   recover — reopen after crash; wait idle; approve from transcript; retry; verify
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import { auroraModels, auroraModelId } from "./lib/aurora.mjs";
import { ApprovalDoc, approvalHook, dangerousTool, DANGEROUS_TOOL } from "./lib/approvals.mjs";
import { loadDotEnv } from "./lib/env.mjs";
loadDotEnv();

const mode = process.argv[2];
if (!["happy", "crash", "recover"].includes(mode)) {
  console.error("usage: node 04-approval.mjs <happy|crash|recover>");
  process.exit(2);
}

const ctx = BACKGROUND_CONTEXT;
const WORK = fileURLToPath(new URL("./work", import.meta.url));

const registry = createRegistry();
registry.install(CodingTools);
registry.install(
  defineExtension({
    name: "sensitive",
    tools: [dangerousTool()],
    hooks: [approvalHook()],
  }),
);

const h = await Harness.open(
  await openNodeSqliteStorage("./data/approval.sqlite"),
  {
    models: await auroraModels(),
    registry,
    env: () => new NodeExecutionEnv({ cwd: WORK }),
  },
  ctx,
);
h.resume();

const TASK =
  `Use the ${DANGEROUS_TOOL} tool to send the message "ship it now". ` +
  `If it is blocked pending human approval, report the approval key and stop — do not retry.`;

async function findApprovalKey() {
  const root = await h.root(ctx);
  const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 200), ctx);
  for (const item of page.items) {
    if ((item.kind ?? "") !== "pi.tool-result") continue;
    const s = JSON.stringify(item);
    const m = s.match(/Approval key: ([a-f0-9]{12})/);
    if (m) return m[1];
  }
  return undefined;
}

async function approve(key) {
  await h.commit(async (tx) => {
    const d = await tx.doc(ApprovalDoc, key, {});
    d.decision = "approved";
    d.decidedBy = "human-driver";
    return d;
  }, ctx);
  console.log(`approval written for key=${key}`);
}

async function verifyExecuted() {
  const root = await h.root(ctx);
  const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 200), ctx);
  const executed = page.items.some(
    (i) => (i.kind ?? "") === "pi.tool-result" && JSON.stringify(i).includes("ACTION EXECUTED"),
  );
  console.log(`dangerous_action executed in transcript: ${executed}`);
  return executed;
}

if (mode === "happy") {
  const root = await h.root(ctx, {
    agent: { model: { provider: "aurora", modelId: await auroraModelId() }, thinkingLevel: "medium" },
  });
  const sub1 = await root.submit({ type: "input", content: TASK, requestId: "ph3-appr-1" }, ctx);
  await sub1.wait(ctx);
  const key = await findApprovalKey();
  if (!key) {
    console.log("PHASE3-APPROVAL: FAIL — no blocked call / approval key found in transcript");
    process.exitCode = 1;
    await h.close(ctx);
    process.exit(1);
  }
  console.log(`blocked with approval key=${key}`);
  await approve(key);
  const sub2 = await root.submit(
    { type: "input", content: `The human has APPROVED action key ${key}. Retry ${DANGEROUS_TOOL} with the exact same arguments.`, requestId: "ph3-appr-2" },
    ctx,
  );
  const settled2 = await sub2.wait(ctx);
  console.log(`retry status=${settled2.status}`);
  if (settled2.status === "done") {
    const a = await root.commit((tx) => tx.entry(AssistantEntry, settled2.answer), ctx);
    console.log((a?.model ?? []).flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text)).join("\n").slice(0, 400));
  }
  const ok = await verifyExecuted();
  console.log(ok ? "PHASE3-APPROVAL: PASS" : "PHASE3-APPROVAL: FAIL");
  process.exitCode = ok ? 0 : 1;
  await h.close(ctx);
}

if (mode === "crash") {
  const root = await h.root(ctx, {
    agent: { model: { provider: "aurora", modelId: await auroraModelId() }, thinkingLevel: "medium" },
  });
  const sub1 = await root.submit({ type: "input", content: TASK, requestId: "ph3-appr-c" }, ctx);
  console.log("SUBMITTED");
  await sub1.wait(ctx); // parent kills -9 while this is pending
  await h.close(ctx);
}

if (mode === "recover") {
  const root = await h.root(ctx);
  console.log("waiting for in-flight run to settle after restart…");
  await root.waitForIdle(ctx);
  const key = await findApprovalKey();
  if (!key) {
    console.log("PHASE3-APPROVAL-CRASH: FAIL — approval key not found after restart");
    process.exitCode = 1;
    await h.close(ctx);
    process.exit(1);
  }
  console.log(`found pending approval key=${key} after restart`);
  await approve(key);
  const sub2 = await root.submit(
    { type: "input", content: `The human has APPROVED action key ${key}. Retry ${DANGEROUS_TOOL} with the exact same arguments.`, requestId: "ph3-appr-cr" },
    ctx,
  );
  const settled2 = await sub2.wait(ctx);
  console.log(`retry status=${settled2.status}`);
  const ok = await verifyExecuted();
  console.log(ok ? "PHASE3-APPROVAL-CRASH: PASS — pending approval survived SIGKILL; approved after restart" : "PHASE3-APPROVAL-CRASH: FAIL");
  process.exitCode = ok ? 0 : 1;
  await h.close(ctx);
}
