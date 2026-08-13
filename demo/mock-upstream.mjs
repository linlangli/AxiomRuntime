#!/usr/bin/env node
// Demo-only mock OpenAI-compatible upstream.
// Lets `ai status` / `ai provider` run against a real HTTP endpoint so recorded
// demos show genuine CLI output without touching any real provider or API key.
//
// Usage: node demo/mock-upstream.mjs <port> <profile>
//   profile=healthy  -> serves a model catalogue
//   profile=broken   -> always 502, used to demo provider fallback
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4801);
const profile = process.argv[3] ?? "healthy";

const CLAUDE_MODELS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
const CODEX_MODELS = ["gpt-5.5", "gpt-5.5-codex", "o4-mini"];

const catalogue = {
  object: "list",
  data: [...CLAUDE_MODELS, ...CODEX_MODELS].map((id) => ({
    id,
    object: "model",
    owned_by: "demo"
  }))
};

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (profile === "broken") {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream unavailable", type: "bad_gateway" } }));
    return;
  }

  if (req.method === "GET" && url.includes("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(catalogue));
    return;
  }

  if (req.method === "POST" && url.includes("/chat/completions")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-demo",
        object: "chat.completion",
        model: "claude-opus-4-6",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
      })
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock-upstream ${profile} listening on 127.0.0.1:${port}\n`);
});
