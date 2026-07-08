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
import {
  buildCliKeyboard,
  buildReadyKeyboard,
  buildReadyModeKeyboard,
  buildWorkdirListKeyboard,
  buildWorkdirStartKeyboard
} from "../dist/telegram/interaction/keyboards.js";
import { buildCodexArgs, parseCodexOutput } from "../dist/telegram/engine/codex-engine.js";
import { buildClaudeArgs, parseClaudeOutput } from "../dist/telegram/engine/claude-engine.js";
import { resolveWorkingCommand } from "../dist/telegram/engine/engine-utils.js";
import { deleteRecentChatMessages, shouldHandleStartCommand } from "../dist/telegram/handlers/command.js";
import { startTypingStatus } from "../dist/telegram/handlers/message.js";
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
    assert.equal(normalizeTelegramConfig({}).defaultPermissionMode, "bypassPermissions");

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
    assert.deepEqual(session.providerUsage, []);

    const usage = manager.recordProviderUsage(session.id, {
      provider: "api",
      model: "claude-sonnet-4-6",
      costUsd: 0.0123
    });
    assert.equal(usage.providerUsage[0].provider, "api");
    assert.equal(usage.providerUsage[0].model, "claude-sonnet-4-6");
    assert.equal(usage.providerUsage[0].requestCount, 1);
    assert.equal(usage.providerUsage[0].costUsd, 0.0123);

    const unknownUsage = manager.recordProviderUsage(session.id, {
      provider: "api",
      model: "claude-sonnet-4-6"
    });
    assert.equal(unknownUsage.providerUsage[0].requestCount, 2);
    assert.equal(unknownUsage.providerUsage[0].unknownCostCount, 1);

    manager.update(session.id, { engine: "codex", messageCount: 1 });
    const updated = manager.getOrCreate(123);
    assert.equal(updated.engine, "codex");
    assert.equal(updated.messageCount, 1);

    manager.addAttachment(123, { name: "a.txt", path: "/tmp/a.txt", text: "hello", createdAt: "now" });
    const withAttachment = manager.getOrCreate(123);
    assert.equal(withAttachment.attachments.length, 1);
    const dirty = manager.update(withAttachment.id, {
      engineSessionId: "engine-session-1",
      approveAll: true,
      messageCount: 3
    });
    const cleared = manager.clearConversation(123);
    assert.equal(cleared.id, dirty.id);
    assert.equal(cleared.engine, dirty.engine);
    assert.equal(cleared.cwd, dirty.cwd);
    assert.equal(cleared.permissionMode, dirty.permissionMode);
    assert.equal(cleared.setupStep, dirty.setupStep);
    assert.equal(cleared.engineSessionId, null);
    assert.equal(cleared.approveAll, false);
    assert.equal(cleared.messageCount, 0);
    assert.equal(cleared.attachments.length, 0);

    const next = manager.newSession(123);
    assert.notEqual(next.id, session.id);
    assert.equal(next.engine, "codex");
    assert.deepEqual(manager.getActiveSessions().map((item) => item.id), [next.id]);

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
  assert.equal(Formatter.workdirPrompt(), "🤖 你好呀，先确定工作路径吧");
  assert.equal(Formatter.workdirRequired(), "🤖 请选确定工作路径哦");
  assert.equal(Formatter.workdirList(["/Users/linlangli/Script"]), "🤖 选择一个已存在的工作路径吧");
  assert.doesNotMatch(Formatter.workdirList(["/Users/linlangli/Script"]), /1\.|📁/);
  assert.equal(Formatter.cliPrompt("/Users/linlangli/Script"), "🤖 确定你要使用的CLI吧");
  assert.equal(Formatter.cliRequired(), "🤖 先确定你想使用的CLI哦。");
  const sessionCard = Formatter.sessionCard({
    id: "1350dd03abcdef",
    chatId: 1,
    engine: "codex",
    engineSessionId: null,
    cwd: "/Users/linlangli/Script",
    permissionMode: "default",
    approveAll: false,
    setupStep: "ready",
    status: "idle",
    messageCount: 0,
    attachments: [],
    createdAt: "now",
    lastActiveAt: "now"
  }, { name: "51talk-codex", model: "gpt-5.5" });
  assert.equal(sessionCard, "🤖 会话<code>1350dd03</code>已就绪，可以开始和我聊天啦");
  assert.equal(Formatter.sessionCleared({
    id: "1350dd03abcdef",
    chatId: 1,
    engine: "codex",
    engineSessionId: null,
    cwd: "/Users/linlangli/Script",
    permissionMode: "default",
    approveAll: false,
    setupStep: "ready",
    status: "idle",
    messageCount: 0,
    attachments: [],
    createdAt: "now",
    lastActiveAt: "now"
  }), "🤖 会话<code>1350dd03</code>聊天记录已清理");
  const usagePanel = Formatter.sessionUsage({
    id: "1350dd03abcdef",
    chatId: 1,
    engine: "codex",
    engineSessionId: null,
    cwd: "/Users/linlangli/Script",
    permissionMode: "bypassPermissions",
    approveAll: false,
    setupStep: "ready",
    status: "idle",
    messageCount: 0,
    attachments: [],
    providerUsage: [{
      provider: "51talk-codex",
      model: "gpt-5.5",
      requestCount: 1,
      costUsd: 0.1234,
      unknownCostCount: 0,
      updatedAt: "now"
    }],
    createdAt: "now",
    lastActiveAt: "now"
  }, { name: "51talk-codex", model: "gpt-5.5" });
  assert.match(usagePanel, /当前会话用量/);
  assert.match(usagePanel, /Session：<code>1350dd03<\/code>/);
  assert.match(usagePanel, /Provider：<code>51talk-codex<\/code>/);
  assert.match(usagePanel, /额度：<code>\$0\.1234<\/code>/);
  assert.doesNotMatch(sessionCard, /blockquote|工作路径|Provider|Model|权限模式|🍺|✨|🆔|📁|🧰|🔌|🧠|🛡️/);
  assert.match(Formatter.help(), /\/claude prompt - 使用 Claude Code/);
  assert.match(Formatter.help(), /\/reset - 重置会话信息/);
  assert.match(Formatter.help(), /\/fresh - 清空会话聊天记录/);
  assert.match(Formatter.help(), /\/config - 查看或编辑 Bot 配置/);
  assert.match(Formatter.help(), /\/usage - 查看当前会话额度/);
  assert.doesNotMatch(Formatter.help(), /\/mode|\/new|\/resume|\/stop|\/session|\/history/);
  const completed = Formatter.taskCompleted("codex", {
    response: "我现在是 Codex，基于 GPT-5 的编码代理。",
    provider: "51talk-codex",
    model: "gpt-5.5",
    cost: 0.1234,
    duration: 18800
  });
  assert.equal(completed, "我现在是 Codex，基于 GPT-5 的编码代理。");
  assert.doesNotMatch(completed, /Done|Status: processing|Prompt:|18\.8s|额度|51talk-codex|gpt-5\.5|<i>/);
});

