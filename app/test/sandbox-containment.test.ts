// Containment of a bad member (Collective A3) — sandbox verification.
//
// Directly exercises PodmanSandboxEnv (the D12–13 sidecar) to prove the two code-execution
// containment properties that make a "bad member" safe:
//   1. No host env vars cross into the container → a member cannot read shared secrets.
//   2. File operations are confined to the member's workspace → side effects can't escape.
// No model or harness is needed. Skips cleanly when Podman (or the base image) is unavailable.
// Run with: node test/sandbox-containment.test.ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PodmanSandboxEnv } from "../src/sandbox.ts";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

const ctx = BACKGROUND_CONTEXT;

function podmanAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn("podman", ["--version"], { stdio: "ignore" });
    c.on("error", () => resolve(false));
    c.on("close", (code) => resolve(code === 0));
  });
}

async function main() {
  if (!(await podmanAvailable())) {
    console.log("SKIP — Podman not available (containment verified on a host with Podman)");
    process.exit(0);
  }
  // macOS Podman VM shares only $HOME for bind mounts, so the workspace must live under it.
  const base = mkdtempSync(path.join(homedir(), "engram-sbx-contain-"));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "escape.txt"); // parent of workspace → outside the sandbox
  // A host secret that must NOT be visible inside the sandbox.
  process.env.ENGRAM_SECRET_TEST = `engram-secret-${Date.now()}`;

  const env = new PodmanSandboxEnv({ workspace, image: "docker.io/library/python:3.12-alpine", network: "none" });
  let done = false;
  try {
    try {
      await env.init(ctx);
    } catch (e) {
      console.log(`SKIP — could not start sandbox container: ${(e as Error).message}`);
      process.exit(0);
    }
    console.log("sandbox containment (Collective A3)");

    // 1. No host env vars cross into the container (a member cannot read shared secrets).
    let captured = "";
    const probe = "sh -lc 'if [ -n \"$ENGRAM_SECRET_TEST\" ]; then echo HAS_SECRET; else echo NO_SECRET; fi'";
    const r = await env.exec(probe, { timeout: 30, onOutput: (s) => (captured += s) }, ctx);
    check("env probe executed in the sandbox", r.ok);
    check("no host env vars cross into the sandbox (secret not visible)", captured.trim() === "NO_SECRET");

    // 2. File operations are confined to the workspace (side effects can't escape).
    const wOut = await env.writeFile(outside, "escape", ctx);
    check("write OUTSIDE the workspace is denied", !wOut.ok && /escapes|permission_denied/i.test(wOut.error.message));
    check("no file was written outside the workspace", !existsSync(outside));

    const inside = path.join(workspace, "inside.txt");
    const wIn = await env.writeFile(inside, "confined", ctx);
    check("write INSIDE the workspace succeeds", wIn.ok && existsSync(inside));
  } finally {
    if (!done) {
      try {
        await env.cleanup(ctx);
      } catch {
        /* ignore cleanup errors */
      }
      done = true;
    }
    rmSync(base, { recursive: true, force: true });
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness error:", err);
  process.exit(1);
});
