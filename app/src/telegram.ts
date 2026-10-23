// Telegram client (PLAN §4 D8–9): long polling — outbound only, no inbound ports.
//   - bound chat      ↔ root conversation
//   - forum topic     ↔ fork of the root conversation (created on first use)
//   - progress        one edited message per run (throttled ~2s), gated on run_start/run_end
//   - final answer    posted on run_end (full text via GET /conversations/:id/entries)
//   - approvals       inline Approve/Deny buttons; callback → POST /approvals/:key; UI settled after decision
// Text fallback: "approve <key>" / "deny <key>". Access control via ALLOWED_TELEGRAM_IDS.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TelegramClientOptions {
  botToken: string;
  /** Bot API base (default https://api.telegram.org/bot<token>); tests point this at a mock. */
  apiBase?: string;
  /** Numeric user IDs allowed to use the bot. Empty = first-come binding (PoC mode). */
  allowedIds: number[];
  /** State file (chat bindings + polling offset), kept in the data dir. */
  stateFile: string;
  /** The app's own HTTP API. */
  apiBaseUrl: string;
  apiToken: string;
  rootConversationId: number;
}

interface ChatBinding {
  conversationId: number;
  kind: "root" | "topic";
  forkedFrom?: number;
  topicName?: string;
}

interface State {
  offset: number;
  chats: Record<string, ChatBinding>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** chatId, or chatId:threadId for forum topics. */
export function chatKey(chatId: number, threadId?: number): string {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

function parseChatKey(key: string): { chatId: number; threadId?: number } {
  const [c, t] = key.split(":");
  return t ? { chatId: Number(c), threadId: Number(t) } : { chatId: Number(c) };
}

/** "approve|deny <key>" text fallback. */
export function parseApprovalText(text: string): { decision: "approved" | "denied"; key: string } | null {
  const m = text.match(/\b(approve|deny|denied|reject)\b[\s:]*([a-f0-9]{12})/i);
  if (!m) return null;
  return { decision: /approve/i.test(m[1]) ? "approved" : "denied", key: m[2] };
}

function loadState(file: string): State {
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as State;
      return { offset: s.offset ?? 0, chats: s.chats ?? {} };
    } catch (err) {
      throw new Error(`corrupt telegram state file ${file}: ${String(err)}`);
    }
  }
  return { offset: 0, chats: {} };
}

function saveState(file: string, state: State): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/** Minimal SSE reader over fetch (reconnect with cursor is handled by the caller). */
async function sseStream(url: string, token: string, onEvent: (event: string, data: unknown) => void): Promise<void> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length > 0) onEvent(event, JSON.parse(dataLines.join("\n")));
    }
  }
}

/** Progress reporter for one conversation → one chat/thread. */
class ProgressWatcher {
  private inRun = false;
  private progressMsgId: number | null = null;
  private lastEditAt = 0;
  private runStartEntryId = 0;
  private lastEntryId = 0;
  private closed = false;
  private client: TelegramClient;
  private convId: number;
  private key: string;

  constructor(client: TelegramClient, convId: number, key: string) {
    this.client = client;
    this.convId = convId;
    this.key = key;
  }

  async run(): Promise<void> {
    while (!this.closed && !this.client.isStopped()) {
      try {
        const url = `${this.client.appApiBase}/stream?conversationId=${this.convId}&cursor=${this.lastEntryId}`;
        await sseStream(url, this.client.apiToken, (event, data) => this.handle(event, data));
      } catch (err) {
        if (!this.closed && !this.client.isStopped()) console.error(`[telegram] stream ${this.convId}: ${String(err)}`);
      }
      await sleep(1000);
    }
  }

  close(): void {
    this.closed = true;
  }

