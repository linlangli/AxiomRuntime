import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { planImageGeneration, ImagePlanClarificationError } from "../dist/core/images/image-generation-plan.js";
import { generateImages } from "../dist/core/images/image-generation-service.js";
import { resolveImageCommandInput } from "../dist/cli/commands/image.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { upsertProviderCache } from "../dist/core/config/cache-store.js";
import { setRuntimeFailover } from "../dist/core/config/runtime-config.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const provider = { name: "images", baseUrl: "https://images.test/v1", apiKey: "secret", mode: "auto", level: 1, model: "gpt-image-2" };
const cache = { images: { status: "ok", models: [provider.model], lastCheckedAt: "now", lastError: null } };
const noPrompt = async () => { throw new Error("Unexpected interactive prompt"); };
const brief = "生成3张咖啡店宣传图：一张1024×1024方图、一张1536x1024横图、一张1024x1536竖图，保持统一风格";

test("image recovery defaults to cwd even with assets/results and honors an explicit output directory", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-image-output-")));
  try {
    const results = path.join(root, "assets", "results");
    await fs.mkdir(results, { recursive: true });
    await fs.writeFile(path.join(root, "response.json"), JSON.stringify({
      version: 1, status: "completed", createdAt: new Date().toISOString(), provider: provider.name, model: provider.model,
      responseStatus: 200, responseContentType: "application/json", responseText: JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })
    }));
    const moduleUrl = new URL("../dist/core/images/image-generation-service.js", import.meta.url).href;
    const script = `
      globalThis.fetch = () => { throw new Error("Unexpected network request"); };
      const { recoverGeneratedImages } = await import(${JSON.stringify(moduleUrl)});
      const defaultImages = await recoverGeneratedImages("response.json");
      const explicitImages = await recoverGeneratedImages("response.json", "assets/results/selected-task");
      console.log(JSON.stringify({ defaultImages, explicitImages }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const { defaultImages, explicitImages } = JSON.parse(child.stdout);
    assert.equal(path.dirname(defaultImages[0].filePath), root);
    assert.equal(path.dirname(explicitImages[0].filePath), path.join(results, "selected-task"));
    assert.deepEqual(await fs.readFile(defaultImages[0].filePath), png);
    assert.deepEqual(await fs.readFile(explicitImages[0].filePath), png);
    assert.deepEqual(await fs.readdir(results), ["selected-task"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("image planning recognizes explicit Chinese and English counts and ordered mixed sizes", () => {
  const plan = planImageGeneration({ prompt: brief });
  assert.deepEqual(plan.map((task) => task.size), ["1024x1024", "1536x1024", "1024x1536"]);
  assert.match(plan[1].prompt, /exactly ONE standalone image for item 2 of 3/);
  assert.match(plan[1].prompt, /This item's requirement: 一张1536x1024横图/);
  assert.match(plan[2].prompt, /保持统一风格/);
  for (const prompt of ["生成三张猫的图片", "Generate three images of a cat", "Create 3 images at 1024x1024"]) {
    assert.equal(planImageGeneration({ prompt }).length, 3);
  }
  assert.equal(planImageGeneration({ prompt: "生成一套海报：2张1024x1024方图、1张1536x1024横图" }).length, 3);
  assert.equal(planImageGeneration({ prompt: "一只猫，1024x1024", count: 3 }).length, 3);
});

test("scene counts and quoted text do not become output counts; ambiguous plans fail before generation", () => {
  for (const prompt of ["三个小孩站在树下", "参考这几张图片的风格，生成森林壁纸", "生成一张包含3张照片的海报", '海报上写着“生成3张1024x1024图片”']) {
    assert.equal(planImageGeneration({ prompt }).length, 1);
  }
  for (const prompt of ["生成多张宣传图", "生成一套海报", "生成3张不同尺寸的海报", "生成3张图片：一张1024x1024，一张1536x1024"]) {
    assert.throws(() => planImageGeneration({ prompt }), ImagePlanClarificationError);
  }
  for (const input of [
    { prompt: "生成9张图片" }, { prompt: "生成一百张图片" }, { prompt: "生成2张100000x100000图片" }, { prompt: "cat", count: 0 }, { prompt: "cat", count: 2.5 },
    { prompt: "cat", size: "1024:1024" }, { prompt: "cat", size: "99999x99999" },
    { prompt: "生成2张图片", count: 3 }, { prompt: brief, size: "1024x1024" }
  ]) assert.throws(() => planImageGeneration(input));
});

test("interactive Image prompt and flags use the same planner and clarify ambiguous briefs", async () => {
  const answers = ["生成多张宣传图", brief];
  const questions = [];
  const input = await resolveImageCommandInput([], [provider], cache,
    async (message) => message === "Select image provider" ? provider.name : message.startsWith("Select image model") ? provider.model : "generate",
    async (message) => { questions.push(message); return answers.shift(); });
  assert.equal(input.prompt, brief);
  assert.equal(questions.length, 2);
  assert.match(questions[1], /How many images/);
  const flags = await resolveImageCommandInput(["--count=3", "images", "cat", "--size", "1024×1024"], [provider], cache, noPrompt, noPrompt);
  assert.deepEqual(flags, { provider: "images", model: provider.model, prompt: "cat", count: 3, size: "1024x1024" });
  for (const args of [["--count"], ["--count=9"], ["--count=1", "--count=2"], ["--size"], ["--size=bad"]]) {
    await assert.rejects(resolveImageCommandInput(args, [provider], cache, noPrompt, noPrompt));
  }
  await assert.rejects(resolveImageCommandInput(["images", "生成多张图片"], [provider], cache, noPrompt, noPrompt), ImagePlanClarificationError);
});

const wallpaperBrief = "参考这几张图片的风格，帮我生出类似的4k高清图用作壁纸，2张图片，分别对应2种尺寸，适配手机屏幕的和适配pc屏幕的";

test("wallpaper brief recognizes its mid-sentence count and asks for dimensions rather than count", () => {
  assert.throws(() => planImageGeneration({ prompt: wallpaperBrief }), (error) => {
    assert.equal(error.field, "sizes");
    assert.equal(error.count, 2);
    return true;
  });
  const tasks = planImageGeneration({ prompt: `${wallpaperBrief}\nOutput sizes: 2160x3840,3840x2160` });
  assert.deepEqual(tasks.map((task) => task.size), ["2160x3840", "3840x2160"]);
  assert.ok(tasks.every((task) => task.prompt.includes("参考这几张图片的风格")));
  assert.throws(() => planImageGeneration({ prompt: "2" }), ImagePlanClarificationError);
});

test("wallpaper clarification preserves the original brief and references when the answer is only a number", async () => {
  const answers = ["p1.jpeg", "p2.jpeg", "p3.jpeg", "", wallpaperBrief, "2", "2160x3840,3840x2160"];
  const questions = [];
  const input = await resolveImageCommandInput([], [provider], cache,
    async (message) => message === "Select image provider" ? provider.name : message.startsWith("Select image model") ? provider.model : "edit",
    async (message) => { questions.push(message); assert.ok(answers.length); return answers.shift(); });
  assert.ok(input.prompt.startsWith(wallpaperBrief));
  assert.deepEqual(input.imagePaths, ["p1.jpeg", "p2.jpeg", "p3.jpeg"]);
  assert.deepEqual(planImageGeneration(input).map((task) => task.size), ["2160x3840", "3840x2160"]);
  assert.ok(questions.slice(5).every((message) => message.includes("Identified 2 image(s)")));
});

test("a count-only clarification supplements rather than replaces the creative brief", async () => {
  const answers = ["参考图片风格生成多张森林壁纸", "2"];
  const input = await resolveImageCommandInput([], [provider], cache,
    async (message) => message === "Select image provider" ? provider.name : message.startsWith("Select image model") ? provider.model : "generate",
    async () => { assert.ok(answers.length); return answers.shift(); });
  assert.equal(input.prompt, "参考图片风格生成多张森林壁纸");
  assert.equal(input.count, 2);
  assert.equal(planImageGeneration(input).length, 2);
});

async function fixture(action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-image-batch-"));
  const previous = process.env.AI_GATEWAY_HOME;
  process.env.AI_GATEWAY_HOME = directory;
  const servers = [];
  async function server(handler) {
    const instance = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await handler(req, res, Buffer.concat(chunks));
    });
    await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
    servers.push(instance);
    return `http://127.0.0.1:${instance.address().port}/v1`;
  }
  try { await action({ directory, server }); }
  finally {
    for (const instance of servers) { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); }
    if (previous === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("batch sends ordered per-image sizes, retains partial successes, saves every returned image and records usage once per request", async () => {
  await fixture(async ({ directory, server }) => {
    const requests = [];
    const baseUrl = await server(async (_req, res, body) => {
      const request = JSON.parse(body);
      requests.push(request);
      res.setHeader("content-type", "application/json");
      if (requests.length === 2) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: "Unsupported size" } })); return; }
      const data = requests.length === 1 ? [{ b64_json: png.toString("base64") }, { url: "https://images.test/extra.png" }] : [{ b64_json: png.toString("base64") }];
      res.end(JSON.stringify({ data, usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }));
    });
    await writeProviders([{ ...provider, baseUrl }]);
    const result = await generateImages({ provider: provider.name, prompt: brief, outputDir: directory });
    assert.deepEqual(requests.map((request) => request.size), ["1024x1024", "1536x1024", "1024x1536"]);
    assert.ok(requests.every((request) => request.n === 1));
    assert.equal(result.images.length, 3);
    assert.equal(result.success, false);
    assert.match(result.tasks[1].error, /Unsupported size/);
    assert.match(result.tasks[0].images[0].warning, /received 1x1/);
    assert.equal(result.images[0].actualSize, "1x1");
    assert.equal(result.images[1].url, "https://images.test/extra.png");
    for (const image of result.images.filter((image) => image.filePath)) {
      assert.deepEqual(await fs.readFile(image.filePath), png);
      assert.equal((await fs.stat(image.filePath)).mode & 0o777, 0o600);
    }
    const usage = JSON.parse(await fs.readFile(path.join(directory, "usage.json"), "utf8"));
    assert.equal(usage.events.length, 2);
    assert.equal(usage.events.reduce((sum, event) => sum + event.totalTokens, 0), 10);
    const log = await fs.readFile(path.join(directory, ".ai-gateway.log"), "utf8");
    assert.doesNotMatch(log, /咖啡店|统一风格/);
  });
});

