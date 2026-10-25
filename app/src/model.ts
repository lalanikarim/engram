// Multi-provider model catalog for pi-ai (replaces the single-endpoint discovery).
//
// Sources, in order:
//   1. All built-in pi-ai providers (opencode-go, openrouter, …) with a static catalog.
//   2. Custom providers from <agentDir>/models.json (pi's global config format; e.g. the
//      local Unsloth hosts `spark`/`aurora`). A custom entry wins over the env provider
//      when their ids match.
//   3. Legacy env-driven OpenAI-compatible endpoint (OPENAI_BASE_URL + /v1/models discovery).
//
// Credentials: read-only store over <agentDir>/auth.json (pi's stored api keys, e.g.
// opencode-go) — no key duplication. PI_AGENT_DIR overrides the agent dir (default
// ~/.pi/agent) for tests and containers.
//
// Model refs are canonical strings "<provider>:<modelId>" (split on the FIRST colon —
// model ids may contain "/"), see parseModelRef().
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type ApiKeyAuth,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Api,
  type Model,
  type Models,
  type MutableModels,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ModelRef } from "@earendil-works/pi-durable";

export type CatalogModel = {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  available: boolean;
};

export type ModelsConfig = {
  models: Models;
  agentDir: string;
  /** DEFAULT_MODEL parsed at load time, or null when unset. */
  configuredDefault: ModelRef | null;
  /** The model picked by legacy env discovery (loaded-preferred), or null. */
  envModel: ModelRef | null;
};

type Env = Record<string, string | undefined>;

// ---- Read-only credential store over <agentDir>/auth.json ---------------------

/**
 * Serves pi's stored credentials from auth.json to pi-ai's auth resolution.
 * Read/list come from the file; modify/delete keep an in-memory view and never
 * persist (this app has no login flows).
 */
class FileCredentialStore implements CredentialStore {
  private readonly path: string;
  private memory: Map<string, Credential> | null = null;

  constructor(authPath: string) {
    this.path = authPath;
  }

  private view(): Map<string, Credential> {
    if (this.memory) return this.memory;
    const map = new Map<string, Credential>();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      raw = {}; // missing/unreadable file → no stored credentials
    }
    if (raw && typeof raw === "object") {
      for (const [providerId, entry] of Object.entries(raw)) {
        if (entry && typeof entry === "object" && (entry as Credential).type === "api_key") {
          map.set(providerId, entry as Credential);
        }
      }
    }
    this.memory = map;
    return map;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.view().get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.view().entries()].map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const current = this.view().get(providerId);
    const next = await fn(current);
    if (next === undefined) return current;
    this.view().set(providerId, next); // in-memory only — never persisted
    return next;
  }

  async delete(providerId: string): Promise<void> {
    this.view().delete(providerId);
  }
}

// ---- Catalog building ----------------------------------------------------------

type ModelsJson = {
  providers?: Record<
    string,
    {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      api?: string;
      models?: Array<{
        id: string;
        name?: string;
        api?: string;
        baseUrl?: string;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
        input?: string[];
      }>;
    }
  >;
};

/** Resolve a models.json apiKey value: literal, "$NAME"/"${NAME}" env interpolation. */
function resolveApiKey(value: string): string | undefined {
  const m = value.match(/^\$(\w+)$/);
  if (m) return process.env[m[1]];
  if (value.startsWith("!")) throw new Error(`apiKey "!command" values are not supported in models.json`);
  return value;
}

function customProviderAuth(id: string, apiKey: string | undefined): ApiKeyAuth {
  // An unset $ENV key degrades to "provider unavailable", not a load error —
  // the catalog still lists the models so operators can see what's missing.
  const resolved = apiKey !== undefined ? resolveApiKey(apiKey) : undefined;
  return {
    name: `${id} API key`,
    check: () => (resolved ? Promise.resolve({ type: "api_key" as const, source: "models.json" }) : Promise.resolve(undefined)),
    resolve: () => (resolved ? Promise.resolve({ auth: { apiKey: resolved }, source: "models.json" }) : Promise.resolve(undefined)),
  };
}

/**
 * Stream dispatch for custom providers: route each model to the API implementation
 * registered for its `api` string (same pattern pi's own provider composer uses).
 */
function customApiStreams(): ProviderStreams {
  const impl = (model: Model<Api>) => {
    const api = getApiProvider(model.api);
    if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
    return api;
  };
  return {
    stream: (model, context, options) => impl(model).stream(model, context, options),
    streamSimple: (model, context, options) => impl(model).streamSimple(model, context, options),
  };
}

function registerCustomProvider(models: MutableModels, id: string, spec: NonNullable<ModelsJson["providers"]>[string]): void {
  if (!spec.baseUrl && (spec.models?.length ?? 0) > 0) {
    throw new Error(`custom provider "${id}" has models but no baseUrl in models.json`);
  }
  const baseUrl = spec.baseUrl!;
  const providerModels = (spec.models ?? []).map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    provider: id,
    baseUrl: m.baseUrl ?? baseUrl,
    api: m.api ?? spec.api ?? "openai-completions",
    reasoning: m.reasoning ?? true,
    input: (m.input ?? ["text"]) as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 128000,
    maxTokens: m.maxTokens ?? 16384,
  }));
  models.setProvider(
    createProvider({
      id,
      name: spec.name ?? id,
      baseUrl: spec.baseUrl,
      auth: { apiKey: customProviderAuth(id, spec.apiKey) },
      models: providerModels,
      api: customApiStreams(),
    }),
  );
}

