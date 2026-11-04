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
  /**
   * Per-tool effect-bearing argument paths for the destructive floor (issue #69). Merged over
   * DEFAULT_DESTRUCTIVE_ARGS: a tool named here replaces that tool's list, so a deployment can narrow its own
   * tools without touching the shipped ones. An empty list means "this call carries no destructive argument" —
   * for prose-only tools (record a verdict, open a draft PR) where nothing about the payload can be destructive.
   */
  destructiveArgs?: Record<string, string[]>;
  classifier?: ClassifierSpec;
};

/** Built-in safety floor — always active regardless of config. */
export const DEFAULT_DESTRUCTIVE_PATTERNS: string[] = [
  "\\brm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\\b", // rm -rf / -fr (any order, with extras)
  "\\brm(?:Sync|Async)\\s*\\([^)]*recursive\\s*:\\s*true", // Node fs recursive delete (issue #63)
  "\\bmkfs(\\.|\\s|$)",
  "\\bdd\\s+if=",
  ":\\(\\)\\{", // fork bomb
  "\\bgit\\s+push\\s+(-f|--force)(-|\\s|$)",
  "\\bgit\\s+reset\\s+--hard\\b",
  "\\bDROP\\s+(TABLE|DATABASE|INDEX)\\b",
  "\\bTRUNCATE\\s+\\w+",
  ">\\s*/dev/", // guards device writes (bash candidates drop only discard sinks, issue #63)
];

/**
 * Effect-bearing argument paths for the destructive floor (issue #69).
 *
 * The floor used to scan every string argument of every tool call, which cannot tell doing a thing from describing
 * it. In production that meant: writing a test whose cleanup is `rmSync(dir,{recursive:true})`, a review verdict
 * quoting the payload it had just reproduced, and a PR summary mentioning `/dev/sda` were each classified
 * DESTRUCTIVE — and because destructive keys can never be allow-listed, every one cost a fresh human approval.
 * Across four real stores: 18 markers, 7 distinct causes, **0** destructive effects.
 *
 * The principle is not new — #53 introduced "words that are destructive only when they ARE the command being run"
 * for bash, and #63 extended it to quoted arguments of code-executing heads. This applies the same distinction to
 * non-bash tools: a call is judged on the arguments that carry its effect.
 *
 * Path syntax: `.` nests, `[]` maps over an array (`edits[].path`). A tool listed here is scanned ONLY at those
 * paths, so this table stays short and reviewed — and it is only safe alongside PATH_DESTRUCTIVE_PATTERNS below,
 * which keeps the targets that are dangerous by identity (devices, credentials, files executed later) destructive
 * regardless of what the payload says.
 *
 * A tool NOT listed here keeps today's behavior: every string argument is scanned. Unknown and custom tools never
 * become weaker by default — narrowing is opt-in, here or in gates.json.
 */
export const DEFAULT_DESTRUCTIVE_ARGS: Record<string, string[]> = {
  // CodingTools: the effect is WHICH file changes, not what the new text happens to contain.
  write: ["path"],
  edit: ["edits[].path", "path"],
  multi_edit: ["edits[].path", "path"],
};

/**
 * Targets that are destructive by identity rather than by payload (issue #69). Matched against the same candidates
 * the floor already judges, so `write {path:"/dev/sda"}` and an edit onto `.ssh/authorized_keys` stay DESTRUCTIVE
 * while the identical call writing `app/test/x.test.ts` does not.
 *
 * Two families, and the second is what makes narrowing honest rather than merely permissive:
 *   (a) the target IS the damage — block devices, key material, account databases;
 *   (b) content that executes later — shell rc files, git hooks, cron/systemd/launchd units. Writing `rm -rf /`
 *       into `~/.bashrc` is destructive even though no command ran; the path says so without reading the payload.
 *
 * `/dev/null`, `/dev/stdout`, `/dev/stderr` and `/dev/fd/*` are deliberately absent: they are discard sinks, and
 * #63 established that discarding output is not a write.
 */
