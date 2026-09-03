import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { upsertProviderCache } from "../dist/core/config/cache-store.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { buildReviewAgentArgs, parseReviewAgentResponse } from "../dist/core/review/review-agent.js";
import { clearReviewConfig, normalizeReviewConfig, readReviewConfig, writeReviewConfig } from "../dist/core/review/review-config.js";
import { LocalReviewGit } from "../dist/core/review/review-git.js";
import { mergeReviewFindings, parseInitialReview, parseJudgeReview } from "../dist/core/review/review-parser.js";
import { inferReviewTarget, ReviewService } from "../dist/core/review/review-service.js";
import { configureReviewModels, getReviewModelOptions, parseReviewCommandArgs } from "../dist/cli/commands/review.js";

const REVIEW_CONFIG = {
  version: 1,
  firstEngine: "codex",
  codex: { provider: "primary", model: "gpt-5.6-sol" },
  claude: { provider: "primary", model: "claude-opus-4-6" }
};

test("review config is normalized and stored without credentials", async () => {
  await withTempHome(async (tempDir) => {
    assert.deepEqual(normalizeReviewConfig(REVIEW_CONFIG), REVIEW_CONFIG);
    await writeReviewConfig(REVIEW_CONFIG);
    assert.deepEqual(await readReviewConfig(), REVIEW_CONFIG);
    const stored = await fs.readFile(path.join(tempDir, "review.json"), "utf8");
    assert.doesNotMatch(stored, /apiKey/i);
    await clearReviewConfig();
    assert.equal(await readReviewConfig(), null);
  });
});

test("review config rejects missing engine models", () => {
  assert.throws(
    () => normalizeReviewConfig({ ...REVIEW_CONFIG, claude: { provider: "primary", model: "" } }),
    /claude\.model cannot be empty/
  );
});

test("review command parses explicit commits and natural commit ids", () => {
  assert.deepEqual(parseReviewCommandArgs(["--commit", "abc1234", "check", "security"]), {
    target: "abc1234",
    request: "check security"
  });
  assert.deepEqual(parseReviewCommandArgs(["check", "--commit=def5678"]), {
    target: "def5678",
    request: "check"
  });
  assert.equal(inferReviewTarget("审核一下commitid为uehudf2121的代码"), "uehudf2121");
  assert.equal(inferReviewTarget("review this change"), "HEAD");
});

test("review command redacts its request from usage logs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-review-log-test-"));
  const runtimeHome = path.join(tempDir, "runtime-home");
  const request = "confidential review instructions";
  const result = spawnSync(process.execPath, [
    path.resolve("dist/cli/index.js"),
    "review",
    "--commit",
    "abc1234",
    request
  ], {
    encoding: "utf8",
    env: { ...process.env, AI_GATEWAY_HOME: runtimeHome }
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, new RegExp(request));
  const logs = await fs.readFile(path.join(runtimeHome, ".ai-gateway.log"), "utf8");
  assert.doesNotMatch(logs, new RegExp(request));
  assert.match(logs, /\[review request 49 chars\]/);
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("review model choices are separated by engine compatibility", () => {
  const providers = [
    { name: "primary", baseUrl: "https://api.test", apiKey: "secret", mode: "auto", level: 1, model: "gpt-5.6-sol" },
    { name: "claude-only", baseUrl: "https://claude.test", apiKey: "secret", mode: "auto", level: 2, model: "claude-opus-4-6" }
  ];
  const cache = {
    providers: {
      primary: { status: "ok", models: ["gpt-5.6-sol", "claude-sonnet-4-6"], lastCheckedAt: "now", lastError: null },
      "claude-only": { status: "ok", models: ["claude-opus-4-6"], lastCheckedAt: "now", lastError: null }
    }
  };
  assert.deepEqual(getReviewModelOptions("codex", providers, cache).map((item) => item.provider.name), ["primary"]);
  assert.deepEqual(getReviewModelOptions("claude", providers, cache).map((item) => item.provider.name), ["primary", "claude-only"]);
});

test("review setup interactively stores both models and the first engine", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "primary", baseUrl: "https://api.test", apiKey: "secret", mode: "auto", level: 1, model: "gpt-5.6-sol" }
    ]);
    await upsertProviderCache("primary", {
      status: "ok",
      models: ["gpt-5.6-sol", "claude-opus-4-6"],
      lastCheckedAt: "now",
      lastError: null
    });
    const prompts = [];
    const config = await configureReviewModels(async (message, choices) => {
      prompts.push(message);
      if (message === "Select the first review engine") return "claude";
      if (message.startsWith("Select provider")) return "primary";
      return choices[0].value;
    });

    assert.equal(config.firstEngine, "claude");
    assert.equal(config.codex.model, "gpt-5.6-sol");
    assert.equal(config.claude.model, "claude-opus-4-6");
    assert.deepEqual(await readReviewConfig(), config);
    assert.deepEqual(prompts, [
      "Select the first review engine",
      "Select provider for codex",
      "Select model for codex / primary",
      "Select provider for claude",
      "Select model for claude / primary"
    ]);
  });
});

