// Local OpenAI-compatible model provider wiring for pi-ai.
// Config resolution order:
//   1. OPENAI_BASE_URL + OPENAI_API_KEY env vars — the served model is
//      auto-discovered via GET /v1/models (prefers the model currently `loaded`).
//   2. Fallback (local dev convenience): an `aurora` provider in ~/.pi/agent/models.json.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const MODELS_JSON = join(homedir(), ".pi/agent/models.json");
let cached = null;

async function discoverFromEndpoint(baseUrl, apiKey) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`GET /models failed: ${res.status} — check OPENAI_BASE_URL/OPENAI_API_KEY`);
  const data = await res.json();
  const list = data?.data ?? [];
  if (list.length === 0) throw new Error("endpoint reported no models");
  const m = list.find((x) => x.loaded) ?? list[0];
  return {
    baseUrl,
    apiKey,
    models: [
      {
        id: m.id,
        name: m.display_name ?? m.id,
        contextWindow: m.context_length ?? m.native_context_length ?? 200000,
        maxTokens: 32000,
        reasoning: true,
        input: ["text"],
      },
    ],
  };
}

export async function loadAuroraConfig() {
  if (cached) return cached;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  let cfg;
  if (baseUrl && apiKey) {
    cfg = await discoverFromEndpoint(baseUrl, apiKey);
  } else {
    const file = JSON.parse(readFileSync(MODELS_JSON, "utf8")).providers?.aurora;
    if (!file?.baseUrl || !file?.apiKey) {
      throw new Error("set OPENAI_BASE_URL + OPENAI_API_KEY (see poc/.env.example), or have an 'aurora' provider in ~/.pi/agent/models.json");
    }
    cfg = file;
  }
  // envApiKeyAuth resolves from the environment at request time
  process.env.OPENAI_API_KEY = cfg.apiKey;
  cached = cfg;
  return cfg;
}

export async function auroraModelId() {
  const cfg = await loadAuroraConfig();
  return cfg.models[0].id;
}

export async function auroraModels(overrides = {}) {
  const cfg = await loadAuroraConfig();
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "aurora",
      name: "Local OpenAI-compatible endpoint",
      baseUrl: cfg.baseUrl,
      auth: { apiKey: envApiKeyAuth("OpenAI-compatible API key", ["OPENAI_API_KEY"]) },
      models: cfg.models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: "aurora",
        baseUrl: cfg.baseUrl,
        api: "openai-completions",
        reasoning: Boolean(m.reasoning),
        input: m.input ?? ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // local model — no $ cost
        contextWindow: overrides.contextWindow ?? m.contextWindow ?? 200000,
        maxTokens: overrides.maxTokens ?? m.maxTokens ?? 32000,
      })),
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
