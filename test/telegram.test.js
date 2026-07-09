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
import { upsertProviderCache } from "../dist/core/config/cache-store.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { requiresDangerousConfirmation } from "../dist/telegram/interaction/approval.js";
import {
  getBaseBotCommands,
  getChatBotCommands,
  parseTelegramCommand,
  resolveMappedCommand
} from "../dist/telegram/interaction/command-menu.js";
import { escapeHtml, Formatter, markdownToTelegramHtml, splitPlainText, truncateText } from "../dist/telegram/interaction/formatter.js";
import {
  buildAgentProfileBackKeyboard,
  buildAgentProfileKeyboard,
  buildCliKeyboard,
  buildModelPickerKeyboard,
  buildProviderPickerKeyboard,
  buildReadyKeyboard,
  buildReadyModeKeyboard,
  buildUsagePricingKeyboard,
  buildWorkdirListKeyboard,
  buildWorkdirStartKeyboard
} from "../dist/telegram/interaction/keyboards.js";
import { buildCodexArgs, findLatestCodexSessionId, formatCodexFailure, parseCodexOutput } from "../dist/telegram/engine/codex-engine.js";
import { buildClaudeArgs, parseClaudeOutput } from "../dist/telegram/engine/claude-engine.js";
import { spawnCapture } from "../dist/telegram/engine/process-utils.js";
import { resolveWorkingCommand } from "../dist/telegram/engine/engine-utils.js";
import { deleteRecentChatMessages, registerCommands, shouldHandleStartCommand } from "../dist/telegram/handlers/command.js";
import { registerDocumentHandler } from "../dist/telegram/handlers/document.js";
import { executePrompt, registerMessageHandler, runCliInit, startTypingStatus } from "../dist/telegram/handlers/message.js";
import { completeAgentProfile, inferEngineFromModel, setWorkdir } from "../dist/telegram/handlers/setup.js";
import { parseModelPriceInput } from "../dist/telegram/handlers/usage.js";
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
    assert.equal(session.botContextFingerprint, null);
    assert.deepEqual(session.conversation, []);
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
      model: "claude-sonnet-4-6",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    });
    assert.equal(unknownUsage.providerUsage[0].requestCount, 2);
    assert.equal(unknownUsage.providerUsage[0].unknownCostCount, 1);
    assert.equal(unknownUsage.providerUsage[0].totalTokens, 15);

    manager.update(session.id, { engine: "codex", messageCount: 1 });
    const updated = manager.getOrCreate(123);
    assert.equal(updated.engine, "codex");
    assert.equal(updated.messageCount, 1);

    manager.addAttachment(123, { name: "a.txt", path: "/tmp/a.txt", text: "hello", createdAt: "now" });
    const withAttachment = manager.getOrCreate(123);
    assert.equal(withAttachment.attachments.length, 1);
    const withConversation = manager.appendConversationTurn(withAttachment.id, {
      user: "上一轮问题",
      assistant: "上一轮回答"
    });
    assert.equal(withConversation.conversation.length, 1);
    assert.equal(withConversation.conversation[0].user, "上一轮问题");
    const dirty = manager.update(withAttachment.id, {
      engineSessionId: "engine-session-1",
      botContextFingerprint: "codex:/tmp/project:abc",
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
    assert.equal(cleared.botContextFingerprint, null);
    assert.equal(cleared.approveAll, false);
    assert.equal(cleared.messageCount, 0);
    assert.equal(cleared.attachments.length, 0);
    assert.equal(cleared.conversation.length, 0);

    const next = manager.newSession(123);
    assert.notEqual(next.id, session.id);
    assert.equal(next.engine, "codex");
    assert.deepEqual(manager.getActiveSessions().map((item) => item.id), [next.id]);

    const resumed = manager.resume(123, session.id.slice(0, 8));
    assert.equal(resumed.id, session.id);

    const setup = manager.startSetup(123);
    assert.equal(setup.setupStep, "model");
    const custom = manager.update(setup.id, { setupStep: "custom_workdir" });
    assert.equal(custom.setupStep, "custom_workdir");
    const profile = manager.update(setup.id, { setupStep: "agent_profile" });
    assert.equal(profile.setupStep, "agent_profile");
    manager.rememberWorkdir(123, path.join(tempDir, "project-a"));
    assert.deepEqual(manager.getWorkdirs(123), [path.join(tempDir, "project-a")]);
    store.close();
  });
});

