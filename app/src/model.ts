// Inference-host/model-agnostic OpenAI-compatible provider wiring for pi-ai
// (TS port of poc/lib/model.mjs). The served model is auto-discovered via
// GET /v1/models (prefers the model currently `loaded`).
//
// Env config: PI_PROVIDER_ID (provider id, default "aurora"),
// PI_MODEL_ID (explicit model id override, skips discovery),
// OPENAI_BASE_URL + OPENAI_API_KEY (the endpoint).
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export type DiscoveredModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
};

export type ModelConfig = {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  models: DiscoveredModel[];
};

let cached: ModelConfig | null = null;

async function discoverFromEndpoint(baseUrl: string, apiKey: string): Promise<{ baseUrl: string; apiKey: string; models: DiscoveredModel[] }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`GET /models failed: ${res.status} — check OPENAI_BASE_URL/OPENAI_API_KEY`);
  }
  const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const list = data.data ?? [];
  if (list.length === 0) throw new Error("endpoint reported no models");
  const m = list.find((x) => x.loaded === true) ?? list[0];
  return {
    baseUrl,
    apiKey,
    models: [
      {
        id: String(m.id),
        name: String(m.display_name ?? m.id),
        contextWindow: Number(m.context_length ?? m.native_context_length ?? 200000),
        maxTokens: 32000,
      },
    ],
  };
}

export async function loadModelConfig(): Promise<ModelConfig> {
  if (cached) return cached;
  const providerId = process.env.PI_PROVIDER_ID ?? "aurora";
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("set OPENAI_BASE_URL + OPENAI_API_KEY (see app/.env.example)");
  }
  let endpoint: { baseUrl: string; apiKey: string; models: DiscoveredModel[] };
  if (process.env.PI_MODEL_ID) {
    // Explicit model id — no discovery needed.
    endpoint = {
      baseUrl,
      apiKey,
      models: [{ id: process.env.PI_MODEL_ID, name: process.env.PI_MODEL_ID, contextWindow: 200000, maxTokens: 32000 }],
    };
  } else {
    endpoint = await discoverFromEndpoint(baseUrl, apiKey);
  }
  // envApiKeyAuth resolves from the environment at request time.
  process.env.OPENAI_API_KEY = endpoint.apiKey;
  cached = { providerId, ...endpoint };
  return cached;
}

/** Provider id to register (from PI_PROVIDER_ID, default "aurora"). */
export async function providerId(): Promise<string> {
  return (await loadModelConfig()).providerId;
}

export async function modelId(): Promise<string> {
  const cfg = await loadModelConfig();
  return cfg.models[0].id;
}

export async function localModels() {
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
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // local model — no $ cost
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
