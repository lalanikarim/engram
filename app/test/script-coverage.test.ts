// #78 — a test file that no CI job collects is not a test; it is a rumor.
//
// This repository has now produced that defect three times, always green:
//   * R10 (drydock side): `npm test` enumerated its suites and silently dropped one.
//   * PR #77 here: `gates-docs-verification.test.ts` passed when run directly, was collected by
//     no script, and CI stayed green. Caught in review, wired in `02f535c`.
//   * The residual this check exists for: `app/package.json` had a `test` script referencing four
//     live suites that nothing ever invoked — so "referenced by a script" is NOT the property that
//     matters. **Reachable from CI** is.
//
// So this is not a substring scan over package.json. It parses what CI actually runs, expands the
// npm script graph from those entry points, and only then asks whether every file in `app/test` is
// either (a) collected by that closure or (b) explicitly declared manual with a reason and a real
// script to run it with. A file mentioned only by an unreachable script fails, which is exactly the
// case #78 was filed about.
import assert from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(APP_TEST_DIR, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");

/** Manual files must carry this on one line at column 0: a reason, and the script that runs them.
 *  Example: `// manual-only: needs a live model endpoint; run with npm run test:live:model`
 *
 *  Two parsing traps, both hit while writing this:
 *   - **Anchor to column 0.** Unanchored, this file matched *itself* on the example strings below and
 *     reported itself as declared-manual. A rule about markers must not treat documentation of the
 *     marker as a use of it.
 *   - **Reasons may contain semicolons.** `(.+?);\s*run with` binds to the literal separator, so
 *     "live model + in-process mock Bot API; GitHub runners have none" parses. A stricter capture
 *     silently classified such a file as running nowhere. */
const MANUAL_MARKER = /^\/\/ manual-only:\s*(.+?);\s*run with\s+(npm run ([\w:-]+))/m;

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(`${name} — ${(e as Error).message}`);
    console.error(`FAIL ${name} — ${(e as Error).message}`);
  }
}

function scriptsOf(dir: string): Record<string, string> {
  const file = path.join(dir, "package.json");
  if (!existsSync(file)) return {};
  return (JSON.parse(readFileSync(file, "utf8")).scripts ?? {}) as Record<string, string>;
}

/** Every `npm run x` / `npm test` mention in a script body or CI step, with its optional workspace. */
function npmMentions(text: string): Array<{ name: string; workspace?: string }> {
  const out: Array<{ name: string; workspace?: string }> = [];
  const re = /npm\s+(?:run\s+([\w:-]+)|(?<![\w-]test))(?:\s+(?:-w|--workspace(?:=|\s+))([\w./-]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1] ?? (m[0].includes("npm test") ? "test" : undefined);
    if (name) out.push({ name, ...(m[2] ? { workspace: m[2] } : {}) });
  }
  return out;
}

/** Test files mentioned by a script body. Root scripts say `app/test/x.test.ts`; app workspace
 *  scripts say `test/x.test.ts`. Both name the same file, so normalize to the basename. */
function testFilesMentioned(text: string): string[] {
  return [...text.matchAll(/(?:app\/)?test\/([\w.-]+\.test\.ts)/g)].map((m) => m[1]);
}

/** The closure of test files reachable from CI's own commands. */
function reachableFromCi(ciCommands: string[]): Set<string> {
  const rootScripts = scriptsOf(REPO_ROOT);
  const appScripts = scriptsOf(APP_ROOT);
  const seenScripts = new Set<string>();
  const files = new Set<string>();

  const visit = (name: string, workspace?: string) => {
    const isApp = workspace === "app" || workspace === "./app";
    const body = (isApp ? appScripts : rootScripts)[name];
    const key = `${isApp ? "app/" : ""}${name}`;
    if (!body || seenScripts.has(key)) return;
    seenScripts.add(key);
    for (const f of testFilesMentioned(body)) files.add(f);
    for (const nested of npmMentions(body)) visit(nested.name, nested.workspace);
  };

  for (const cmd of ciCommands) {
    for (const mention of npmMentions(cmd)) visit(mention.name, mention.workspace);
  }
  return files;
}

