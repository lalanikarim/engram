// kb_search tool: ripgrep over the knowledge base directory, with a dependency-free
// Node fallback when `rg` is not installed.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

const MAX_RESULTS = 50;
const MAX_LINE_CHARS = 300;
const MAX_FILE_BYTES = 1_000_000; // skip files larger than this in the fallback scan

function hasRipgrep(): boolean {
  try {
    execFileSync("rg", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

type Match = { file: string; line: number; text: string };

function rgSearch(kbDir: string, pattern: string, limit: number): Match[] {
  const out = execFileSync("rg", ["-n", "--no-heading", `--max-count=${limit}`, "-e", pattern, kbDir], {
    encoding: "utf8",
  });
  const matches: Match[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    // rg output: <relpath>:<lineno>:<text>
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (m) matches.push({ file: m[1], line: Number(m[2]), text: m[3].slice(0, MAX_LINE_CHARS) });
  }
  return matches;
}

function nodeSearch(kbDir: string, pattern: string, limit: number): Match[] {
  const re = new RegExp(pattern, "i");
  const matches: Match[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
        const lines = readFileSync(full, "utf8").split("\n");
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          if (re.test(lines[i])) {
            matches.push({ file: path.relative(kbDir, full), line: i + 1, text: lines[i].slice(0, MAX_LINE_CHARS) });
            if (matches.length >= limit) return;
          }
        }
      }
    }
  };
  walk(kbDir);
  return matches;
}

export function kbSearchTool(kbDir: string) {
  const useRg = hasRipgrep();
  return defineTool({
    name: "kb_search",
    description: `Search the knowledge base for a text pattern (regex). Returns matching lines as "file:line: text".`,
    parameters: Type.Object({
      pattern: Type.String(),
      max_results: Type.Optional(Type.Number()),
    }),
    replay: "safe", // read-only
    execute: async (args: { pattern: string; max_results?: number }) => {
      const limit = Math.min(Math.max(1, args.max_results ?? MAX_RESULTS), 200);
      let matches: Match[];
      try {
        matches = useRg ? rgSearch(kbDir, args.pattern, limit) : nodeSearch(kbDir, args.pattern, limit);
      } catch (err) {
        throw new Error(`kb_search failed: ${String(err)}`);
      }
      if (matches.length === 0) {
        return { output: [{ type: "text" as const, text: `no matches for "${args.pattern}" in the knowledge base` }] };
      }
      const text = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
      return { output: [{ type: "text" as const, text: `${matches.length} match(es):\n${text}` }] };
    },
  });
}
