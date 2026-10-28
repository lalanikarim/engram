// Engram Web UI — minimal SPA (Preact + htm, no build step).
// Data plane is fully bearer-authenticated; this file is a public bootstrap that is
// useless without the token (LAN-only design, see PLAN §5).
import { h, render } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { html } from "/vendor/htm-preact.mjs";

const TOKEN_KEY = "engram.token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

class AuthError extends Error {}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${getToken()}`, "content-type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) throw new AuthError("unauthorized");
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/** Fetch-based SSE reader (EventSource cannot send the Authorization header). */
async function sseStream(url, onEvent) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${getToken()}` } });
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
      const dataLines = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length > 0) onEvent(event, JSON.parse(dataLines.join("\n")));
    }
  }
}

function fmtTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ---- model picker (GET /models catalog; per-conversation POST/PATCH) ----

function modelRef(m) {
  return `${m.provider}:${m.id}`;
}

function shortRef(ref) {
  const i = String(ref ?? "").indexOf(":");
  return i >= 0 ? ref.slice(i + 1) : ref;
}

/** <select> of the model catalog: "" = default, grouped by provider, unavailable disabled. */
function ModelSelect({ catalog, value, onChange, testId }) {
  const byProvider = new Map();
  for (const m of catalog?.models ?? []) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  return html`<select class="model-select" data-testid=${testId} value=${value ?? ""} onChange=${onChange}>
    <option value="">default${catalog?.default ? ` (${shortRef(catalog.default)})` : ""}</option>
    ${[...byProvider.entries()].map(([provider, ms]) => html`
      <optgroup label=${provider}>
        ${ms.map((m) => html`<option key=${modelRef(m)} value=${modelRef(m)} disabled=${!m.available}>${m.name === m.id ? m.id : m.name}</option>`)}
      </optgroup>`)}
  </select>`;
}

// ---- entry rendering (full EntryRecords from GET /conversations/:id/entries) ----

function contentTexts(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "");
}

function EntryView({ e }) {
  const out = [];
  for (const m of e.model ?? []) {
    if (m.role === "user") {
      out.push(html`<div class="msg user"><div class="who">you</div>${contentTexts(m.content).join("\n")}</div>`);
    } else if (m.role === "assistant") {
      const calls = Array.isArray(m.content) ? m.content.filter((c) => c.type === "toolCall") : [];
      const text = contentTexts(m.content).join("\n");
      for (const c of calls) {
        out.push(html`<div class="toolcall">🔧 ${c.name}(${JSON.stringify(c.arguments ?? {})})</div>`);
      }
      if (text.trim()) out.push(html`<div class="msg assistant"><div class="who">agent</div>${text}</div>`);
    } else if (m.role === "toolResult") {
      const text = contentTexts(m.content).join("\n");
      out.push(
        html`<div class="toolresult ${m.isError ? "err" : ""}">
          <div class="tr-head">${m.toolName ?? "tool"}${m.isError ? " — error" : ""}</div>
          <div class="tr-body">${text || "(no output)"}</div>
        </div>`,
      );
    }
  }
  if (out.length === 0 && e.kind !== "pi.submission") return null;
  return html`<div key=${e.id}>${out}</div>`;
}

// ---- chat view: history + live stream + composer ----