/** `run:` step bodies from the workflow file — block scalars and one-liners both. */
function ciRunCommands(workflowPath: string): string[] {
  const lines = readFileSync(workflowPath, "utf8").split("\n");
  const commands: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const inline = m[2].trim();
    if (inline && !inline.startsWith("|") && !inline.startsWith(">")) {
      commands.push(inline);
      continue;
    }
    // Block scalar: gather following lines that are more indented than `run:`.
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (/^/.test(lines[j]) && lines[j].match(/^\s*/)![0].length <= indent) break;
      body.push(lines[j].trim());
    }
    commands.push(body.join("\n"));
  }
  return commands;
}

const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const commands = existsSync(WORKFLOW) ? ciRunCommands(WORKFLOW) : [];
const reachable = reachableFromCi(commands);
const allFiles = readdirSync(APP_TEST_DIR).filter((f) => f.endsWith(".test.ts")).sort();

// ---------------------------------------------------------------- the checks

check("the CI workflow exists and is parseable", () => {
  assert.ok(existsSync(WORKFLOW), `${WORKFLOW} not found — if CI moved, this check must move with it, not pass`);
  assert.ok(commands.length > 0, "no `run:` steps parsed from ci.yml; the parser or the workflow changed shape");
});

check("CI runs `npm run test:unit` (the required status check's only source)", () => {
  const runsUnitSuite = commands.some((c) => /npm\s+run\s+test:unit/.test(c));
  assert.ok(
    runsUnitSuite,
    "ci.yml no longer invokes `npm run test:unit`. Branch protection requires the `unit-suite` context; " +
      "a required check that no workflow produces sits 'Expected' forever (#70).",
  );
});

check("every file in app/test is collected by CI or declared manual", () => {
  const offenders: string[] = [];
  for (const file of allFiles) {
    const isReachable = reachable.has(file);
    const marker = MANUAL_MARKER.exec(readFileSync(path.join(APP_TEST_DIR, file), "utf8"));
    if (isReachable && marker) {
      offenders.push(`${file}: collected by a CI-reachable script AND marked manual — delete the stale marker`);
    } else if (!isReachable && !marker) {
      offenders.push(
        `${file}: runs nowhere. Wire it into a CI-reachable script (root package.json → test:unit), or add ` +
          `a column-0 header line of the form: “// manual-only: why; run with npm run script”`,
      );
    }
  }
  assert.equal(offenders.length, 0, `\n${offenders.join("\n")}`);
});

check("a manual marker names a script that actually exists", () => {
  const rootScripts = scriptsOf(REPO_ROOT);
  const broken: string[] = [];
  for (const file of allFiles) {
    const marker = MANUAL_MARKER.exec(readFileSync(path.join(APP_TEST_DIR, file), "utf8"));
    if (!marker) continue;
    const scriptName = marker[3];
    if (!rootScripts[scriptName]) {
      broken.push(`${file}: marked 'run with npm run ${scriptName}', but no such script in package.json`);
    }
  }
  assert.equal(broken.length, 0, `\n${broken.join("\n")}`);
});

check("non-vacuity: the check can see a file at all", () => {
  // A parser that silently matched nothing would pass every rule above. Pin the floor.
  assert.ok(allFiles.length >= 17, `expected the app/test inventory to be non-trivial, saw ${allFiles.length}`);
  assert.ok(reachable.size >= 8, `expected CI to reach at least the hermetic suite (${reachable.size} files reached)`);
  assert.ok(reachable.has("gates.test.ts"), "reached-set does not include gates.test.ts, which test:unit runs explicitly");
  assert.ok(!reachable.has("does-not-exist.test.ts"), "the matcher is matching things it should not");
});

// ------------------------------------------------------- what this run collected

const manualFiles = allFiles.filter((f) => MANUAL_MARKER.test(readFileSync(path.join(APP_TEST_DIR, f), "utf8")));
console.log(`\n=== test-file collection report (${allFiles.length} files in app/test) ===`);
for (const file of allFiles) {
  const collected = reachable.has(file);
  const marker = MANUAL_MARKER.exec(readFileSync(path.join(APP_TEST_DIR, file), "utf8"));
  console.log(`  ${collected ? "CI-COLLECTED" : marker ? "manual        " : "ORPHAN       "}  ${file}${marker ? `   (${marker[1].trim()} → npm run ${marker[3]})` : ""}`);
}
console.log(`  collected by CI: ${reachable.size} · declared manual: ${manualFiles.length} · orphans: ${allFiles.length - reachable.size - manualFiles.length}`);

console.log(`\nRESULT: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
