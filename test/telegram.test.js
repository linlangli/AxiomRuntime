import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizePermissionMode,
  normalizeTelegramConfig,
  parseTelegramConfigValue,
  saveTelegramConfig,
  setTelegramConfigValue
} from "../dist/telegram/config.js";
import { requiresDangerousConfirmation } from "../dist/telegram/interaction/approval.js";
import {
  getBaseBotCommands,
  getChatBotCommands,
  parseTelegramCommand,
  resolveMappedCommand
} from "../dist/telegram/interaction/command-menu.js";
import { escapeHtml, Formatter, splitPlainText, truncateText } from "../dist/telegram/interaction/formatter.js";
import { buildCodexArgs, parseCodexOutput } from "../dist/telegram/engine/codex-engine.js";
import { buildClaudeArgs, parseClaudeOutput } from "../dist/telegram/engine/claude-engine.js";
import { resolveWorkingCommand } from "../dist/telegram/engine/engine-utils.js";
import { SessionManager } from "../dist/telegram/session/manager.js";
import { SessionStore } from "../dist/telegram/session/store.js";

test("normalizes telegram config and parses config values", async () => {
  await withTempHome(async () => {
    const config = normalizeTelegramConfig({
      token: " 123:abc ",
      allowAllUsers: "true",
      allowedUserIds: ["1", "2", "bad", 2],
      defaultEngine: "codex",
      defaultPermissionMode: "full-auto",
      sessionTimeoutHours: "12",
      maxOutputLength: "3000",
      proxyUrl: " http://127.0.0.1:7890 "
    });

    assert.equal(config.token, "123:abc");
    assert.equal(config.allowAllUsers, true);
    assert.deepEqual(config.allowedUserIds, [1, 2]);
    assert.equal(config.defaultEngine, "codex");
    assert.equal(config.defaultPermissionMode, "bypassPermissions");
    assert.equal(config.sessionTimeoutHours, 12);
    assert.equal(config.maxOutputLength, 3000);
    assert.equal(config.proxyUrl, "http://127.0.0.1:7890");
    assert.deepEqual(parseTelegramConfigValue("allowedUserIds", "10, 11 12"), [10, 11, 12]);
    assert.equal(normalizePermissionMode("auto-edit"), "acceptEdits");

    await saveTelegramConfig(config);
    const updated = await setTelegramConfigValue("defaultEngine", "claude");
    assert.equal(updated.defaultEngine, "claude");
    const publicConfig = await setTelegramConfigValue("allowAllUsers", "true");
    assert.equal(publicConfig.allowAllUsers, true);
  });
});

test("session store creates, updates, resumes, and stores attachments", async () => {
  await withTempHome(async (tempDir) => {
    const store = new SessionStore(path.join(tempDir, "telegram.sqlite"));
    const manager = new SessionManager(store, {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [1],
      defaultEngine: "claude",
      defaultCwd: tempDir,
      defaultPermissionMode: "default",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      proxyUrl: undefined,
      dbPath: path.join(tempDir, "telegram.sqlite")
    });

    const session = manager.getOrCreate(123);
    assert.equal(session.engine, "claude");
    assert.equal(session.status, "idle");
    assert.equal(session.setupStep, "ready");

    manager.update(session.id, { engine: "codex", messageCount: 1 });
    const updated = manager.getOrCreate(123);
    assert.equal(updated.engine, "codex");
    assert.equal(updated.messageCount, 1);

    manager.addAttachment(123, { name: "a.txt", path: "/tmp/a.txt", text: "hello", createdAt: "now" });
    const withAttachment = manager.getOrCreate(123);
    assert.equal(withAttachment.attachments.length, 1);

    const next = manager.newSession(123);
    assert.notEqual(next.id, session.id);
    assert.equal(next.engine, "codex");

    const resumed = manager.resume(123, session.id.slice(0, 8));
    assert.equal(resumed.id, session.id);

    const setup = manager.startSetup(123);
    assert.equal(setup.setupStep, "workdir");
    const custom = manager.update(setup.id, { setupStep: "custom_workdir" });
    assert.equal(custom.setupStep, "custom_workdir");
    manager.rememberWorkdir(123, path.join(tempDir, "project-a"));
    assert.deepEqual(manager.getWorkdirs(123), [path.join(tempDir, "project-a")]);
    store.close();
  });
});

