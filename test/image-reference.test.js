import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveImageCommandInput } from "../dist/cli/commands/image.js";
import { generateImage } from "../dist/core/images/image-generation-service.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { upsertProviderCache, readCache } from "../dist/core/config/cache-store.js";
import { startOpenAiUsageProxy } from "../dist/core/runner/openai-usage-proxy.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const provider = { name: "images", baseUrl: "https://images.test/v1", apiKey: "secret", mode: "auto", level: 1, model: "gpt-image-2" };
const cache = { images: { status: "ok", models: [provider.model], lastCheckedAt: "now", lastError: null } };
const noPrompt = async () => { throw new Error("Unexpected interactive prompt"); };

test("image reference flags work before/after positionals and preserve quoted paths", async () => {
  for (const args of [
    ["--image", "C:\\My Pictures\\cat.png", "images", provider.model, "watercolor"],
    ["images", provider.model, "watercolor", "--image=C:\\My Pictures\\cat.png"]
  ]) {
    assert.deepEqual(await resolveImageCommandInput(args, [provider], cache, noPrompt, noPrompt), {
      provider: "images", model: provider.model, prompt: "watercolor", imagePath: "C:\\My Pictures\\cat.png"
    });
  }
  const input = await resolveImageCommandInput([provider.model, "watercolor", "--image", "cat.png"], [provider], cache, noPrompt, noPrompt);
  assert.deepEqual(input, { target: provider.model, prompt: "watercolor", imagePath: "cat.png" });
});

test("image reference options reject missing paths, excessive references and unknown flags", async () => {
  for (const args of [["--image"], ["--image="], ["--image", "--other"], ["--unknown"]]) {
    await assert.rejects(resolveImageCommandInput(args, [provider], cache, noPrompt, noPrompt), /requires|At most 8|Unknown/);
  }
});

test("interactive reference workflow selects mode, local path and prompt", async () => {
  const selections = [];
  const texts = [];
  const input = await resolveImageCommandInput([], [provider], cache, async (message) => {
    selections.push(message);
    return ["images", provider.model, "edit"][selections.length - 1];
  }, async (message) => {
    texts.push(message);
    return ['"./my cat.png"', "", "watercolor"][texts.length - 1];
  });
  assert.deepEqual(input, { provider: "images", model: provider.model, prompt: "watercolor", imagePath: "./my cat.png" });
  assert.equal(selections.at(-1), "Select image mode");
  assert.match(texts[0], /Local reference image path/);
  assert.match(texts[1], /Next reference/);
  assert.equal(texts[2], "Image prompt");
});

test("explicit --image prompts only for missing prompt; empty interactive path is rejected", async () => {
  const input = await resolveImageCommandInput(["images", "--image", "cat.png"], [provider], cache, noPrompt, async () => "watercolor");
  assert.equal(input.imagePath, "cat.png");
  await assert.rejects(resolveImageCommandInput(["images"], [provider], cache, async () => "edit", async () => ""), /path is required/);
});

async function withHome(action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-reference-test-"));
  const previous = process.env.AI_GATEWAY_HOME;
  process.env.AI_GATEWAY_HOME = directory;
  try { await action(directory); }
  finally {
    if (previous === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("local reference validation rejects missing, empty, invalid, GIF, directory and oversized files before provider calls", async () => {
  await withHome(async (directory) => {
    await writeProviders([provider]);
    await upsertProviderCache(provider.name, cache.images);
    const originalCache = await readCache();
    for (const [name, bytes] of [["empty.png", Buffer.alloc(0)], ["fake.png", Buffer.from("not an image")], ["animated.gif", Buffer.from("GIF89a")]]) {
      const imagePath = path.join(directory, name);
      await fs.writeFile(imagePath, bytes);
      await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePath }), /Reference image must be/);
    }
    const oversized = path.join(directory, "large.png");
    const file = await fs.open(oversized, "w");
    await file.truncate(20 * 1024 * 1024 + 1);
    await file.close();
    await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePath: oversized }), /exceeds 20 MiB/);
    await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePath: path.join(directory, "missing.png") }), /ENOENT/);
    await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePath: directory }), /regular local file|EISDIR|EPERM/);
    assert.deepEqual(await readCache(), originalCache);
  });
});

