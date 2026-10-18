// Aurora (Unsloth Studio) provider wiring for pi-ai.
// Reads the `aurora` provider from ~/.pi/agent/models.json (baseUrl + apiKey),
// registers it as an openai-completions provider with the served model.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const MODELS_JSON = join(homedir(), ".pi/agent/models.json");

export function loadAuroraConfig() {
  const cfg = JSON.parse(readFileSync(MODELS_JSON, "utf8")).providers?.aurora;
  if (!cfg?.baseUrl || !cfg?.apiKey) throw new Error("no 'aurora' provider (baseUrl+apiKey) in ~/.pi/agent/models.json");
  return cfg;
}

export function auroraModelId(cfg = loadAuroraConfig()) {
  return cfg.models[0].id;
}

export function auroraModels() {
  const cfg = loadAuroraConfig();
  // envApiKeyAuth resolves from the environment at request time
  process.env.UNSLOTH_KEY = cfg.apiKey;
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "aurora",
      name: "Aurora (Unsloth Studio)",
      baseUrl: cfg.baseUrl,
      auth: { apiKey: envApiKeyAuth("Aurora Unsloth API key", ["UNSLOTH_KEY"]) },
      models: cfg.models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: "aurora",
        baseUrl: cfg.baseUrl,
        api: "openai-completions",
        reasoning: Boolean(m.reasoning),
        input: m.input ?? ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // local model — no $ cost
        contextWindow: m.contextWindow ?? 200000,
        maxTokens: m.maxTokens ?? 32000,
      })),
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
