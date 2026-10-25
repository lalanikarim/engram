// Unit tests for persistent allow-rules (src/extensions/approvals.ts) — no live model needed.
// Run with: node test/approval-rules.test.ts
import { defaultRuleMatch, isApprovalExpired, ruleIdFor, ruleMatches, type ApprovalRule } from "../src/extensions/approvals.ts";

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

const rules: ApprovalRule[] = [
  { id: "r1", tool: "send_message", match: { to: "bob" }, createdAt: 0, source: "test" },
  { id: "r2", tool: "deploy", match: { target: "staging", env: "true" }, createdAt: 0, source: "test" },
];

console.log("rule matching");
check("matching rule passes", ruleMatches(rules, "send_message", { to: "bob", message: "anything" }));
check(
  "different recipient does not match",
  !ruleMatches(rules, "send_message", { to: "eve", message: "x" }),
);
check("multi-field rule requires all fields", ruleMatches(rules, "deploy", { target: "staging", env: "true" }));
check(
  "multi-field rule fails on one mismatch",
  !ruleMatches(rules, "deploy", { target: "prod", env: "true" }),
);
check("extra args are fine (match fields only)", ruleMatches(rules, "send_message", { to: "bob", message: "x", cc: "y" }));
check("wrong tool never matches", !ruleMatches(rules, "other_tool", { to: "bob" }));
check("missing arg does not match", !ruleMatches(rules, "send_message", { message: "x" }));

console.log("default rule scope");
check(
  "send_message scopes to recipient only",
  JSON.stringify(defaultRuleMatch("send_message", { to: "bob", message: "secret text" })) === '{"to":"bob"}',
);
check(
  "generic tool matches all scalar args",
  JSON.stringify(defaultRuleMatch("deploy", { target: "staging", count: 2, flag: true, blob: { a: 1 } })) ===
    '{"target":"staging","count":"2","flag":"true"}',
);
check("no scalar args → empty match (exact-action rule)", JSON.stringify(defaultRuleMatch("x", {})) === "{}");

console.log("ttl expiry");
const now = 1_000_000;
check("expired past ttl", isApprovalExpired(now - 10_001, now, 10_000));
check("not expired exactly at ttl", !isApprovalExpired(now - 10_000, now, 10_000));
check("unknown pendingSince never expires", !isApprovalExpired(undefined, now, 0));
check("zero ttl expires any known age", isApprovalExpired(now - 1, now, 0) && !isApprovalExpired(now, now, 0));

console.log("rule id stability");
const a = ruleIdFor("send_message", { to: "bob" });
check("same (tool, match) → same id", a === ruleIdFor("send_message", { to: "bob" }));
check(
  "key order in match does not change the id",
  a === ruleIdFor("send_message", JSON.parse('{"to":"bob"}')),
);
check("different tool → different id", a !== ruleIdFor("other", { to: "bob" }));
check("different match → different id", a !== ruleIdFor("send_message", { to: "eve" }));

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