test("formatter escapes and splits telegram text safely", () => {
  assert.equal(escapeHtml("<tag>&"), "&lt;tag&gt;&amp;");
  assert.equal(truncateText("abcdef", 5), "ab...");
  assert.deepEqual(splitPlainText("a\nb\nc", 4), ["a\nb\n", "c"]);
  assert.equal(Formatter.modelPrompt(), "🤖 确定你要使用的大模型吧");
  assert.equal(Formatter.modelPrompt(true), "🤖 重新选择你要使用的大模型吧");
  assert.equal(Formatter.workdirPrompt(), "🤖 你好呀，先确定工作路径吧");
  assert.equal(Formatter.workdirRequired(), "🤖 请选确定工作路径哦");
  assert.equal(Formatter.workdirList(["/Users/linlangli/Script"]), "🤖 选择一个已存在的工作路径吧");
  assert.doesNotMatch(Formatter.workdirList(["/Users/linlangli/Script"]), /1\.|📁/);
  assert.equal(Formatter.cliPrompt("/Users/linlangli/Script"), "🤖 确定你要使用的CLI吧");
  assert.equal(Formatter.cliRequired(), "🤖 先确定你想使用的CLI哦。");
  assert.equal(Formatter.agentProfilePrompt(), "🤖 介绍一下我和你吧，可以帮你构建画像哦");
  assert.match(Formatter.agentProfile("# BOT\n\n<profile>"), /<b>BOT\.md<\/b>/);
  assert.match(Formatter.agentProfile("# BOT\n\n<profile>"), /&lt;profile&gt;/);
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
  const unknownSession = {
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
      costUsd: 0,
      unknownCostCount: 1,
      inputTokens: 1000,
      outputTokens: 25,
      totalTokens: 1025,
      updatedAt: "now"
    }],
    createdAt: "now",
    lastActiveAt: "now"
  };
  const unknownUsagePanel = Formatter.sessionUsage(
    unknownSession,
    { name: "51talk-codex", model: "gpt-5.5" },
    undefined,
    { missingPrice: true }
  );
  assert.match(unknownUsagePanel, /额度：<code>缺少价格表<\/code>/);
  assert.match(unknownUsagePanel, /Tokens：<code>1,025<\/code>/);
  assert.match(unknownUsagePanel, /可以输入价格后计算额度/);
  const tokenOnlyUsagePanel = Formatter.sessionUsage(
    unknownSession,
    { name: "51talk-codex", model: "gpt-5.5" },
    undefined,
    { tokenOnly: true }
  );
  assert.match(tokenOnlyUsagePanel, /当前会话 Token/);
  assert.match(tokenOnlyUsagePanel, /Tokens：<code>1,025<\/code>/);
  assert.doesNotMatch(tokenOnlyUsagePanel, /额度/);
  const estimatedUsagePanel = Formatter.sessionUsage(
    unknownSession,
    { name: "51talk-codex", model: "gpt-5.5" },
    undefined,
    { estimatedCostUsd: 0.001075 }
  );
  assert.match(estimatedUsagePanel, /额度：<code>\$0\.0011（按价格表估算）<\/code>/);
  const missingTokenUsagePanel = Formatter.sessionUsage(
    {
      ...unknownSession,
      providerUsage: [{
        provider: "51talk-codex",
        model: "gpt-5.5",
        requestCount: 1,
        costUsd: 0,
        unknownCostCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        updatedAt: "now"
      }]
    },
    { name: "51talk-codex", model: "gpt-5.5" },
    undefined,
    { missingPrice: true }
  );
  assert.match(missingTokenUsagePanel, /额度：<code>额度未知<\/code>/);
  assert.match(missingTokenUsagePanel, /可以输入价格后计算额度/);
  assert.doesNotMatch(sessionCard, /blockquote|工作路径|Provider|Model|权限模式|🍺|✨|🆔|📁|🧰|🔌|🧠|🛡️/);
  assert.match(Formatter.help(), /\/claude - 切换 Claude Code 并重新选择模型/);
  assert.match(Formatter.help(), /\/codex - 切换 Codex 并重新选择模型/);
  assert.match(Formatter.help(), /\/reset - 重置会话信息/);
  assert.match(Formatter.help(), /\/fresh - 清空聊天窗口/);
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
  const markdownCompleted = Formatter.taskCompleted("codex", {
    response: [
      "你目前亏最多的基金是：**天弘中证食品饮料ETF联接C**。",
      "",
      "| 基金 | 当前市值 | 浮亏 | 收益率 |",
      "|---|---:|---:|---:|",
      "| 天弘中证食品饮料ETF联接C | ¥5,227.99 | **-¥1,034.25** | **-16.52%** |",
      "",
      "如果只看“亏损金额”，食品饮料亏得最多：**亏约 1034 元**。"
    ].join("\n")
  });
  assert.match(markdownCompleted, /<b>天弘中证食品饮料ETF联接C<\/b>/);
  assert.match(markdownCompleted, /当前市值：¥5,227\.99/);
  assert.match(markdownCompleted, /浮亏：<b>-¥1,034\.25<\/b>/);
  assert.match(markdownCompleted, /-¥1,034\.25/);
  assert.doesNotMatch(markdownCompleted, /\*\*|\|---|<pre>基金/);
  const strategyTable = markdownToTelegramHtml([
    "| 策略 | 适合情况 | 优点 | 风险 |",
    "|---|---|---|---|",
    "| 直接割肉 | 你彻底不看好中国消费和白酒 | 释放资金，转向更强主线 | 可能卖在低位，错过修复 |",
    "| 降低到小额定投/暂停 | 你不想割肉，但也想提高资金效率 | 保留修复机会，把新钱投向更强资产 | 回本速度可能变慢 |"
  ].join("\n"));
  assert.match(strategyTable, /<b>直接割肉<\/b>\n适合情况：你彻底不看好中国消费和白酒\n优点：释放资金/);
  assert.match(strategyTable, /<b>降低到小额定投\/暂停<\/b>\n适合情况：你不想割肉/);
  assert.doesNotMatch(strategyTable, /<pre>|-{3,}|策略\s+适合情况/);
  assert.equal(markdownToTelegramHtml("`<x>` and [OpenAI](https://openai.com)"), "<code>&lt;x&gt;</code> and <a href=\"https://openai.com\">OpenAI</a>");
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
  assert.deepEqual(buildAgentProfileKeyboard().inline_keyboard, [[
    { text: "暂不提供", callback_data: "setup:agent:skip" }
  ]]);
  assert.deepEqual(buildAgentProfileBackKeyboard().inline_keyboard, [[
    { text: "back", callback_data: "ready:back" }
  ]]);
  assert.deepEqual(buildProviderPickerKeyboard(["51talk-codex"], "setup").inline_keyboard, [
    [{ text: "51talk-codex", callback_data: "setup:provider:pick:0" }]
  ]);
  assert.deepEqual(buildProviderPickerKeyboard(["51talk-cs"], "ready", "claude").inline_keyboard, [
    [{ text: "51talk-cs", callback_data: "ready:provider:pick:0:claude" }],
    [{ text: "back", callback_data: "ready:back" }]
  ]);
  assert.deepEqual(buildModelPickerKeyboard(["gpt-5.5"], 0, "setup").inline_keyboard, [
    [{ text: "gpt-5.5", callback_data: "setup:model:pick:0:0" }],
    [{ text: "back", callback_data: "setup:provider:show" }]
  ]);
  assert.equal(inferEngineFromModel("gpt-5.5"), "codex");
  assert.equal(inferEngineFromModel("claude-opus-4-6"), "claude");
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
  assert.deepEqual(buildUsagePricingKeyboard().inline_keyboard, [[
    { text: "输入价格", callback_data: "usage:price:input" },
    { text: "未知", callback_data: "usage:price:unknown" }
  ]]);
});