test("multipart reference bytes pass through existing proxy; usage is recorded and source is unchanged", async () => {
  await withHome(async (directory) => {
    const source = path.join(directory, "private name.not-png");
    await fs.writeFile(source, png);
    let calls = 0;
    const upstream = http.createServer(async (req, res) => {
      calls += 1;
      assert.equal(req.url, "/v1/images/edits");
      assert.equal(req.headers.authorization, "Bearer secret");
      assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=/);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request("http://test/images/edits", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: Buffer.concat(chunks) });
      const form = await request.formData();
      assert.equal(form.get("model"), provider.model);
      assert.equal(form.get("prompt"), "private watercolor prompt");
      assert.equal(form.get("n"), "1");
      assert.equal(form.get("image").type, "image/png");
      assert.equal(form.get("image").name, "reference.png");
      assert.deepEqual(Buffer.from(await form.get("image").arrayBuffer()), png);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    await writeProviders([{ ...provider, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }]);
    await upsertProviderCache(provider.name, cache.images);
    try {
      const result = await generateImage({ provider: provider.name, prompt: "private watercolor prompt", imagePath: source, outputDir: directory });
      assert.equal(calls, 1);
      assert.notEqual(result.filePath, source);
      assert.deepEqual(await fs.readFile(result.filePath), png);
      assert.deepEqual(await fs.readFile(source), png);
      const usage = JSON.parse(await fs.readFile(path.join(directory, "usage.json"), "utf8"));
      assert.equal(usage.events.length, 1);
      assert.equal(usage.events[0].totalTokens, 10);
      assert.equal(usage.events[0].provider, provider.name);
      assert.equal(usage.events[0].model, provider.model);
      const log = await fs.readFile(path.join(directory, ".ai-gateway.log"), "utf8");
      assert.doesNotMatch(log, /private watercolor prompt|private name|iVBORw0KGgo/);
    } finally { await new Promise((resolve) => upstream.close(resolve)); }
  });
});

test("unsupported edit and transient errors do not upload to fallback or retry", async () => {
  await withHome(async (directory) => {
    const imagePath = path.join(directory, "cat.png");
    await fs.writeFile(imagePath, png);
    let calls = 0;
    const upstream = http.createServer((req, res) => {
      calls += 1;
      req.resume();
      res.writeHead(calls === 1 ? 404 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "edit unavailable" } }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
      await writeProviders([{ ...provider, baseUrl }, { ...provider, name: "backup", baseUrl, level: 2 }]);
      for (const name of [provider.name, "backup"]) await upsertProviderCache(name, cache.images);
      await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePaths: [imagePath, imagePath] }), /does not support.*image edit/);
      assert.equal(calls, 1);
      await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePath }), /edit unavailable/);
      assert.equal(calls, 2);
    } finally { await new Promise((resolve) => upstream.close(resolve)); }
  });
});

test("an unavailable explicit provider never silently uploads a reference to another provider", async () => {
  await withHome(async (directory) => {
    const imagePath = path.join(directory, "cat.png");
    await fs.writeFile(imagePath, png);
    await writeProviders([provider, { ...provider, name: "backup", level: 2 }]);
    await upsertProviderCache(provider.name, { ...cache.images, status: "error", lastError: "unavailable" });
    await upsertProviderCache("backup", cache.images);
    await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePath }), /No usable provider/);
    await assert.rejects(generateImage({ target: provider.name, prompt: "edit", imagePath }), /No usable provider/);
  });
});

test("JPEG and WebP references are identified by content and uploaded with correct MIME types", async () => {
  await withHome(async (directory) => {
    const formats = [
      { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), type: "image/jpeg", name: "reference.jpg" },
      { bytes: Buffer.from("RIFF0000WEBP", "ascii"), type: "image/webp", name: "reference.webp" }
    ];
    let calls = 0;
    const upstream = http.createServer(async (req, res) => {
      const expected = formats[calls++];
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = await new Request("http://test", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: Buffer.concat(chunks) }).formData();
      assert.equal(form.get("image").type, expected.type);
      assert.equal(form.get("image").name, expected.name);
      assert.deepEqual(Buffer.from(await form.get("image").arrayBuffer()), expected.bytes);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ url: "https://images.test/result.png" }] }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      await writeProviders([{ ...provider, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }]);
      await upsertProviderCache(provider.name, cache.images);
      for (const format of formats) {
        const imagePath = path.join(directory, "reference.wrong-extension");
        await fs.writeFile(imagePath, format.bytes);
        const result = await generateImage({ provider: provider.name, prompt: "edit", imagePath });
        assert.equal(result.url, "https://images.test/result.png");
      }
      assert.equal(calls, 2);
    } finally { await new Promise((resolve) => upstream.close(resolve)); }
  });
});