  private handle(event: string, data: unknown): void {
    if (event === "entry") {
      const e = data as { id: number };
      this.lastEntryId = Math.max(this.lastEntryId, e.id);
      return;
    }
    if (event !== "event") return;
    const ev = data as { type: string; toolName?: string; args?: unknown };
    switch (ev.type) {
      case "run_start":
        this.inRun = true;
        this.progressMsgId = null; // fresh progress line per run
        this.runStartEntryId = this.lastEntryId;
        break;
      case "tool_execution_start":
        if (this.inRun) void this.editProgress(`🔧 ${ev.toolName}(${JSON.stringify(ev.args ?? {}).slice(0, 80)})`);
        break;
      case "message_update":
        if (this.inRun) void this.editProgress("✍️ writing…");
        break;
      case "run_end": {
        this.inRun = false;
        const msgId = this.progressMsgId;
        this.progressMsgId = null;
        // Clear the progress line, then post the final answer with full text.
        void (async () => {
          if (msgId !== null) await this.client.tg("deleteMessage", this.msgTarget(msgId)).catch(() => {});
          const text = await this.fetchFinalAnswer();
          if (text.trim()) {
            await this.client
              .tg("sendMessage", { ...this.msgTarget(), text: text.slice(0, 4000) })
              .catch((e) => console.error("[telegram] final:", errText(e)));
          }
        })();
        break;
      }
    }
  }

  private msgTarget(msgId?: number): Record<string, unknown> {
    const { chatId, threadId } = parseChatKey(this.key);
    return {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...(msgId !== undefined ? { message_id: msgId } : {}),
    };
  }

  private async editProgress(line: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastEditAt < 2000) return; // ~Telegram rate limits
    this.lastEditAt = now;
    try {
      if (this.progressMsgId === null) {
        const r = await this.client.tg("sendMessage", { ...this.msgTarget(), text: `⏳ ${line}` });
        this.progressMsgId = Number(r.message_id);
      } else {
        await this.client.tg("editMessageText", { ...this.msgTarget(this.progressMsgId), text: `⏳ ${line}` });
      }
    } catch (e) {
      console.error("[telegram] progress:", errText(e));
    }
  }

  /** Full assistant text of the run that just ended (SSE summaries are truncated). */
  private async fetchFinalAnswer(): Promise<string> {
    try {
      const res = await fetch(
        `${this.client.appApiBase}/conversations/${this.convId}/entries?after=${this.runStartEntryId}&limit=200`,
        { headers: { authorization: `Bearer ${this.client.apiToken}` } },
      );
      if (!res.ok) return "";
      const body = (await res.json()) as {
        entries: Array<{ model?: Array<{ role?: string; content?: unknown }> }>;
      };
      let text = "";
      for (const e of body.entries) {
        for (const m of e.model ?? []) {
          if (m.role !== "assistant") continue;
          const content = m.content;
          const t = Array.isArray(content)
            ? (content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
            : typeof content === "string"
              ? content
              : "";
          if (t.trim()) text = t; // last assistant text wins
        }
      }
      return text;
    } catch {
      return "";
    }
  }
}

export class TelegramClient {
  private stoppedFlag = false;
  private state: State;
  private watchers = new Map<number, ProgressWatcher>();
  /** approval key → button message + conversation, so we can settle its UI and route the retry. */
  private approvalMsgs = new Map<string, { key: string; msgId: number; convId: number }>();
  private postedKeys = new Set<string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private opts: TelegramClientOptions;

  constructor(opts: TelegramClientOptions) {
    this.opts = opts;
    this.state = loadState(opts.stateFile);
  }

  get apiBase(): string {
    return (this.opts.apiBase ?? `https://api.telegram.org/bot${this.opts.botToken}`).replace(/\/$/, "");
  }

  get apiToken(): string {
    return this.opts.apiToken;
  }

  /** The app's own HTTP API (not the Bot API). */
  get appApiBase(): string {
    return this.opts.apiBaseUrl.replace(/\/$/, "");
  }

  isStopped(): boolean {
    return this.stoppedFlag;
  }

  /** Bot API call (outbound HTTPS only). */
  async tg(method: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return (json.result ?? {}) as Record<string, unknown>;
  }

  async start(): Promise<void> {
    // Restore watchers for bindings from a previous life (root chat + any topics).
    for (const [key, binding] of Object.entries(this.state.chats)) this.ensureWatcher(binding.conversationId, key);
    this.pollTimer = setInterval(() => void this.pollApprovals(), 3000);
    void this.updateLoop();
    console.log(`[telegram] client started (root conversation ${this.opts.rootConversationId})`);
  }