test("review agent builds sandboxed arguments and extracts responses", () => {
  const base = {
    engine: "codex",
    provider: "primary",
    model: "gpt-5.6-sol",
    cwd: "/repo",
    prompt: "review",
    mode: "readOnly",
    baseUrl: "http://127.0.0.1:1234/v1",
    settingsPath: null
  };
  const codexArgs = buildReviewAgentArgs(base);
  assert.ok(codexArgs.includes("read-only"));
  assert.ok(codexArgs.includes("never"));
  assert.ok(!codexArgs.includes("--dangerously-bypass-approvals-and-sandbox"));

  const claudeArgs = buildReviewAgentArgs({
    ...base,
    engine: "claude",
    model: "claude-opus-4-6",
    mode: "workspaceWrite",
    settingsPath: "/tmp/settings.json"
  });
  assert.ok(claudeArgs.includes("acceptEdits"));
  assert.ok(claudeArgs.includes("Read,Grep,Glob,Edit,Write"));
  assert.ok(!claudeArgs.includes("Bash"));

  assert.equal(parseReviewAgentResponse("claude", '{"type":"result","result":"claude result"}\n'), "claude result");
  assert.equal(
    parseReviewAgentResponse("codex", '{"type":"item.completed","item":{"type":"agent_message","text":"codex result"}}\n'),
    "codex result"
  );
});

test("review parser preserves model provenance and consensus", () => {
  const initial = parseInitialReview(`\`\`\`json
{"summary":"one issue","findings":[{"severity":"high","title":"Null crash","file":"src/a.ts","line":12,"evidence":"value can be null","recommendation":"guard null"}]}
\`\`\``);
  const adjudication = parseJudgeReview(JSON.stringify({
    summary: "confirmed",
    assessments: [{ index: 1, verdict: "agree", reason: "the call accepts null" }],
    findings: []
  }));
  const findings = mergeReviewFindings({
    round: 1,
    reviewer: { engine: "codex", provider: "primary", model: "gpt-5.6-sol", response: "" },
    judge: { engine: "claude", provider: "primary", model: "claude-opus-4-6", response: "" },
    initial,
    adjudication
  });
  assert.equal(findings[0].id, "R1-001");
  assert.equal(findings[0].consensus, true);
  assert.deepEqual(findings[0].sources.map((source) => source.engine), ["codex", "claude"]);
});

test("local review git enforces a clean tree and creates a traceable local commit", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-review-git-test-"));
  try {
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.name", "Review Test"]);
    runGit(repo, ["config", "user.email", "review@example.test"]);
    await fs.writeFile(path.join(repo, "value.txt"), "before\n", "utf8");
    runGit(repo, ["add", "value.txt"]);
    runGit(repo, ["commit", "-m", "initial"]);

    const git = new LocalReviewGit();
    assert.equal(await git.getRepositoryRoot(repo), await fs.realpath(repo));
    await git.assertClean(repo);
    const initial = await git.resolveCommit(repo, "HEAD");
    assert.match(await git.readCommit(repo, initial), /initial/);

    await fs.writeFile(path.join(repo, "value.txt"), "after\n", "utf8");
    await assert.rejects(git.assertClean(repo), /requires a clean working tree/);
    const commit = await git.commitAll(repo, "fix(review): test", "Review-Round: 1\nReview-Findings: R1-001");

    assert.notEqual(commit, initial);
    assert.equal((await git.readStatus(repo)).trim(), "");
    assert.match(runGit(repo, ["log", "-1", "--format=%B"]), /Review-Findings: R1-001/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("review service fixes selected consensus findings, commits, and swaps reviewers", async () => {
  await withTempHome(async () => {
    const git = new FakeGit();
    const calls = [];
    const responses = [
      JSON.stringify({
        summary: "found one",
        findings: [{
          severity: "high",
          title: "Null crash",
          file: "src/a.ts",
          line: 12,
          evidence: "value can be null",
          recommendation: "guard null"
        }]
      }),
      JSON.stringify({
        summary: "confirmed",
        assessments: [{ index: 1, verdict: "agree", reason: "confirmed by type flow" }],
        findings: []
      }),
      "fixed",
      JSON.stringify({ summary: "clean", findings: [] }),
      JSON.stringify({ summary: "clean", assessments: [], findings: [] })
    ];
    const agent = {
      async execute(request) {
        calls.push(request);
        if (calls.length === 3) git.status = " M src/a.ts\n";
        return { engine: request.engine, provider: request.provider, model: request.model, response: responses[calls.length - 1] };
      }
    };
    const rounds = [];
    const service = new ReviewService(agent, git);
    const result = await service.run({
      cwd: "/repo",
      request: "review HEAD",
      config: REVIEW_CONFIG
    }, {
      onRound: (round) => rounds.push(round),
      selectFindings: async (round) => ({
        action: "fix",
        findingIds: round.findings.filter((finding) => finding.consensus).map((finding) => finding.id)
      })
    });

    assert.equal(result.status, "clean");
    assert.deepEqual(result.commits, ["b".repeat(40)]);
    assert.deepEqual(calls.map((call) => `${call.engine}:${call.mode}`), [
      "codex:readOnly",
      "claude:readOnly",
      "codex:workspaceWrite",
      "claude:readOnly",
      "codex:readOnly"
    ]);
    assert.equal(rounds.length, 2);
    assert.match(git.commitBody, /Review-Findings: R1-001/);
    assert.match(git.commitBody, /Review-Fixer: codex/);
  });
});

class FakeGit {
  status = "";
  head = "a".repeat(40);
  commitBody = "";

  async getRepositoryRoot() { return "/repo"; }
  async assertClean() {
    if (this.status.trim()) throw new Error("dirty");
  }
  async resolveCommit(_cwd, target) { return target === "HEAD" ? this.head : target; }
  async readCommit(_cwd, commit) { return `commit ${commit}\ndiff --git a/src/a.ts b/src/a.ts`; }
  async readStatus() { return this.status; }
  async commitAll(_cwd, _subject, body) {
    this.commitBody = body;
    this.status = "";
    this.head = "b".repeat(40);
    return this.head;
  }
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function withTempHome(fn) {
  const previousHome = process.env.AI_GATEWAY_HOME;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-review-test-"));
  process.env.AI_GATEWAY_HOME = tempDir;
  try {
    await fn(tempDir);
  } finally {
    if (previousHome === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = previousHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
