#!/usr/bin/env node
import fs from "node:fs";
import { startRuntimeServer } from "./runtime-server.js";

function readToken(): string {
  const inline = process.env.AI_GATEWAY_SERVER_TOKEN?.trim();
  if (inline) return inline;
  const file = process.env.AI_GATEWAY_SERVER_TOKEN_FILE?.trim();
  if (file) return fs.readFileSync(file, "utf8").trim();
  throw new Error("Set AI_GATEWAY_SERVER_TOKEN or AI_GATEWAY_SERVER_TOKEN_FILE.");
}

const server = await startRuntimeServer({
  host: process.env.AI_GATEWAY_SERVER_HOST || "127.0.0.1",
  port: Number(process.env.AI_GATEWAY_SERVER_PORT || "8080"),
  token: readToken(),
  maxRequestBytes: Number(process.env.AI_GATEWAY_MAX_REQUEST_BYTES || "16777216"),
  upstreamHeadersTimeoutMs: Number(process.env.AI_GATEWAY_UPSTREAM_HEADERS_TIMEOUT_MS || "45000"),
  agentWorkspaceRoot: process.env.AI_GATEWAY_AGENT_WORKSPACE_ROOT,
  agentMaxConcurrentRuns: Number(process.env.AI_GATEWAY_AGENT_MAX_CONCURRENT_RUNS || "2"),
  agentTimeoutMs: Number(process.env.AI_GATEWAY_AGENT_TIMEOUT_MS || "600000")
});

console.log(`AI Gateway runtime server listening on ${server.baseUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