export const PATH_DESTRUCTIVE_PATTERNS: string[] = [
  "(^|/)/dev/(sd[a-z]|nvme|disk|rd|md|mapper)([0-9]|$)", // whole disks and partitions
  "(^|/)[.]ssh(/|$)", // key material and authorized_keys live here
  "(^|/)(authorized_keys|authorized_keys2)$",
  "^/etc/(passwd|shadow|group|sudoers)([.]|$)",
  "^/etc/ssh/sshd_config$",
  "(^|/)/etc/(cron|systemd)/",
  "(^|/)[.]git/hooks/",
  "(^|/)[.](bashrc|bash_profile|bash_login|zshrc|zshenv|zprofile|profile)$",
  "(^|/)Library/Launch(Agents|Daemons)/",
];

/**
 * Words that are destructive only when they ARE the command being run, never when merely
 * mentioned as an argument or in text (issue #53): `grep reboot src/` must not block.
 */
const WEAK_WORD_COMMANDS = new Set(["reboot", "shutdown"]);

/**
 * Heads whose quoted arguments are live code executed by the head, not data (issue #63).
 * Basename → execution flag(s) that put the command in "code mode"; an empty list means any
 * quoted argument is code (shells: -c scripts and script paths alike). Adding a new
 * interpreter is a data change here, not a logic change.
 */
const CODE_INTERPRETERS = new Map<string, string[]>([
  ["sh", []], ["bash", []], ["zsh", []], ["dash", []], ["ksh", []], ["eval", []],
  ["python", ["-c"]], ["python3", ["-c"]], ["perl", ["-e"]], ["ruby", ["-e"]],
  ["node", ["-e", "--eval"]], ["deno", ["--eval"]],
]);

/**
 * Whether a simple command's quoted spans are live code (issue #63): true when some token is
 * an interpreter head and — for flag-gated heads — one of its execution flags appears as a
 * later argument. Scanning every token means heads hidden behind sudo/VAR= are found, and
 * `docker run image sh -c "…"` counts: the inner `sh -c` executes the span.
 */