test("transport never retries or changes routes for multipart uploads even with fallback configured", async () => {
  await withHome(async () => {
    let calls = 0;
    const upstream = http.createServer((req, res) => {
      calls += 1;
      req.resume();
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const selected = { ...provider, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` };
    const proxy = await startOpenAiUsageProxy({ provider: selected, model: provider.model, tool: "image", engine: "codex", globalProxyUrl: null, fallbackRoutes: [{ provider: { ...selected, name: "backup" }, model: "different-image-model" }] });
    try {
      const form = new FormData();
      form.set("model", provider.model);
      form.set("image", new Blob([png], { type: "image/png" }), "reference.png");
      const response = await fetch(`${proxy.baseUrl}/images/edits`, { method: "POST", body: form });
      assert.equal(response.status, 503);
      await response.text();
      assert.equal(calls, 1);
    } finally {
      await proxy.close();
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});

test("CLI redacts reference paths even when --image is the first or only argument", async () => {
  await withHome(async (directory) => {
    for (const args of [["--image=private-reference.png", "--image=private-second.png"], ["--image", "private-reference.png", "images", "confidential prompt"]]) {
      const result = spawnSync(process.execPath, [path.resolve("dist/cli/index.js"), "image", ...args], { encoding: "utf8", env: { ...process.env, AI_GATEWAY_HOME: directory } });
      assert.equal(result.status, 1);
    }
    const log = await fs.readFile(path.join(directory, ".ai-gateway.log"), "utf8");
    assert.doesNotMatch(log, /private-reference|confidential prompt/);
    assert.match(log, /image arguments redacted/);
  });
});


test("multiple reference flags preserve order and enforce the count limit", async () => {
  const input = await resolveImageCommandInput(["--image", "first.png", "images", "combine", "--image=second.jpg"], [provider], cache, noPrompt, noPrompt);
  assert.deepEqual(input, { provider: "images", model: provider.model, prompt: "combine", imagePaths: ["first.png", "second.jpg"] });
  await assert.rejects(resolveImageCommandInput(Array(9).fill("--image=a.png"), [provider], cache, noPrompt, noPrompt), /At most 8/);
});

test("interactive references collect multiple paths until a blank entry", async () => {
  const answers = ["first.png", '"second picture.jpg"', "", "combine"];
  const input = await resolveImageCommandInput(["images"], [provider], cache, async () => "edit", async () => answers.shift());
  assert.deepEqual(input.imagePaths, ["first.png", "second picture.jpg"]);
  assert.equal(input.prompt, "combine");
});

test("multiple references upload ordered image[] parts with generic names through the proxy", async () => {
  await withHome(async (directory) => {
    const sources = [path.join(directory, "private first.png"), path.join(directory, "private second.jpg")];
    const bytes = [png, Buffer.from([0xff, 0xd8, 0xff, 0xe0])];
    await Promise.all(sources.map((p, i) => fs.writeFile(p, bytes[i])));
    let calls = 0;
    const upstream = http.createServer(async (req, res) => {
      calls++;
      assert.equal(req.url, "/v1/images/edits");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = await new Request("http://test", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: Buffer.concat(chunks) }).formData();
      assert.equal(form.get("image"), null);
      const images = form.getAll("image[]");
      assert.equal(images.length, 2);
      assert.deepEqual(images.map(i => [i.name, i.type]), [["reference-1.png", "image/png"], ["reference-2.jpg", "image/jpeg"]]);
      for (let i = 0; i < images.length; i++) assert.deepEqual(Buffer.from(await images[i].arrayBuffer()), bytes[i]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ url: "https://images.test/result.png" }] }));
    });
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    try {
      await writeProviders([{ ...provider, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }]);
      await upsertProviderCache(provider.name, cache.images);
      const result = await generateImage({ provider: provider.name, prompt: "private multi prompt", imagePaths: sources });
      assert.equal(result.url, "https://images.test/result.png");
      assert.equal(calls, 1);
      for (let i = 0; i < sources.length; i++) assert.deepEqual(await fs.readFile(sources[i]), bytes[i]);
      const log = await fs.readFile(path.join(directory, ".ai-gateway.log"), "utf8");
      assert.doesNotMatch(log, /private first|private second|private multi prompt/);
    } finally { await new Promise(resolve => upstream.close(resolve)); }
  });
});

test("all references are validated before any provider request, with aggregate and count limits", async () => {
  await withHome(async (directory) => {
    const source = path.join(directory, "large.png");
    const file = await fs.open(source, "w");
    await file.write(png);
    await file.truncate(15 * 1024 * 1024);
    await file.close();
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { calls++; throw new Error("Unexpected upload"); };
    try {
      await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePaths: [source, source, source] }), /40 MiB in total/);
      await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePaths: Array(9).fill(source) }), /At most 8/);
      await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePaths: [source, path.join(directory, "missing.png")] }), /ENOENT/);
      await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePath: source, imagePaths: [source] }), /not both/);
      await assert.rejects(generateImage({ provider: provider.name, prompt: "edit", imagePaths: [] }), /At least one/);
      assert.equal(calls, 0);
    } finally { globalThis.fetch = originalFetch; }
  });
});
