// Unit tests for the multi-provider model catalog (src/model.ts) — no live model needed.
// Run with: node test/model-catalog.test.ts
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRef } from "@earendil-works/pi-durable";
import { buildCatalog, defaultModelRef, formatModelRef, parseModelRef, type ModelsConfig } from "../src/model.ts";

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

const base = mkdtempSync(path.join(tmpdir(), "engram-models-"));
const agentDir = path.join(base, "agent");
mkdirSync(agentDir, { recursive: true });

// Custom providers in pi's models.json format: two boxes sharing a model id (ambiguity test).
writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      localbox: {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "local-key",
        api: "openai-completions",
        models: [
          { id: "m-a", contextWindow: 1000, maxTokens: 100 },
          { id: "m-b", contextWindow: 2000 },
        ],
      },
      otherbox: {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "$UNSET_ENV_VAR_XYZ",
        models: [{ id: "m-a" }],
      },
    },
  }),
);
// Stored credential for a built-in provider (opencode-go), pi's auth.json format.
writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api_key", key: "test-key" } }));

async function main() {
  const { models } = await buildCatalog({ agentDir, env: {} });

  console.log("catalog building");
  check("custom provider model registered (localbox:m-a)", Boolean(models.getModel("localbox", "m-a")));
  check(
    "custom model contextWindow from models.json",
    models.getModel("localbox", "m-a")?.contextWindow === 1000,
  );
  check("second custom provider registered (otherbox:m-a)", Boolean(models.getModel("otherbox", "m-a")));
  check(
    "built-in opencode-go static catalog present",
    Boolean(models.getModel("opencode-go", "qwen3.8-max")),
  );

  console.log("credential resolution");
  const available = new Set((await models.getAvailable()).map((m) => `${m.provider}:${m.id}`));
  check(
    "auth.json credential makes opencode-go available",
    available.has("opencode-go:qwen3.8-max"),
  );
  check("literal apiKey from models.json makes localbox available", available.has("localbox:m-a"));
  check(
    "unset env var keeps otherbox unavailable",
    !available.has("otherbox:m-a"),
  );

  console.log("ref parsing");
  const explicit = parseModelRef(models, "localbox:m-a");
  check('explicit "<provider>:<modelId>" parses', explicit.provider === "localbox" && explicit.modelId === "m-a");
  const bare = parseModelRef(models, "m-b");
  check("bare unique id resolves", bare.provider === "localbox" && bare.modelId === "m-b");
  let ambiguous = false;
  try {
    parseModelRef(models, "m-a");
  } catch (e) {
    ambiguous = /ambiguous/.test(String(e));
  }
  check("bare ambiguous id rejected with hint", ambiguous);
  let unknown = false;
  try {
    parseModelRef(models, "nope:nothing");
  } catch (e) {
    unknown = /unknown provider/.test(String(e));
  }
  check("unknown provider rejected", unknown);
  let missingModel = false;
  try {
    parseModelRef(models, "localbox:does-not-exist");
  } catch (e) {
    missingModel = /not found on provider/.test(String(e));
  }
  check("missing model on known provider rejected", missingModel);
  check(
    "formatModelRef round-trips",
    formatModelRef({ provider: "a", modelId: "b/c" }) === "a:b/c",
  );

  console.log("default resolution");
  const cfgNoDefault: ModelsConfig = {
    models,
    agentDir,
    configuredDefault: null,
    envModel: { provider: "localbox", modelId: "m-b" },
  };
  const fallback: ModelRef = await defaultModelRef(cfgNoDefault);
  check("no DEFAULT_MODEL → local endpoint fallback", fallback.provider === "localbox" && fallback.modelId === "m-b");
  const cfgWithDefault: ModelsConfig = { ...cfgNoDefault, configuredDefault: { provider: "opencode-go", modelId: "qwen3.8-max" } };
  const chosen: ModelRef = await defaultModelRef(cfgWithDefault);
  check("DEFAULT_MODEL wins over fallback", chosen.provider === "opencode-go" && chosen.modelId === "qwen3.8-max");
  let noSource = false;
  try {
    await defaultModelRef({ ...cfgNoDefault, envModel: null });
  } catch (e) {
    noSource = /no default model/.test(String(e));
  }
  check("no default and no local endpoint → clear error", noSource);

  console.log("legacy env endpoint discovery");
  // Tiny mock OpenAI-compatible /models endpoint.
  const MOCK_PORT = 18941;
  const mock = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "not-loaded" }, { id: "loaded-model", loaded: true }] }));
  });
  await new Promise<void>((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

  const withEnv = await buildCatalog({
    agentDir,
    env: { OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, OPENAI_API_KEY: "k" },
  });
  check(
    "env discovery picks the loaded model",
    withEnv.envModel?.modelId === "loaded-model" && withEnv.envModel?.provider === "aurora",
  );
  check("env provider registered when no custom entry shares its id", Boolean(withEnv.models.getModel("aurora", "loaded-model")));

  // Custom entry owning the env provider id wins; discovery still feeds the fallback.
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        aurora: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", models: [{ id: "custom-aurora-model" }] },
      },
    }),
  );
  const conflict = await buildCatalog({
    agentDir,
    env: { OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, OPENAI_API_KEY: "k" },
  });
  check(
    "models.json entry wins when it owns the env provider id",
    Boolean(conflict.models.getModel("aurora", "custom-aurora-model")) && !conflict.models.getModel("aurora", "loaded-model"),
  );
  check("discovery still feeds envModel fallback on conflict", conflict.envModel?.modelId === "loaded-model");
  mock.close();

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness error:", err);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
