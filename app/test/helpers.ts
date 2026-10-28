// Shared helpers for the board live suites: an API client, an SSE stream reader, and
// port hygiene for spawned instances.
import { execSync } from "node:child_process";

/**
 * Kill any process LISTENING on the given port (orphans from earlier aborted runs crash our
 * respawns with EADDRINUSE). LISTEN-only match + own-PID guard so we never touch the test
 * runner's client connections or unrelated processes.
 */
export function killPortSquatter(port: number): void {
  let pids: string[] = [];
  try {
    pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n").filter(Boolean);
  } catch {
    return; // nothing listening → port is free
  }
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    if (pid === process.pid) continue;
    console.log(`[preflight] killing LISTEN squatter pid ${pid} on port ${port}`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function api(port: number, token: string, method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
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

export type StreamEvent = { event: string; data: any };

/** SSE reader for one conversation's stream (from cursor 0). */
export class Stream {
  private controller = new AbortController();
  events: StreamEvent[] = [];
  private waiters: Array<() => void> = [];

  constructor(port: number, token: string, conversationId: number) {
    const url = `http://127.0.0.1:${port}/stream?conversationId=${conversationId}&cursor=0`;
    (async () => {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: this.controller.signal });
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
      let buf = "";
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) {
            try {
              this.events.push({ event, data: JSON.parse(data) });
            } catch {
              // keep raw frames out of the typed stream
            }
            for (const w of this.waiters.splice(0)) w();
          }
        }
      }
    })().catch(() => {});
  }

  close(): void {
    this.controller.abort();
  }

  async waitFor(pred: (e: StreamEvent) => boolean, timeoutMs: number): Promise<StreamEvent | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) return undefined;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async waitForRunEnd(submissionId: number, timeoutMs: number): Promise<boolean> {
    const ev = await this.waitFor(
      (e) => e.event === "event" && e.data.type === "run_end" && Array.isArray(e.data.inputs) && e.data.inputs.includes(submissionId),
      timeoutMs,
    );
    return ev !== undefined;
  }

  toolResultTexts(toolName?: string): string[] {
    return this.events
      .filter((e) => e.event === "entry" && e.data.summary?.role === "toolResult" && (!toolName || e.data.summary.toolName === toolName))
      .map((e) => e.data.summary.textPreview ?? "");
  }
}