test("reference batch preserves order and size fields without retry or cross-provider uploads", async () => {
  await fixture(async ({ directory, server }) => {
    let calls = 0;
    let backups = 0;
    const baseUrl = await server(async (req, res, body) => {
      calls++;
      const form = await new Request("http://test", { method: "POST", body, headers: { "content-type": req.headers["content-type"] } }).formData();
      assert.equal(req.url, "/v1/images/edits");
      assert.equal(form.get("size"), "1024x1024");
      assert.deepEqual(await Promise.all(form.getAll("image[]").map(async (file) => Buffer.from(await file.arrayBuffer()))), [png, png]);
      res.statusCode = calls === 1 ? 503 : 200;
      res.end(JSON.stringify(calls === 1 ? { error: "busy" } : { data: [{ url: "https://images.test/result.png" }] }));
    });
    const backupUrl = await server(async (_req, res) => { backups++; res.end("{}"); });
    await writeProviders([{ ...provider, baseUrl }, { ...provider, name: "backup", baseUrl: backupUrl, level: 2 }]);
    const reference = path.join(directory, "private-reference.png");
    await fs.writeFile(reference, png);
    const result = await generateImages({ provider: provider.name, prompt: "cat", count: 2, size: "1024x1024", imagePaths: [reference, reference], outputDir: directory });
    assert.equal(calls, 2);
    assert.equal(backups, 0);
    assert.equal(result.images.length, 1);
    assert.match(result.tasks[0].error, /busy/);
    assert.match(result.images[0].warning, /unverified/);
    assert.deepEqual(await fs.readFile(reference), png);
  });
});

