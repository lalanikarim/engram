// Unit tests for the phase 5 classifier: verdict parsing/validation, escalation rule,
// and gates.json classifier config validation. No model, no server — deterministic.
import assert from "node:assert";
import { parseVerdict, applyVerdict } from "../src/extensions/classifier.ts";
import { compileGates } from "../src/extensions/gates.ts";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL ${name} — ${(e as Error).message}`);
  }
}

// ---- parseVerdict ----
check("parses a clean JSON verdict", () => {
  const v = parseVerdict('{"score": 0.4, "destructive": false, "note": "reads a file"}');
  assert.deepStrictEqual(v, { score: 0.4, destructive: false, note: "reads a file" });
});

check("parses JSON embedded in prose/markdown", () => {
  const v = parseVerdict('Sure! Here is my assessment:\n```json\n{"score": 0.9, "destructive": true, "note": "deletes data"}\n```\nLet me know.');
  assert.ok(v);
  assert.strictEqual(v.score, 0.9);
  assert.strictEqual(v.destructive, true);
  assert.strictEqual(v.note, "deletes data");
});

check("clamps out-of-range scores into [0,1]", () => {
  assert.strictEqual(parseVerdict('{"score": 1.5, "destructive": false, "note": "x"}')?.score, 1);
  assert.strictEqual(parseVerdict('{"score": -2, "destructive": false, "note": "x"}')?.score, 0);
});

check("accepts string booleans for destructive", () => {
  assert.strictEqual(parseVerdict('{"score": 0.1, "destructive": "true", "note": "x"}')?.destructive, true);
  assert.strictEqual(parseVerdict('{"score": 0.1, "destructive": "false", "note": "x"}')?.destructive, false);
});

check("truncates long notes to 200 chars and tolerates missing note", () => {
  const v = parseVerdict(`{"score": 0.2, "destructive": false, "note": "${"a".repeat(300)}"}`);
  assert.ok(v);
  assert.strictEqual(v.note.length, 200);
  assert.strictEqual(parseVerdict('{"score": 0.2, "destructive": false}')?.note, "");
});

check("missing/invalid score → null (fail-safe)", () => {
  assert.strictEqual(parseVerdict('{"destructive": false, "note": "x"}'), null);
  assert.strictEqual(parseVerdict('{"score": "high", "destructive": false, "note": "x"}'), null);
});

check("malformed or non-object JSON → null", () => {
  assert.strictEqual(parseVerdict("no json here"), null);
  assert.strictEqual(parseVerdict("{not valid json}"), null);
  assert.strictEqual(parseVerdict("[1, 2, 3]"), null);
});

// ---- applyVerdict (escalation rule) ----
check("below threshold stays prompt", () => {
  assert.strictEqual(applyVerdict({ score: 0.69, destructive: false, note: "" }, 0.7), "prompt");
});

check("at or above threshold escalates to destructive", () => {
  assert.strictEqual(applyVerdict({ score: 0.7, destructive: false, note: "" }, 0.7), "destructive");
  assert.strictEqual(applyVerdict({ score: 0.9, destructive: false, note: "" }, 0.7), "destructive");
});

check("destructive flag escalates regardless of score", () => {
  assert.strictEqual(applyVerdict({ score: 0.1, destructive: true, note: "" }, 0.7), "destructive");
});

// ---- gates.json classifier config validation ----
check("absent classifier → disabled with defaults", () => {
  const g = compileGates({ tiers: [] });
  assert.strictEqual(g.classifier.enabled, false);
  assert.strictEqual(g.classifier.model, undefined);
  assert.strictEqual(g.classifier.timeoutMs, 60_000);
  assert.strictEqual(g.classifier.threshold, 0.7);
});

check("explicit classifier config compiles", () => {
  const g = compileGates({ tiers: [], classifier: { enabled: true, model: "aurora:m1", timeoutMs: 5000, destructiveThreshold: 0.9 } });
  assert.deepStrictEqual(g.classifier, { enabled: true, model: "aurora:m1", timeoutMs: 5000, threshold: 0.9 });
});

check("invalid classifier config throws at startup", () => {
  assert.throws(() => compileGates({ tiers: [], classifier: { enabled: true, model: "nope" } }), /classifier\.model/);
  assert.throws(() => compileGates({ tiers: [], classifier: { timeoutMs: -5 } }), /timeoutMs/);
  assert.throws(() => compileGates({ tiers: [], classifier: { destructiveThreshold: 1.5 } }), /destructiveThreshold/);
  assert.throws(() => compileGates({ tiers: [], classifier: { enabled: "yes" as never } }), /enabled/);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
