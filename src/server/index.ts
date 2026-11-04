#!/usr/bin/env node
import fs from "node:fs";
import { startRuntimeServer } from "./runtime-server.js";
import { loadServiceExposure } from "../core/config/service-exposure.js";

function readToken(): string | undefined {
  const inline = process.env.AI_GATEWAY_SERVER_TOKEN?.trim();
  if (inline) return inline;
  const file = process.env.AI_GATEWAY_SERVER_TOKEN_FILE?.trim();
  if (file) return fs.readFileSync(file, "utf8").trim();
  return undefined;
}

const exposure = await loadServiceExposure();
const server = await startRuntimeServer({
  host: process.env.AXIOM_MANAGED_API ? "127.0.0.1" : process.env.AI_GATEWAY_SERVER_HOST || "127.0.0.1",
  port: process.env.AXIOM_MANAGED_API ? 8080 : Number(process.env.AI_GATEWAY_SERVER_PORT || "8080"),
  token: process.env.AXIOM_MANAGED_API ? undefined : readToken(),
  useExposureConfig: Boolean(process.env.AXIOM_MANAGED_API) || exposure.updatedAt !== null,
  maxRequestBytes: process.env.AI_GATEWAY_MAX_REQUEST_BYTES ? Number(process.env.AI_GATEWAY_MAX_REQUEST_BYTES) : undefined,
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