function hasLiveCodeArgs(cleaned: string): boolean {
  const tokens = cleaned.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const flags = CODE_INTERPRETERS.get((tokens[i] ?? "").replace(/^.*\//, ""));
    if (flags === undefined) continue;
    if (flags.length === 0) return true;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j] ?? "";
      if (flags.some((f) => t === f || (f.startsWith("--") && t.startsWith(`${f}=`)))) return true;
    }
  }
  return false;
}

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
  /** Targets destructive by identity (issue #69): devices, credentials, later-executed files. */
  pathDestructive: RegExp[];
  /** tool → effect-bearing arg paths scanned by the floor; absent = scan every string arg (#69). */
  destructiveArgs: Map<string, string[]>;
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
  const pathDestructive = PATH_DESTRUCTIVE_PATTERNS.map((p) => compilePattern(p, "<path-destructive>"));

  // Effect paths: built-ins, then per-tool overrides from config. An empty array is meaningful ("nothing this call
  // carries can be destructive") and must not be confused with an absent entry, which means "scan everything".
  const destructiveArgs = new Map<string, string[]>(Object.entries(DEFAULT_DESTRUCTIVE_ARGS));
  for (const [tool, paths] of Object.entries(config?.destructiveArgs ?? {})) {
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
      throw new Error(`gates.json: destructiveArgs["${tool}"] must be an array of arg paths (strings)`);
    }
    destructiveArgs.set(tool, [...paths]);
  }
  // Loud at startup, like the containment declaration: a narrowed floor is a posture change and must not be visible
  // only in a diff. Prose-only tools are named as such because those are the calls left with no floor at all.
  const narrowed = [...destructiveArgs.entries()].map(([t, p]) => `${t}(${p.join(",") || "nothing scanned"})`);
  if (narrowed.length > 0) {
    console.warn(
      `[gates] destructive floor judges effect-bearing args only for: ${narrowed.join(", ")} — ` +
        "payload/prose is not scanned for these tools; device/credential/later-executed paths stay destructive",
    );
  }
  return { tiers, destructive, pathDestructive, destructiveArgs, classifier: compileClassifier(config?.classifier) };
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
 * (issues #53/#63): split on shell operators and newlines, drop discard-sink redirections
 * (/dev/null, /dev/stdout, /dev/stderr, /dev/fd/* — discarding output is not a write, but
 * writes onto other devices stay as candidates), and mask quoted string literals — except
 * when the simple command passes quoted arguments to a code-executing head (shell,
 * python/python3 -c, node -e, deno run --eval, docker run … sh -c, …), where quoted text is
 * live code and is also tested as its own candidate. Backticks and $(...) are never masked:
 * they execute.
 */
export function destructiveCandidates(command: string): string[] {
  const out: string[] = [];
  for (const segment of splitSimpleCommands(command)) {
    // Drop only actual discard sinks; any other /dev/* target stays (issue #63).
    const cleaned = segment.replace(
      /\d*\s*>>?\s*\/dev\/(?:null|stdout|stderr)(?=\s|$)|\d*\s*>>?\s*\/dev\/fd\/\S*/g,
      " ",
    );
    if (hasLiveCodeArgs(cleaned)) {
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
 * The strings the destructive floor judges for one call (issue #69). Three cases, in order:
 *   - `bash`: shell-aware simple-command candidates, exactly as #53/#63 built them.
 *   - a tool with effect-bearing paths (`DEFAULT_DESTRUCTIVE_ARGS` or gates.json): only the values at those paths.
 *     This is what stops file content and prose fields from being read as commands.
 *   - anything else: the whole canonical arg text, unchanged — so an unknown tool taking a `sql` or `command`
 *     string is still judged on it. Failing safe here means failing strict.
 */
export function gateCandidates(gates: CompiledGates, tool: string, args: unknown): string[] {
  if (tool === "bash") return destructiveCandidates(gateArgText(tool, args));
  const paths = gates.destructiveArgs.get(tool);
  if (paths === undefined) return [gateArgText(tool, args)];
  const out: string[] = [];
  for (const p of paths) for (const v of valuesAtArgPath(args, p)) out.push(v);
  return out;
}

/** Resolve an arg path (`path`, `a.b`, `edits[].path`) to the string values it names. Missing → no candidate. */
function valuesAtArgPath(value: unknown, path: string): string[] {
  const [head, ...rest] = path.split(".");
  if (!head) return [];
  const isMapped = head.endsWith("[]");
  const key = isMapped ? head.slice(0, -2) : head;
  const container = (value ?? {}) as Record<string, unknown>;
  const next = container[key];
  if (isMapped && !Array.isArray(next)) return [];
  const step = isMapped ? (next as unknown[]) : [next];
  const here = rest.length === 0 ? step : step.flatMap((item) => valuesAtArgPath(item, rest.join(".")));
  return here.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Destructive check (issues #53/#63/#69): patterns match the call's candidates — simple-command texts for bash,
 * effect-bearing argument values for narrowed tools, raw arg text otherwise. `reboot`/`shutdown` count only as the
 * command being run, never as a mentioned word.
 */
function isDestructive(gates: CompiledGates, candidates: string[]): boolean {
  if (gates.destructive.some((p) => candidates.some((c) => p.test(c)))) return true;
  // Identity targets (#69): judged on candidates only, never on prose — a PR summary that quotes
  // "~/.ssh/authorized_keys" is not an attempt to write it.
  if (gates.pathDestructive.some((c2) => candidates.some((c) => c2.test(c)))) return true;
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
  if (isDestructive(gates, gateCandidates(gates, tool, args))) return "destructive";
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