/** GET /v1/models → the loaded model's id (first entry if no `loaded` flag). */
async function discoverLoadedModel(baseUrl: string, apiKey: string): Promise<string> {
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
  return String(m.id);
}

export type BuildCatalogOptions = {
  agentDir: string;
  env: Env;
};

/**
 * Build the pi-ai catalog from built-ins + <agentDir>/models.json custom providers +
 * (fallback) the legacy env OpenAI-compatible endpoint. Pure w.r.t. process state
 * except apiKey $ENV resolution, which reads process.env by design.
 */
export async function buildCatalog(opts: BuildCatalogOptions): Promise<{ models: Models; envModel: ModelRef | null }> {
  const credentials = new FileCredentialStore(path.join(opts.agentDir, "auth.json"));
  const models = createModels({ credentials }) as MutableModels;
  for (const p of builtinProviders()) models.setProvider(p);

  // Custom providers from the global pi config.
  let customIds = new Set<string>();
  const modelsJsonPath = path.join(opts.agentDir, "models.json");
  if (existsSync(modelsJsonPath)) {
    const spec = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as ModelsJson;
    for (const [id, providerSpec] of Object.entries(spec.providers ?? {})) {
      registerCustomProvider(models, id, providerSpec);
      customIds.add(id);
    }
  }

  // Legacy env-driven OpenAI-compatible endpoint (kept for back-compat and tests).
  let envModel: ModelRef | null = null;
  const baseUrl = opts.env.OPENAI_BASE_URL;
  const apiKey = opts.env.OPENAI_API_KEY;
  if (baseUrl && apiKey) {
    const providerId = opts.env.PI_PROVIDER_ID ?? "aurora";
    const discoveredId = await discoverLoadedModel(baseUrl, apiKey);
    // Discovery always tells us which model is loaded on the local box.
    envModel = { provider: providerId, modelId: discoveredId };
    if (!customIds.has(providerId)) {
      models.setProvider(
        createProvider({
          id: providerId,
          name: "Local OpenAI-compatible endpoint",
          baseUrl,
          auth: { apiKey: envApiKeyAuth("OpenAI-compatible API key", ["OPENAI_API_KEY"]) },
          models: [
            {
              id: discoveredId,
              name: discoveredId,
              provider: providerId,
              baseUrl,
              api: "openai-completions",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 32000,
            },
          ],
          api: customApiStreams(),
        }),
      );
    }
    // else: models.json owns this provider id — its catalog entry wins; the
    // discovery result still feeds the default-model fallback.
  }

  return { models, envModel };
}

/** Parse "<provider>:<modelId>" (first colon) or a bare unique model id. */
export function parseModelRef(models: Models, input: string): ModelRef {
  const trimmed = input.trim();
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const provider = trimmed.slice(0, colon);
    const modelId = trimmed.slice(colon + 1);
    if (!modelId) throw new Error(`invalid model ref "${input}" — expected <provider>:<modelId>`);
    const model = models.getModel(provider, modelId);
    if (!model) {
      const known = models.getProviders().map((p) => p.id).filter((id) => id === provider);
      throw new Error(
        known.length === 0
          ? `unknown provider "${provider}" — available: ${models.getProviders().map((p) => p.id).join(", ")}`
          : `model "${modelId}" not found on provider "${provider}"`,
      );
    }
    return { provider, modelId };
  }
  // Bare id: must resolve to exactly one (provider, model) in the catalog.
  const matches: ModelRef[] = [];
  for (const p of models.getProviders()) {
    for (const m of models.getModels(p.id)) {
      if (m.id === trimmed) matches.push({ provider: p.id, modelId: m.id });
    }
  }
  if (matches.length === 0) throw new Error(`model "${trimmed}" not found in the catalog`);
  if (matches.length > 1) {
    throw new Error(
      `model id "${trimmed}" is ambiguous — use <provider>:<modelId>: ${matches.map(formatModelRef).join(", ")}`,
    );
  }
  return matches[0];
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.modelId}`;
}

/** Global default: DEFAULT_MODEL env var, else the loaded model on the local endpoint. */
export async function defaultModelRef(cfg: ModelsConfig): Promise<ModelRef> {
  if (cfg.configuredDefault) return cfg.configuredDefault;
  if (cfg.envModel) return cfg.envModel;
  throw new Error("no default model — set DEFAULT_MODEL=<provider>:<modelId> or OPENAI_BASE_URL");
}

/** All chat models in the catalog, with an availability flag from auth resolution. */
export async function listCatalogModels(cfg: ModelsConfig): Promise<CatalogModel[]> {
  const available = new Set(
    (await cfg.models.getAvailable()).map((m) => `${m.provider}:${m.id}`),
  );
  const out: CatalogModel[] = [];
  for (const p of cfg.models.getProviders()) {
    for (const m of cfg.models.getModels(p.id)) {
      out.push({
        provider: p.id,
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        available: available.has(`${p.id}:${m.id}`),
      });
    }
  }
  return out;
}

let cached: ModelsConfig | null = null;

/** Load the catalog once for this process (env-driven). */
export async function loadModelsConfig(): Promise<ModelsConfig> {
  if (cached) return cached;
  const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const { models, envModel } = await buildCatalog({ agentDir, env: process.env });

  let configuredDefault: ModelRef | null = null;
  if (process.env.DEFAULT_MODEL) {
    configuredDefault = parseModelRef(models, process.env.DEFAULT_MODEL);
  }

  cached = { models, agentDir, configuredDefault, envModel };
  return cached;
}