test("workdir setup keyboards use compact labels and absolute path buttons", () => {
  assert.deepEqual(buildWorkdirStartKeyboard(true).inline_keyboard, [[
    { text: "已存在", callback_data: "setup:workdir:list" },
    { text: "自定义", callback_data: "setup:workdir:custom" }
  ]]);
  assert.deepEqual(buildWorkdirListKeyboard(["/Users/linlangli/Script"]).inline_keyboard, [
    [{ text: "/Users/linlangli/Script", callback_data: "setup:workdir:pick:0" }],
    [{ text: "back", callback_data: "setup:workdir:back" }]
  ]);
  assert.deepEqual(buildCliKeyboard().inline_keyboard, [[
    { text: "Claude Code", callback_data: "setup:cli:claude" },
    { text: "Codex", callback_data: "setup:cli:codex" }
  ]]);
  assert.deepEqual(buildReadyKeyboard({
    cli: "Codex",
    providerModel: "51talk-codex · gpt-5.5",
    permissionMode: "default",
    cwd: "/Users/linlangli/Script"
  }).inline_keyboard, [
    [{ text: "Codex", callback_data: "ready:cli" }],
    [{ text: "51talk-codex · gpt-5.5", callback_data: "ready:provider" }],
    [{ text: "默认权限", callback_data: "ready:mode" }],
    [{ text: "/Users/linlangli/Script", callback_data: "ready:workdir" }]
  ]);
  assert.deepEqual(buildReadyModeKeyboard().inline_keyboard[0], [
    { text: "默认权限", callback_data: "ready:mode:pick:default" }
  ]);
});