test("usage price input parser accepts compact price formats", () => {
  assert.deepEqual(parseModelPriceInput("1/3/0.1"), {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 3,
    cacheReadPerMillionUsd: 0.1
  });
  assert.deepEqual(parseModelPriceInput("$0.5 $1.25 $0.05"), {
    inputPerMillionUsd: 0.5,
    outputPerMillionUsd: 1.25,
    cacheReadPerMillionUsd: 0.05
  });
  assert.equal(parseModelPriceInput("1/3"), null);
});

test("telegram command menu maps selected CLI slash commands", () => {
  assert.deepEqual(getBaseBotCommands().map((item) => item.command), ["claude", "codex", "reset", "fresh", "cwd", "config", "usage", "help"]);
  assert.equal(getBaseBotCommands().find((item) => item.command === "reset")?.description, "重置会话信息");
  assert.equal(getBaseBotCommands().find((item) => item.command === "fresh")?.description, "清空聊天窗口");
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

test("workdir setup runs native init before asking for profile", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: projectDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      provider: "51talk-codex",
      model: "gpt-5.5",
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const setup = manager.startSetup(123);
    manager.update(setup.id, { engine: "codex", setupStep: "workdir" });

    const engineCalls = [];
    const fakeEngine = {
      name: "codex",
      execute: async (params) => {
        engineCalls.push(params);
        return { response: "initialized", sessionId: "engine-session", provider: "51talk-codex", model: "gpt-5.5" };
      },
      abort: () => undefined
    };
    const deps = {
      sessionManager: manager,
      claudeEngine: { ...fakeEngine, name: "claude" },
      codexEngine: fakeEngine,
      approvalManager: { request: async () => true },
      config
    };

    const replies = [];
    const edits = [];
    const typing = [];
    const ctx = {
      chat: { id: 123 },
      reply: async (text) => {
        replies.push(text);
      },
      editMessageText: async (text) => {
        edits.push(text);
      },
      api: {
        sendChatAction: async (chatId, action) => {
          typing.push([chatId, action]);
          return true;
        }
      }
    };

    await setWorkdir(ctx, deps, projectDir, {
      edit: true,
      afterSet: (next) => runCliInit(ctx, deps, next.engine)
    });

    assert.equal(engineCalls.length, 1);
    assert.equal(engineCalls[0].prompt, "/init");
    assert.equal(engineCalls[0].cwd, projectDir);
    assert.equal(engineCalls[0].permissionMode, "bypassPermissions");
    assert.equal(engineCalls[0].timeoutMs, 180000);
    assert.equal(manager.getOrCreate(123).setupStep, "agent_profile");
    assert.equal(edits.some((text) => String(text).includes("介绍一下我和你")), true);
    assert.equal(replies.some((text) => String(text).includes("介绍一下我和你")), false);
    assert.equal(replies.some((text) => String(text).includes("initialized")), false);
    assert.deepEqual(typing[0], [123, "typing"]);

    const next = await completeAgentProfile(ctx, deps, "我是 Lin，喜欢直接给结论。", { edit: true });
    assert.equal(next?.setupStep, "ready");
    assert.equal(manager.getOrCreate(123).setupStep, "ready");
    assert.equal(edits.some((text) => String(text).includes("已就绪")), true);
    assert.equal(replies.some((text) => String(text).includes("已就绪")), false);
    await assert.rejects(fs.readFile(path.join(projectDir, "PROMPT.md"), "utf8"), /ENOENT/);
    await assert.rejects(fs.readFile(path.join(projectDir, "BOT.md"), "utf8"), /ENOENT/);
    store.close();
  });
});

