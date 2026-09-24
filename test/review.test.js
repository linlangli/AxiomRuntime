import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { upsertProviderCache } from "../dist/core/config/cache-store.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { buildReviewAgentArgs, formatReviewAgentFailure, parseReviewAgentResponse } from "../dist/core/review/review-agent.js";
import { clearReviewConfig, normalizeReviewConfig, readReviewConfig, writeReviewConfig } from "../dist/core/review/review-config.js";
import { LocalReviewGit } from "../dist/core/review/review-git.js";
import { createReviewHandoff, mergeReviewFindings, parseInitialReview, parseJudgeReview } from "../dist/core/review/review-parser.js";
import { buildFixPrompt, buildInitialReviewPrompt, buildJudgePrompt } from "../dist/core/review/review-prompts.js";
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
    /claude\.model 不能为空/
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
      "claude-only": { status: "ok", models: ["claude-opus-4-6"], lastCheckedAt: "now", lastError: null },
      "image-only": { status: "ok", models: ["gpt-image-2"], lastCheckedAt: "now", lastError: null }
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
      if (message === "选择首审引擎") return "claude";
      if (message.includes("Provider")) return "primary";
      return choices[0].value;
    });

    assert.equal(config.firstEngine, "claude");
    assert.equal(config.codex.model, "gpt-5.6-sol");
    assert.equal(config.claude.model, "claude-opus-4-6");
    assert.deepEqual(await readReviewConfig(), config);
    assert.deepEqual(prompts, [
      "选择首审引擎",
      "选择 Claude Code 的 Provider",
      "选择 Claude Code / primary 的模型",
      "选择 Codex 的 Provider",
      "选择 Codex / primary 的模型"
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

  const scopedReadOnlyClaudeArgs = buildReviewAgentArgs({
    ...base,
    engine: "claude",
    model: "claude-opus-4-6",
    settingsPath: "/tmp/settings.json",
    scopeFiles: ["src/a.ts"]
  });
  assert.ok(scopedReadOnlyClaudeArgs.includes("Read(./AGENTS.md),Read(./CLAUDE.md),Read(./src/a.ts)"));
  assert.ok(scopedReadOnlyClaudeArgs.includes("Read"));
  assert.ok(!scopedReadOnlyClaudeArgs.includes("Read,Grep,Glob"));
  assert.ok(!scopedReadOnlyClaudeArgs.includes("Edit(./src/a.ts)"));

  const claudeArgs = buildReviewAgentArgs({
    ...base,
    engine: "claude",
    model: "claude-opus-4-6",
    mode: "workspaceWrite",
    settingsPath: "/tmp/settings.json",
    scopeFiles: ["src/a.ts"]
  });
  assert.ok(claudeArgs.includes("acceptEdits"));
  assert.ok(claudeArgs.includes("Read,Edit,Write"));
  assert.ok(claudeArgs.includes("Read(./AGENTS.md),Read(./CLAUDE.md),Read(./src/a.ts),Edit(./src/a.ts),Write(./src/a.ts)"));
  assert.ok(claudeArgs.includes("--bare"));
  assert.ok(claudeArgs.includes("--no-session-persistence"));
  assert.ok(claudeArgs.includes("--disable-slash-commands"));
  assert.ok(!claudeArgs.includes("Bash"));

  const unscopedClaudeArgs = buildReviewAgentArgs({
    ...base,
    engine: "claude",
    model: "claude-opus-4-6",
    mode: "workspaceWrite",
    settingsPath: "/tmp/settings.json"
  });
  assert.ok(unscopedClaudeArgs.includes("Read"));
  assert.ok(unscopedClaudeArgs.includes("Read(./AGENTS.md),Read(./CLAUDE.md)"));
  assert.ok(!unscopedClaudeArgs.includes("Read,Edit,Write"));

  assert.equal(parseReviewAgentResponse("claude", '{"type":"result","result":"claude result"}\n'), "claude result");
  assert.equal(
    parseReviewAgentResponse("codex", '{"type":"item.completed","item":{"type":"agent_message","text":"codex result"}}\n'),
    "codex result"
  );
});

test("review agent summarizes structured failures without dumping Claude hooks", () => {
  const hookEvent = JSON.stringify({
    type: "system",
    subtype: "hook_response",
    output: "x".repeat(20_000)
  });
  const failureEvent = JSON.stringify({
    type: "result",
    is_error: true,
    terminal_reason: "blocking_limit",
    result: "Prompt is too long"
  });
  const message = formatReviewAgentFailure("claude", `${hookEvent}\n${failureEvent}`, "", 1);
  assert.equal(message, "审阅模型执行失败：审阅内容过长，超出模型上下文限制；请缩小提交范围后重试。");
  assert.doesNotMatch(message, /hook_response/);
});

