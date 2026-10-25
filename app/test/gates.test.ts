// Unit tests for risk-tiered approval gating (src/extensions/gates.ts) — no live model needed.
// Run with: node test/gates.test.ts
import {
  DEFAULT_DESTRUCTIVE_PATTERNS,
  compileGates,
  evaluateGate,
  gateArgText,
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
