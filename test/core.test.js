import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonFile, updateJsonFile, writeJsonFile } from "../dist/core/config/json-store.js";
import { normalizeProviders, swapProviderLevel } from "../dist/core/config/providers-store.js";
import { checkProvider, extractTokenUsage } from "../dist/core/models/model-discovery.js";
import { isModelCompatible, pickCompatibleModel } from "../dist/core/models/model-filter.js";
import { resolveToolCommandWithOptions } from "../dist/core/runner/command-resolver.js";
import { isPrivilegedProcess, resolveClaudePermissionMode } from "../dist/core/runner/claude-permission-policy.js";
import { getRunnerEngine, listRunnerEngines } from "../dist/core/runner/engine-registry.js";
import { startOpenAiUsageProxy } from "../dist/core/runner/openai-usage-proxy.js";
import { buildRunnerArgs, getSecretFingerprint, getToolBaseUrl, resolveRunnerLaunchPolicy, writeTemporaryClaudeSettings } from "../dist/core/runner/tool-runner.js";
import { estimateTokenCostUsd } from "../dist/core/usage/pricing.js";
import { runResolvedProviderCandidates } from "../dist/cli/commands/use.js";
import { getCliCommand, listInteractiveCliCommands, registerCliCommand } from "../dist/cli/registry.js";

test("normalizes provider levels by priority", () => {
  const providers = normalizeProviders([
    { name: "b", baseUrl: "https://b.test/", apiKey: "b", mode: "auto", level: 2, model: "gpt-5" },
    { name: "a", baseUrl: "https://a.test/", apiKey: "a", mode: "ask", level: 1, model: "claude" }
  ]);

  assert.equal(providers[0].name, "a");
  assert.equal(providers[0].level, 1);
  assert.equal(providers[1].name, "b");
  assert.equal(providers[1].level, 2);
  assert.equal(providers[1].baseUrl, "https://b.test");
});

