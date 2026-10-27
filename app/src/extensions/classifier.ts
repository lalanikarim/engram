// Classifier-assisted risk scoring (docs/plans/approvals.md, phase 5).
//
// A local model scores each prompt-tier action before the human sees it:
//   - score: 0..1 — estimated risk of harm if executed
//   - destructive: the model's call that the action is irreversible/damaging
//   - note: one plain-English line for the approver
//
// Fail-safe invariants (MUST survive any future change):
//   - The classifier NEVER approves, auto-passes, or suppresses a prompt. It can only
//     escalate "prompt" → "destructive" and annotate pending requests. Only humans write
//     decisions; allow-rules remain human-driven.
//   - Any failure (timeout, missing model, malformed output) degrades to the plain
//     prompt tier — classification can never block the gate or let an action through.
//   - The approval key is unchanged: sha1(tool + canonical args). Classifier output
//     never feeds the key, so crash-retry idempotency is unaffected.

import type { AssistantMessageEventStream, Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

/** One classification verdict for a gated action. */
export type ClassifierVerdict = { score: number; destructive: boolean; note: string };

/** Classifies one gated action. Throws on any failure (callers fail safe). */
export type ClassifyAction = (input: { tool: string; args: unknown }) => Promise<ClassifierVerdict>;

const NOTE_MAX = 200;
const ARGS_MAX_CHARS = 2000;

/** Parse + validate the model's JSON verdict. Returns null when unparseable/invalid. */
export function parseVerdict(text: string): ClassifierVerdict | null {
  const obj = firstJsonObject(text);
  if (!obj) return null;
  const rawScore = obj.score;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) return null;
  const score = Math.min(1, Math.max(0, rawScore));
  const destructive = rawBool(obj.destructive);
  const note = typeof obj.note === "string" ? obj.note.slice(0, NOTE_MAX) : "";
  return { score, destructive, note };
}

/** Escalation rule: prompt → destructive iff the verdict says so or the score crosses the threshold. */
export function applyVerdict(verdict: ClassifierVerdict, threshold: number): "prompt" | "destructive" {
  return verdict.destructive || verdict.score >= threshold ? "destructive" : "prompt";
}

/** Build the classifier from a catalog model. Throws if the model is unknown (caller falls back). */
export function makeClassifyAction(models: Models, modelRef: ModelRef, timeoutMs: number): ClassifyAction {
  const model = models.getModel(modelRef.provider, modelRef.modelId);
  if (!model) throw new Error(`classifier model "${modelRef.provider}:${modelRef.modelId}" is not in the catalog`);
  return async ({ tool, args }) => {
    const prompt = [
      "You are a risk classifier for an AI agent's pending tool call. A human will be asked to approve it.",
      `Tool: ${tool}`,
      `Args: ${JSON.stringify(args ?? {}).slice(0, ARGS_MAX_CHARS)}`,
      'Reply with ONLY a JSON object: {"score": <number 0..1 — risk of harm if executed>, "destructive": <boolean — true only if this could irreversibly damage data or systems>, "note": "<= 160 chars — plain-English summary of what it does and why it is risky>}.',
    ].join("\n");
    const stream = models.streamSimple(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
    const text = await withTimeout(collectText(stream), timeoutMs);
    const verdict = parseVerdict(text);
    if (!verdict) throw new Error("classifier returned an unparseable verdict");
    return verdict;
  };
}

/** First balanced JSON object in the text (models often wrap JSON in prose/markdown). */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          return obj !== null && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function rawBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  if (typeof v === "number") return v !== 0;
  return false;
}

async function collectText(stream: AssistantMessageEventStream): Promise<string> {
  let text = "";
  for await (const ev of stream) {
    if (ev.type === "text_delta") text += ev.delta;
    else if (ev.type === "error") throw new Error("classifier model call failed");
  }
  return text;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`classifier timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
