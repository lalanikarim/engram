// Approval gating (PoC Phase 3b pattern, productionized):
// - A beforeTool hook blocks any configured "gated" tool until a human decision is stored
//   durably in the session-scoped ApprovalDoc family.
// - Key = sha1(tool name + exact args) → approvals are per distinct action and idempotent
//   across crash-retries (an approved action re-executes on retry by design).
// - The hook only READS the decision; only the API driver writes it, so the agent cannot self-approve.
// - Blocked calls leave a machine-parseable marker in the transcript; GET /approvals discovers
//   pending requests from those markers (verified crash-safe in PoC Phase 3b).
import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineDocFamily, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import { evaluateGate, type CompiledGates, type GateTier } from "./gates.ts";

export type ApprovalState = {
  decision: "pending" | "approved" | "denied";
  decidedBy: string | null;
  decidedAt: number | null;
  /** Human-supplied reason (usually for denials), fed back to the agent. */
  reason?: string | null;
};

/**
 * A persistent global allow-rule (docs/plans/approvals.md, phase 2): calls whose tool and
 * every `match` field equal the call's args pass without prompting. Destructive-tier calls
 * are never matched — the guard is evaluated before rules.
 */
export type ApprovalRule = {
  /** Stable id: sha1(tool + canonical match) — creating the same rule twice is a no-op. */
  id: string;
  tool: string;
  /** Top-level arg fields that must equal the call's args (string values). */
  match: Record<string, string>;
  createdAt: number;
  source: string;
};

/** Session-scoped singleton holding every allow-rule. */
export const ApprovalRulesDoc = defineDoc({
  scope: "session",
  kind: "mvp.approval-rules",
  version: 1,
  initial: (): { rules: ApprovalRule[] } => ({ rules: [] }),
});

/** Stable rule id from (tool, match). */
export function ruleIdFor(tool: string, match: Record<string, string>): string {
  return createHash("sha1")
    .update(tool)
    .update(JSON.stringify(canonicalize(match)))
    .digest("hex")
    .slice(0, 12);
}

/**
 * Default rule scope when a human taps "Always allow": the recipient for send_message,
 * otherwise every top-level scalar arg (an exact-action rule).
 */
export function defaultRuleMatch(tool: string, args: unknown): Record<string, string> {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "send_message" && typeof a.to === "string") return { to: a.to };
  const match: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") match[k] = String(v);
  }
  return match;
}

/**
 * TTL expiry (docs/plans/approvals.md, phase 3): a pending request is expired once it has
 * been waiting longer than `ttlMs`. `pendingSince` comes from the marker entry's timestamp;
 * an unknown time never expires (conservative — when in doubt, keep asking).
 */
export function isApprovalExpired(pendingSince: number | undefined, now: number, ttlMs: number): boolean {
  return pendingSince !== undefined && now - pendingSince > ttlMs;
}

/** True when some rule matches this call (tool + every match field equal). */
export function ruleMatches(rules: readonly ApprovalRule[], tool: string, args: unknown): boolean {
  const a = (args ?? {}) as Record<string, unknown>;
  return rules.some((r) => {
    if (r.tool !== tool) return false;
    return Object.entries(r.match).every(([k, v]) => String(a[k] ?? "") === v);
  });
}

export const ApprovalDoc = defineDocFamily<ApprovalState, JsonValue>({
  family: true,
  scope: "session",
  kind: "mvp.approval",
  version: 1,
  initial: () => ({ decision: "pending", decidedBy: null, decidedAt: null }),
});

export type ApprovalRequest = {
  key: string;
  tool: string;
  args: Record<string, unknown>;
  /** Risk tier that produced this request ("prompt" | "destructive"). Absent on pre-tier markers. */
  tier?: GateTier;
};

/** Canonical JSON: object keys sorted recursively, so logically identical args serialize identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Stable approval key for a call: logically identical args map to the same key even when the model
 * re-serializes them with a different property order (verified by the integration suite).
 */
export function approvalKeyFor(name: string, arguments_: unknown): string {
  return createHash("sha1")
    .update(name)
    .update(JSON.stringify(canonicalize(arguments_ ?? {})))
    .digest("hex")
    .slice(0, 12);
}

/** The exact marker embedded in a blocked tool result; GET /approvals parses it. */
export function approvalMarker(req: ApprovalRequest): string {
  return `Approval request: ${JSON.stringify(req)}`;
}

/** Parse an approval marker out of a transcript entry's text, if present. */
export function parseApprovalMarker(text: string): ApprovalRequest | undefined {
  const start = text.indexOf("Approval request: ");
  if (start === -1) return undefined;
  const jsonStart = text.indexOf("{", start);
  if (jsonStart === -1) return undefined;
  // Brace-balanced scan (args may contain nested objects).
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const req = JSON.parse(text.slice(jsonStart, i + 1)) as ApprovalRequest;
          if (typeof req.key === "string" && typeof req.tool === "string") return req;
        } catch {
          // malformed marker
        }
        return undefined;
      }
    }
  }
  return undefined;
}

export function approvalHook(gates: CompiledGates) {
  return hook(ToolTask, {
    beforeTool: async (call, api, ctx) => {
      const tier = evaluateGate(gates, call.name, call.arguments);
      if (tier === null || tier === "auto") return undefined; // ungated or auto-approved
      // Persistent allow-rules: checked after the destructive guard (destructive never
      // matches) and before the prompt block — matching calls pass silently.
      if (tier === "prompt") {
        const rulesDoc = await api.snapshot(ApprovalRulesDoc, ctx);
        if (rulesDoc && ruleMatches(rulesDoc.rules, call.name, call.arguments)) return undefined;
      }
      const key = approvalKeyFor(call.name, call.arguments);
      const rec = await api.snapshot(ApprovalDoc, key, ctx);
      if (rec?.decision === "approved") return undefined; // allow
      if (rec?.decision === "denied") {
        // Already decided against (human or TTL): a hard stop, not a new request.
        const by = rec.decidedBy ? ` by ${rec.decidedBy}` : "";
        const why = rec.reason ? ` Reason given: \u201c${rec.reason}\u201d` : "";
        return {
          block:
            `BLOCKED: \u201c${call.name}\u201d was DENIED${by}${why}. Do not retry this action; report that it was declined and adapt if possible.`,
        };
      }
      const marker = approvalMarker({ key, tool: call.name, args: call.arguments ?? {}, tier });
      const warning =
        tier === "destructive"
          ? "This action was classified DESTRUCTIVE. It will run only if the user explicitly acknowledges the risk.\n"
          : "";
      return {
        block:
          `BLOCKED: "${call.name}" requires human approval before it can run.\n` +
          warning +
          `${marker}\n` +
          "Do not retry this action until the user has approved it. Tell the user that this action needs their " +
          "explicit approval (they can approve via the client, or by telling you — you cannot self-approve).",
      };
    },
  });
}


/**
 * Demo gated tool: simulates an outgoing send (the first external side effect; real email/Telegram
 * sending lands in Week 2 behind this same gate).
 */
export function sendMessageTool() {
  return defineTool({
    name: "send_message",
    description:
      'Send an outgoing message to a recipient. This is an EXTERNAL SIDE EFFECT and requires human approval before it can run.',
    parameters: Type.Object({ to: Type.String(), message: Type.String() }),
    replay: "unsafe", // external side effect — the harness tracks execution durably
    execute: async (args: { to: string; message: string }) => ({
      output: [{ type: "text" as const, text: `ACTION EXECUTED: sent "${args.message}" to ${args.to}` }],
    }),
  });
}