test("provider config validation rejects empty connection fields", () => {
  assert.throws(
    () => normalizeProviders([
      { name: "api", baseUrl: "", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.5" }
    ]),
    /baseUrl cannot be empty/
  );
  assert.throws(
    () => normalizeProviders([
      { name: "api", baseUrl: "https://api.test", apiKey: "", mode: "auto", level: 1, model: "gpt-5.5" }
    ]),
    /apiKey cannot be empty/
  );
});

test("swaps provider levels", () => {
  const providers = normalizeProviders([
    { name: "a", baseUrl: "https://a.test", apiKey: "a", mode: "auto", level: 1, model: "gpt-5" },
    { name: "b", baseUrl: "https://b.test", apiKey: "b", mode: "auto", level: 2, model: "gpt-5" },
    { name: "c", baseUrl: "https://c.test", apiKey: "c", mode: "auto", level: 3, model: "gpt-5" }
  ]);

  const swapped = swapProviderLevel(providers, "c", 2);
  assert.equal(swapped.find((provider) => provider.name === "b").level, 3);
  assert.equal(swapped.find((provider) => provider.name === "c").level, 2);
});

test("filters compatible models", () => {
  assert.equal(isModelCompatible("claude", "claude-opus-4-6"), true);
  assert.equal(isModelCompatible("codex", "gpt-5.5"), true);
  assert.equal(isModelCompatible("codex", "grok-4.5"), true);
  assert.equal(isModelCompatible("codex", "claude-opus-4-6"), false);
  assert.equal(pickCompatibleModel("codex", "claude-opus", ["claude-opus", "gpt-5"]), "gpt-5");
});

test("runner engine registry exposes built-in engines", () => {
  assert.deepEqual(listRunnerEngines().map((engine) => engine.name).sort(), ["claude", "codex"]);
  const claude = getRunnerEngine("claude");
  const codex = getRunnerEngine("codex");
  assert.equal(claude.normalizeBaseUrl("https://api.test/v1"), "https://api.test");
  assert.equal(codex.normalizeBaseUrl("https://api.test"), "https://api.test/v1");
  assert.equal(claude.buildArgs({
    provider: { name: "api", baseUrl: "https://api.test", apiKey: "key", mode: "auto", level: 1, model: "claude-opus-4-6" },
    model: "claude-opus-4-6",
    uid: 0
  }).includes("--dangerously-skip-permissions"), false);
  assert.deepEqual(codex.buildArgs({
    provider: { name: "api", baseUrl: "https://api.test", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.5" },
    model: "gpt-5.5"
  }), [
    "-c",
    'model_provider="ai_gateway_selected"',
    "-c",
    'model_providers.ai_gateway_selected.name="AI Gateway (api)"',
    "-c",
    'model_providers.ai_gateway_selected.base_url="https://api.test/v1"',
    "-c",
    'model_providers.ai_gateway_selected.env_key="OPENAI_API_KEY"',
    "-c",
    "model_providers.ai_gateway_selected.requires_openai_auth=true",
    "-c",
    'model_providers.ai_gateway_selected.wire_api="responses"',
    "--model",
    "gpt-5.5",
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
});

test("CLI command registry resolves commands and aliases", async () => {
  let called = false;
  registerCliCommand({
    name: "unit-test-command",
    aliases: ["utc"],
    description: "unit test command",
    interactive: false,
    run: async () => {
      called = true;
    }
  });

  assert.equal(getCliCommand("utc")?.name, "unit-test-command");
  assert.equal(listInteractiveCliCommands().some((command) => command.name === "unit-test-command"), false);
  await getCliCommand("unit-test-command")?.run([]);
  assert.equal(called, true);
});

test("version command prints the package version without creating runtime state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-version-test-"));
  const runtimeHome = path.join(tempDir, "runtime-home");
  const result = spawnSync(process.execPath, [path.resolve("dist/cli/index.js"), "--version"], {
    encoding: "utf8",
    env: { ...process.env, AI_GATEWAY_HOME: runtimeHome }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.0.1");
  await assert.rejects(fs.access(runtimeHome), { code: "ENOENT" });
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("setup command initializes an empty runtime home non-interactively", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-setup-test-"));
  const runtimeHome = path.join(tempDir, "runtime-home");
  const result = spawnSync(process.execPath, [
    path.resolve("dist/cli/index.js"),
    "setup",
    "--yes",
    "--skip-tools",
    "--skip-provider"
  ], {
    encoding: "utf8",
    env: { ...process.env, AI_GATEWAY_HOME: runtimeHome }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeHome, "providers.json"), "utf8")), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeHome, ".ai-cache.json"), "utf8")), { providers: {} });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeHome, "usage.json"), "utf8")), { events: [] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeHome, "sessions.json"), "utf8")), { sessions: [] });
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("extracts OpenAI-compatible token usage", () => {
  assert.deepEqual(
    extractTokenUsage({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15
      }
    }),
    {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15
    }
  );
});

test("extracts cached input token usage", () => {
  assert.deepEqual(
    extractTokenUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: {
          cached_tokens: 400
        }
      }
    }),
    {
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1050,
      cacheReadInputTokens: 400
    }
  );
  assert.deepEqual(
    extractTokenUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 300
      }
    }),
    {
      inputTokens: 400,
      outputTokens: 20,
      totalTokens: 420,
      cacheReadInputTokens: 300
    }
  );
});

test("extracts Anthropic-style token usage", () => {
  assert.deepEqual(
    extractTokenUsage({
      usage: {
        input_tokens: 8,
        output_tokens: 2
      }
    }),
    {
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10
    }
  );
});

