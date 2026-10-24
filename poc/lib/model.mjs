// Inference-host/model-agnostic OpenAI-compatible provider wiring for pi-ai.
//
// Env config (all optional; defaults keep the historical behavior):
//   PI_PROVIDER_ID  — provider id to register (default: "aurora")
//   OPENAI_BASE_URL + OPENAI_API_KEY — the inference endpoint; the served model
//                 is auto-discovered via GET /models (prefers the model currently `loaded`)
//   PI_MODEL_ID     — explicit model id override (skips discovery)
//
// Fallback (local dev convenience): a provider entry in ~/.pi/agent/models.json,
// keyed by the provider id.
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

/** Resolved endpoint config: { providerId, baseUrl, apiKey, models }. */
export async function loadModelConfig() {
  if (cached) return cached;
  const providerId = process.env.PI_PROVIDER_ID || "aurora";
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  let cfg;
  if (process.env.PI_MODEL_ID) {
    // Explicit model id — no discovery needed, but the endpoint still is.
    if (!baseUrl || !apiKey) throw new Error("set OPENAI_BASE_URL + OPENAI_API_KEY (see poc/.env.example)");
    cfg = {
      baseUrl,
      apiKey,
      models: [{ id: process.env.PI_MODEL_ID, name: process.env.PI_MODEL_ID, contextWindow: 200000, maxTokens: 32000 }],
    };
  } else if (baseUrl && apiKey) {
    cfg = await discoverFromEndpoint(baseUrl, apiKey);
  } else {
    const file = JSON.parse(readFileSync(MODELS_JSON, "utf8")).providers?.[providerId];
    if (!file?.baseUrl || !file?.apiKey) {
      throw new Error(
        `set OPENAI_BASE_URL + OPENAI_API_KEY (see poc/.env.example), or have a '${providerId}' provider in ~/.pi/agent/models.json`,
      );
    }
    cfg = file;
  }
  // envApiKeyAuth resolves from the environment at request time.
  process.env.OPENAI_API_KEY = cfg.apiKey;
  cached = { providerId, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, models: cfg.models };
  return cached;
}

/** Provider id to register (from PI_PROVIDER_ID, default "aurora"). */
export async function providerId() {
  return (await loadModelConfig()).providerId;
}

/** The model id to use (PI_MODEL_ID override or auto-discovered). */
export async function modelId() {
  return (await loadModelConfig()).models[0].id;
}

/** Ready-to-use model reference for conversation/agent configs: { provider, modelId }. */
export async function localModel() {
  const cfg = await loadModelConfig();
  return { provider: cfg.providerId, modelId: cfg.models[0].id };
}

/** pi-ai Models registry with the configured provider registered. */
export async function localModels(overrides = {}) {
  const cfg = await loadModelConfig();
  const models = createModels();
  models.setProvider(
    createProvider({
      id: cfg.providerId,
      name: "Local OpenAI-compatible endpoint",
      baseUrl: cfg.baseUrl,
      auth: { apiKey: envApiKeyAuth("OpenAI-compatible API key", ["OPENAI_API_KEY"]) },
      models: cfg.models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: cfg.providerId,
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
