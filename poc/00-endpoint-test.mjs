#!/usr/bin/env node
// Phase 0 — verify the OpenAI-compatible endpoint on Aurora (Unsloth Studio)
// supports chat completions + tool calling. Read-only; no harness involved.
// Usage: node poc/00-endpoint-test.mjs
const BASE = process.env.UNSLOTH_BASE || "http://aurora.infinidigm:8888/v1";
const KEY = process.env.UNSLOTH_KEY || "";

function auth() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };
}

async function main() {
  // 1. reachability + model list
  const modelsRes = await fetch(`${BASE}/models`, { headers: auth() });
  if (!modelsRes.ok) throw new Error(`GET /models failed: ${modelsRes.status}`);
  const models = await modelsRes.json();
  console.log("✓ /models reachable. ids:", (models.data || []).slice(0, 3).map(m => m.id).join(", "), "…");

  // 2. tool calling: model must emit a tool_call, not prose
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      model: "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF", // informational; active model answers
      messages: [
        { role: "user", content: "What is the weather in Paris right now? Use the tool." },
      ],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      }],
      tool_choice: "auto",
    }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`chat/completions failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  const tc = msg?.tool_calls?.[0];
  console.log(`✓ chat/completions ok in ${ms}ms`);
  console.log("  finish_reason:", data.choices?.[0]?.finish_reason);
  if (tc) {
    console.log("  tool_call:", tc.function.name, JSON.stringify(tc.function.arguments));
    const args = JSON.parse(tc.function.arguments || "{}");
    if (tc.function.name === "get_weather" && args.city === "Paris") {
      console.log("✓ GATE 0 PASS: endpoint serves chat + valid tool calls");
    } else {
      console.log("✗ unexpected tool call shape"); process.exitCode = 1;
    }
  } else {
    console.log("✗ no tool_call emitted. content:", (msg?.content || "").slice(0, 200));
    process.exitCode = 1;
  }
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
