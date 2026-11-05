// Issue #69: the destructive floor must judge a call by the arguments that carry its EFFECT, not by every string
// inside it. Regression cover for false positives observed in four production stores (18 approval markers, 7 distinct
// causes, 0 destructive effects) and for the true positives narrowing must not lose.
//
// Run with: node app/test/gates-prose-args.test.ts
import {
  DEFAULT_DESTRUCTIVE_ARGS,
  PATH_DESTRUCTIVE_PATTERNS,
  compileGates,
  evaluateGate,
  gateCandidates,
} from "../src/extensions/gates.ts";

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

// The shipped posture: no tiers, floor only. This is what a factory instance's gates.json looks like today apart
// from merge_pr/bash declarations, so the false positives below reproduce here unaided.
const gates = compileGates({ tiers: [] });

/** Verbatim shapes from approval markers recorded in the real instance stores (see issue #69). */
const TEST_CLEANUP_CONTENT = `
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  main().catch((err) => { console.error(err); process.exit(1); });
`;
const GUARD_SOURCE_OLDTEXT = `
  "\\\\brm\\\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\\\\b", // rm -rf / -fr (any order, with extras)
  "\\\\brm(?:Sync|Async)\\\\s*\\\\([^)]*recursive\\\\s*:\\\\s*true", // Node fs recursive delete (issue #63)
`;
const GUARD_TEST_NEWTEXT = `
  check("fs.rmSync recursive is destructive", evaluateGate(minimal, "bash", { command: \`node -e "require('fs').rmSync('/tmp/x',{recursive:true})"\` }) === "destructive");
`;

console.log("# false positives that blocked real runs (issue #69) — must NOT be destructive");
check(
  "write: test file whose cleanup is rmSync(...recursive:true)",
  evaluateGate(gates, "write", { path: "app/test/root-agent-reapply.test.ts", content: TEST_CLEANUP_CONTENT }) !== "destructive",
);
check(
  "edit: oldText quoting the destructive pattern list of gates.ts itself",
  evaluateGate(gates, "edit", { edits: [{ path: "app/src/extensions/gates.ts", oldText: GUARD_SOURCE_OLDTEXT, newText: "" }] }) !== "destructive",
);
check(
  "edit: newText asserting that rmSync IS classified destructive",
  evaluateGate(gates, "edit", { edits: [{ path: "app/test/gates.test.ts", oldText: "", newText: GUARD_TEST_NEWTEXT }] }) !== "destructive",
);
check(
  "write: content MENTIONING a dangerous path is not a write to it",
  evaluateGate(gates, "write", { path: "docs/security.md", content: "Never chmod 666 /etc/passwd, and never write ~/.ssh/authorized_keys from an agent." }) !== "destructive",
);

console.log("\n# true positives narrowing must preserve");
check("bash rm -rf still destructive", evaluateGate(gates, "bash", { command: "rm -rf /var" }) === "destructive");
check(
  "bash interpreter-wrapped rmSync still destructive (#63)",
  evaluateGate(gates, "bash", { command: `node -e "require('fs').rmSync('/tmp/x',{recursive:true})"` }) === "destructive",
);
check("write /dev/sda is destructive by target", evaluateGate(gates, "write", { path: "/dev/sda", content: "x" }) === "destructive");
check("write ./ssh dir path is destructive", evaluateGate(gates, "write", { path: "/Users/dev/.ssh/id_ed25519", content: "x" }) === "destructive");
check(
  "write authorized_keys is destructive",
  evaluateGate(gates, "write", { path: "/home/deploy/.ssh/authorized_keys", content: "ssh-rsa AAAA… attacker@host" }) === "destructive",
);
check(
  "write ~/.bashrc is destructive — content executes at next login (#69 family b)",
  evaluateGate(gates, "write", { path: "/Users/dev/.bashrc", content: "rm -rf ./node_modules" }) === "destructive",
);
check(
  "edit .git/hooks/pre-commit is destructive",
  evaluateGate(gates, "edit", { edits: [{ path: "/repo/.git/hooks/pre-commit", oldText: "a", newText: "b" }] }) === "destructive",
);
check(
  "write Library/LaunchAgents unit is destructive",
  evaluateGate(gates, "write", { path: "/Users/dev/Library/LaunchAgents/com.evil.plist", content: "x" }) === "destructive",
);

