// Telegram client (PLAN §4 D8–9): long polling — outbound only, no inbound ports.
//   - bound chat      ↔ root conversation
//   - forum topic     ↔ fork of the root conversation (created on first use)
//   - progress        one edited message per run (throttled ~2s), gated on run_start/run_end
//   - final answer    posted on run_end (full text via GET /conversations/:id/entries)
//   - approvals       inline Approve/Deny buttons; callback → POST /approvals/:key; UI settled after decision
// Text fallback: "approve <key>" / "deny <key>". Access control via ALLOWED_TELEGRAM_IDS.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderAction } from "./extensions/gates.ts";

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
/**
 * Text fallback for decisions: `approve|deny <key>` with an optional reason:
 * `deny <key> because <reason>` (also accepts `denied`/`reject`).
 */
export function parseApprovalText(text: string): { decision: "approved" | "denied"; key: string; reason?: string } | null {
  const m = text.match(/\b(approve|deny|denied|reject)\b[\s:]*([a-f0-9]{12})(?:\s+because\s+(.+))?/is);
  if (!m) return null;
  const reason = m[3]?.trim();
  return { decision: /approve/i.test(m[1]) ? "approved" : "denied", key: m[2], reason: reason || undefined };
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
  /** Grouped "approve all" prompts (phase 4), one per conversation. */
  private ballotMsgs = new Map<number, { chatKey: string; msgId: number; keys: string[] }>();
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
      await this.decide(approval.decision, approval.key, `telegram-text:${msg.from?.first_name ?? "user"}`, approval.reason);
      return;
    }

    // /model command: show the model catalog or switch this conversation's model.
    const modelCmd = text.match(/^\/model(?:\s+(.+))?$/s);
    if (modelCmd) {
      await this.handleModelCommand(msg.chat.id, msg.message_thread_id, modelCmd[1]?.trim());
      return;
    }

    // /board command: the shared board dashboard (members, open jobs, pending approvals).
    const boardCmd = text.match(/^\/board\s*$/);
    if (boardCmd) {
      await this.handleBoardCommand(msg.chat.id, msg.message_thread_id);
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
        approvals: Array<{
          key: string;
          tool: string;
          args: Record<string, unknown>;
          tier?: string;
          why?: string;
          riskScore?: number;
          riskNote?: string;
          conversationId: number;
        }>;
      };
      // Conversations this bot owns, keyed by conversation id. Approvals from unbound
      // conversations (e.g. board members) route to the human's root chat so they stay actionable.
      const mine = new Map<number, string>();
      for (const [k, b] of Object.entries(this.state.chats)) mine.set(b.conversationId, k);
      const rootKey = Object.entries(this.state.chats).find(([, b]) => b.kind === "root")?.[0];
      const byTarget = new Map<string, typeof body.approvals>();
      for (const a of body.approvals) {
        if (this.postedKeys.has(a.key)) continue;
        // Target chat: the bound chat for owned conversations, else the root chat for unbound ones.
        const targetKey = mine.get(a.conversationId) ?? rootKey;
        if (!targetKey) continue;
        const list = byTarget.get(targetKey) ?? [];
        list.push(a);
        byTarget.set(targetKey, list);
      }
      for (const [chatKey, items] of byTarget) {
        // Destructive items are ALWAYS individual — never batched.
        for (const a of items.filter((x) => x.tier === "destructive")) await this.postSingle(a, chatKey, a.conversationId);
        const promptItems = items.filter((x) => x.tier !== "destructive");
        if (promptItems.length === 1) await this.postSingle(promptItems[0], chatKey, promptItems[0].conversationId);
        else if (promptItems.length >= 2) await this.postBallot(promptItems, chatKey, promptItems[0].conversationId);
      }
    } catch (e) {
      console.error("[telegram] approvals:", errText(e));
    }
  }

  /** /board command: the shared board dashboard (members, open jobs, pending approvals).
   * Served by apps that register a GET /board route (the Collective); solo instances have none. */
  private async handleBoardCommand(chatId: number, threadId?: number): Promise<void> {
    const target = { chat_id: chatId, ...(threadId ? { message_thread_id: threadId } : {}) };
    try {
      const res = await fetch(`${this.opts.apiBaseUrl}/board`, { headers: { authorization: `Bearer ${this.opts.apiToken}` } });
      if (res.status === 404) {
        await this.tg("sendMessage", { ...target, text: "This instance has no board (solo mode)." }).catch(() => {});
        return;
      }
      if (!res.ok) throw new Error(`board fetch failed: ${res.status}`);
      const body = (await res.json()) as {
        members?: Array<{ name: string; kind: string }>;
        openJobs?: Array<{ id: string; title: string }>;
        pendingApprovals?: unknown[];
      };
      const lines: string[] = ["📋 Board"];
      const members = body.members ?? [];
      lines.push(`Members (${members.length}): ${members.length ? members.map((m) => `${m.name} [${m.kind}]`).join(", ") : "none"}`);
      const jobs = body.openJobs ?? [];
      if (jobs.length === 0) lines.push("Open jobs: none");
      else for (const j of jobs.slice(0, 15)) lines.push(`• ${j.id}: ${j.title}`);
      const pending = body.pendingApprovals ?? [];
      lines.push(pending.length ? `⏳ Pending approvals: ${pending.length}` : "No pending approvals");
      await this.tg("sendMessage", { ...target, text: lines.join("\n") });
    } catch (e) {
      console.error("[telegram] board:", errText(e));
      await this.tg("sendMessage", { ...target, text: "Could not load the board." }).catch(() => {});
    }
  }

  /** One approval request as its own message with per-action buttons. */
  private async postSingle(
    a: { key: string; tool: string; args: Record<string, unknown>; tier?: string; why?: string; riskScore?: number; riskNote?: string },
    chatKey: string,
    convId: number,
  ): Promise<void> {
    const destructive = a.tier === "destructive";
    const action = renderAction(a.tool, a.args).slice(0, 500);
    const whyLine = a.why ? `\nWhy: ${a.why.slice(0, 300)}` : "";
    const riskLine = a.riskNote ? `\nRisk ${Number(a.riskScore).toFixed(2)}: ${a.riskNote.slice(0, 200)}` : "";
    const badge = destructive ? "⚠️ DESTRUCTIVE — " : "";
    const r = await this.tg("sendMessage", {
      ...this.msgTarget(chatKey),
      text:
        `${destructive ? "🔴" : "⚠️"} ${badge}The agent wants to run \`${a.tool}\`:\n${action}${whyLine}${riskLine}\nKey: \`${a.key}\`` +
        (destructive
          ? "\nThis action is destructive. Approving requires explicitly acknowledging the risk. Deny with a reason via: deny <key> because …"
          : "\nDeny with a reason via: deny <key> because …"),
      reply_markup: {
        inline_keyboard: [
          destructive
            ? [{ text: "⚠️ I understand the risk — run it", callback_data: `approve:${a.key}` }, { text: "❌ Deny", callback_data: `deny:${a.key}` }]
            : [{ text: "✅ Approve", callback_data: `approve:${a.key}` }, { text: "🔁 Always allow", callback_data: `always:${a.key}` }, { text: "❌ Deny", callback_data: `deny:${a.key}` }],
        ],
      },
    });
    this.approvalMsgs.set(a.key, { key: chatKey, msgId: Number(r.message_id), convId });
    this.postedKeys.add(a.key); // only after a real send; next tick retries otherwise
  }

  /**
   * Grouped prompt (phase 4): N pending actions from one conversation as ONE message —
   * per-action approve/deny rows plus "Approve all" (callback `ballot`). Destructive
   * items never appear here; they get their own explicit message.
   */
  private async postBallot(
    items: Array<{ key: string; tool: string; args: Record<string, unknown>; tier?: string }>,
    chatKey: string,
    convId: number,
  ): Promise<void> {
    const lines = items.map((a, i) => `${i + 1}. \`${a.tool}\` → ${renderAction(a.tool, a.args).slice(0, 200)}\n   Key: \`${a.key}\``);
    const r = await this.tg("sendMessage", {
      ...this.msgTarget(chatKey),
      text: `⚠️ ${items.length} actions awaiting approval:\n${lines.join("\n")}\nDeny with a reason via: deny <key> because …`,
      reply_markup: {
        inline_keyboard: [
          [{ text: `✅ Approve all ${items.length}`, callback_data: "ballot" }],
          ...items.map((a, i) => [
            { text: `✅ ${i + 1}`, callback_data: `approve:${a.key}` },
            { text: `❌ ${i + 1}`, callback_data: `deny:${a.key}` },
          ]),
        ],
      },
    });
    for (const a of items) this.postedKeys.add(a.key); // only after a real send; next tick retries otherwise
    this.ballotMsgs.set(convId, { chatKey, msgId: Number(r.message_id), keys: items.map((a) => a.key) });
  }

  private async handleCallback(q: CallbackQuery): Promise<void> {
    if (this.opts.allowedIds.length > 0 && !this.opts.allowedIds.includes(q.from?.id ?? -1)) return;
    await this.tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    const data = String(q.data);
    // Model picker flow (provider → model → switch).
    if (data === "mlist" || data.startsWith("mprov:") || data.startsWith("mmodel:")) {
      await this.handleModelCallback(q, data);
      return;
    }
    const [action, key] = data.split(":");
    if (!key) return;
    if (action === "approve") {
      await this.decide("approved", key, `telegram:${q.from?.first_name ?? "user"}`);
    } else if (action === "ballot") {
      // "Approve all": batch-decide every still-pending non-destructive action of the
      // conversation that owns the ballot message.
      await this.decideBallot(q, `telegram:${q.from?.first_name ?? "user"}`);
    } else if (action === "always") {
      // Approve AND write a persistent allow-rule in one commit.
      await this.decide("approved", key, `telegram:${q.from?.first_name ?? "user"}`, undefined, true);
    } else if (action === "deny") {
      await this.decide("denied", key, `telegram:${q.from?.first_name ?? "user"}`);
    }
  }

  private async decide(
    decision: "approved" | "denied",
    key: string,
    decidedBy: string,
    reason?: string,
    alwaysAllow?: boolean,
  ): Promise<void> {
    // Resolve the owning conversation while the request is still pending.
    const known = this.approvalMsgs.get(key)?.convId;
    const convId = known ?? (await this.pendingConversationForKey(key));
    if (!convId) return;

    const res = await fetch(`${this.opts.apiBaseUrl}/approvals/${key}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision, ...(reason ? { reason } : {}), ...(alwaysAllow ? { alwaysAllow: true } : {}) }),
    });
    // Settle the button UI (edit away the buttons) whether or not we made the decision.
    const posted = this.approvalMsgs.get(key);
    if (posted) {
      const label = decision === "approved" ? (alwaysAllow ? "✅ APPROVED + always allowed" : "✅ APPROVED") : "❌ DENIED";
      await this.tg("editMessageText", { ...this.msgTarget(posted.key), message_id: posted.msgId, text: `🔒 ${label} by ${decidedBy}\nKey: \`${key}\`` }).catch(() => {});
      this.approvalMsgs.delete(key);
    }
    if (res.status === 409) {
      console.log(`[telegram] approval ${key} already decided — no duplicate retry`);
      return; // someone else decided it first: do not double-instruct the agent
    }
    if (res.status !== 200) {
      console.error(`[telegram] approval POST ${key}: ${res.status} ${(await res.text().catch(() => ""))}`);
      return;
    }
    const reasonLine = reason ? ` Reason given: "${reason}"` : "";
    const content =
      decision === "approved"
        ? `The human APPROVED action key ${key}. Retry the action with the exact same arguments.`
        : `The human DENIED action key ${key}.${reasonLine} Do not retry it; report that it was declined and adapt if the reason suggests a different approach.`;
    await this.apiPost("/tasks", { content, requestId: `tg-${decision}-${key}-${Date.now()}`, conversationId: convId });
  }

  /** Batch-approve every still-pending non-destructive action of one conversation. */
  private async decideBallot(q: CallbackQuery, decidedBy: string): Promise<void> {
    const msg = q.message as { chat?: { id?: number }; message_thread_id?: number } | undefined;
    if (!msg?.chat?.id) return;
    const binding = this.state.chats[chatKey(msg.chat.id, msg.message_thread_id)];
    if (!binding) return;
    // Re-read the pending list: only decide what is still open.
    const res = await fetch(`${this.opts.apiBaseUrl}/approvals`, {
      headers: { authorization: `Bearer ${this.opts.apiToken}` },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { approvals: Array<{ key: string; conversationId: number; tier?: string }> };
    const keys = body.approvals
      .filter((a) => a.conversationId === binding.conversationId && a.tier !== "destructive")
      .map((a) => a.key);
    if (keys.length === 0) return; // all already decided
    const post = await fetch(`${this.opts.apiBaseUrl}/approvals/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ keys, decision: "approved" }),
    });
    // Settle the grouped prompt (edit away the buttons).
    const posted = this.ballotMsgs.get(binding.conversationId);
    if (posted) {
      await this.tg("editMessageText", {
        ...this.msgTarget(posted.chatKey),
        message_id: posted.msgId,
        text: `🔒 ✅ APPROVED ALL (${keys.length}) by ${decidedBy}`,
      }).catch(() => {});
      this.ballotMsgs.delete(binding.conversationId);
    }
    if (post.status !== 200) {
      console.error(`[telegram] batch POST: ${post.status} ${(await post.text().catch(() => ""))}`);
      return;
    }
    // One feedback instruction covering the whole batch.
    const content = `The human APPROVED these actions in batch: ${keys.map((k) => `\`${k}\``).join(", ")}. Retry each with the exact same arguments.`;
    await this.apiPost("/tasks", { content, requestId: `tg-ballot-${binding.conversationId}-${Date.now()}`, conversationId: binding.conversationId });
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
    return this.apiRequest("POST", p, body);
  }

  private async apiRequest(method: string, p: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.opts.apiBaseUrl}${p}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.apiToken}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`api ${p}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  // ---- /model command ----

  private async handleModelCommand(chatId: number, threadId: number | undefined, arg?: string): Promise<void> {
    const target = { chat_id: chatId, ...(threadId ? { message_thread_id: threadId } : {}) };
    const key = chatKey(chatId, threadId);
    const binding = this.state.chats[key];
    if (!binding) {
      await this.tg("sendMessage", { ...target, text: "This chat isn't bound yet — send me a task first." }).catch(() => {});
      return;
    }
    try {
      if (!arg) {
        // Interactive picker: provider buttons first, models on click.
        await this.sendProviderMenu(chatId, threadId);
      } else {
        const body = await this.apiRequest("PATCH", `/conversations/${binding.conversationId}`, { model: arg });
        await this.tg("sendMessage", { ...target, text: `Model switched to ${String(body.model)}.` }).catch(() => {});
      }
    } catch (e) {
      await this.tg("sendMessage", { ...target, text: `model command failed: ${String(e instanceof Error ? e.message : e)}` }).catch(() => {});
    }
  }

  /** First step of the picker: one button per provider with available models. */
  private async sendProviderMenu(chatId: number, threadId: number | undefined): Promise<void> {
    const target = { chat_id: chatId, ...(threadId ? { message_thread_id: threadId } : {}) };
    try {
      const body = await this.apiRequest("GET", "/providers");
      const providers = (body.providers ?? []) as Array<{ id: string; modelCount: number; available: boolean }>;
      const usable = providers.filter((p) => p.available && p.modelCount > 0);
      if (usable.length === 0) {
        await this.tg("sendMessage", { ...target, text: "No providers with available models are configured." }).catch(() => {});
        return;
      }
      const rows = usable.map((p) => [{ text: p.id, callback_data: `mprov:${p.id}` }]);
      await this.tg("sendMessage", {
        ...target,
        text: "Pick a provider:",
        reply_markup: { inline_keyboard: rows },
      }).catch(() => {});
    } catch (e) {
      await this.tg("sendMessage", { ...target, text: `model command failed: ${String(e instanceof Error ? e.message : e)}` }).catch(() => {});
    }
  }

  /** Callbacks for the picker: provider list (re)render, model list, final switch. */
  private async handleModelCallback(q: CallbackQuery, data: string): Promise<void> {
    const msg = q.message;
    if (!msg?.chat || msg.message_id === undefined) return;
    const key = chatKey(msg.chat.id, msg.message_thread_id);
    const binding = this.state.chats[key];
    if (!binding) {
      await this.tg("answerCallbackQuery", { callback_query_id: q.id, alert: "This chat isn't bound yet." }).catch(() => {});
      return;
    }
    try {
      if (data.startsWith("mmodel:")) {
        // Model ids never contain ":" in pi's catalogs; join defensively anyway.
        const ref = data.slice("mmodel:".length);
        const body = await this.apiRequest("PATCH", `/conversations/${binding.conversationId}`, { model: ref });
        await this.tg(
          "editMessageText",
          { ...this.msgTarget(key), message_id: Number(msg.message_id), text: `🤖 Model switched to ${String(body.model)}.` },
        ).catch(() => {});
      } else {
        const providerId = data === "mlist" ? undefined : data.slice("mprov:".length);
        await this.renderModelMenu(q, key, providerId);
      }
    } catch (e) {
      await this.tg(
        "answerCallbackQuery",
        { callback_query_id: q.id, alert: String(e instanceof Error ? e.message : e).slice(0, 200) },
      ).catch(() => {});
    }
  }

  /** Render the provider list (no id) or one provider's models into the picker message. */
  private async renderModelMenu(q: CallbackQuery, key: string, providerId?: string): Promise<void> {
    const msg = q.message!;
    if (!providerId) {
      const body = await this.apiRequest("GET", "/providers");
      const providers = (body.providers ?? []) as Array<{ id: string; modelCount: number; available: boolean }>;
      const rows = providers
        .filter((p) => p.available && p.modelCount > 0)
        .map((p) => [{ text: p.id, callback_data: `mprov:${p.id}` }]);
      await this.tg(
        "editMessageText",
        { ...this.msgTarget(key), message_id: Number(msg.message_id), text: "Pick a provider:", reply_markup: { inline_keyboard: rows } },
      ).catch(() => {});
      return;
    }
    const body = await this.apiRequest("GET", `/providers/${encodeURIComponent(providerId)}/models`);
    const models = (body.models ?? []) as Array<{ id: string; available: boolean }>;
    const usable = models.filter((m) => m.available);
    // Telegram callback_data is capped at 64 bytes — fall back to a text list when any ref overflows.
    const tooLong = usable.some((m) => Buffer.byteLength(`mmodel:${providerId}:${m.id}`, "utf8") > 63);
    if (usable.length === 0 || tooLong) {
      const lines = usable.map((m) => `/model ${providerId}:${m.id}`).join("\n");
      await this.tg(
        "editMessageText",
        { ...this.msgTarget(key), message_id: Number(msg.message_id), text: `Models on ${providerId} — send one to switch:\n${lines || "(none available)"}` },
      ).catch(() => {});
      return;
    }
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < usable.length; i += 4) {
      rows.push(usable.slice(i, i + 4).map((m) => ({ text: m.id.slice(0, 40), callback_data: `mmodel:${providerId}:${m.id}` })));
    }
    rows.push([{ text: "⬅️ Providers", callback_data: "mlist" }]);
    await this.tg(
      "editMessageText",
      { ...this.msgTarget(key), message_id: Number(msg.message_id), text: `Models on ${providerId}:`, reply_markup: { inline_keyboard: rows } },
    ).catch(() => {});
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
  /** Present for callbacks on regular (non-inline) messages — our chat context. */
  message?: { chat: { id: number }; message_thread_id?: number; message_id?: number };
}