test("formatter escapes and splits telegram text safely", () => {
  assert.equal(escapeHtml("<tag>&"), "&lt;tag&gt;&amp;");
  assert.equal(truncateText("abcdef", 5), "ab...");
  assert.deepEqual(splitPlainText("a\nb\nc", 4), ["a\nb\n", "c"]);
  assert.equal(Formatter.workdirPrompt(), "🤖 你好呀，先确定工作路径吧。");
  assert.equal(Formatter.workdirRequired(), "🤖 请选确定工作路径哦");
  assert.equal(Formatter.cliRequired(), "🤖 先确定你想使用的CLI哦。");
  assert.match(Formatter.help(), /\/claude prompt - 使用 Claude Code/);
  assert.doesNotMatch(Formatter.help(), /\/mode|\/new|\/resume|\/stop|\/session|\/history|\/config/);
});

test("telegram command menu maps selected CLI slash commands", () => {
  assert.deepEqual(getBaseBotCommands().map((item) => item.command), ["claude", "codex", "reset", "cwd", "help"]);
  const claudeCommands = getChatBotCommands("claude").map((item) => item.command);
  assert.equal(claudeCommands.includes("model"), true);
  assert.equal(claudeCommands.includes("clear"), true);
  assert.equal(claudeCommands.includes("help_claude"), true);
  assert.equal(claudeCommands.includes("pr_comments"), true);
  assert.equal(resolveMappedCommand("claude", "model")?.prompt, "/model");
  assert.equal(resolveMappedCommand("claude", "help_claude")?.prompt, "/help");
  assert.deepEqual(parseTelegramCommand("/model opus"), { command: "model", args: "opus" });
  assert.deepEqual(parseTelegramCommand("/model@my_bot opus"), { command: "model", args: "opus" });
});

test("dangerous command detector catches high risk commands", () => {
  assert.equal(requiresDangerousConfirmation("rm -rf /tmp/demo"), true);
  assert.equal(requiresDangerousConfirmation("git push origin main --force"), true);
  assert.equal(requiresDangerousConfirmation("ls -la"), false);
});

test("codex args map permission modes to non-interactive CLI flags", () => {
  assert.deepEqual(buildCodexArgs("hello", "gpt-5.5", "/tmp/project", "default"), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-m",
    "gpt-5.5",
    "-C",
    "/tmp/project",
    "-s",
    "workspace-write",
    "-a",
    "on-request",
    "hello"
  ]);
  assert.equal(buildCodexArgs("hello", "gpt-5.5", "/tmp/project", "bypassPermissions").includes("--dangerously-bypass-approvals-and-sandbox"), true);
});

test("claude args include verbose stream-json output", () => {
  const args = buildClaudeArgs({
    prompt: "hello",
    model: "claude-opus-4-6",
    settingsPath: "/tmp/settings.json",
    permissionMode: "default"
  });
  assert.equal(args.includes("-p"), true);
  assert.equal(args.includes("--output-format"), true);
  assert.equal(args.includes("stream-json"), true);
  assert.equal(args.includes("--verbose"), true);
});

test("engine output parsers extract final text and metadata", () => {
  const claude = parseClaudeOutput([
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }] } }),
    JSON.stringify({ type: "result", result: "done", session_id: "sid", total_cost_usd: 0.01 })
  ].join("\n"), 1000);
  assert.equal(claude.response, "done");
  assert.equal(claude.sessionId, "sid");
  assert.deepEqual(claude.filesChanged, ["a.ts"]);
  assert.equal(claude.cost, 0.01);

  const codex = parseCodexOutput([
    JSON.stringify({ type: "tool_call", tool: "shell", input: { command: "ls" } }),
    JSON.stringify({ type: "result", message: "ok", files_changed: ["b.ts"], session_id: "cid" })
  ].join("\n"), 500);
  assert.equal(codex.response, "ok");
  assert.equal(codex.sessionId, "cid");
  assert.deepEqual(codex.filesChanged, ["b.ts"]);
  assert.equal(codex.toolCalls.length, 1);
});

test("telegram engine command resolver skips broken codex shim when app binary exists", () => {
  const brokenShim = spawnSync("/opt/homebrew/bin/codex", ["--version"], { stdio: "ignore", timeout: 5000 }).status !== 0;
  const appBinaryExists = spawnSync("/Applications/Codex.app/Contents/Resources/codex", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
  if (!brokenShim || !appBinaryExists) return;

  const command = resolveWorkingCommand("codex");
  assert.equal(command, "/Applications/Codex.app/Contents/Resources/codex");
});

async function withTempHome(fn) {
  const previousHome = process.env.AI_GATEWAY_HOME;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-telegram-test-"));
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