test("review agent explains Claude context thrashing in Chinese", () => {
  const message = formatReviewAgentFailure(
    "claude",
    JSON.stringify({ type: "error", message: "Autocompact is thrashing: the context refilled to the limit" }),
    "",
    1
  );
  assert.equal(message, "审阅模型执行失败：修复模型上下文在连续压缩后仍超出限制；已限制修复范围，请拆分问题后重试。");
});

test("review parser preserves model provenance and consensus", () => {
  const initial = parseInitialReview(`\`\`\`json
{"summary":"one issue","findings":[{"severity":"high","title":"Null crash","file":"src/a.ts","line":12,"evidence":"value can be null","recommendation":"guard null"}]}
\`\`\``);
  const adjudication = parseJudgeReview(JSON.stringify({
    summary: "confirmed",
    assessments: [{ id: "R1-001", verdict: "agree", reason: "the call accepts null" }]
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

test("judge parser ignores findings added outside the handoff", () => {
  const adjudication = parseJudgeReview(JSON.stringify({
    summary: "验证完成",
    assessments: [{ id: "R1-001", verdict: "agree", reason: "结论成立" }],
    findings: [{
      severity: "high",
      title: "第二模型新增问题",
      file: "src/extra.ts",
      line: 1,
      evidence: "不应进入结果",
      recommendation: "不应进入结果"
    }]
  }));

  assert.deepEqual(adjudication, {
    summary: "验证完成",
    assessments: [{ id: "R1-001", verdict: "agree", reason: "结论成立" }]
  });
});

test("judge prompt receives only a bounded first-review handoff", () => {
  const initialPrompt = buildInitialReviewPrompt({
    request: "review concurrency",
    commit: "a".repeat(40),
    commitText: "diff --git a/src/a.ts b/src/a.ts"
  });
  assert.match(initialPrompt, /human-readable value in Simplified Chinese/);
  assert.match(initialPrompt, /所有自然语言内容必须使用简体中文/);
  assert.match(initialPrompt, /用简体中文写简短的总体结论/);

  const handoff = createReviewHandoff({
    round: 1,
    targetCommit: "a".repeat(40),
    reviewer: { engine: "claude", provider: "primary", model: "claude-opus-4-6" },
    initial: {
      summary: "Claude found one concurrency risk.",
      findings: [{
        severity: "high",
        title: "Race in stop",
        file: "src/a.ts",
        line: 12,
        evidence: "stop can overlap start",
        recommendation: "serialize lifecycle operations"
      }]
    }
  });
  const prompt = buildJudgePrompt({ handoff });
  assert.match(prompt, /Bounded ReviewHandoff/);
  assert.match(prompt, /Claude found one concurrency risk/);
  assert.match(prompt, /Race in stop/);
  assert.match(prompt, /stop can overlap start/);
  assert.doesNotMatch(prompt, /serialize lifecycle operations/);
  assert.doesNotMatch(prompt, /diff --git/);
  assert.doesNotMatch(prompt, /User request/);
  assert.match(prompt, /exactly one .* assessment for every handed-off finding id/);
  assert.match(prompt, /do not add new findings/);
  assert.match(prompt, /human-readable value in Simplified Chinese/);
  assert.match(prompt, /所有自然语言内容必须使用简体中文/);
  assert.match(prompt, /用简体中文写验证依据/);
});

test("review handoff bounds finding count and text lengths", () => {
  const handoff = createReviewHandoff({
    round: 2,
    targetCommit: "b".repeat(40),
    reviewer: { engine: "codex", provider: "primary", model: "gpt-5.6-sol" },
    initial: {
      summary: "总".repeat(1000),
      findings: Array.from({ length: 15 }, (_, index) => ({
        severity: "medium",
        title: `问题${index}-${"题".repeat(200)}`,
        file: `src/${"long/".repeat(100)}file-${index}.ts`,
        line: index + 1,
        evidence: "证据".repeat(500),
        recommendation: "建议".repeat(500)
      }))
    }
  });

  assert.equal(handoff.findings.length, 12);
  assert.equal(handoff.omittedFindingCount, 3);
  assert.ok(handoff.summary.length <= 600);
  assert.ok(handoff.findings.every((finding) => finding.title.length <= 120));
  assert.ok(handoff.findings.every((finding) => (finding.file?.length ?? 0) <= 300));
  assert.ok(handoff.findings.every((finding) => finding.claim.length <= 500));
  assert.equal(handoff.findings[0].id, "R2-001");
  assert.equal(handoff.findings[11].id, "R2-012");
});

test("findings beyond the handoff limit remain unverified", () => {
  const initial = {
    summary: "发现十三个问题",
    findings: Array.from({ length: 13 }, (_, index) => ({
      severity: "medium",
      title: `问题 ${index + 1}`,
      file: `src/file-${index + 1}.ts`,
      line: index + 1,
      evidence: `证据 ${index + 1}`,
      recommendation: `建议 ${index + 1}`
    }))
  };
  const findings = mergeReviewFindings({
    round: 1,
    reviewer: { engine: "claude", provider: "primary", model: "claude-opus-4-6", response: "" },
    judge: { engine: "codex", provider: "primary", model: "gpt-5.6-sol", response: "" },
    initial,
    adjudication: {
      summary: "已验证交接范围",
      assessments: Array.from({ length: 12 }, (_, index) => ({
        id: `R1-${String(index + 1).padStart(3, "0")}`,
        verdict: "agree",
        reason: "结论成立"
      }))
    }
  });

  assert.equal(findings.length, 13);
  assert.ok(findings.slice(0, 12).every((finding) => finding.verdict === "agree"));
  assert.equal(findings[12].id, "R1-013");
  assert.equal(findings[12].verdict, "unverified");
  assert.equal(findings[12].consensus, false);
});

test("judge assessments cannot verify findings outside the handoff limit", () => {
  const initial = {
    summary: "发现十三个问题",
    findings: Array.from({ length: 13 }, (_, index) => ({
      severity: "medium",
      title: `问题 ${index + 1}`,
      file: `src/file-${index + 1}.ts`,
      line: index + 1,
      evidence: `证据 ${index + 1}`,
      recommendation: `建议 ${index + 1}`
    }))
  };
  const findings = mergeReviewFindings({
    round: 1,
    reviewer: { engine: "claude", provider: "primary", model: "claude-opus-4-6", response: "" },
    judge: { engine: "codex", provider: "primary", model: "gpt-5.6-sol", response: "" },
    initial,
    adjudication: {
      summary: "越权裁决",
      assessments: [{ id: "R1-013", verdict: "agree", reason: "不应接受" }]
    }
  });

  assert.equal(findings[12].verdict, "unverified");
  assert.equal(findings[12].verdictReason, "第二模型未返回该问题的裁决。");
});

test("fix prompt constrains the fixing agent to selected files and local context", () => {
  const prompt = buildFixPrompt({
    request: "review concurrency",
    commit: "a".repeat(40),
    selected: [{
      id: "R1-001",
      severity: "medium",
      title: "并发状态未失效",
      file: "src/a.ts",
      line: 120,
      evidence: "旧回调可能影响新会话",
      recommendation: "校验会话代次",
      sources: [],
      verdict: "agree",
      verdictReason: "已确认",
      consensus: true
    }]
  });
  assert.match(prompt, /Allowed finding files:/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /只能读取或修改下面列出的 finding 文件/);
  assert.match(prompt, /前后最多 120 行/);
  assert.match(prompt, /根目录 AGENTS\.md 或 CLAUDE\.md 仅在确有必要时读取/);
});

test("review parser uses Chinese fallback text", () => {
  assert.equal(parseInitialReview(JSON.stringify({ findings: [] })).summary, "模型未提供总结。");
  assert.equal(
    parseJudgeReview(JSON.stringify({ assessments: [{ id: "R1-001" }] })).assessments[0].reason,
    "模型未提供验证依据。"
  );
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
    await assert.rejects(git.assertClean(repo), /审阅要求 Git 工作区干净/);
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
        assessments: [{ id: "R1-001", verdict: "agree", reason: "confirmed by type flow" }]
      }),
      "fixed",
      JSON.stringify({ summary: "clean", findings: [] })
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
      "claude:readOnly"
    ]);
    assert.deepEqual(calls[1].scopeFiles, ["src/a.ts"]);
    assert.deepEqual(calls[2].scopeFiles, ["src/a.ts"]);
    assert.equal(rounds.length, 2);
    assert.match(calls[1].prompt, /Bounded ReviewHandoff/);
    assert.match(calls[1].prompt, /found one/);
    assert.match(calls[1].prompt, /Null crash/);
    assert.doesNotMatch(calls[1].prompt, /diff --git/);
    assert.equal(rounds[1].judgeExecuted, false);
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
