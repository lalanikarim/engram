// Phase 6 — compaction on a local model (A4).
// Uses a deliberately small window (8192) so threshold/background compaction fires
// within a few turns; the mechanism is identical at the real 228k window.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import { auroraModels, auroraModelId } from "./lib/aurora.mjs";
import { loadDotEnv } from "./lib/env.mjs";
loadDotEnv();

const ctx = BACKGROUND_CONTEXT;
const WORK = fileURLToPath(new URL("./work", import.meta.url));

const FACTS = [
  "the lighthouse keeper's cat is named Marlowe",
  "the backup key is under the blue tile in the courtyard",
  "our deploy window is Thursdays at 09:00 UTC",
  "the test database password is stored in vault entry qa-db-7",
  "the vendor invoice deadline is the 15th of each month",
  "the emergency contact for the rooftop server is Dana at extension 4421",
];
const CHECKS = ["Marlowe", "blue tile", "Thursdays", "qa-db-7", "15th", "Dana"];

const registry = createRegistry();
registry.install(CodingTools);

const h = await Harness.open(
  await openNodeSqliteStorage("./data/compaction.sqlite"),
  {
    // pi-ai always reserves 4096 tokens of headroom (CONTEXT_SAFETY_TOKENS), so the
    // window must be > prompt + 4096. 8192 leaves ~3k for output and fires compaction early.
    models: await auroraModels({ contextWindow: 8192, maxTokens: 4096 }),
    registry,
    env: () => new NodeExecutionEnv({ cwd: WORK }),
    settings: {
      // blocking threshold = 8192-2000 = 6192; background starts at 5792
      compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 800, backgroundTokens: 400 },
    },
  },
  ctx,
);
h.resume();

const root = await h.root(ctx, {
  agent: { model: { provider: "aurora", modelId: await auroraModelId() }, thinkingLevel: "off" },
});

let pass = true;
const check = (label, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) pass = false;
};

async function ask(content, requestId) {
  const sub = await root.submit({ type: "input", content, requestId }, ctx);
  const settled = await sub.wait(ctx);
  let answer = "";
  if (settled.status === "done") {
    const a = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
    answer = (a?.model ?? []).flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text)).join("\n");
  } else {
    console.log(`  [${requestId}] status=${settled.status} ${JSON.stringify(settled.reason ?? "")}`);
  }
  return { settled, answer };
}

// --- six fact turns; manual compaction after the third ---
for (let i = 1; i <= 6; i++) {
  const { settled, answer } = await ask(
    `Remember fact ${i}: ${FACTS[i - 1]}. Now write a short paragraph (about six sentences) elaborating on that fact in the context of running a small remote observatory. End your reply with exactly: OK-${i}.`,
    `ph6-f${i}`,
  );
  console.log(`fact ${i}: ${settled.status} → ${answer.trim().slice(0, 40)}`);
  check(`fact ${i} turn done`, settled.status === "done");

  if (i === 3) {
    const taskId = await root.compact(
      "Summarize the conversation so far. Keep every remembered fact verbatim and note any open questions.",
      ctx,
    );
    const settledTask = await h.waitForTask(taskId, ctx);
    const result = settledTask.state.outcome.result;
    console.log(`manual compaction: ${JSON.stringify(result)}`);
    check("manual compaction produced a summary", Boolean(result.entryId ?? result.submissionId));
  }
}

// --- post-compaction recall: only answerable from pre-compaction history ---
const { settled, answer } = await ask(
  "List every fact I asked you to remember, numbered. Be exact.",
  "ph6-recall",
);
console.log(`\nrecall answer:\n${answer.slice(0, 800)}`);
check("recall turn done", settled.status === "done");
const found = CHECKS.filter((c) => answer.toLowerCase().includes(c.toLowerCase()));
console.log(`facts recalled: ${found.length}/6 (${found.join(", ")})`);
check("all six facts survived compaction", found.length === 6);

// --- transcript audit: compaction entries and reasons ---
const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 500), ctx);
const comps = page.items.filter((i) => (i.kind ?? "") === "pi.compaction");
console.log(`\ncompaction entries: ${comps.length}`);
for (const c of comps) {
  const s = JSON.stringify(c.data ?? c.model ?? {});
  console.log("  -", s.slice(0, 220));
}
check("at least one compaction entry in transcript", comps.length >= 1);

console.log(pass ? "\nPHASE6-COMPACTION: PASS" : "\nPHASE6-COMPACTION: FAIL");
process.exitCode = pass ? 0 : 1;
await h.close(ctx);
