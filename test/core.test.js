import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProviders, swapProviderLevel } from "../dist/core/config/providers-store.js";
import { extractTokenUsage } from "../dist/core/models/model-discovery.js";
import { isModelCompatible, pickCompatibleModel } from "../dist/core/models/model-filter.js";
import { getSecretFingerprint, getToolBaseUrl } from "../dist/core/runner/tool-runner.js";

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
  assert.equal(isModelCompatible("codex", "claude-opus-4-6"), false);
  assert.equal(pickCompatibleModel("codex", "claude-opus", ["claude-opus", "gpt-5"]), "gpt-5");
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
