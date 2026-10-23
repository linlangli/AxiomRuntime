import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { writeCache } from "../dist/core/config/cache-store.js";
import { saveServiceExposure, createServiceCredential, revokeServiceCredential } from "../dist/core/config/service-exposure.js";
import { startRuntimeServer } from "../dist/server/runtime-server.js";

async function fixture(run, { maxRequestBytes } = {}) {
  const previous = process.env.AI_GATEWAY_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-image-api-"));
  process.env.AI_GATEWAY_HOME = root;
  const requests = [];
  let status = 200;
  let disconnect = false;
  let payload = { created: 123, data: [{ b64_json: "a".repeat(9 * 1024 * 1024) }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (disconnect) { req.socket.destroy(); return; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  await writeProviders([
    { name: "image-only", baseUrl, apiKey: "upstream-secret", mode: "auto", level: 1, model: "gpt-image-1" },
    { name: "second", baseUrl, apiKey: "second-secret", mode: "auto", level: 2, model: "gpt-image-1" }
  ]);
  const refresh = () => writeCache({ providers: Object.fromEntries(["image-only", "second"].map(name => [name, { status: "ok", models: ["gpt-image-1"], lastCheckedAt: null, lastError: null }])) });
  await refresh();
  const save = capabilities => saveServiceExposure({ publicBaseUrl: "https://ai.example.test", upstreamUrl: "http://127.0.0.1:8080", capabilities });
  await save(["images", "image_edits", "models"]);
  const generation = await createServiceCredential("generation", ["images"]);
  const edit = await createServiceCredential("edit", ["image_edits"]);
  const modelOnly = await createServiceCredential("models", ["models"]);
  const server = await startRuntimeServer({ port: 0, useExposureConfig: true, maxRequestBytes, agentWorkspaceRoot: path.join(root, "workspaces") });
  const send = (body, token = generation.token, route = "generations", headers = { "content-type": "application/json" }) => fetch(`${server.baseUrl}/v1/images/${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body });
  try {
    await run({ root, requests, send, generation, edit, modelOnly, refresh, save, setStatus: value => { status = value; }, setPayload: value => { payload = value; }, disconnect: () => { disconnect = true; } });
  } finally {
    await server.close();
    await new Promise(resolve => upstream.close(resolve));
    if (previous === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

const generationBody = JSON.stringify({ model: "gpt-image-1", prompt: "a cat", n: 1, size: "1024x1024", response_format: "b64_json", quality: "high" });

test("image API routes image models, preserves large Base64 and URL responses, records usage once", () => fixture(async ({ root, send, requests, setPayload }) => {
  const response = await send(generationBody);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-agent-router-provider"), "image-only");
  assert.equal((await response.json()).data[0].b64_json.length, 9 * 1024 * 1024);
  assert.equal(requests[0].path, "/v1/images/generations");
  assert.equal(requests[0].headers.authorization, "Bearer upstream-secret");
  assert.equal(requests[0].body.toString(), generationBody);
  setPayload({ data: [{ url: "https://images.example.test/result.png" }] });
  const urlResponse = await send(generationBody);
  assert.equal((await urlResponse.json()).data[0].url, "https://images.example.test/result.png");
  const { events } = JSON.parse(await fs.readFile(path.join(root, "usage.json"), "utf8"));
  assert.equal(events.length, 1);
  assert.equal(events[0].tool, "image");
  assert.equal(events[0].totalTokens, 5);
}));

test("image edits preserve multipart files and boundaries and require their own capability", () => fixture(async ({ send, requests, edit, generation, setPayload }) => {
  setPayload({ data: [{ b64_json: "cG5n" }] });
  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("prompt", "blue background");
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  form.append("image[]", new Blob([bytes], { type: "image/png" }), "reference.png");
  form.append("mask", new Blob([bytes], { type: "image/png" }), "mask.png");
  const response = await send(form, edit.token, "edits", {});
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(requests[0].path, "/v1/images/edits");
  const uploaded = await new Response(requests[0].body, { headers: { "content-type": requests[0].headers["content-type"] } }).formData();
  assert.equal(uploaded.get("prompt"), "blue background");
  assert.deepEqual(new Uint8Array(await uploaded.get("image[]").arrayBuffer()), bytes);
  assert.equal((await send(form, generation.token, "edits", {})).status, 403);
  assert.equal((await send(generationBody, edit.token)).status, 403);
  assert.equal(requests.length, 1);
}));

test("image API enforces global scope, caller scope and immediate revocation before upstream dispatch", () => fixture(async ({ send, requests, generation, modelOnly, save }) => {
  assert.equal((await send(generationBody, "invalid")).status, 401);
  assert.equal((await send(generationBody, modelOnly.token)).status, 403);
  await save(["models"]);
  assert.equal((await send(generationBody)).status, 403);
  await save(["images"]);
  await revokeServiceCredential(generation.id);
  assert.equal((await send(generationBody)).status, 401);
  assert.equal(requests.length, 0);
}));

test("invalid image requests never reach a provider", () => fixture(async ({ send, requests, edit }) => {
  for (const value of [null, [], {}, { model: "gpt-image-1", prompt: "" }, { model: "gpt-image-1", prompt: "cat", n: 9 }, { model: "gpt-image-1", prompt: "cat", n: "2" }, { model: "gpt-image-1", prompt: "cat", size: "1x1" }, { model: "gpt-image-1", prompt: "cat", response_format: "file" }]) {
    assert.equal((await send(JSON.stringify(value))).status, 400);
  }
  assert.equal((await send("{bad json")).status, 400);
  assert.equal((await send(generationBody, undefined, "generations", { "content-type": "text/plain" })).status, 400);
  const form = new FormData();
  form.append("model", "gpt-image-1"); form.append("prompt", "cat");
  form.append("image", "/etc/passwd");
  assert.equal((await send(form, edit.token, "edits", {})).status, 400);
  form.delete("image");
  assert.equal((await send(form, edit.token, "edits", {})).status, 400);
  form.append("image", new Blob(["fake"], { type: "image/png" }), "a.png");
  form.append("model", "other");
  assert.equal((await send(form, edit.token, "edits", {})).status, 400);
  assert.equal(requests.length, 0);
}));

test("image API rejects oversized requests and unavailable models", () => fixture(async ({ send, requests }) => {
  assert.equal((await send(generationBody)).status, 413);
  assert.equal((await send('{"model":"unknown","prompt":"cat"}')).status, 503);
  assert.equal(requests.length, 0);
}, { maxRequestBytes: 100 }));

test("image failures never retry or fall back to a second provider", () => fixture(async ({ send, requests, setStatus, refresh, disconnect }) => {
  for (const status of [429, 503]) {
    await refresh(); setStatus(status);
    const response = await send(generationBody);
    assert.equal(response.status, status);
    await response.json();
  }
  await refresh(); disconnect();
  assert.equal((await send(generationBody)).status, 502);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.headers.authorization === "Bearer upstream-secret"));
}));
