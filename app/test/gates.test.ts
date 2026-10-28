// Unit tests for risk-tiered approval gating (src/extensions/gates.ts) — no live model needed.
// Run with: node test/gates.test.ts
import {
  DEFAULT_DESTRUCTIVE_PATTERNS,
  applyContainment,
  compileGates,
  destructiveCandidates,
  evaluateGate,
  gateArgText,
  headCommand,
  renderAction,
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

const gates = compileGates({
  tiers: [
    { tool: "bash", autoPatterns: ["^ls( |$)", "^cat ", "^git status$"], default: "prompt" },
    { tool: "send_message", default: "prompt" },
  ],
});

console.log("tier evaluation");
check("ungated tool → null", evaluateGate(gates, "web_fetch", { url: "https://x" }) === null);
check("bash auto pattern (ls) → auto", evaluateGate(gates, "bash", { command: "ls -la" }) === "auto");
check("bash non-matching → prompt", evaluateGate(gates, "bash", { command: "curl https://x" }) === "prompt");
check("send_message → prompt", evaluateGate(gates, "send_message", { to: "a", message: "b" }) === "prompt");

console.log("destructive guard (always wins)");
check(
  "rm -rf beats auto pattern and gating",
  evaluateGate(gates, "bash", { command: "ls && rm -rf /tmp/x" }) === "destructive",
);
check("rm -fr order variant caught", evaluateGate(gates, "bash", { command: "rm -fr /data" }) === "destructive");
check("plain rm (no -r) not destructive", evaluateGate(gates, "bash", { command: "rm file.txt" }) !== "destructive");
check("git push --force caught", evaluateGate(gates, "bash", { command: "git push --force origin main" }) === "destructive");
check(
  "DROP TABLE caught in non-bash args (canonical JSON)",
  evaluateGate(gates, "db_exec", { sql: "DROP TABLE users" }) === "destructive",
);
check("fork bomb caught", evaluateGate(gates, "bash", { command: ":(){ :|:& };:" }) === "destructive");
check(
  "built-in patterns always present (config cannot remove them)",
  compileGates(null).destructive.length === DEFAULT_DESTRUCTIVE_PATTERNS.length,
);

console.log("config handling");
const extra = compileGates({
  tiers: [{ tool: "deploy", autoPatterns: ['"staging"'], default: "prompt" }],
  destructivePatterns: ["\\bpay_money\\b"],
});
check("extra destructive pattern honored", evaluateGate(extra, "transfer", { cmd: "pay_money 5" }) === "destructive");
check(
  "auto tier passes even for a prompt-default tool",
  evaluateGate(extra, "deploy", { target: "staging" }) === "auto",
);
let badRegex = false;
try {
  compileGates({ tiers: [{ tool: "x", autoPatterns: ["[" ] }] });
} catch (e) {
  badRegex = /invalid regex/.test(String(e));
}
check("invalid pattern rejected at load", badRegex);
let badTier = false;
try {
  compileGates({ tiers: [{ tool: "x", default: "confirm" as never }] });
} catch (e) {
  badTier = /unknown default tier/.test(String(e));
}
check("unknown tier rejected at load", badTier);

console.log("issue #53: destructive matching on simple commands, not substrings");
// The minimal policy a sandboxed consumer writes — gate only the consequential tool; bash is NOT gated.
const minimal = compileGates({ tiers: [{ tool: "merge_pr" }] });
check("node --test → null", evaluateGate(minimal, "bash", { command: "node --test" }) === null);
check(
  "git add && commit → null",
  evaluateGate(minimal, "bash", { command: "git add src/x.mjs && git commit -m fix" }) === null,
);
check(
  "npm ci >/dev/null 2>&1 → null (discarding output is not a write)",
  evaluateGate(minimal, "bash", { command: "npm ci >/dev/null 2>&1" }) === null,
);
check(
  "cd /sandbox && npm test 2>/dev/null → null",
  evaluateGate(minimal, "bash", { command: "cd /sandbox && npm test 2>/dev/null" }) === null,
);
check(
  "grep -rn 'shutdown' src/ → null (quoted search text)",
  evaluateGate(minimal, "bash", { command: "grep -rn 'shutdown' src/" }) === null,
);
check(
  "cat ... | grep reboot → null (a mentioned word is not a command)",
  evaluateGate(minimal, "bash", { command: "cat src/server.mjs | grep reboot" }) === null,
);
check(
  "node -e with SQL in a string → null",
  evaluateGate(minimal, "bash", { command: `node -e "console.log('DROP TABLE x')"` }) === null,
);
check(
  "printf writing a script → null (writing ≠ running)",
  evaluateGate(minimal, "bash", { command: "printf '%s\\n' '#!/bin/sh' 'rm -rf /tmp/build' > clean.sh" }) === null,
);

console.log("issue #53: real destructive commands still caught");
check("rm -rf /var → destructive", evaluateGate(minimal, "bash", { command: "rm -rf /var" }) === "destructive");
check(
  "git push --force → destructive",
  evaluateGate(minimal, "bash", { command: "git push --force origin main" }) === "destructive",
);
check(
  "git reset --hard → destructive",
  evaluateGate(minimal, "bash", { command: "git reset --hard HEAD~1" }) === "destructive",
);
check("mkfs.ext4 /dev/sda1 → destructive", evaluateGate(minimal, "bash", { command: "mkfs.ext4 /dev/sda1" }) === "destructive");
check(
  "dd if= → destructive",
  evaluateGate(minimal, "bash", { command: "dd if=/dev/zero of=/tmp/x" }) === "destructive",
);
check("fork bomb → destructive", evaluateGate(minimal, "bash", { command: ":(){ :|:& };:" }) === "destructive");
check(
  "reboot as the command (sudo) → destructive",
  evaluateGate(minimal, "bash", { command: "sudo reboot" }) === "destructive",
);
check(
  "rm -rf inside a chain → destructive",
  evaluateGate(minimal, "bash", { command: "npm ci && rm -rf /var" }) === "destructive",
);
check(
  "git push --force after || → destructive",
  evaluateGate(minimal, "bash", { command: "true || git push --force origin main" }) === "destructive",
);
check(
  "bash -c with live rm → destructive (interpreter quotes stay live)",
  evaluateGate(minimal, "bash", { command: 'bash -c "rm -rf /var"' }) === "destructive",
);

console.log("issue #53: containment-gated floor suppression");
const contained = compileGates({ tiers: [{ tool: "merge_pr" }, { tool: "bash", containment: "sandbox" }] });
check(
  "containment + sandboxed → ungated (even from the destructive tier)",
  applyContainment(contained, "bash", "destructive", true) === null,
);
check(
  "containment + not sandboxed → floor kept",
  applyContainment(contained, "bash", "destructive", false) === "destructive",
);
check(
  "no containment declaration → unchanged even when sandboxed",
  applyContainment(minimal, "bash", "destructive", true) === "destructive",
);
check("containment also suppresses the declared tier", applyContainment(contained, "bash", "prompt", true) === null);
let badContainment = false;
try {
  compileGates({ tiers: [{ tool: "x", containment: "host" as never }] });
} catch (e) {
  badContainment = /unknown containment/.test(String(e));
}
check("unknown containment rejected at load", badContainment);

console.log("issue #53: candidate reduction units");
check(
  "redirections to /dev/* are dropped",
  destructiveCandidates("npm ci >/dev/null 2>&1").every((c) => !c.includes("/dev/")),
);
check("headCommand skips env assignments and sudo", headCommand("FOO=bar sudo rm -rf /") === "rm");
check("headCommand basenames paths", headCommand("/bin/bash -c x") === "bash");

console.log("arg rendering");
check(
  "bash gate text is the command string",
  gateArgText("bash", { command: "ls -la" }) === "ls -la",
);
check(
  "non-bash gate text is canonical JSON (sorted keys)",
  gateArgText("send_message", { b: 1, a: 2 }) === '{"a":2,"b":1}',
);
check("renderAction bash → command", renderAction("bash", { command: "ls -la" }) === "ls -la");
check(
  "renderAction send_message → recipient + body",
  renderAction("send_message", { to: "bob", message: "hi" }) === "to bob\nhi",
);

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