test("agent profile document completes setup without writing BOT.md", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "claude",
      defaultCwd: projectDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      provider: "51talk-cs",
      model: "claude-opus-4-6",
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const setup = manager.startSetup(123);
    manager.update(setup.id, { cwd: projectDir, engine: "claude", setupStep: "agent_profile" });

    const engineCalls = [];
    const fakeEngine = {
      name: "claude",
      execute: async (params) => {
        engineCalls.push(params);
        return { response: "initialized", sessionId: "engine-session", provider: "51talk-cs", model: "claude-opus-4-6" };
      },
      abort: () => undefined
    };
    let handler;
    registerDocumentHandler({
      on: (_event, callback) => {
        handler = callback;
      }
    }, {
      sessionManager: manager,
      claudeEngine: fakeEngine,
      codexEngine: { ...fakeEngine, name: "codex" },
      approvalManager: { request: async () => true },
      config
    });

    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("我是 Lin，偏好中文直接回复。");
    const replies = [];
    try {
      await handler({
        message: {
          document: {
            file_name: "PROMPT.md",
            file_size: 42
          }
        },
        chat: { id: 123 },
        getFile: async () => ({ file_path: "documents/PROMPT.md" }),
        reply: async (text) => {
          replies.push(text);
        },
        api: {
          sendChatAction: async () => true
        }
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    const session = manager.getOrCreate(123);
    assert.equal(session.setupStep, "ready");
    assert.equal(session.attachments.length, 0);
    assert.equal(engineCalls.length, 0);
    await assert.rejects(fs.readFile(path.join(projectDir, "PROMPT.md"), "utf8"), /ENOENT/);
    await assert.rejects(fs.readFile(path.join(projectDir, "BOT.md"), "utf8"), /ENOENT/);
    assert.equal(replies.some((text) => String(text).includes("Attached")), false);
    assert.equal(replies.some((text) => String(text).includes("已就绪")), true);
    assert.equal(replies.some((text) => String(text).includes("initialized")), false);
    store.close();
  });
});

