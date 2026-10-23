// Config-driven HTTP tool loader: tools declared in app/tools.json become generated
// `defineTool` wrappers (PLAN §1 A8 — extend without code changes). Security: only the
// declaratively allow-listed endpoints in the config file are reachable.
import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { HttpToolSpec } from "../config.ts";

const MAX_CHARS = 20000;
const TIMEOUT_MS = 30_000;

function paramSchema(spec: HttpToolSpec): TSchema {
  const props: Record<string, TSchema> = {};
  for (const [name, p] of Object.entries(spec.params)) {
    const opts = p.description ? { description: p.description } : {};
    props[name] =
      p.type === "string" ? Type.String(opts) : p.type === "number" ? Type.Number(opts) : Type.Boolean(opts);
  }
  return Type.Object(props);
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z0-9_]+)\}/gi, (whole, name) =>
    name in values ? encodeURIComponent(values[name]) : whole,
  );
}

export function httpToolExtension(specs: HttpToolSpec[]) {
  const tools = specs.map((spec) => {
    const method = spec.method ?? "GET";
    const bodyParams = new Set(spec.body ?? []);
    return defineTool({
      name: spec.name,
      description: `${spec.description} (HTTP ${method} ${spec.url})`,
      parameters: paramSchema(spec),
      replay: "safe", // read-only calls to allow-listed endpoints; side effects need their own gated tools
      execute: async (args: Record<string, string | number | boolean>) => {
        const values: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) values[k] = String(v);
        const url = fillTemplate(spec.url, values);

        const query = new URLSearchParams();
        const body: Record<string, string> = {};
        for (const [name, p] of Object.entries(spec.params)) {
          if (!(name in values)) continue;
          if (bodyParams.has(name)) body[name] = values[name];
          else query.set(name, values[name]);
        }
        const qs = query.toString();
        const finalUrl = qs && !url.includes("?") ? `${url}?${qs}` : qs ? url.replace(/\?$/, `?${qs}`) : url;

        const res = await fetch(finalUrl, {
          method,
          headers: { "User-Agent": "Mozilla/5.0 (PiDurable)", ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...spec.headers },
          body: method === "GET" || Object.keys(body).length === 0 ? undefined : JSON.stringify(body),
          redirect: "follow",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${spec.name}`);
        const text = (await res.text()).slice(0, MAX_CHARS);
        return {
          output: [
            { type: "text" as const, text: `<untrusted source="${finalUrl}" status="${res.status}">\n${text}\n</untrusted>` },
          ],
        };
      },
    });
  });
  return defineExtension({ name: "http-tools", tools });
}