function ChatView({ conv, catalog, onConvsChanged }) {
  const switchModel = async (e) => {
    const v = e.target.value;
    try {
      await api(`/conversations/${conv.id}`, { method: "PATCH", body: { model: v === "" ? null : v } });
      onConvsChanged?.();
    } catch (err) {
      console.error("model switch:", err);
    }
  };
  const [entries, setEntries] = useState([]);
  const [inRun, setInRun] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  const stickRef = useRef(true);
  const fullCursorRef = useRef(0);

  // Load history, then follow the stream. SSE entry events are change notifications;
  // full content always comes from the entries endpoint (summaries in SSE are truncated).
  useEffect(() => {
    let cancelled = false;
    let stop = false;
    stickRef.current = true;

    const refresh = async (after) => {
      const body = await api(`/conversations/${conv.id}/entries?after=${after}&limit=200`);
      if (cancelled) return;
      fullCursorRef.current = Math.max(fullCursorRef.current, ...body.entries.map((e) => e.id), 0);
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const add = body.entries.filter((e) => !seen.has(e.id));
        return add.length ? [...prev, ...add] : prev;
      });

    };

    (async () => {
      try {
        await refresh(0);
        if (cancelled) return;
        const follow = async () => {
          while (!stop && !cancelled) {
            try {
              await sseStream(`/stream?conversationId=${conv.id}&cursor=${fullCursorRef.current}`, (event, data) => {
                if (event === "entry") void refresh(fullCursorRef.current);
                else if (event === "event") {
                  if (data.type === "run_start") setInRun(true);
                  else if (data.type === "run_end") setInRun(false);
                }
              });
            } catch {
              // reconnect after a beat (cursor resumes where we left off)
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
        };
        void follow();
      } catch (err) {
        if (!cancelled) console.error("chat load:", err);
      }
    })();

    return () => {
      cancelled = true;
      stop = true;
    };
  }, [conv.id]);

  // Auto-scroll: stick to bottom unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const submit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const body = { content: text, requestId: crypto.randomUUID(), conversationId: conv.id };
      if (inRun) await api("/steer", { method: "POST", body });
      else await api("/tasks", { method: "POST", body });
      setInput("");
      stickRef.current = true;
      onConvsChanged?.();
    } catch (err) {
      console.error("submit:", err);
    } finally {
      setBusy(false);
    }
  };

  return html`
    <div class="chat-head">
      <span class="title">${conv.name}</span>
      ${conv.cwd ? html`<span class="cwd">work/${conv.cwd}</span>` : ""}
      ${catalog ? html`<${ModelSelect} catalog=${catalog} value=${conv.model ?? ""} onChange=${switchModel} testId="conv-model-select" />` : ""}
      ${inRun ? html`<span class="badge run" data-testid="run-badge">running</span>` : ""}
    </div>
    <div class="messages" data-testid="messages" ref=${scrollRef} onScroll=${(e) => {
      const el = e.target;
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      ${entries.length === 0 ? html`<div class="empty">No messages yet — send one below.</div>` : ""}
      ${entries.map((e) => html`<${EntryView} e=${e} />`)}
    </div>
    <div class="hint">${inRun ? "agent is running — sending will steer the current turn" : "sending starts a new run"}</div>
    <div class="composer">
      <input data-testid="composer" value=${input} placeholder="Message the agent…" onInput=${(e) => setInput(e.target.value)}
        onKeyDown=${(e) => e.key === "Enter" && submit()} />
      <button class="btn primary" data-testid="send-btn" disabled=${busy || !input.trim()} onClick=${submit}>Send</button>
    </div>`;
}

// ---- approvals banner (polls GET /approvals) ----

// Human-readable rendering of a gated action (mirrors src/extensions/gates.ts).
function renderAction(tool, args) {
  const a = args ?? {};
  if (tool === "bash") return String(a.command ?? "");
  if (tool === "send_message") {
    const to = a.to !== undefined ? `to ${a.to}` : "";
    const message = a.message !== undefined ? `\n${a.message}` : "";
    return `${to}${message}`.trim();
  }
  return JSON.stringify(a);
}