test("regular telegram prompts do not inject legacy BOT.md context", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "BOT.md"), "# BOT\n\n偏好：回答要简洁直接。\n", "utf8");
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: projectDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      provider: "51talk-codex",
      model: "gpt-5.5",
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const session = manager.getOrCreate(123);
    manager.update(session.id, { cwd: projectDir, engine: "codex", setupStep: "ready" });

    const engineCalls = [];
    const fakeEngine = {
      name: "codex",
      execute: async (params) => {
        engineCalls.push(params);
        return { response: "ok", sessionId: "engine-session", provider: "51talk-codex", model: "gpt-5.5" };
      },
      abort: () => undefined
    };
    let handler;
    registerMessageHandler({
      on: (_event, callback) => {
        handler = callback;
      }
    }, {
      sessionManager: manager,
      claudeEngine: { ...fakeEngine, name: "claude" },
      codexEngine: fakeEngine,
      approvalManager: { request: async () => true },
      config
    });

    await handler({
      message: { text: "今天怎么规划？" },
      chat: { id: 123 },
      reply: async () => undefined,
      api: {
        sendChatAction: async () => true
      }
    });

    assert.equal(engineCalls.length, 1);
    assert.doesNotMatch(engineCalls[0].prompt, /<bot_context source="BOT\.md">/);
    assert.doesNotMatch(engineCalls[0].prompt, /回答要简洁直接/);
    assert.match(engineCalls[0].prompt, /今天怎么规划？/);

    await handler({
      message: { text: "继续" },
      chat: { id: 123 },
      reply: async () => undefined,
      api: {
        sendChatAction: async () => true
      }
    });

    assert.equal(engineCalls.length, 2);
    assert.doesNotMatch(engineCalls[1].prompt, /<bot_context source="BOT\.md">/);
    assert.match(engineCalls[1].prompt, /继续/);
    assert.equal(manager.getOrCreate(123).botContextFingerprint, null);

    const cleared = manager.clearConversation(123);
    assert.equal(cleared.botContextFingerprint, null);
    store.close();
  });
});

