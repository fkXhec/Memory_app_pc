// llm.js — LLM service (Claude tool use)
import { MODEL, API_URL } from "./config.js";

export async function callTool(tool, systemPrompt, userContent, apiKey, retries = 1) {
  if (!apiKey) return { ok: false, error: "Pas de clé API" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }],
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error?.message || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const tu = data.content?.find(c => c.type === "tool_use");
      if (!tu) throw new Error("No tool_use in response");
      return { ok: true, data: tu.input };
    } catch (e) {
      console.warn(`LLM attempt ${attempt}:`, e.message);
      if (attempt === retries) return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: "unreachable" };
}