test("known size constraints are checked before calls, and failover off keeps all tasks on the chosen provider", async () => {
  await fixture(async ({ server }) => {
    let calls = 0;
    let backups = 0;
    const baseUrl = await server(async (_req, res) => { calls++; res.statusCode = 503; res.end('{"error":"busy"}'); });
    const backup = await server(async (_req, res) => { backups++; res.end('{"data":[{"url":"https://images.test/result.png"}]}'); });
    await writeProviders([{ ...provider, baseUrl, model: "dall-e-3" }]);
    await assert.rejects(generateImages({ provider: provider.name, prompt: "cat", size: "1536x1024" }), /does not support size/);
    assert.equal(calls, 0);
    await writeProviders([{ ...provider, baseUrl }, { ...provider, name: "backup", baseUrl: backup, level: 2 }]);
    await setRuntimeFailover(true);
    const result = await generateImages({ provider: provider.name, prompt: "cat", count: 3 });
    assert.equal(calls, 3);
    assert.equal(backups, 0);
    assert.equal(result.images.length, 0);
    assert.ok(result.tasks.every((task) => task.error));
  });
});

test("text batch failures never retry or fall back and still process distinct tasks", async () => {
  await fixture(async ({ directory, server }) => {
    let primaryCalls = 0;
    let backupCalls = 0;
    const baseUrl = await server(async (_req, res) => { primaryCalls++; res.statusCode = 503; res.end('{"error":"busy"}'); });
    const backupUrl = await server(async (_req, res) => {
      backupCalls++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ url: `https://images.test/${backupCalls}.png` }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
    });
    await writeProviders([{ ...provider, baseUrl }, { ...provider, name: "backup", baseUrl: backupUrl, level: 2 }]);
    const result = await generateImages({ provider: provider.name, prompt: "Generate two images of a cat" });
    assert.equal(result.success, false);
    assert.equal(primaryCalls, 2);
    assert.equal(backupCalls, 0);
    assert.equal(result.images.length, 0);
    assert.ok(result.tasks.every((task) => task.error));
  });
});

