// Issue #76: every config snippet and tier claim in docs/gates.md must compile and evaluate as documented.
// An example that does not run is worse than no example — this suite re-runs the page's worked example end to end.
//
// Run with: node app/test/gates-docs-verification.test.ts
import { compileGates, evaluateGate } from "../src/extensions/gates.ts";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Verbatim from docs/gates.md "Worked example (correct as written)". */
const docConfig = {
  tiers: [
    { tool: "bash", default: "prompt" },
    { tool: "write", default: "prompt" },
    { tool: "edit", default: "prompt" },
    { tool: "submit_verdict", default: "prompt" },
  ],
  destructiveArgs: {
    write: ["path"],
    edit: ["edits[].path", "path"],
    submit_verdict: [],
  },
};

// Capture the startup posture line exactly as the kernel prints it.
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.join(" "));
};
let gates: ReturnType<typeof compileGates>;
try {
  gates = compileGates(docConfig);
} finally {
  console.warn = originalWarn;
}

console.log("# startup posture line (docs/gates.md § The startup posture line)");
const POSTURE_PREFIX = "[gates] destructive floor judges effect-bearing args only for: ";
check(
  "posture line printed verbatim at compile/startup",
  warnings.some((w) => w.startsWith(POSTURE_PREFIX)),
  JSON.stringify(warnings),
);
check(
  "posture line lists the worked-example entries, prose-only as (nothing scanned)",
  warnings.some((w) =>
    w.includes("write(path), edit(edits[].path,path), multi_edit(edits[].path,path), submit_verdict(nothing scanned)"),
  ),
);
// The posture line prints on every startup — shipped coding tools always appear in it, with or without config.
const defaultWarnings: string[] = [];
console.warn = (...args: unknown[]) => {
  defaultWarnings.push(args.join(" "));
};
try {
  compileGates({ tiers: [] });
} finally {
  console.warn = originalWarn;
}
check(
  "posture line also prints with no destructiveArgs declared (shipped defaults always listed)",
  defaultWarnings.some((w) => w.startsWith(POSTURE_PREFIX) && w.includes("write(path), edit(edits[].path,path), multi_edit(edits[].path,path)")),
  JSON.stringify(defaultWarnings),
);

console.log("# worked-example evaluations (docs/gates.md § Worked example)");
check(
  "write test file whose content is 'rm -rf /' → prompt (content is text, not execution)",
  evaluateGate(gates, "write", { path: "app/test/x.test.ts", content: "rm -rf /" }) === "prompt",
);
check(
  "write /Users/dev/.bashrc with 'rm -rf /' → destructive (target is destructive by identity)",
  evaluateGate(gates, "write", { path: "/Users/dev/.bashrc", content: "rm -rf /" }) === "destructive",
);
check(
  "edit whose oldText quotes the pattern list → prompt (only edits[].path is scanned)",
  evaluateGate(gates, "edit", {
    edits: [{ path: "app/src/extensions/gates.ts", oldText: "\\brm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\\b", newText: "" }],
  }) === "prompt",
);
check(
  "submit_verdict quoting 'rm -rf' in evidence → prompt ([] removes the floor; declared tier still applies)",
  evaluateGate(gates, "submit_verdict", {
    issueNumber: 69,
    verdict: "fail",
    evidence: ['sh -c "rm -rf /tmp/x"'],
  }) === "prompt",
);
check(
  "db_exec DROP TABLE (never declared) → destructive (absent entry = scan every string arg)",
  evaluateGate(gates, "db_exec", { sql: "DROP TABLE users" }) === "destructive",
);

console.log("# the strict default and its failure modes");
check(
  "undeclared custom tool carrying rm -rf in a payload arg → destructive (narrowing is opt-in)",
  evaluateGate(gates, "some_future_tool", { command: "rm -rf /tmp/x" }) === "destructive",
);
check(
  "undeclared tool with no tier and harmless args → ungated (null)",
  evaluateGate(gates, "some_future_tool", { a: "ls -la" }) === null,
);
check(
  "too-narrow declaration silently stops the floor for that tool (the silent failure mode)",
  evaluateGate(
    compileGates({ tiers: [{ tool: "write", default: "prompt" }], destructiveArgs: { write: [] } }),
    "write",
    { path: "/Users/dev/.bashrc", content: "rm -rf /" },
  ) === "prompt",
);

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