test("telegram prompts include recent conversation when engine session id is unavailable", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: projectDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      provider: "51talk-codex",
      model: "gpt-5.5",
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const session = manager.getOrCreate(123);
    manager.update(session.id, { cwd: projectDir, engine: "codex", setupStep: "ready" });

    const engineCalls = [];
    const fakeEngine = {
      name: "codex",
      execute: async (params) => {
        engineCalls.push(params);
        return {
          response: engineCalls.length === 1
            ? "亏最多的是天弘中证食品饮料ETF联接C。"
            : "可以继续分析这支基金。",
          provider: "51talk-codex",
          model: "gpt-5.5"
        };
      },
      abort: () => undefined
    };
    let handler;
    registerMessageHandler({
      on: (_event, callback) => {
        handler = callback;
      }
    }, {
      sessionManager: manager,
      claudeEngine: { ...fakeEngine, name: "claude" },
      codexEngine: fakeEngine,
      approvalManager: { request: async () => true },
      config
    });

    await handler({
      message: { text: "我现在亏最多的基金是哪支？" },
      chat: { id: 123 },
      reply: async () => undefined,
      api: { sendChatAction: async () => true }
    });
    await handler({
      message: { text: "这支还要继续定投吗？" },
      chat: { id: 123 },
      reply: async () => undefined,
      api: { sendChatAction: async () => true }
    });

    assert.equal(engineCalls.length, 2);
    assert.equal(engineCalls[1].resume, null);
    assert.match(engineCalls[1].prompt, /<recent_conversation purpose=/);
    assert.match(engineCalls[1].prompt, /我现在亏最多的基金是哪支？/);
    assert.match(engineCalls[1].prompt, /天弘中证食品饮料ETF联接C/);
    assert.match(engineCalls[1].prompt, /这支还要继续定投吗？/);
    assert.equal(manager.getOrCreate(123).conversation.length, 2);
    store.close();
  });
});

test("telegram provider fallback clears cross-provider resume and keeps recent context", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProviders([
      { name: "bad", baseUrl: "https://bad.test/v1", apiKey: "bad", mode: "auto", level: 1, model: "gpt-5.5" },
      { name: "good", baseUrl: "https://good.test/v1", apiKey: "good", mode: "auto", level: 2, model: "gpt-5.5" }
    ]);
    await upsertProviderCache("bad", { status: "ok", models: ["gpt-5.5"], lastCheckedAt: "now", lastError: null });
    await upsertProviderCache("good", { status: "ok", models: ["gpt-5.5"], lastCheckedAt: "now", lastError: null });

    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: projectDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      provider: "bad",
      model: "gpt-5.5",
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const session = manager.getOrCreate(123);
    manager.update(session.id, {
      cwd: projectDir,
      engine: "codex",
      setupStep: "ready",
      engineSessionId: "bad-session"
    });
    manager.appendConversationTurn(session.id, {
      user: "上一轮问题",
      assistant: "上一轮回答"
    });

    const engineCalls = [];
    const codexEngine = {
      name: "codex",
      execute: async (params) => {
        engineCalls.push(params);
        if (params.providerName === "bad") {
          throw new Error("provider upstream failed");
        }
        return {
          sessionId: "good-session",
          response: "备用 provider 已回答",
          provider: "good",
          model: "gpt-5.5"
        };
      },
      abort: () => undefined
    };

    const replies = [];
    const ok = await executePrompt({
      chat: { id: 123 },
      reply: async (text) => {
        replies.push(text);
      },
      api: { sendChatAction: async () => true }
    }, {
      sessionManager: manager,
      claudeEngine: { ...codexEngine, name: "claude" },
      codexEngine,
      approvalManager: { request: async () => true },
      config
    }, "继续分析");

    assert.equal(ok, true);
    assert.equal(engineCalls.length, 2);
    assert.equal(engineCalls[0].providerName, "bad");
    assert.equal(engineCalls[0].resume, "bad-session");
    assert.doesNotMatch(engineCalls[0].prompt, /<recent_conversation purpose=/);
    assert.equal(engineCalls[1].providerName, "good");
    assert.equal(engineCalls[1].resume, null);
    assert.match(engineCalls[1].prompt, /<recent_conversation purpose=/);
    assert.match(engineCalls[1].prompt, /上一轮问题/);
    assert.match(engineCalls[1].prompt, /上一轮回答/);

    const current = manager.getOrCreate(123);
    assert.equal(current.engineSessionId, null);
    assert.equal(current.providerUsage[0].provider, "good");
    assert.equal(config.provider, "bad");
    assert.equal(replies.length, 1);
    store.close();
  });
});

