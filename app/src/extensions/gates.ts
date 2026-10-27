// Risk-tiered approval gating (docs/plans/approvals.md, phase 1).
//
// Evaluation order per tool call (first match wins):
//   1. Destructive guard — args matching a destructive pattern are ALWAYS tier
//      "destructive": they prompt with explicit acknowledgement and can never be
//      auto-approved or covered by allow-rules (phase 2 must preserve this).
//   2. Tool tier from config — an `auto` pattern match passes silently; otherwise the
//      tool's default tier ("prompt") blocks until a human decision.
//   3. Ungated tools: no gate.
/** One declared gate (app/gates.json). */
export type GateSpec = {
  /** Tool name this tier applies to. */
  tool: string;
  /** Args matching any of these regexes pass without prompting (still logged). */
  autoPatterns?: string[];
  /** Tier when no auto pattern matches. Only "prompt" in phase 1. */
  default?: "prompt";
};

/**
 * Classifier-assisted risk scoring (docs/plans/approvals.md, phase 5). A local model scores
 * prompt-tier actions before the human sees them; it can only escalate to destructive and
 * annotate — never approve or suppress (see classifier.ts invariants).
 */
export type ClassifierSpec = {
  /** Enable classification of prompt-tier actions. Default false. */
  enabled?: boolean;
  /** "<provider>:<modelId>" — the scoring model. Default: the catalog default model. */
  model?: string;
  /** Max time for one classification (ms). Default 60000 (local 27B models can be slow). */
  timeoutMs?: number;
  /** A score at or above this escalates prompt → destructive. Default 0.7. */
  destructiveThreshold?: number;
};

/** gates.json shape. */
export type GatesConfig = {
  tiers: GateSpec[];
  /** Extra destructive patterns, added to the built-in list (never removed). */
  destructivePatterns?: string[];
  classifier?: ClassifierSpec;
};

/** Built-in safety floor — always active regardless of config. */
export const DEFAULT_DESTRUCTIVE_PATTERNS: string[] = [
  "\\brm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\\b", // rm -rf / -fr (any order, with extras)
  "\\bmkfs(\\.|\\s|$)",
  "\\bdd\\s+if=",
  ":\\(\\)\\{", // fork bomb
  "\\bgit\\s+push\\s+(-f|--force)(-|\\s|$)",
  "\\bgit\\s+reset\\s+--hard\\b",
  "\\bDROP\\s+(TABLE|DATABASE|INDEX)\\b",
  "\\bTRUNCATE\\s+\\w+",
  ">\\s*/dev/",
  "\\bshutdown\\b",
  "\\breboot\\b",
];

export type GateTier = "destructive" | "prompt" | "auto";

export type CompiledClassifier = {
  enabled: boolean;
  /** "<provider>:<modelId>" scoring model; undefined → the catalog default at build time. */
  model?: string;
  timeoutMs: number;
  threshold: number;
};

export type CompiledGates = {
  /** tool → auto patterns + default tier; absent = ungated. */
  tiers: Map<string, { auto: RegExp[]; def: GateTier }>;
  destructive: RegExp[];
  classifier: CompiledClassifier;
};

/** Canonical arg text a pattern is matched against: the command for bash, else canonical JSON. */
export function gateArgText(tool: string, args: unknown): string {
  if (tool === "bash" && args !== null && typeof args === "object" && "command" in (args as Record<string, unknown>)) {
    return String((args as Record<string, unknown>).command);
  }
  return JSON.stringify(canonicalizeJson(args ?? {}));
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalizeJson((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function compileGates(config: GatesConfig | null): CompiledGates {
  const tiers = new Map<string, { auto: RegExp[]; def: GateTier }>();
  for (const spec of config?.tiers ?? []) {
    if (!spec.tool) throw new Error("gates.json: every tier needs a tool name");
    if (spec.default !== undefined && spec.default !== "prompt") {
      throw new Error(`gates.json: tool "${spec.tool}" has unknown default tier "${String(spec.default)}"`);
    }
    tiers.set(spec.tool, {
      auto: (spec.autoPatterns ?? []).map((p) => compilePattern(p, spec.tool)),
      def: spec.default ?? "prompt",
    });
  }
  const destructive = [...DEFAULT_DESTRUCTIVE_PATTERNS, ...(config?.destructivePatterns ?? [])].map((p) =>
    compilePattern(p, "<destructive>"),
  );
  return { tiers, destructive, classifier: compileClassifier(config?.classifier) };
}

function compileClassifier(spec: ClassifierSpec | undefined): CompiledClassifier {
  if (spec === undefined) return { enabled: false, timeoutMs: 60_000, threshold: 0.7 };
  if (spec.enabled !== undefined && typeof spec.enabled !== "boolean") throw new Error("gates.json: classifier.enabled must be a boolean");
  let model: string | undefined;
  if (spec.model !== undefined) {
    const m = /^([^:\s]+):([^:\s]+)$/.exec(spec.model);
    if (!m) throw new Error(`gates.json: classifier.model must be "<provider>:<modelId>", got "${spec.model}"`);
    model = spec.model;
  }
  const timeoutMs = spec.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("gates.json: classifier.timeoutMs must be a positive integer");
  const threshold = spec.destructiveThreshold ?? 0.7;
  if (typeof threshold !== "number" || !(threshold > 0 && threshold <= 1)) {
    throw new Error("gates.json: classifier.destructiveThreshold must be a number in (0, 1]");
  }
  return { enabled: spec.enabled ?? false, model, timeoutMs, threshold };
}

function compilePattern(pattern: string, where: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`gates.json: invalid regex "${pattern}" (${where}): ${(e as Error).message}`);
  }
}

/** First match wins: destructive > auto pattern > tool default. null = ungated. */
export function evaluateGate(gates: CompiledGates, tool: string, args: unknown): GateTier | null {
  const text = gateArgText(tool, args);
  if (gates.destructive.some((p) => p.test(text))) return "destructive";
  const spec = gates.tiers.get(tool);
  if (!spec) return null;
  if (spec.auto.some((p) => p.test(text))) return "auto";
  return spec.def;
}

/** Human-readable rendering of a gated action for prompts. */
export function renderAction(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "bash") return String(a.command ?? "");
  if (tool === "send_message") {
    const to = a.to !== undefined ? `to ${String(a.to)}` : "";
    const message = a.message !== undefined ? `\n${String(a.message)}` : "";
    return `${to}${message}`.trim();
  }
  return JSON.stringify(canonicalizeJson(args ?? {}));
}


