// Configuration: environment variables + declarative JSON configs (roles, HTTP tools).
// All paths default relative to the app root so `node src/main.ts` works from any cwd.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Subagent role configuration (app/roles.json). */
export type RoleConfig = {
  name: string;
  /** Tool names the role's worker conversation may use. */
  tools: string[];
  /** Rendered as the worker conversation's instructions. */
  instructions?: string;
  /** Optional model for this role ("<provider>:<modelId>"); unset = inherit/chain default. */
  model?: string;
};

import type { GatesConfig } from "./extensions/gates.ts";

/** One declarative HTTP tool (app/tools.json). */
export type HttpToolSpec = {
  name: string;
  description: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** URL template; `{param}` placeholders are filled from params. */
  url: string;
  /** Param schema. Params listed in `body` go into a JSON body (non-GET), the rest into the query string. */
  params: Record<string, { type: "string" | "number" | "boolean"; description?: string }>;
  body?: string[];
  headers?: Record<string, string>;
};

export type AppConfig = {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  workRoot: string;
  kbDir: string;
  configDir: string;
  /** Compaction sizing (see POC-FINDINGS Phase 6): reserveTokens must exceed pi-ai's 4096 safety margin. */
  reserveTokens: number;
  keepRecentTokens: number;
  backgroundTokens: number;
  roles: RoleConfig[];
  httpTools: HttpToolSpec[];
  /** Risk-tiered gate config (app/gates.json; legacy GATED_TOOLS fallback when absent). */
  gates: GatesConfig | null;
  /** Podman sandbox for code-gen/test conversations (D12–13). */
  sandbox: {
    image: string;
    network: string;
  };
  /** Telegram client (PLAN §4 D8–9). Null when TELEGRAM_BOT_TOKEN is unset. */
  telegram: {
    botToken: string;
    allowedIds: number[];
    /** Bot API base override (default https://api.telegram.org/bot<token>); tests point this at a mock. */
    apiBase?: string;
  } | null;
};

function resolveDir(value: string | undefined, fallback: string): string {
  const v = value ?? fallback;
  return path.isAbsolute(v) ? v : path.join(APP_ROOT, v);
}

export function loadConfig(): AppConfig {
  const token = process.env.API_TOKEN;
  if (!token) throw new Error("API_TOKEN env var is required (see app/.env.example)");
  const configDir = resolveDir(process.env.CONFIG_DIR, ".");

  const roles = readJson<RoleConfig[]>(path.join(configDir, "roles.json"), []);
  const httpTools = readJson<HttpToolSpec[]>(path.join(configDir, "tools.json"), []);
  for (const spec of httpTools) validateHttpToolSpec(spec);

  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8791),
    token,
    dataDir: resolveDir(process.env.DATA_DIR, "./data"),
    workRoot: resolveDir(process.env.WORK_ROOT, "./work"),
    kbDir: resolveDir(process.env.KB_DIR, "./kb"),
    configDir,
    reserveTokens: Number(process.env.RESERVE_TOKENS ?? 16384),
    keepRecentTokens: Number(process.env.KEEP_RECENT_TOKENS ?? 8192),
    backgroundTokens: Number(process.env.BACKGROUND_TOKENS ?? 8192),
    roles,
    httpTools,
    // gates.json wins; otherwise the legacy GATED_TOOLS list becomes prompt-tier entries.
    gates: readJson<GatesConfig | null>(path.join(configDir, "gates.json"), null) ?? {
      tiers: (process.env.GATED_TOOLS ?? "send_message")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((tool) => ({ tool })),
    },
    sandbox: {
      image: process.env.SANDBOX_IMAGE ?? "docker.io/library/python:3.12-alpine",
      network: process.env.SANDBOX_NETWORK ?? "none",
    },
    telegram: process.env.TELEGRAM_BOT_TOKEN
      ? {
          botToken: process.env.TELEGRAM_BOT_TOKEN,
          allowedIds: (process.env.ALLOWED_TELEGRAM_IDS ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number),
          apiBase: process.env.TELEGRAM_API_BASE || undefined,
        }
      : null,
  };
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    throw new Error(`failed to parse ${file}: ${String(err)}`);
  }
}

function validateHttpToolSpec(spec: HttpToolSpec): void {
  if (!spec.name || !/^[a-z][a-z0-9_]*$/.test(spec.name)) {
    throw new Error(`invalid HTTP tool name "${spec.name ?? ""}" (must match [a-z][a-z0-9_]*)`);
  }
  if (!spec.description) throw new Error(`HTTP tool "${spec.name}" missing description`);
  if (!/^https?:\/\//.test(spec.url)) {
    throw new Error(`HTTP tool "${spec.name}": url must be http(s) — allow-listed endpoints only`);
  }
  for (const name of spec.body ?? []) {
    if (!(name in spec.params)) throw new Error(`HTTP tool "${spec.name}": body param "${name}" not in params`);
  }
}
