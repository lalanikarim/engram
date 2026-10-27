// Unit tests for loadConfig (src/config.ts) — no live model needed.
// Issue #48: overrides.configDir must steer the declarative file reads
// (roles.json, tools.json, gates.json), not just the final merged config object.
// Run with: node test/config.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.API_TOKEN ??= "config-test-token";

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

const base = mkdtempSync(path.join(tmpdir(), "engram-config-"));
const envDir = path.join(base, "env-config");
const overrideDir = path.join(base, "override-config");
mkdirSync(envDir, { recursive: true });
mkdirSync(overrideDir, { recursive: true });

// Distinctive declarative files in each dir so a wrong source is unmistakable.
writeFileSync(path.join(envDir, "gates.json"), JSON.stringify({ tiers: [{ tool: "env_gate_tool" }] }));
writeFileSync(
  path.join(overrideDir, "gates.json"),
  JSON.stringify({ tiers: [{ tool: "override_gate_tool" }] }),
);
writeFileSync(
  path.join(overrideDir, "roles.json"),
  JSON.stringify([{ name: "override-role", tools: ["bash"] }]),
);
writeFileSync(
  path.join(overrideDir, "tools.json"),
  JSON.stringify([
    { name: "override_http_tool", description: "probe", url: "https://example.test/x", params: {} },
  ]),
);

const { loadConfig } = await import("../src/config.ts");

// ---- env fallback still works when no override is given ----
console.log("loadConfig: env CONFIG_DIR fallback");
process.env.CONFIG_DIR = envDir;
const fromEnv = loadConfig();
check(
  "gates.json read from env CONFIG_DIR",
  fromEnv.gates?.tiers[0]?.tool === "env_gate_tool",
  `got ${JSON.stringify(fromEnv.gates)}`,
);

// ---- issue #48: overrides.configDir wins for all declarative reads ----
console.log("loadConfig: overrides.configDir (issue #48)");
const cfg = loadConfig({ configDir: overrideDir });
check(
  "configDir field reflects the override",
  cfg.configDir === overrideDir,
);
check(
  "gates.json read from override dir, not env dir",
  cfg.gates?.tiers[0]?.tool === "override_gate_tool",
  `got ${JSON.stringify(cfg.gates)}`,
);
check(
  "roles.json read from override dir",
  cfg.roles.length === 1 && cfg.roles[0].name === "override-role",
  `got ${JSON.stringify(cfg.roles)}`,
);
check(
  "tools.json read from override dir",
  cfg.httpTools.length === 1 && cfg.httpTools[0].name === "override_http_tool",
  `got ${JSON.stringify(cfg.httpTools)}`,
);

delete process.env.CONFIG_DIR;
rmSync(base, { recursive: true, force: true });

console.log(`\nconfig: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
