// Minimal .env loader (no dependency). Reads app/.env if present and sets variables that
// are not already set in the environment. Never overwrites existing env vars.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

export function loadDotEnv(): void {
  let text: string;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    return; // no .env file — rely on the ambient environment
  }
  for (const line of text.split("\n")) {
    if (!line || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let [, key, value] = m;
    // strip matching surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
