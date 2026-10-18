// Phase 4b — Telegram long-polling client (A8). Outbound-only: no inbound ports.
// - Incoming text → root.submit({requestId: "tg-<update_id>"}) (exactly-once vs Telegram retries)
// - Progress: one edited message per run (throttled ~2s) showing current tool call
// - Final answer posted on run_end
// - Blocked dangerous_action → inline Approve/Deny buttons; callback writes the
//   durable approval decision and instructs the agent to retry (Phase 3 path).
// Requires TELEGRAM_BOT_TOKEN env var. Run: node 06-telegram.mjs
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, watchEvents } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import { auroraModels, auroraModelId } from "./lib/aurora.mjs";
import { ApprovalDoc, approvalHook, dangerousTool } from "./lib/approvals.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN env var required (create a bot via @BotFather → /newbot)");
  process.exit(2);
}
const API = `https://api.telegram.org/bot${TOKEN}`;

const ctx = BACKGROUND_CONTEXT;
const WORK = fileURLToPath(new URL("./work", import.meta.url));

const registry = createRegistry();
registry.install(CodingTools);
registry.install(defineExtension({ name: "sensitive", tools: [dangerousTool()], hooks: [approvalHook()] }));

const h = await Harness.open(
  await openNodeSqliteStorage("./data/telegram.sqlite"),
  { models: auroraModels(), registry, env: () => new NodeExecutionEnv({ cwd: WORK }) },
  ctx,
);
h.resume();
const root = await h.root(ctx, {
  agent: { model: { provider: "aurora", modelId: auroraModelId() }, thinkingLevel: "medium" },
});

// --- Telegram API helpers (outbound HTTPS only) ---
async function tg(method, payload = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
  return json.result;
}

// --- event stream → progress message + final answer on run_end ---
let progressMsgId = null;
let lastEditAt = 0;
const postedApprovals = new Set();

function startRunWatcher() {
  const stream = watchEvents(h, root.id, ctx);
  stream.start(async (events) => {
    for (const ev of events) {
      try {
        if (ev.type === "run_end") {
          progressMsgId = null; // next run gets a fresh progress message
          const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 10), ctx);
          const latest = page.items.find((i) => (i.kind ?? "") === "pi.assistant");
          const text = (latest?.model?.[0]?.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          if (text.trim()) await postFinalAnswer(text);
          continue;
        }
        const now = Date.now();
        if (now - lastEditAt < 2000) continue; // throttle edits (~Telegram rate limits)
        let statusLine = "thinking…";
        if (ev.type === "tool_execution_start") statusLine = `🔧 ${ev.toolName}(${JSON.stringify(ev.args).slice(0, 80)})`;
        else if (ev.type === "message_update" && ev.usage.output > 0) statusLine = "✍️ writing…";
        lastEditAt = now;
        await sendProgress(statusLine);
      } catch (e) {
        console.error("watcher:", e.message);
      }
    }
  }, ctx);
}

async function sendProgress(line) {
  const chatId = ownerChatId;
  if (!chatId) return;
  const text = `⏳ ${line}`;
  try {
    if (progressMsgId === null) {
      const r = await tg("sendMessage", { chat_id: chatId, text });
      progressMsgId = r.message_id;
    } else {
      await tg("editMessageText", { chat_id: chatId, message_id: progressMsgId, text });
    }
  } catch (e) {
    console.error("progress:", e.message);
  }
}

async function postFinalAnswer(text) {
  if (!ownerChatId) return;
  try {
    await tg("sendMessage", { chat_id: ownerChatId, text: text.slice(0, 4000) });
  } catch (e) {
    console.error("final:", e.message);
  }
}

async function postApprovalRequest(key) {
  if (!ownerChatId) return;
  await tg("sendMessage", {
    chat_id: ownerChatId,
    text: `⚠️ The agent wants to run a sensitive action and needs your approval.\nApproval key: \`${key}\``,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:${key}` },
          { text: "❌ Deny", callback_data: `deny:${key}` },
        ],
      ],
    },
  });
}

// --- update loop (long polling; outbound only) ---
let ownerChatId = null;
let offset = 0;
startRunWatcher();

console.log("telegram bot polling…");
while (true) {
  let updates;
  try {
    updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
  } catch (e) {
    console.error("getUpdates:", e.message);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  for (const u of updates) {
    offset = u.update_id + 1;
    if (u.message) {
      const chatId = u.message.chat.id;
      if (ownerChatId === null) {
        ownerChatId = chatId;
        await tg("sendMessage", { chat_id: chatId, text: "Project brain online. Send me a task." }).catch(() => {});
      } else if (chatId !== ownerChatId) {
        await tg("sendMessage", { chat_id: chatId, text: "This bot is bound to another chat for the PoC." }).catch(() => {});
        continue;
      }
      const text = u.message.text?.trim();
      if (!text) continue;
      const sub = await root.submit({ type: "input", content: text, requestId: `tg-${u.update_id}` }, ctx);
      // answer arrives via the watcher's final-answer path (run_end → latest assistant entry)
      void sub;
    } else if (u.callback_query) {
      const { data, from } = u.callback_query;
      await tg("answerCallbackQuery", { callback_query_id: u.callback_query.id }).catch(() => {});
      const [decision, key] = data.split(":");
      if (key && ["approve", "deny"].includes(decision)) {
        await h.commit(async (tx) => {
          const d = await tx.doc(ApprovalDoc, key, {});
          d.decision = decision === "approve" ? "approved" : "denied";
          d.decidedBy = `telegram:${from.first_name ?? "user"}`;
          return d;
        }, ctx);
        if (decision === "approve") {
          await root.submit(
            { type: "input", content: `The human APPROVED action key ${key} via Telegram. Retry the sensitive action with the exact same arguments.`, requestId: `tg-approve-${u.update_id}` },
            ctx,
          );
        } else {
          await root.submit(
            { type: "input", content: `The human DENIED action key ${key} via Telegram. Do not retry it; report that it was declined.`, requestId: `tg-deny-${u.update_id}` },
            ctx,
          );
        }
      }
    }
  }
}

// approval detection: watch for blocked tool results with an approval key
setInterval(async () => {
  try {
    const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 20), ctx);
    const block = page.items.find(
      (i) => (i.kind ?? "") === "pi.tool-result" && JSON.stringify(i).includes("Approval key:"),
    );
    if (!block) return;
    const m = JSON.stringify(block).match(/Approval key: ([a-f0-9]{12})/);
    if (m && !postedApprovals.has(m[1])) {
      postedApprovals.add(m[1]);
      await postApprovalRequest(m[1]);
    }
  } catch (e) {
    console.error("poller:", e.message);
  }
}, 3000);
