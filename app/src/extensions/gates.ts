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
  /**
   * Containment declaration (issue #53): when this conversation runs sandboxed
   * (ConversationMeta.sandbox === true), the tool is ungated — neither the destructive
   * floor nor the declared tier applies, because the sealed container is the protection.
   * Uncontained conversations keep the full gate. Only "sandbox" in phase 1.
   */
  containment?: "sandbox";
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
  ">\\s*/dev/", // still guards non-bash tools (bash candidates drop /dev/* redirections first)
];

/**
 * Words that are destructive only when they ARE the command being run, never when merely
 * mentioned as an argument or in text (issue #53): `grep reboot src/` must not block.
 */
const WEAK_WORD_COMMANDS = new Set(["reboot", "shutdown"]);

/** Heads whose quoted arguments are live shell code, not data. */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval"]);

export type GateTier = "destructive" | "prompt" | "auto";

export type CompiledClassifier = {
  enabled: boolean;
  /** "<provider>:<modelId>" scoring model; undefined → the catalog default at build time. */
  model?: string;
  timeoutMs: number;
  threshold: number;
};

export type CompiledGates = {
  /** tool → auto patterns + default tier (+ optional containment declaration); absent = ungated. */
  tiers: Map<string, { auto: RegExp[]; def: GateTier; containment?: "sandbox" }>;
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
  const tiers = new Map<string, { auto: RegExp[]; def: GateTier; containment?: "sandbox" }>();
  for (const spec of config?.tiers ?? []) {
    if (!spec.tool) throw new Error("gates.json: every tier needs a tool name");
    if (spec.default !== undefined && spec.default !== "prompt") {
      throw new Error(`gates.json: tool "${spec.tool}" has unknown default tier "${String(spec.default)}"`);
    }
    if (spec.containment !== undefined && spec.containment !== "sandbox") {
      throw new Error(`gates.json: tool "${spec.tool}" has unknown containment "${String(spec.containment)}"`);
    }
    tiers.set(spec.tool, {
      auto: (spec.autoPatterns ?? []).map((p) => compilePattern(p, spec.tool)),
      def: spec.default ?? "prompt",
      containment: spec.containment,
    });
  }
  // Loud at startup: containment-gated suppression weakens the floor for sandboxed
  // conversations and must never be enabled by accident (issue #53).
  const contained = [...tiers.entries()].filter(([, s]) => s.containment === "sandbox").map(([t]) => t);
  if (contained.length > 0) {
    console.warn(
      `[gates] containment-gated floor suppression declared for: ${contained.join(", ")} — ` +
        "the destructive tier and declared tier are skipped when a conversation runs sandboxed",
    );
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

/**
 * Reduce a bash command line to the simple-command texts destructive patterns match against
 * (issue #53): split on shell operators and newlines, drop /dev/* redirections (discarding
 * output is not a write), and mask quoted string literals — except when the simple command's
 * head is a shell interpreter or eval, where quoted text is live code and is also tested as
 * its own candidate. Backticks and $(...) are never masked: they execute.
 */
export function destructiveCandidates(command: string): string[] {
  const out: string[] = [];
  for (const segment of splitSimpleCommands(command)) {
    const cleaned = segment.replace(/\d*\s*>>?\s*\/dev\/\S*/g, " ");
    const head = headCommand(cleaned);
    if (head !== null && SHELL_INTERPRETERS.has(head)) {
      out.push(cleaned);
      for (const quoted of quotedSpans(cleaned)) out.push(quoted); // live code: test the contents too
    } else {
      out.push(maskQuotes(cleaned));
    }
  }
  return out;
}

/** The effective command word of a simple command: first token after leading VAR=val assignments and an optional sudo, basename'd. */
export function headCommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_]\w*=\S*$/.test(tokens[i] ?? "")) i++; // VAR=val assignments
  if (tokens[i] === "sudo") i++;
  const word = tokens[i];
  if (!word) return null;
  return word.replace(/^.*\//, "");
}

/** Split a bash line into simple commands on &&, ||, |, ;, & and newlines — quote-aware. */
function splitSimpleCommands(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Contents of single/double-quoted spans (double-quote escapes honored). */
function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "'" && ch !== '"') {
      i++;
      continue;
    }
    let j = i + 1;
    let content = "";
    while (j < text.length) {
      if (ch === '"' && text[j] === "\\" && j + 1 < text.length) {
        content += text[j + 1];
        j += 2;
        continue;
      }
      if (text[j] === ch) break;
      content += text[j];
      j++;
    }
    spans.push(content);
    i = j + 1;
  }
  return spans;
}

/** The command with all quoted spans removed — data positions can't perform actions. */
function maskQuotes(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (ch === '"' && text[j] === "\\" && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (text[j] === ch) break;
        j++;
      }
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Destructive check (issue #53): patterns match simple-command candidates for bash, raw text
 * otherwise; reboot/shutdown count only as the command being run, never as a mentioned word.
 */
function isDestructive(gates: CompiledGates, tool: string, text: string): boolean {
  const candidates = tool === "bash" ? destructiveCandidates(text) : [text];
  if (gates.destructive.some((p) => candidates.some((c) => p.test(c)))) return true;
  return candidates.some((c) => {
    const head = headCommand(c);
    return head !== null && WEAK_WORD_COMMANDS.has(head);
  });
}

/**
 * Containment-gated floor suppression (issue #53): a tool whose tier declares
 * containment:"sandbox" is ungated when the conversation runs sandboxed — the sealed
 * container is the protection. Pure so it is unit-testable; the hook supplies the meta.
 */
export function applyContainment(
  gates: CompiledGates,
  tool: string,
  tier: GateTier | null,
  sandboxed: boolean,
): GateTier | null {
  if (tier === null || !sandboxed) return tier;
  if (gates.tiers.get(tool)?.containment !== "sandbox") return tier;
  return null;
}

/** First match wins: destructive > auto pattern > tool default. null = ungated. */
export function evaluateGate(gates: CompiledGates, tool: string, args: unknown): GateTier | null {
  const text = gateArgText(tool, args);
  if (isDestructive(gates, tool, text)) return "destructive";
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