test("extra provider outputs cannot expand an execution beyond eight images", async () => {
  await fixture(async ({ server }) => {
    let calls = 0;
    const baseUrl = await server(async (_req, res) => {
      calls++;
      res.end(JSON.stringify({ data: Array.from({ length: 8 }, (_, i) => ({ url: `https://images.test/${i}.png` })) }));
    });
    await writeProviders([{ ...provider, baseUrl }]);
    const result = await generateImages({ provider: provider.name, prompt: "cat", count: 3 });
    assert.equal(calls, 1);
    assert.equal(result.images.length, 8);
    assert.equal(result.success, false);
    assert.ok(result.tasks.slice(1).every((task) => /Output limit/.test(task.error)));
  });
});

test("a disk failure on a later response item retains earlier saved output paths", async () => {
  await fixture(async ({ directory, server }) => {
    const baseUrl = await server(async (_req, res) => {
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] }));
    });
    await writeProviders([{ ...provider, baseUrl }]);
    const rename = fs.rename;
    let saves = 0;
    fs.rename = async (source, destination) => {
      if (path.basename(source).startsWith(".axiom-image-") && ++saves === 2) throw new Error("simulated disk failure");
      return rename(source, destination);
    };
    try {
      const result = await generateImages({ provider: provider.name, prompt: "cat", outputDir: directory });
      assert.equal(result.success, false);
      assert.equal(result.images.length, 1);
      assert.match(result.tasks[0].error, /simulated disk failure/);
      assert.deepEqual(await fs.readFile(result.images[0].filePath), png);
      assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")).length, 0);
    } finally { fs.rename = rename; }
  });
});

test("image argument logging redacts prompts even when options precede the provider", async () => {
  await fixture(async ({ directory }) => {
    const result = spawnSync(process.execPath, ["dist/cli/index.js", "image", "--count", "2", "--size", "1024x1024", "images", "confidential-batch-prompt"], {
      encoding: "utf8", env: { ...process.env, AI_GATEWAY_HOME: directory }
    });
    assert.equal(result.status, 1);
    const log = await fs.readFile(path.join(directory, ".ai-gateway.log"), "utf8");
    assert.doesNotMatch(log, /confidential-batch-prompt/);
  });
});
