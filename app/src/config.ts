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

/** One declarative scheduled check (app/schedules.json, issue #58). */
export type ScheduleSpec = {
  /** Stable id; also the idempotency anchor for its firings. */
  id: string;
  /** Target conversation: "root", a conversation name, or a numeric id. */
  conversation: string | number;
  /** Prompt submitted as input when the schedule fires. */
  prompt: string;
  /** 5-field cron expression (local time). */
  cron: string;
  /** Disabled schedules are stored but never fire. Default true. */
  enabled?: boolean;
};

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
  /** Pending approvals auto-deny after this many hours (APPROVAL_TTL_HOURS, default 24). */
  approvalTtlHours: number;
  /** Podman sandbox for code-gen/test conversations (D12–13). */
  sandbox: {
    image: string;
    network: string;
    /** §5 item 7: approved base images for sandbox containers. */
    allowImages?: string[];
    /** §5 item 7: host paths sandbox mounts may source from. */
    allowMountRoot?: string;
  };
  /** Telegram client (PLAN §4 D8–9). Null when TELEGRAM_BOT_TOKEN is unset. */
  telegram: {
    botToken: string;
    allowedIds: number[];
    /** Bot API base override (default https://api.telegram.org/bot<token>); tests point this at a mock. */
    apiBase?: string;
  } | null;
  /** Declarative scheduled checks (app/schedules.json, issue #58). */
  schedules: ScheduleSpec[];
  /** Scheduler tick interval in ms (SCHEDULER_TICK_MS, default 30000). */
  schedulerTickMs: number;
  /** Missed-slot policy (SCHEDULER_MISSED_POLICY: "skip" | "catch-up", default "skip"). */
  missedFiringPolicy: "skip" | "catch-up";
};

function resolveDir(value: string | undefined, fallback: string): string {
  const v = value ?? fallback;
  return path.isAbsolute(v) ? v : path.join(APP_ROOT, v);
}

/**
 * Load config from env + declarative JSON. `overrides` (issue #42) lets consumers of
 * the composable core supply per-instance values (data dirs, port, …) without touching
 * process env; unspecified fields keep their env/defaults.
 */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const token = process.env.API_TOKEN;
  if (!token) throw new Error("API_TOKEN env var is required (see app/.env.example)");
  // Issue #48: the override wins over env so per-instance declarative files
  // (roles.json, tools.json, gates.json) are read from the right directory.
  const configDir = resolveDir(overrides.configDir ?? process.env.CONFIG_DIR, ".");

  const roles = readJson<RoleConfig[]>(path.join(configDir, "roles.json"), []);
  const httpTools = readJson<HttpToolSpec[]>(path.join(configDir, "tools.json"), []);
  for (const spec of httpTools) validateHttpToolSpec(spec);
  const schedules = readJson<ScheduleSpec[]>(path.join(configDir, "schedules.json"), []);
  for (const spec of schedules) validateScheduleSpec(spec);

  const config: AppConfig = {
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
    // Invalid/missing TTL falls back to the 24 h default (never zero/negative in production).
    approvalTtlHours: (() => {
      const h = Number(process.env.APPROVAL_TTL_HOURS ?? 24);
      return Number.isFinite(h) && h > 0 ? h : 24;
    })(),
    sandbox: {
      image: process.env.SANDBOX_IMAGE ?? "docker.io/library/python:3.12-alpine",
      network: process.env.SANDBOX_NETWORK ?? "none",
      allowImages: process.env.SANDBOX_ALLOW_IMAGES
        ? process.env.SANDBOX_ALLOW_IMAGES.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      allowMountRoot: process.env.SANDBOX_ALLOW_MOUNT_ROOT || undefined,
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
    schedules,
    schedulerTickMs: (() => {
      const ms = Number(process.env.SCHEDULER_TICK_MS ?? 30_000);
      return Number.isFinite(ms) && ms > 0 ? ms : 30_000;
    })(),
    missedFiringPolicy: process.env.SCHEDULER_MISSED_POLICY === "catch-up" ? "catch-up" : "skip",
  };

  return { ...config, ...overrides };
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    throw new Error(`failed to parse ${file}: ${String(err)}`);
  }
}

function validateScheduleSpec(spec: ScheduleSpec): void {
  if (!spec.id || typeof spec.id !== "string") throw new Error(`schedule missing string "id"`);
  if (spec.conversation === undefined || (typeof spec.conversation !== "string" && typeof spec.conversation !== "number")) {
    throw new Error(`schedule "${spec.id}": "conversation" must be a name, "root", or a numeric id`);
  }
  if (!spec.prompt || typeof spec.prompt !== "string") throw new Error(`schedule "${spec.id}" missing string "prompt"`);
  if (!spec.cron || typeof spec.cron !== "string") throw new Error(`schedule "${spec.id}" missing string "cron"`);
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