test("telegram command menu maps selected CLI slash commands", () => {
  assert.deepEqual(getBaseBotCommands().map((item) => item.command), ["claude", "codex", "reset", "fresh", "cwd", "config", "usage", "help"]);
  assert.equal(getBaseBotCommands().find((item) => item.command === "reset")?.description, "重置会话信息");
  assert.equal(getBaseBotCommands().find((item) => item.command === "fresh")?.description, "清空会话聊天记录");
  assert.equal(getBaseBotCommands().find((item) => item.command === "config")?.description, "查看或编辑 Bot 配置");
  assert.equal(getBaseBotCommands().find((item) => item.command === "usage")?.description, "查看当前会话额度");
  const claudeCommands = getChatBotCommands("claude").map((item) => item.command);
  assert.equal(claudeCommands.includes("fresh"), true);
  assert.equal(claudeCommands.includes("config"), true);
  assert.equal(claudeCommands.includes("usage"), true);
  assert.equal(claudeCommands.includes("model"), true);
  assert.equal(claudeCommands.includes("clear"), true);
  assert.equal(claudeCommands.includes("help_claude"), true);
  assert.equal(claudeCommands.includes("pr_comments"), true);
  assert.equal(resolveMappedCommand("claude", "model")?.prompt, "/model");
  assert.equal(resolveMappedCommand("claude", "help_claude")?.prompt, "/help");
  assert.deepEqual(parseTelegramCommand("/model opus"), { command: "model", args: "opus" });
  assert.deepEqual(parseTelegramCommand("/model@my_bot opus"), { command: "model", args: "opus" });
});

test("start command dedupe suppresses immediate duplicate", () => {
  const recent = new Map();
  assert.equal(shouldHandleStartCommand(123, 1000, recent), true);
  assert.equal(shouldHandleStartCommand(123, 1500, recent), false);
  assert.equal(shouldHandleStartCommand(456, 1500, recent), true);
  assert.equal(shouldHandleStartCommand(123, 9000, recent), false);
  assert.equal(shouldHandleStartCommand(123, 20001, recent), true);
});

test("typing status sends Telegram chat action immediately", () => {
  const calls = [];
  const stop = startTypingStatus({
    api: {
      sendChatAction: async (chatId, action) => {
        calls.push([chatId, action]);
        return true;
      }
    }
  }, 123);
  stop();
  assert.deepEqual(calls, [[123, "typing"]]);
});

test("fresh deletion scans backward and falls back to single deletes", async () => {
  const bulkCalls = [];
  const singleCalls = [];
  const deleted = await deleteRecentChatMessages({
    api: {
      deleteMessages: async (chatId, messageIds) => {
        bulkCalls.push([chatId, messageIds]);
        throw new Error("bulk failed");
      },
      deleteMessage: async (chatId, messageId) => {
        singleCalls.push([chatId, messageId]);
        if (messageId === 8) throw new Error("old message");
        return true;
      }
    }
  }, 123, 10, 4);
  assert.equal(deleted, 3);
  assert.deepEqual(bulkCalls, [[123, [10, 9, 8, 7]]]);
  assert.deepEqual(singleCalls, [[123, 10], [123, 9], [123, 8], [123, 7]]);
});

test("dangerous command detector catches high risk commands", () => {
  assert.equal(requiresDangerousConfirmation("rm -rf /tmp/demo"), true);
  assert.equal(requiresDangerousConfirmation("git push origin main --force"), true);
  assert.equal(requiresDangerousConfirmation("ls -la"), false);
});

test("codex args map permission modes to non-interactive CLI flags", () => {
  assert.deepEqual(buildCodexArgs("hello", "gpt-5.5", "/tmp/project", "default"), [
    "-a",
    "on-request",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-m",
    "gpt-5.5",
    "-C",
    "/tmp/project",
    "-s",
    "workspace-write",
    "hello"
  ]);
  const acceptEditsArgs = buildCodexArgs("hello", "gpt-5.5", "/tmp/project", "acceptEdits");
  assert.deepEqual(acceptEditsArgs.slice(0, 3), ["-a", "never", "exec"]);
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