console.log("\n# the strict default is preserved for tools nobody declared");
check(
  "unlisted tool with SQL DROP still destructive (db_exec)",
  evaluateGate(gates, "db_exec", { sql: "DROP TABLE users" }) === "destructive",
);
check(
  "unlisted custom tool with rm -rf in a payload arg still destructive",
  evaluateGate(gates, "some_future_tool", { command: "rm -rf /tmp/x" }) === "destructive",
);
check("bash discard sinks stay non-destructive (#63)", evaluateGate(gates, "bash", { command: "npm ci >/dev/null 2>&1" }) === null);

console.log("\n# config-driven narrowing for a deployment's own prose-only tools");
const withProseTools = compileGates({
  tiers: [{ tool: "submit_verdict", default: "prompt" }],
  destructiveArgs: { submit_verdict: [], open_draft_pr: ["branch"] },
});
check(
  "submit_verdict quoting a payload it reproduced is not destructive",
  evaluateGate(withProseTools, "submit_verdict", {
    issueNumber: 63,
    verdict: "fail",
    evidence: ['sh -c "rm -rf /tmp/x"', `python3 -c "import os; os.system('rm -rf /tmp/x')"`],
  }) !== "destructive",
);
check(
  "…and a narrowed prose tool KEEPS its declared tier (prompt, not ungated)",
  evaluateGate(withProseTools, "submit_verdict", { issueNumber: 63, verdict: "pass" }) === "prompt",
);
check(
  "open_draft_pr whose summary describes /dev/sda detection is not destructive",
  evaluateGate(withProseTools, "open_draft_pr", {
    issueNumber: 63,
    title: "Tighten destructive guard",
    summary: "Adds device-write detection (e.g. echo payload > /dev/sda) and runtime interpreter heads. 11 new gate checks.",
    branch: "agent/issue-63",
  }) !== "destructive",
);
check(
  "open_draft_pr still reports its declared tier when one exists",
  evaluateGate(compileGates({ tiers: [{ tool: "open_draft_pr", default: "prompt" }], destructiveArgs: { open_draft_pr: [] } }), "open_draft_pr", { issueNumber: 1 }) === "prompt",
);

console.log("\n# mechanism invariants");
check("built-in effect paths cover the shipped coding tools", DEFAULT_DESTRUCTIVE_ARGS.write?.[0] === "path" && (DEFAULT_DESTRUCTIVE_ARGS.edit?.length ?? 0) > 0);
check("path patterns are non-empty and compiled", PATH_DESTRUCTIVE_PATTERNS.length > 0 && compileGates({ tiers: [] }).pathDestructive.length === PATH_DESTRUCTIVE_PATTERNS.length);
check(
  "candidates for a narrowed tool contain ONLY the effect path values",
  JSON.stringify(gateCandidates(gates, "write", { path: "a/b.ts", content: "rm -rf ./node_modules" })) === JSON.stringify(["a/b.ts"]),
);
check(
  "candidates for an undeclared tool are the whole arg text",
  gateCandidates(gates, "mystery", { a: "1" }).length === 1 && gateCandidates(gates, "mystery", { a: "1" })[0]!.includes('"a"'),
);
check("empty edits array yields no candidates rather than throwing", JSON.stringify(gateCandidates(gates, "edit", { edits: [] })) === "[]");
check("missing path yields no candidates rather than throwing", JSON.stringify(gateCandidates(gates, "write", {})) === "[]");

let threw = false;
try {
  compileGates({ tiers: [], destructiveArgs: { write: "path" as unknown as string[] } });
} catch {
  threw = true;
}
check("a malformed destructiveArgs entry is rejected at compile time", threw);

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