  async stop(): Promise<void> {
    this.stoppedFlag = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const w of this.watchers.values()) w.close();
    saveState(this.opts.stateFile, this.state);
  }

  private ensureWatcher(convId: number, key?: string): void {
    if (this.watchers.has(convId)) return;
    const k = key ?? Object.keys(this.state.chats).find((k) => this.state.chats[k].conversationId === convId);
    if (!k) return; // no chat bound for this conversation yet — nothing to post into
    const w = new ProgressWatcher(this, convId, k);
    this.watchers.set(convId, w);
    void w.run();
  }

  private persist(): void {
    saveState(this.opts.stateFile, this.state);
  }

  // ---- update loop (long polling) ----

  private async updateLoop(): Promise<void> {
    while (!this.stoppedFlag) {
      let updates: Array<Record<string, unknown>>;
      try {
        updates = (await this.tg("getUpdates", {
          offset: this.state.offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        })) as unknown as Array<Record<string, unknown>>;
      } catch (e) {
        console.error("[telegram] getUpdates:", errText(e));
        await sleep(5000);
        continue;
      }
      for (const u of updates) {
        const updateId = Number(u.update_id);
        this.state.offset = updateId + 1;
        this.persist(); // offset durable; redelivered updates are exactly-once via requestId anyway
        try {
          if (u.message) await this.handleMessage(u.message as TelegramMessage, updateId);
          else if (u.callback_query) await this.handleCallback(u.callback_query as CallbackQuery);
        } catch (e) {
          console.error("[telegram] update:", errText(e));
        }
      }
    }
  }

  private async handleMessage(msg: TelegramMessage, updateId: number): Promise<void> {
    const fromId = msg.from?.id;
    if (this.opts.allowedIds.length > 0 && !this.opts.allowedIds.includes(fromId ?? -1)) {
      await this.tg("sendMessage", { chat_id: msg.chat.id, text: "This bot is private." }).catch(() => {});
      return;
    }
    const text = msg.text?.trim();
    if (!text) return;

    // Text fallback for approvals.
    const approval = parseApprovalText(text);
    if (approval) {
      this.postedKeys.add(approval.key);
      await this.decide(approval.decision, approval.key, `telegram-text:${msg.from?.first_name ?? "user"}`);
      return;
    }

    const key = chatKey(msg.chat.id, msg.message_thread_id);
    let binding = this.state.chats[key];
    if (!binding) {
      if (msg.message_thread_id) {
        // Topic in a chat that isn't bound yet.
        if (!this.state.chats[chatKey(msg.chat.id)]) {
          await this.tg("sendMessage", { ...this.msgTarget(key), text: "This bot is bound to another chat." }).catch(() => {});
          return;
        }
        binding = await this.createTopicBinding(key, msg.message_topic?.name);
      } else {
        if (this.state.chats[chatKey(msg.chat.id)]) {
          // A different chat already owns the bot.
          await this.tg("sendMessage", { ...this.msgTarget(key), text: "This bot is bound to another chat." }).catch(() => {});
          return;
        }
        binding = { conversationId: this.opts.rootConversationId, kind: "root" };
        this.state.chats[chatKey(msg.chat.id)] = binding;
        this.persist();
        await this.tg("sendMessage", { ...this.msgTarget(key), text: "Project brain online. Send me a task." }).catch(() => {});
      }
    }
    if (!binding) return;

    // requestId is stable per Telegram update → exactly-once under Bot API retries.
    await this.apiPost("/tasks", {
      content: text,
      requestId: `tg-${updateId}`,
      conversationId: binding.conversationId,
    });
    this.ensureWatcher(binding.conversationId, key);
  }

  private async createTopicBinding(key: string, topicName?: string): Promise<ChatBinding> {
    const chatId = parseChatKey(key).chatId;
    const parent = this.state.chats[chatKey(chatId)]!;
    // Fork the root conversation so the topic starts with its history.
    const res = await fetch(`${this.opts.apiBaseUrl}/conversations/${parent.conversationId}/fork`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: topicName ? topicName.slice(0, 120) : undefined }),
    });
    const body = (await res.json()) as { id?: number; forkedFrom?: number };
    if (!res.ok || body.id === undefined) throw new Error(`fork failed: ${res.status} ${JSON.stringify(body)}`);
    const binding: ChatBinding = {
      conversationId: body.id,
      kind: "topic",
      forkedFrom: body.forkedFrom ?? parent.conversationId,
      topicName,
    };
    this.state.chats[key] = binding;
    this.persist();
    await this.tg("sendMessage", { ...this.msgTarget(key), text: `Topic started as its own thread (conversation ${body.id}).` }).catch(() => {});
    return binding;
  }

  private msgTarget(key: string): Record<string, unknown> {
    const { chatId, threadId } = parseChatKey(key);
    return { chat_id: chatId, ...(threadId ? { message_thread_id: threadId } : {}) };
  }

  // ---- approvals ----

  private async pollApprovals(): Promise<void> {
    try {
      const res = await fetch(`${this.opts.apiBaseUrl}/approvals`, {
        headers: { authorization: `Bearer ${this.opts.apiToken}` },
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        approvals: Array<{ key: string; tool: string; args: Record<string, unknown>; conversationId: number }>;
      };
      // Only conversations this bot owns.
      const mine = new Map<number, string>();
      for (const [k, b] of Object.entries(this.state.chats)) mine.set(b.conversationId, k);
      for (const a of body.approvals) {
        const key = mine.get(a.conversationId);
        if (!key || this.postedKeys.has(a.key)) continue;
        const argsLine = Object.entries(a.args)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(", ");
        const r = await this.tg("sendMessage", {
          ...this.msgTarget(key),
          text: `⚠️ The agent wants to run \`${a.tool}\` (${argsLine.slice(0, 300)}) and needs your approval.\nKey: \`${a.key}\``,
          reply_markup: {
            inline_keyboard: [[{ text: "✅ Approve", callback_data: `approve:${a.key}` }, { text: "❌ Deny", callback_data: `deny:${a.key}` }]],
          },
        });
        this.approvalMsgs.set(a.key, { key, msgId: Number(r.message_id), convId: a.conversationId });
        this.postedKeys.add(a.key); // only after a real send; next tick retries otherwise
      }
    } catch (e) {
      console.error("[telegram] approvals:", errText(e));
    }
  }

  private async handleCallback(q: CallbackQuery): Promise<void> {
    if (this.opts.allowedIds.length > 0 && !this.opts.allowedIds.includes(q.from?.id ?? -1)) return;
    await this.tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    const [decision, key] = String(q.data).split(":");
    if (!key || (decision !== "approve" && decision !== "deny")) return;
    await this.decide(decision === "approve" ? "approved" : "denied", key, `telegram:${q.from?.first_name ?? "user"}`);
  }

  private async decide(decision: "approved" | "denied", key: string, decidedBy: string): Promise<void> {
    // Resolve the owning conversation while the request is still pending.
    const known = this.approvalMsgs.get(key)?.convId;
    const convId = known ?? (await this.pendingConversationForKey(key));
    if (!convId) return;

    const res = await fetch(`${this.opts.apiBaseUrl}/approvals/${key}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    // Settle the button UI (edit away the buttons) whether or not we made the decision.
    const posted = this.approvalMsgs.get(key);
    if (posted) {
      const label = decision === "approved" ? "✅ APPROVED" : "❌ DENIED";
      await this.tg("editMessageText", { ...this.msgTarget(posted.key), message_id: posted.msgId, text: `🔒 ${label} by ${decidedBy}\nKey: \`${key}\`` }).catch(() => {});
      this.approvalMsgs.delete(key);
    }
    if (res.status === 409) {
      console.log(`[telegram] approval ${key} already decided — no duplicate retry`);
      return; // someone else decided it first: do not double-instruct the agent
    }
    if (res.status !== 200) {
      console.error(`[telegram] approval POST ${key}: ${res.status}`);
      return;
    }
    const content =
      decision === "approved"
        ? `The human APPROVED action key ${key}. Retry the action with the exact same arguments.`
        : `The human DENIED action key ${key}. Do not retry it; report that it was declined.`;
    await this.apiPost("/tasks", { content, requestId: `tg-${decision}-${key}-${Date.now()}`, conversationId: convId });
  }

  /** Conversation owning a still-pending approval key (via GET /approvals). */
  private async pendingConversationForKey(key: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.opts.apiBaseUrl}/approvals`, {
        headers: { authorization: `Bearer ${this.opts.apiToken}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { approvals: Array<{ key: string; conversationId: number }> };
      return body.approvals.find((a) => a.key === key)?.conversationId ?? null;
    } catch {
      return null;
    }
  }

  private async apiPost(p: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.opts.apiBaseUrl}${p}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`api ${p}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  }
}

// ---- narrow Telegram API shapes we use ----

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name?: string };
  text?: string;
  message_thread_id?: number;
  message_topic?: { name?: string };
}

interface CallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  data: string;
}