test("checkProvider retries transient model discovery failures", async () => {
  let requests = 0;
  const server = await startTestServer((req, res) => {
    if (req.url === "/v1/models") {
      requests += 1;
      if (requests === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "busy" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const result = await checkProvider({
      name: "retry-provider",
      baseUrl: `${server.url}/v1`,
      apiKey: "key",
      mode: "auto",
      level: 1,
      model: "gpt-5.5"
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(result.models, ["gpt-5.5"]);
    assert.equal(result.attempts, 2);
    assert.equal(requests, 2);
    assert.match(result.retryErrors?.[0] ?? "", /503/);
    assert.ok((result.durationMs ?? 0) >= 0);
  } finally {
    await server.close();
  }
});

test("estimates token cost from model pricing table", () => {
  const usage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 };
  assert.equal(
    estimateTokenCostUsd("api", "custom-model", usage, {
      "api/custom-model": { inputPerMillionUsd: 1, outputPerMillionUsd: 3 }
    }),
    0.0025
  );
  assert.equal(
    estimateTokenCostUsd("api", "cached-model", { ...usage, cacheReadInputTokens: 400 }, {
      "api/cached-model": { inputPerMillionUsd: 1, outputPerMillionUsd: 3, cacheReadPerMillionUsd: 0.1 }
    }),
    0.00214
  );
  assert.equal(estimateTokenCostUsd("api", "missing-model", usage, {}), undefined);
});

test("OpenAI usage proxy forwards JSON response and records priced usage", async () => {
  await withTempHome(async (tempDir) => {
    await fs.writeFile(
      path.join(tempDir, "model-pricing.json"),
      JSON.stringify({ "charged-model": { inputPerMillionUsd: 1, outputPerMillionUsd: 3 } }),
      "utf8"
    );

    const upstream = await startTestServer(async (req, res) => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer secret");
      const body = JSON.parse((await readRequestBody(req)).toString("utf8"));
      assert.equal(body.model, "charged-model");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        model: "charged-model",
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500
        }
      }));
    });

    const proxy = await startOpenAiUsageProxy({
      provider: {
        name: "api",
        baseUrl: upstream.url,
        apiKey: "secret",
        mode: "auto",
        level: 1,
        model: "charged-model"
      },
      model: "charged-model",
      tool: "telegram"
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer local" },
        body: JSON.stringify({ model: "charged-model", messages: [] })
      });
      const json = await response.json();
      assert.equal(json.id, "chatcmpl-test");
      assert.equal(proxy.getRecords().length, 1);
      assert.equal(proxy.getRecords()[0].costUsd, 0.0025);
      assert.equal(proxy.getRecords()[0].costSource, "pricing");
      assert.equal(proxy.getMetrics().requestCount, 1);
      assert.equal(proxy.getMetrics().successCount, 1);
      assert.equal(proxy.getMetrics().failureCount, 0);
      assert.equal(proxy.getMetrics().usageRecordCount, 1);
      assert.equal(proxy.getMetrics().noUsageCount, 0);
      assert.equal(proxy.getMetrics().upstreamStatusCounts["200"], 1);

      const usage = JSON.parse(await fs.readFile(path.join(tempDir, "usage.json"), "utf8"));
      assert.equal(usage.events[0].source, "proxy");
      assert.equal(usage.events[0].totalTokens, 1500);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

test("OpenAI usage proxy isolates upstream connections across caller retries", async () => {
  await withTempHome(async () => {
    const upstreamConnections = [];
    const upstream = await startTestServer(async (req, res) => {
      upstreamConnections.push({
        remotePort: req.socket.remotePort,
        connection: req.headers.connection
      });
      await readRequestBody(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "gpt-5.6-sol", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
    });

    const proxy = await startOpenAiUsageProxy({
      provider: { name: "api", baseUrl: upstream.url, apiKey: "secret", mode: "auto", level: 1, model: "gpt-5.6-sol" },
      model: "gpt-5.6-sol",
      tool: "telegram"
    });

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${proxy.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi" })
        });
        assert.equal(response.status, 200);
        await response.text();
      }

      assert.equal(upstreamConnections.length, 2);
      assert.notEqual(upstreamConnections[0].remotePort, upstreamConnections[1].remotePort);
      assert.deepEqual(upstreamConnections.map((entry) => entry.connection), ["close", "close"]);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

test("OpenAI usage proxy bounds repeated upstream headers timeouts", async () => {
  await withTempHome(async () => {
    let upstreamRequests = 0;
    const upstream = await startTestServer(async (req) => {
      upstreamRequests += 1;
      await readRequestBody(req);
      // Intentionally leave the response headers pending.
    });
    const proxy = await startOpenAiUsageProxy({
      provider: { name: "slow", baseUrl: upstream.url, apiKey: "secret", mode: "auto", level: 1, model: "gpt-5.6-sol" },
      model: "gpt-5.6-sol",
      tool: "telegram",
      upstreamHeadersTimeoutMs: 25
    });

    try {
      const attemptDurations = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const startedAt = Date.now();
        const response = await fetch(`${proxy.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: true })
        });
        assert.equal(response.status, 504);
        assert.match(await response.text(), /timed out|timeout/i);
        attemptDurations.push(Date.now() - startedAt);
      }

      assert.equal(upstreamRequests, 2);
      assert.ok(attemptDurations[2] < 250);
      assert.equal(proxy.getMetrics().failureCount, 3);
      assert.equal(proxy.getMetrics().upstreamStatusCounts.headers_timeout, 2);
      assert.equal(proxy.getMetrics().upstreamStatusCounts.headers_timeout_short_circuit, 1);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

test("OpenAI usage proxy records one usage event from SSE response", async () => {
  await withTempHome(async (tempDir) => {
    const upstream = await startTestServer(async (_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write("data: {\"type\":\"response.completed\",\"response\":{\"model\":\"stream-model\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15},\"cost_usd\":0.0042}}\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const proxy = await startOpenAiUsageProxy({
      provider: {
        name: "api",
        baseUrl: upstream.url,
        apiKey: "secret",
        mode: "auto",
        level: 1,
        model: "stream-model"
      },
      model: "stream-model",
      tool: "telegram"
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "stream-model", input: "hello" })
      });
      const text = await response.text();
      assert.match(text, /response.completed/);
      assert.equal(proxy.getRecords().length, 1);
      assert.equal(proxy.getRecords()[0].usage.totalTokens, 15);
      assert.equal(proxy.getRecords()[0].costUsd, 0.0042);
      assert.equal(proxy.getRecords()[0].costSource, "provider");

      const usage = JSON.parse(await fs.readFile(path.join(tempDir, "usage.json"), "utf8"));
      assert.equal(usage.events.length, 1);
      assert.equal(usage.events[0].totalTokens, 15);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

test("OpenAI usage proxy falls back to chat completions when Responses is unsupported", async () => {
  await withTempHome(async (tempDir) => {
    const requests = [];
    const upstream = await startTestServer(async (req, res) => {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8"));
      requests.push({ url: req.url, body });

      if (req.url === "/v1/responses") {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: "此模型不支持 responses 协议" } }));
        return;
      }

      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer secret");
      assert.equal(body.model, "gpt-5.5");
      assert.equal(body.stream, false);
      assert.equal(body.messages[0].role, "system");
      assert.equal(body.messages.at(-1).content, "hello");
      assert.equal(body.tools[0].function.name, "shell_command");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl-fallback",
        model: "gpt-5.5",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "OK" }
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      }));
    });

    const proxy = await startOpenAiUsageProxy({
      provider: {
        name: "api",
        baseUrl: upstream.url,
        apiKey: "secret",
        mode: "auto",
        level: 1,
        model: "gpt-5.5"
      },
      model: "gpt-5.5",
      tool: "telegram"
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          instructions: "system prompt",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
          tools: [{ type: "function", name: "shell_command", description: "run shell", parameters: { type: "object", properties: {} } }],
          tool_choice: "auto",
          stream: true
        })
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(text, /response\.output_text\.delta/);
      assert.match(text, /OK/);
      assert.deepEqual(requests.map((request) => request.url), ["/v1/responses", "/v1/chat/completions"]);
      assert.equal(proxy.getRecords().length, 1);
      assert.equal(proxy.getRecords()[0].usage.totalTokens, 15);

      const usage = JSON.parse(await fs.readFile(path.join(tempDir, "usage.json"), "utf8"));
      assert.equal(usage.events[0].totalTokens, 15);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

test("OpenAI usage proxy streams native Responses without chat translation", async () => {
  await withTempHome(async () => {
    const requests = [];
    const upstream = await startTestServer(async (req, res) => {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8"));
      requests.push({ url: req.url, body });

      assert.equal(req.url, "/v1/responses");
      assert.equal(req.headers.authorization, "Bearer secret");
      assert.equal(body.model, "gpt-5.6-sol");
      assert.equal(body.stream, true);
      res.setHeader("content-type", "text/event-stream");
      res.write("data: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5.6-sol\",\"usage\":{\"input_tokens\":12,\"output_tokens\":4,\"total_tokens\":16}}}\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const proxy = await startOpenAiUsageProxy({
      provider: {
        name: "responses-api",
        baseUrl: upstream.url,
        apiKey: "secret",
        mode: "auto",
        level: 1,
        model: "gpt-5.6-sol"
      },
      model: "gpt-5.6-sol",
      tool: "telegram"
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: "hello",
          stream: true
        })
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(text, /response\.completed/);
      assert.deepEqual(requests.map((request) => request.url), ["/v1/responses"]);
      assert.equal(proxy.getRecords().length, 1);
      assert.equal(proxy.getRecords()[0].usage.totalTokens, 16);
      assert.equal(proxy.getMetrics().successCount, 1);
      assert.equal(proxy.getMetrics().failureCount, 0);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

test("OpenAI usage proxy passes through native Responses no-channel errors without chat fallback", async () => {
  await withTempHome(async () => {
    const requests = [];
    const upstream = await startTestServer(async (req, res) => {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8"));
      requests.push({ url: req.url, body });
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: { code: "model_not_found", message: "No available channel for model gpt-5.6-sol", type: "new_api_error" }
      }));
    });

    const proxy = await startOpenAiUsageProxy({
      provider: { name: "cq", baseUrl: upstream.url, apiKey: "secret", mode: "auto", level: 1, model: "gpt-5.6-sol" },
      model: "gpt-5.6-sol",
      tool: "telegram"
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: true })
      });
      const text = await response.text();
      assert.equal(response.status, 503);
      assert.match(text, /No available channel/);
      // Transient no-channel error must not waste a chat attempt.
      assert.deepEqual(requests.map((request) => request.url), ["/v1/responses"]);
      assert.equal(proxy.getMetrics().failureCount, 1);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

test("OpenAI usage proxy passes through Cloudflare 524 without chat fallback", async () => {
  await withTempHome(async () => {
    const requests = [];
    const upstream = await startTestServer(async (req, res) => {
      requests.push(req.url);
      await readRequestBody(req);
      res.statusCode = 524;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "bad response status code 524" } }));
    });
    const proxy = await startOpenAiUsageProxy({
      provider: { name: "timeout", baseUrl: upstream.url, apiKey: "secret", mode: "auto", level: 1, model: "gpt-5.6-sol" },
      model: "gpt-5.6-sol",
      tool: "telegram"
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: true })
      });
      assert.equal(response.status, 524);
      assert.match(await response.text(), /524/);
      assert.deepEqual(requests, ["/v1/responses"]);
      assert.equal(proxy.getMetrics().failureCount, 1);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

test("OpenAI usage proxy falls back to chat when Responses error is wrapped in HTTP 200", async () => {
  await withTempHome(async () => {
    const requests = [];
    const upstream = await startTestServer(async (req, res) => {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8"));
      requests.push({ url: req.url, body });

      if (req.url === "/v1/responses") {
        // Domestic new-api gateways wrap the real error in HTTP 200.
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          error: { message: "status_code=400, 此模型不支持 responses 协议 (request id: 01KXD4HHTQXN)" }
        }));
        return;
      }

      assert.equal(req.url, "/v1/chat/completions");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl-ok",
        model: "gpt-5.6-sol",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
      }));
    });

    const proxy = await startOpenAiUsageProxy({
      provider: { name: "cq", baseUrl: upstream.url, apiKey: "secret", mode: "auto", level: 1, model: "gpt-5.6-sol" },
      model: "gpt-5.6-sol",
      tool: "telegram"
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: true })
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(text, /response\.output_text\.delta/);
      assert.match(text, /OK/);
      assert.deepEqual(requests.map((request) => request.url), ["/v1/responses", "/v1/chat/completions"]);
      assert.equal(proxy.getRecords()[0].usage.totalTokens, 10);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

test("secret fingerprint identifies keys without exposing full value", () => {
  const key = "sk-TESTKEY1234567890abcdefghijklmnopQRSTUV";
  const fingerprint = getSecretFingerprint(key);

  assert.equal(fingerprint.includes(key), false);
  assert.match(fingerprint, /^sk-TESTK\.\.\.QRSTUV len=42$/);
});

test("normalizes base URL per downstream tool", () => {
  const provider = {
    name: "api",
    baseUrl: "https://icode.51talk.biz/v1/",
    apiKey: "key",
    mode: "auto",
    level: 1,
    model: "claude-sonnet-4-6"
  };

  assert.equal(getToolBaseUrl("claude", provider), "https://icode.51talk.biz");
  assert.equal(getToolBaseUrl("codex", provider), "https://icode.51talk.biz/v1");
});

test("adds OpenAI v1 path for codex runtime base URL", () => {
  const provider = {
    name: "api",
    baseUrl: "https://icode.51talk.biz/",
    apiKey: "key",
    mode: "auto",
    level: 1,
    model: "gpt-5.5"
  };

  assert.equal(getToolBaseUrl("codex", provider), "https://icode.51talk.biz/v1");
});

test("json store recovers trailing duplicate content and rewrites clean json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-json-"));
  try {
    const filePath = path.join(tempDir, "cache.json");
    await fs.writeFile(filePath, '{ "ok": true, "items": [1, 2] }\n{ "tail": true }\n', "utf8");

    const recovered = await readJsonFile(filePath, { ok: false, items: [] });
    assert.deepEqual(recovered, { ok: true, items: [1, 2] });

    await writeJsonFile(filePath, { ok: true, items: [3] });
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { ok: true, items: [3] });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("json store serializes concurrent read modify write updates", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-json-lock-"));
  try {
    const filePath = path.join(tempDir, "counter.json");
    await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      await updateJsonFile(filePath, { items: [] }, async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { items: [...current.items, index] };
      });
    }));

    const stored = await readJsonFile(filePath, { items: [] });
    assert.deepEqual([...stored.items].sort((a, b) => a - b), Array.from({ length: 25 }, (_, index) => index));

    const leftovers = (await fs.readdir(tempDir)).filter((item) =>
      item.endsWith(".tmp") || item.endsWith(".lock")
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("maps Claude auto mode to bypass permissions + dangerously skip for non-root users", () => {
  const provider = {
    name: "api",
    baseUrl: "https://icode.51talk.biz/v1/",
    apiKey: "key",
    mode: "auto",
    level: 1,
    model: "claude-sonnet-4-6"
  };

  assert.deepEqual(buildRunnerArgs("claude", provider, "claude-sonnet-4-6", "/tmp/settings.json", { uid: 1000 }), [
    "--model",
    "claude-sonnet-4-6",
    "--settings",
    "/tmp/settings.json",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions"
  ]);
});

test("constrains Claude auto mode to safe defaults for root", () => {
  const provider = {
    name: "api",
    baseUrl: "https://api.test/v1",
    apiKey: "key",
    mode: "auto",
    level: 1,
    model: "claude-sonnet-4-6"
  };

  const resolution = resolveClaudePermissionMode("bypassPermissions", { uid: 0 });
  assert.equal(isPrivilegedProcess({ uid: 0 }), true);
  assert.equal(resolution.effectiveMode, "default");
  assert.equal(resolution.constrained, true);
  assert.equal(resolution.reason, "root_bypass_permissions_unsupported");

  const policy = resolveRunnerLaunchPolicy("claude", provider, { uid: 0 });
  assert.equal(policy.provider.mode, "ask");
  assert.equal(policy.claudeSettingsPermissionMode, "safeDefault");
  assert.match(policy.warning, /non-root user/);
  assert.deepEqual(buildRunnerArgs("claude", provider, "claude-sonnet-4-6", "/tmp/settings.json", { uid: 0 }), [
    "--model",
    "claude-sonnet-4-6",
    "--settings",
    "/tmp/settings.json"
  ]);
});

test("does not skip Claude permissions in ask mode", () => {
  const provider = {
    name: "api",
    baseUrl: "https://icode.51talk.biz/v1/",
    apiKey: "key",
    mode: "ask",
    level: 1,
    model: "claude-sonnet-4-6"
  };

  assert.deepEqual(buildRunnerArgs("claude", provider, "claude-sonnet-4-6", "/tmp/settings.json"), [
    "--model",
    "claude-sonnet-4-6",
    "--settings",
    "/tmp/settings.json"
  ]);
});

test("maps Codex auto mode to bypass approvals and sandbox", () => {
  const provider = {
    name: "api",
    baseUrl: "https://icode.51talk.biz/v1/",
    apiKey: "key",
    mode: "auto",
    level: 1,
    model: "gpt-5.5"
  };

  assert.deepEqual(buildRunnerArgs("codex", provider, "gpt-5.5", null), [
    "-c",
    'model_provider="ai_gateway_selected"',
    "-c",
    'model_providers.ai_gateway_selected.name="AI Gateway (api)"',
    "-c",
    'model_providers.ai_gateway_selected.base_url="https://icode.51talk.biz/v1"',
    "-c",
    'model_providers.ai_gateway_selected.env_key="OPENAI_API_KEY"',
    "-c",
    "model_providers.ai_gateway_selected.requires_openai_auth=true",
    "-c",
    'model_providers.ai_gateway_selected.wire_api="responses"',
    "--model",
    "gpt-5.5",
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
});

test("does not skip Codex approvals in ask mode", () => {
  const provider = {
    name: "api",
    baseUrl: "https://icode.51talk.biz/v1/",
    apiKey: "key",
    mode: "ask",
    level: 1,
    model: "gpt-5.5"
  };

  assert.deepEqual(buildRunnerArgs("codex", provider, "gpt-5.5", null), [
    "-c",
    'model_provider="ai_gateway_selected"',
    "-c",
    'model_providers.ai_gateway_selected.name="AI Gateway (api)"',
    "-c",
    'model_providers.ai_gateway_selected.base_url="https://icode.51talk.biz/v1"',
    "-c",
    'model_providers.ai_gateway_selected.env_key="OPENAI_API_KEY"',
    "-c",
    "model_providers.ai_gateway_selected.requires_openai_auth=true",
    "-c",
    'model_providers.ai_gateway_selected.wire_api="responses"',
    "--model",
    "gpt-5.5"
  ]);
});

test("writeTemporaryClaudeSettings injects bypass permissions in auto mode", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-claude-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    await fs.mkdir(path.join(tempHome, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      `${JSON.stringify({ env: { SOME_VAR: "keep-me" } }, null, 2)}\n`,
      { mode: 0o600 }
    );

    const provider = {
      name: "kunkun",
      baseUrl: "https://api.kunkunout.cn/",
      apiKey: "sk-test",
      mode: "auto",
      level: 1,
      model: "claude-opus-4-8"
    };

    const settingsPath = writeTemporaryClaudeSettings(provider);
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));

    assert.equal(written.env.ANTHROPIC_API_KEY, "sk-test");
    assert.equal(written.env.ANTHROPIC_BASE_URL, "https://api.kunkunout.cn");
    assert.equal(written.env.SOME_VAR, "keep-me");
    assert.equal(written.permissions.defaultMode, "bypassPermissions");
    assert.ok(written.permissions.allow.includes("Bash"));
    assert.ok(written.permissions.allow.includes("Edit"));
    assert.ok(written.permissions.allow.includes("Write"));
    assert.deepEqual(written.permissions.deny, []);

    await fs.unlink(settingsPath);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test("writeTemporaryClaudeSettings preserves user permissions in ask mode", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-claude-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    await fs.mkdir(path.join(tempHome, ".claude"), { recursive: true });
    const userPerms = { defaultMode: "default", allow: ["Read"], deny: ["Bash"] };
    await fs.writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      `${JSON.stringify({ env: {}, permissions: userPerms }, null, 2)}\n`,
      { mode: 0o600 }
    );

    const provider = {
      name: "kunkun",
      baseUrl: "https://api.kunkunout.cn/",
      apiKey: "sk-test",
      mode: "ask",
      level: 1,
      model: "claude-opus-4-8"
    };

    const settingsPath = writeTemporaryClaudeSettings(provider);
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));

    assert.deepEqual(written.permissions, userPerms);

    await fs.unlink(settingsPath);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test("writeTemporaryClaudeSettings removes inherited bypass permissions for privileged execution", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-claude-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    await fs.mkdir(path.join(tempHome, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      `${JSON.stringify({ permissions: { defaultMode: "bypassPermissions", allow: ["Bash", "Write"], deny: [] } }, null, 2)}\n`,
      { mode: 0o600 }
    );
    const provider = {
      name: "root-safe",
      baseUrl: "https://api.test",
      apiKey: "sk-test",
      mode: "ask",
      level: 1,
      model: "claude-opus-4-8"
    };

    const settingsPath = writeTemporaryClaudeSettings(provider, { permissionMode: "safeDefault" });
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    assert.deepEqual(written.permissions, { defaultMode: "default", allow: [], deny: [] });
    await fs.unlink(settingsPath);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test("writeTemporaryClaudeSettings enforces read-only permissions for auto providers", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-claude-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    await fs.mkdir(path.join(tempHome, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      `${JSON.stringify({ permissions: { defaultMode: "bypassPermissions", allow: ["Bash", "Write"] } }, null, 2)}\n`,
      { mode: 0o600 }
    );
    const provider = {
      name: "auto-provider",
      baseUrl: "https://example.test/",
      apiKey: "sk-test",
      mode: "auto",
      level: 1,
      model: "claude-opus-4-8"
    };

    const settingsPath = writeTemporaryClaudeSettings(provider, { permissionMode: "readOnly" });
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));

    assert.equal(written.permissions.defaultMode, "default");
    assert.ok(written.permissions.allow.includes("Read"));
    assert.ok(written.permissions.deny.includes("Bash"));
    assert.ok(written.permissions.deny.includes("Write"));
    assert.ok(!written.permissions.allow.includes("Bash"));

    await fs.unlink(settingsPath);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test("resolveToolCommand skips broken codex shim when app binary exists", () => {
  const brokenShim = "/opt/homebrew/bin/codex";
  const appBinary = "/Applications/Codex.app/Contents/Resources/codex";
  const command = resolveToolCommandWithOptions("codex", {
    pathResolver: () => brokenShim,
    candidates: [appBinary, brokenShim, "/usr/local/bin/codex"],
    runner: (candidate) => candidate === appBinary
  });

  assert.notEqual(command, "/opt/homebrew/bin/codex");
  assert.equal(command, appBinary);
});

test("CLI provider fallback tries next candidate after non-zero exit", async () => {
  await withTempHome(async () => {
    const attempts = [];
    const candidates = [
      {
        provider: { name: "bad", baseUrl: "https://bad.test/v1", apiKey: "bad", mode: "auto", level: 1, model: "gpt-5.5" },
        model: "gpt-5.5"
      },
      {
        provider: { name: "good", baseUrl: "https://good.test/v1", apiKey: "good", mode: "auto", level: 2, model: "gpt-5.5" },
        model: "gpt-5.5"
      }
    ];

    const code = await runResolvedProviderCandidates("codex", candidates, {
      runner: async (candidate, fallbackFrom) => {
        attempts.push({ provider: candidate.provider.name, fallbackFrom });
        return candidate.provider.name === "bad" ? 42 : 0;
      }
    });

    assert.equal(code, 0);
    assert.deepEqual(attempts, [
      { provider: "bad", fallbackFrom: null },
      { provider: "good", fallbackFrom: "bad" }
    ]);
  });
});

test("CLI provider fallback returns last non-zero exit when all candidates fail", async () => {
  await withTempHome(async () => {
    const candidates = [
      {
        provider: { name: "bad", baseUrl: "https://bad.test/v1", apiKey: "bad", mode: "auto", level: 1, model: "gpt-5.5" },
        model: "gpt-5.5"
      },
      {
        provider: { name: "worse", baseUrl: "https://worse.test/v1", apiKey: "worse", mode: "auto", level: 2, model: "gpt-5.5" },
        model: "gpt-5.5"
      }
    ];

    const code = await runResolvedProviderCandidates("codex", candidates, {
      runner: async (candidate) => candidate.provider.name === "bad" ? 42 : 43
    });

    assert.equal(code, 43);
  });
});

async function withTempHome(fn) {
  const previousHome = process.env.AI_GATEWAY_HOME;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-core-test-"));
  process.env.AI_GATEWAY_HOME = tempDir;
  try {
    await fn(tempDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.AI_GATEWAY_HOME;
    } else {
      process.env.AI_GATEWAY_HOME = previousHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function startTestServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