function ApprovalsBanner({ approvals, onDecided }) {
  const [pendingKeys, setPendingKeys] = useState(new Set());
  const [reasons, setReasons] = useState({}); // key → denial reason text

  const decide = async (key, conversationId, decision, alwaysAllow) => {
    setPendingKeys((p) => new Set(p).add(key));
    const reason = reasons[key]?.trim() || undefined;
    try {
      const res = await fetch(`/approvals/${key}`, {
        method: "POST",
        headers: { authorization: `Bearer ${getToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ decision, ...(reason ? { reason } : {}), ...(alwaysAllow ? { alwaysAllow: true } : {}) }),
      });
      if (res.status === 409) return; // already decided — the poll will drop it
      if (!res.ok) throw new Error(`approval ${key} → ${res.status}`);
      // Instruct the agent, mirroring the Telegram client (relaying any denial reason).
      const reasonLine = reason ? ` Reason given: "${reason}"` : "";
      const content =
        decision === "approved"
          ? `The human APPROVED action key ${key}. Retry the action with the exact same arguments.`
          : `The human DENIED action key ${key}.${reasonLine} Do not retry it; report that it was declined and adapt if the reason suggests a different approach.`;
      await api("/tasks", { method: "POST", body: { content, requestId: crypto.randomUUID(), conversationId } });
    } catch (err) {
      console.error("decide:", err);
      setPendingKeys((p) => {
        const n = new Set(p);
        n.delete(key);
        return n;
      });
    } finally {
      onDecided?.();
    }
  };

  // Batch decision (phase 4): one commit for N keys, then one feedback instruction.
  const decideAll = async (keys, conversationId) => {
    setPendingKeys((p) => new Set([...p, ...keys]));
    try {
      const res = await fetch(`/approvals/batch`, {
        method: "POST",
        headers: { authorization: `Bearer ${getToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ keys, decision: "approved" }),
      });
      if (!res.ok) throw new Error(`batch → ${res.status}`);
      const body = await res.json();
      const decided = (body.results ?? []).filter((r) => r.status === "decided").map((r) => r.key);
      if (decided.length > 0) {
        const content = `The human APPROVED these actions in batch: ${decided.map((k) => `\`${k}\``).join(", ")}. Retry each with the exact same arguments.`;
        await api("/tasks", { method: "POST", body: { content, requestId: crypto.randomUUID(), conversationId } });
      }
    } catch (err) {
      console.error("decideAll:", err);
      setPendingKeys((p) => {
        const n = new Set(p);
        for (const k of keys) n.delete(k);
        return n;
      });
    } finally {
      onDecided?.();
    }
  };

  if (approvals.length === 0) return null;

  const itemHtml = (a) => {
    const destructive = a.tier === "destructive";
    return html`<div class="approval${destructive ? " destructive" : ""}" key=${a.key}>
      <span>${destructive ? "🔴" : "⚠️"}</span>
      ${destructive && html`<span class="a-tier">DESTRUCTIVE</span>`}
      <span class="a-what">${a.tool}: ${renderAction(a.tool, a.args)}</span>
      ${a.why && html`<span class="a-why">Why: ${a.why}</span>`}
      ${a.riskNote && html`<span class="a-risk" data-testid="risk-note">Risk ${Number(a.riskScore).toFixed(2)}: ${a.riskNote}</span>`}
      <span class="a-key">${a.key}</span>
      <input class="a-reason" placeholder="reason (optional)"
        value=${reasons[a.key] ?? ""} data-testid="reason-input"
        onInput=${(e) => setReasons((r) => ({ ...r, [a.key]: e.target.value }))} />
      <button class="btn small approve" data-testid="approve-btn" disabled=${pendingKeys.has(a.key)}
        onClick=${() => decide(a.key, a.conversationId, "approved")}>
        ${destructive ? "I understand the risk — run it" : "Approve"}</button>
      ${!destructive && html`<button class="btn small approve" data-testid="always-btn" disabled=${pendingKeys.has(a.key)}
        onClick=${() => decide(a.key, a.conversationId, "approved", true)}>Always allow</button>`}
      <button class="btn small deny" data-testid="deny-btn" disabled=${pendingKeys.has(a.key)}
        onClick=${() => decide(a.key, a.conversationId, "denied")}>Deny</button>
    </div>`;
  };

  // Group non-destructive items per conversation: ≥2 in one conversation get a grouped
  // banner with "Approve all" (phase 4). Destructive items are ALWAYS standalone.
  const byConv = new Map();
  for (const a of approvals) {
    if (a.tier === "destructive") continue;
    const list = byConv.get(a.conversationId) ?? [];
    list.push(a);
    byConv.set(a.conversationId, list);
  }
  const grouped = new Set();
  for (const items of byConv.values()) if (items.length >= 2) for (const a of items) grouped.add(a.key);

  return html`<div class="approvals" data-testid="approvals">
    ${approvals.map((a) => {
      if (grouped.has(a.key)) return null; // rendered inside its group below
      return itemHtml(a);
    })}
    ${[...byConv.entries()].filter(([, items]) => items.length >= 2).map(([convId, items]) => html`
      <div class="approval group" data-testid="approval-group">
        <span>⚠️</span>
        <span class="a-what">${items.length} actions awaiting approval (conversation ${convId})</span>
        <button class="btn small approve" data-testid="approve-all-btn" disabled=${items.some((a) => pendingKeys.has(a.key))}
          onClick=${() => decideAll(items.map((a) => a.key), convId)}>Approve all ${items.length}</button>
        ${items.map(itemHtml)}
      </div>`)}
  </div>`;
}

// ---- shell: sidebar + chat + approvals ----

// ---- board dashboard (polls GET /board — provided by apps like the Collective; solo
// instances have no /board endpoint, in which case the panel stays hidden) ----
function BoardPanel({ board }) {
  if (board === false) return null;
  const members = board?.members ?? [];
  const openJobs = board?.openJobs ?? [];
  return html`<div class="board-section">
    <div class="side-head"><span>Board</span><span class="badge">${openJobs.length} open</span></div>
    <div class="board-list">
      <div class="board-group">Members (${members.length})</div>
      ${members.map((m) => html`<div class="board-row"><span>${m.name}</span><span class="badge">${m.kind}</span>${m.endpoint ? html`<span class="badge" data-testid="remote-badge">remote</span>` : ""}</div>`)}
      <div class="board-group">Open jobs</div>
      ${openJobs.length
        ? openJobs.map((j) => html`<div class="board-row"><span>${j.id} — ${j.title}</span></div>`)
        : html`<div class="board-row dim">none</div>`}
    </div>
  </div>`;
}

function Shell({ onLogout }) {
  const [convs, setConvs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [board, setBoard] = useState(null);
  const [catalog, setCatalog] = useState(null); // { models, default } from GET /models
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [modelSel, setModelSel] = useState("");

  const refreshConvs = useCallback(async () => {
    try {
      const body = await api("/conversations");
      setConvs(body.conversations);
    } catch (err) {
      if (err instanceof AuthError) onLogout();
      else console.error("convs:", err);
    }
  }, [onLogout]);

  useEffect(() => {
    void refreshConvs();
    const t = setInterval(() => void refreshConvs(), 5000);
    return () => clearInterval(t);
  }, [refreshConvs]);

  useEffect(() => {
    const poll = async () => {
      try {
        const body = await api("/approvals");
        setApprovals(body.approvals);
      } catch (err) {
        if (err instanceof AuthError) onLogout();
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 3000);
    return () => clearInterval(t);
  }, [onLogout]);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        setBoard(await api("/board"));
      } catch (err) {
        if (err instanceof AuthError) onLogout();
        else if (String(err.message).includes("404")) {
          // No board endpoint on this instance (solo mode) — stop polling, hide the panel.
          stopped = true;
          setBoard(false);
        }
      }
    };
    void poll();
    const t = setInterval(() => { if (!stopped) void poll(); }, 5000);
    return () => clearInterval(t);
  }, [onLogout]);

  useEffect(() => {
    api("/models").then(setCatalog).catch((err) => {
      if (err instanceof AuthError) onLogout();
      else console.error("models:", err);
    });
  }, [onLogout]);

  const active = convs.find((c) => c.id === activeId) ?? null;

  const newConv = async () => {
    try {
      const body = await api("/conversations", {
        method: "POST",
        body: { name: name.trim() || undefined, cwd: cwd.trim() || undefined, model: modelSel || undefined },
      });
      setName("");
      setCwd("");
      setModelSel("");
      setActiveId(body.id);
      void refreshConvs();
    } catch (err) {
      console.error("new conv:", err);
    }
  };

  return html`<div class="layout">
    <aside>
      <div class="side-head"><span>Conversations</span><button class="btn small" onClick=${onLogout}>Log out</button></div>
      <div class="conv-list">
        ${convs.map((c) => html`<div class="conv ${c.id === activeId ? "active" : ""}" key=${c.id} data-testid="conv-item" data-id=${c.id}
            onClick=${() => setActiveId(c.id)}>
          <div class="name">${c.name}</div>
          <div class="meta">
            ${c.cwd ? html`<span>${c.cwd}</span>` : ""}
            <span>${fmtTime(c.createdAt)}</span>
            ${c.openSubmissions > 0 ? html`<span class="badge run">busy</span>` : ""}
          </div>
        </div>`)}
      </div>
      <${BoardPanel} board=${board} />
      <div class="new-conv">
        <input placeholder="Name (optional)" value=${name} onInput=${(e) => setName(e.target.value)} />
        <input placeholder="cwd under work/ (optional)" value=${cwd} onInput=${(e) => setCwd(e.target.value)}
          onKeyDown=${(e) => e.key === "Enter" && newConv()} />
        ${catalog ? html`<${ModelSelect} catalog=${catalog} value=${modelSel} onChange=${(e) => setModelSel(e.target.value)} testId="new-conv-model" />` : ""}
        <button class="btn" data-testid="new-conv-btn" onClick=${newConv}>New conversation</button>
      </div>
    </aside>
    <main>
      <${ApprovalsBanner} approvals=${approvals} onDecided=${refreshConvs} />
      ${active
        ? html`<${ChatView} conv=${active} catalog=${catalog} onConvsChanged=${refreshConvs} />`
        : html`<div class="empty">Pick a conversation, or start a new one.</div>`}
    </main>
  </div>`;
}

// ---- app root: token gate + shell ----

function TokenScreen({ onSubmit }) {
  const [value, setValue] = useState("");
  return html`<form class="token-screen" onSubmit=${(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
    <h1>Engram</h1>
    <p>Enter the API token to open your project brain.</p>
    <input type="password" placeholder="API token" data-testid="token-input" value=${value} onInput=${(e) => setValue(e.target.value)} autofocus />
  </form>`;
}

function App() {
  const [token, setToken] = useState(getToken());

  const login = (t) => {
    localStorage.setItem(TOKEN_KEY, t);
    setToken(t);
  };
  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
  };

  return token === "" ? html`<${TokenScreen} onSubmit=${login} />` : html`<${Shell} onLogout=${logout} />`;
}

render(html`<${App} />`, document.getElementById("root"));
