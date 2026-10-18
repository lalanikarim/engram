// Phase 6b — natural (threshold/background) compaction: same setup as 08, more turns,
// no manual trigger. Expects at least one pi.compaction entry with reason "threshold"
// and an uninterrupted conversation.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import { auroraModels, auroraModelId } from "./lib/aurora.mjs";

const ctx = BACKGROUND_CONTEXT;
const WORK = fileURLToPath(new URL("./work", import.meta.url));

const registry = createRegistry();
registry.install(CodingTools);

const h = await Harness.open(
  await openNodeSqliteStorage("./data/compaction-bg.sqlite"),
  {
    models: auroraModels({ contextWindow: 8192, maxTokens: 4096 }),
    registry,
    env: () => new NodeExecutionEnv({ cwd: WORK }),
    // reserveTokens must exceed pi-ai's fixed 4096-token safety margin, otherwise
    // generation dies (max_completion_tokens→1) before the harness threshold fires.
    settings: {
      compaction: { enabled: true, reserveTokens: 5000, keepRecentTokens: 800, backgroundTokens: 400 },
    },
  },
  ctx,
);
h.resume();

const root = await h.root(ctx, {
  agent: { model: { provider: "aurora", modelId: auroraModelId() }, thinkingLevel: "off" },
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

const TOPICS = [
  "the observatory's primary telescope is a 0.6m Ritchey-Chrétien",
  "our nightly calibration routine takes about forty minutes",
  "the dome rotates at one degree per second maximum",
  "we lose roughly two weeks of observing each year to lunar windows",
  "the weather station on the ridge feeds our cloud forecast model",
  "the backup generator holds twelve hours of fuel",
  "our data pipeline writes raw frames to the local NAS first",
  "the visitor program runs three weekends per season",
  "the spectrograph grating was replaced last winter",
  "our grant report is due the first Monday of March",
];

for (let i = 1; i <= TOPICS.length; i++) {
  const t0 = Date.now();
  const { settled, answer } = await ask(
    `Context: we run a small remote observatory. New detail ${i}: ${TOPICS[i - 1]}. Write a short paragraph (about eight sentences) working this into the observatory's operations. End with exactly: OK-${i}.`,
    `ph6b-t${i}`,
  );
  console.log(`turn ${i}: ${settled.status} (${((Date.now() - t0) / 1000).toFixed(1)}s, answer ${answer.length} chars)`);
  check(`turn ${i} done`, settled.status === "done");
}

const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 500), ctx);
const comps = page.items.filter((i) => (i.kind ?? "") === "pi.compaction");
console.log(`\ncompaction entries: ${comps.length}`);
for (const c of comps) console.log("  -", JSON.stringify(c.data ?? {}));
check("threshold/background compaction fired naturally", comps.some((c) => (c.data?.reason ?? "") === "threshold"));

// conversation still functional after natural compaction
const { settled, answer } = await ask(
  "How long does the backup generator hold fuel? Answer in one sentence.",
  "ph6b-check",
);
console.log(`post-compaction check: ${settled.status} → ${answer.trim().slice(0, 120)}`);
check("post-compaction turn done and correct", settled.status === "done" && /twelve hours/i.test(answer));

console.log(pass ? "\nPHASE6B-BACKGROUND-COMPACTION: PASS" : "\nPHASE6B-BACKGROUND-COMPACTION: FAIL");
process.exitCode = pass ? 0 : 1;
await h.close(ctx);