test("switching telegram engines carries recent conversation fallback", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: projectDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      provider: "51talk-cs",
      model: "claude-opus-4-6",
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const session = manager.getOrCreate(123);
    manager.update(session.id, { cwd: projectDir, engine: "codex", setupStep: "ready" });
    manager.appendConversationTurn(session.id, {
      user: "Codex 上一轮问题",
      assistant: "Codex 上一轮回答"
    });

    const engineCalls = [];
    const claudeEngine = {
      name: "claude",
      execute: async (params) => {
        engineCalls.push(params);
        return {
          response: "Claude 新会话回答",
          provider: "51talk-cs",
          model: "claude-opus-4-6"
        };
      },
      abort: () => undefined
    };

    await executePrompt({
      chat: { id: 123 },
      reply: async () => undefined,
      api: { sendChatAction: async () => true }
    }, {
      sessionManager: manager,
      claudeEngine,
      codexEngine: { ...claudeEngine, name: "codex" },
      approvalManager: { request: async () => true },
      config
    }, "切换到 Claude 后的新问题", "claude");

    assert.equal(engineCalls.length, 1);
    assert.equal(engineCalls[0].resume, null);
    assert.match(engineCalls[0].prompt, /<recent_conversation purpose=/);
    assert.match(engineCalls[0].prompt, /Codex 上一轮问题/);
    assert.match(engineCalls[0].prompt, /Codex 上一轮回答/);
    const current = manager.getOrCreate(123);
    assert.equal(current.engine, "claude");
    assert.equal(current.conversation.length, 2);
    assert.equal(current.conversation[0].user, "Codex 上一轮问题");
    assert.equal(current.conversation[1].user, "切换到 Claude 后的新问题");
    store.close();
  });
});

test("fresh clears telegram window without resetting engine context", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: projectDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      provider: "51talk-codex",
      model: "gpt-5.5",
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const session = manager.getOrCreate(123);
    const withConversation = manager.appendConversationTurn(session.id, {
      user: "上一轮问题",
      assistant: "上一轮回答"
    });
    manager.update(withConversation.id, {
      engineSessionId: "codex-session-1",
      botContextFingerprint: "codex:fingerprint"
    });

    const commands = new Map();
    const bot = {
      command: (name, callback) => {
        commands.set(name, callback);
      },
      api: {
        setMyCommands: async () => true
      }
    };
    const fakeEngine = { name: "codex", execute: async () => ({ response: "ok" }), abort: () => undefined };
    registerCommands(bot, {
      sessionManager: manager,
      claudeEngine: { ...fakeEngine, name: "claude" },
      codexEngine: fakeEngine,
      engines: {
        claude: { ...fakeEngine, name: "claude" },
        codex: fakeEngine
      },
      approvalManager: {
        request: async () => true,
        resolveAll: () => undefined
      },
      config
    });

    const replies = [];
    await commands.get("fresh")({
      chat: { id: 123 },
      message: { message_id: 10 },
      reply: async (text) => {
        replies.push(text);
      },
      api: {
        deleteMessages: async () => true,
        deleteMessage: async () => true
      }
    });

    const current = manager.getOrCreate(123);
    assert.equal(current.engineSessionId, "codex-session-1");
    assert.equal(current.botContextFingerprint, "codex:fingerprint");
    assert.equal(current.conversation.length, 1);
    assert.match(String(replies[0]), /聊天记录已清理/);
    store.close();
  });
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
  const proxiedArgs = buildCodexArgs("hello", "gpt-5.5", "/tmp/project", "default", {
    baseUrl: "http://127.0.0.1:12345/v1"
  });
  assert.equal(proxiedArgs.includes("model_provider=\"ai_gateway_proxy\""), true);
  assert.equal(proxiedArgs.includes("model_providers.ai_gateway_proxy.base_url=\"http://127.0.0.1:12345/v1\""), true);
  assert.equal(proxiedArgs.includes("model_providers.ai_gateway_proxy.wire_api=\"responses\""), true);
  assert.deepEqual(buildCodexArgs("again", "gpt-5.5", "/tmp/project", "default", undefined, "session-1"), [
    "-s",
    "workspace-write",
    "-a",
    "on-request",
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "-m",
    "gpt-5.5",
    "session-1",
    "again"
  ]);
});

test("codex failure formatter hides benign diagnostics", () => {
  const message = formatCodexFailure([
    "Reading additional input from stdin...",
    "2026-07-08T06:20:12Z  WARN codex_core_plugins::remote::remote_installed_plugin_sync: remote installed plugin bundle sync failed",
    "2026-07-08T06:20:21Z  WARN codex_core::responses_retry: stream disconnected - retrying sampling request (5/5 in 3.191s)..."
  ].join("\n"), "51talk-codex", "gpt-5.5");
  assert.match(message, /模型流式响应连续断开/);
  assert.match(message, /51talk-codex \/ gpt-5\.5/);
  assert.doesNotMatch(message, /remote_installed_plugin_sync|Reading additional input/);
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

test("codex session id fallback reads local session metadata", async () => {
  await withTempHome(async (tempDir) => {
    const codexHome = path.join(tempDir, ".codex");
    const cwd = path.join(tempDir, "project");
    await fs.mkdir(cwd, { recursive: true });
    const startedAtMs = Date.now();
    const date = new Date(startedAtMs);
    const sessionDir = path.join(
      codexHome,
      "sessions",
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    );
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionId = "019f4110-5969-7f73-9576-bd071405af09";
    const filePath = path.join(sessionDir, `rollout-${sessionId}.jsonl`);
    await fs.writeFile(filePath, [
      JSON.stringify({
        type: "session_meta",
        payload: {
          session_id: sessionId,
          id: sessionId,
          cwd,
          source: "exec"
        }
      }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [] } })
    ].join("\n"), "utf8");
    await fs.utimes(filePath, new Date(startedAtMs), new Date(startedAtMs));

    assert.equal(findLatestCodexSessionId({
      cwd,
      startedAtMs: startedAtMs - 1000,
      finishedAtMs: startedAtMs + 1000,
      codexHome
    }), sessionId);
    assert.equal(findLatestCodexSessionId({
      cwd: path.join(tempDir, "other"),
      startedAtMs: startedAtMs - 1000,
      finishedAtMs: startedAtMs + 1000,
      codexHome
    }), undefined);
  });
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

  const nestedCodex = parseCodexOutput(JSON.stringify({
    type: "session_configured",
    payload: { session_id: "019f4110-5969-7f73-9576-bd071405af09" }
  }), 100);
  assert.equal(nestedCodex.sessionId, "019f4110-5969-7f73-9576-bd071405af09");
});

test("telegram engine command resolver skips broken codex shim when app binary exists", () => {
  const brokenShim = spawnSync("/opt/homebrew/bin/codex", ["--version"], { stdio: "ignore", timeout: 5000 }).status !== 0;
  const appBinaryExists = spawnSync("/Applications/Codex.app/Contents/Resources/codex", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
  if (!brokenShim || !appBinaryExists) return;

  const command = resolveWorkingCommand("codex");
  assert.equal(command, "/Applications/Codex.app/Contents/Resources/codex");
});

test("spawn capture times out and stops hanging processes", async () => {
  const result = await spawnCapture({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 50,
    killGraceMs: 10
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
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
