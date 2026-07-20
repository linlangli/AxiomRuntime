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
import { applyPromptMiddlewares, listPromptMiddlewares } from "../dist/telegram/interaction/prompt-middleware.js";
import { ProgressReporter } from "../dist/telegram/interaction/progress-reporter.js";
import { countPromptTokens, truncateToTokenBudget } from "../dist/telegram/interaction/token-budget.js";
import { parseToolName } from "../dist/telegram/interaction/tool-name.js";
import { formatMemoryBlock } from "../dist/telegram/memory/memory-inject.js";
import { getBotIdFromToken, MemoryService } from "../dist/telegram/memory/memory-service.js";
import { MemoryStore } from "../dist/telegram/memory/memory-store.js";
import {
  buildAgentProfileBackKeyboard,
  buildAgentProfileKeyboard,
  buildCliKeyboard,
  buildModelPickerKeyboard,
  buildMemoryClearConfirmKeyboard,
  buildMemoryManageKeyboard,
  buildProviderPickerKeyboard,
  buildReadyKeyboard,
  buildReadyModeKeyboard,
  buildRememberScopeKeyboard,
  buildUsagePricingKeyboard,
  buildWorkdirListKeyboard,
  buildWorkdirStartKeyboard
} from "../dist/telegram/interaction/keyboards.js";
import { buildCodexArgs, findLatestCodexSessionId, formatCodexFailure, parseCodexOutput } from "../dist/telegram/engine/codex-engine.js";
import { buildClaudeArgs, formatClaudeFailure, parseClaudeOutput } from "../dist/telegram/engine/claude-engine.js";
import { createTelegramEngines, listTelegramEngineNames } from "../dist/telegram/engine/registry.js";
import { createJsonLineAccumulator, spawnCapture } from "../dist/telegram/engine/process-utils.js";
import { resolveWorkingCommand } from "../dist/telegram/engine/engine-utils.js";
import { TelegramHandlerRegistry } from "../dist/telegram/handler-registry.js";
import { TelegramTaskLifecycleRegistry } from "../dist/telegram/lifecycle-registry.js";
import { isRetryableTelegramNetworkError, withTelegramNetworkRetry } from "../dist/telegram/network-retry.js";
import { deleteRecentChatMessages, registerCommands, shouldHandleStartCommand } from "../dist/telegram/handlers/command.js";
import { registerDocumentHandler } from "../dist/telegram/handlers/document.js";
import {
  handleMemoryCommand,
  handleMemoryManageCallback,
  handleMemoryManageInput,
  handleRememberCommand,
  handleRememberInput,
  handleRememberScopeCallback
} from "../dist/telegram/handlers/memory.js";
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
    assert.deepEqual(session.pinnedTurns, []);
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
    const pinned = manager.pinTurn(123, 77, {
      user: "上一轮问题",
      assistant: "上一轮回答"
    });
    assert.equal(pinned.pinnedTurns.length, 1);
    assert.equal(manager.getOrCreate(123).pinnedTurns[0].messageId, 77);
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
    assert.equal(cleared.pinnedTurns.length, 1);
    assert.equal(manager.unpinTurn(123, 77).pinnedTurns.length, 0);

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
    manager.update(setup.id, { setupStep: "remember_global" });
    assert.equal(manager.getOrCreate(123).setupStep, "remember_global");
    manager.update(setup.id, { setupStep: "memory_promote" });
    assert.equal(manager.getOrCreate(123).setupStep, "memory_promote");
    await fs.mkdir(path.join(tempDir, "project-a"));
    manager.rememberWorkdir(123, path.join(tempDir, "project-a"));
    assert.deepEqual(manager.getWorkdirs(123), [path.join(tempDir, "project-a")]);
    store.close();
  });
});

test("prompt middleware applies recent conversation and attachments", async () => {
  await withTempHome(async (tempDir) => {
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [1],
      defaultEngine: "codex",
      defaultCwd: tempDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const session = manager.getOrCreate(123);
    const withConversation = manager.appendConversationTurn(session.id, {
      user: "上一轮问题 <fund>",
      assistant: "上一轮回答 & conclusion"
    });
    const withAttachment = manager.addAttachment(withConversation.chatId, {
      name: "note.md",
      path: path.join(tempDir, "note.md"),
      text: "attached text",
      createdAt: new Date().toISOString()
    });

    assert.deepEqual(listPromptMiddlewares().map((item) => item.name), ["bot-memory", "reply-context", "recent-conversation", "attachments"]);

    const prompt = await applyPromptMiddlewares({
      chatId: 123,
      prompt: "继续",
      session: withAttachment,
      engine: "codex",
      resume: null,
      includeAgentContext: true
    });
    assert.match(prompt, /<recent_conversation/);
    assert.match(prompt, /上一轮问题 &lt;fund&gt;/);
    assert.match(prompt, /上一轮回答 &amp; conclusion/);
    assert.match(prompt, /<attachment name="note\.md"/);

    const resumed = await applyPromptMiddlewares({
      chatId: 123,
      prompt: "继续",
      session: withAttachment,
      engine: "codex",
      resume: "native-session",
      includeAgentContext: true
    });
    assert.doesNotMatch(resumed, /<recent_conversation/);
    assert.match(resumed, /<attachment name="note\.md"/);
    store.close();
  });
});

test("prompt middleware trims recent conversation by token budget", async () => {
  await withTempHome(async (tempDir) => {
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [1],
      defaultEngine: "codex",
      defaultCwd: tempDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    let session = manager.getOrCreate(123);
    for (const marker of ["oldest", "middle-a", "middle-b", "newest"]) {
      session = manager.appendConversationTurn(session.id, {
        user: `${marker} ${"token ".repeat(3000)}`,
        assistant: `${marker}-answer ${"answer ".repeat(3000)}`
      });
    }

    const prompt = await applyPromptMiddlewares({
      chatId: 123,
      prompt: "继续回答",
      session,
      engine: "codex",
      resume: null,
      includeAgentContext: true
    });

    assert.match(prompt, /newest/);
    assert.doesNotMatch(prompt, /oldest/);
    assert.equal(countPromptTokens(prompt) < 1700, true);
    store.close();
  });
});

test("prompt middleware escapes reply context and describes image attachments", async () => {
  await withTempHome(async (tempDir) => {
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [1],
      defaultEngine: "codex",
      defaultCwd: tempDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const imagePath = path.join(tempDir, "chart.png");
    const session = manager.addAttachment(123, {
      name: "chart\"<&>.png",
      path: imagePath,
      text: "",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 12,
      createdAt: new Date().toISOString()
    });
    const prompt = await applyPromptMiddlewares({
      chatId: 123,
      prompt: "解释图片",
      session,
      engine: "codex",
      resume: null,
      includeAgentContext: true,
      replyToText: "</referenced_message><unsafe>"
    });
    assert.match(prompt, /&lt;\/referenced_message&gt;&lt;unsafe&gt;/);
    assert.match(prompt, /name="chart&quot;&lt;&amp;&gt;\.png"/);
    assert.match(prompt, /kind="image"/);
    store.close();
  });
});

test("memory service stores global profile and isolates bot scoped memories", async () => {
  await withTempHome(async (tempDir) => {
    const store = new MemoryStore(path.join(tempDir, "memory.sqlite"));
    const botA = new MemoryService({ botId: "111", store });
    const botB = new MemoryService({ botId: "222", store });

    const profile = botA.saveProfile(123, "用户偏好中文直接回答。");
    const personaA = botA.savePersona(123, "投资 bot：回答必须提示风险。");
    botB.savePersona(123, "代码 bot：优先给补丁。");
    botB.remember(123, { scope: "bot", content: "部署 staging 需要先跑 npm test", title: "部署流程" });

    const visibleA = botA.listVisible(123);
    assert.equal(profile.scope, "global");
    assert.equal(personaA.scope, "bot");
    assert.equal(visibleA.some((entry) => entry.content.includes("投资 bot")), true);
    assert.equal(visibleA.some((entry) => entry.content.includes("代码 bot")), false);
    assert.equal(visibleA.some((entry) => entry.content.includes("部署 staging")), false);

    const injected = formatMemoryBlock(botA.retrieveForPrompt(123, "我现在问投资风险"));
    assert.match(injected, /用户偏好中文直接回答/);
    assert.match(injected, /投资 bot/);
    assert.doesNotMatch(injected, /代码 bot/);
    store.close();
  });
});

test("remember command uses interactive scope picker and saves next message", async () => {
  await withTempHome(async (tempDir) => {
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "111:abc",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: tempDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const memoryStore = new MemoryStore(path.join(tempDir, "memory.sqlite"));
    const memory = new MemoryService({ botId: getBotIdFromToken(config.token), store: memoryStore });
    const deps = {
      sessionManager: manager,
      approvalManager: { request: async () => true },
      config,
      memoryService: memory
    };

    const commandReplies = [];
    await handleRememberCommand({
      chat: { id: 123 },
      match: "",
      reply: async (text, extra) => commandReplies.push([text, extra])
    }, deps);

    assert.equal(commandReplies[0][0], "🤖 这条记忆保存到哪里？");
    assert.deepEqual(commandReplies[0][1].reply_markup.inline_keyboard, [[
      { text: "global", callback_data: "memory:remember:scope:global" },
      { text: "bot", callback_data: "memory:remember:scope:bot" },
      { text: "auto", callback_data: "memory:remember:scope:auto" }
    ]]);

    const edits = [];
    await handleRememberScopeCallback({
      chat: { id: 123 },
      editMessageText: async (text) => edits.push(text),
      reply: async (text) => edits.push(text)
    }, deps, "global");
    assert.equal(edits[0], "🤖 输入要记录的记忆吧");
    assert.equal(manager.getOrCreate(123).setupStep, "remember_global");

    const replies = [];
    const session = manager.getOrCreate(123);
    const handled = await handleRememberInput({
      chat: { id: 123 },
      reply: async (text) => replies.push(text)
    }, deps, "我喜欢直接给结论", session);

    assert.equal(handled, true);
    assert.equal(manager.getOrCreate(123).setupStep, "ready");
    const entry = memory.listVisible(123).find((item) => item.content === "我喜欢直接给结论");
    assert.equal(entry?.scope, "global");
    assert.equal(entry?.category, "preference");
    assert.match(replies[0], /Scope：<code>global<\/code> · Category：<code>preference<\/code>/);
    memoryStore.close();
    store.close();
  });
});

test("memory command uses interactive management buttons", async () => {
  await withTempHome(async (tempDir) => {
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "111:abc",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: tempDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const memoryStore = new MemoryStore(path.join(tempDir, "memory.sqlite"));
    const memory = new MemoryService({ botId: getBotIdFromToken(config.token), store: memoryStore });
    const deps = {
      sessionManager: manager,
      approvalManager: { request: async () => true },
      config,
      memoryService: memory
    };

    const botEntry = memory.remember(123, {
      scope: "bot",
      content: "部署 staging 需要先跑 npm test"
    });
    memory.remember(123, {
      scope: "bot",
      content: "临时记录本周要复盘发布流程"
    });

    const commandReplies = [];
    await handleMemoryCommand({
      chat: { id: 123 },
      match: "",
      reply: async (text, extra) => commandReplies.push([text, extra])
    }, deps);
    assert.equal(commandReplies[0][0], "🤖 选择你要管理的记忆操作吧");
    assert.deepEqual(commandReplies[0][1].reply_markup.inline_keyboard, buildMemoryManageKeyboard().inline_keyboard);

    const edits = [];
    await handleMemoryManageCallback({
      chat: { id: 123 },
      editMessageText: async (text, extra) => edits.push([text, extra]),
      reply: async (text, extra) => edits.push([text, extra])
    }, deps, "promote");
    assert.equal(edits[0][0], "🤖 输入要升级为 global 的记忆编号吧");
    assert.equal(manager.getOrCreate(123).setupStep, "memory_promote");

    const replies = [];
    const session = manager.getOrCreate(123);
    const handled = await handleMemoryManageInput({
      chat: { id: 123 },
      reply: async (text) => replies.push(text)
    }, deps, String(botEntry.id), session);
    assert.equal(handled, true);
    assert.equal(manager.getOrCreate(123).setupStep, "ready");
    assert.equal(memory.listVisible(123).find((entry) => entry.id === botEntry.id)?.scope, "global");
    assert.match(replies[0], /已升级为 global/);

    await handleMemoryManageCallback({
      chat: { id: 123 },
      editMessageText: async (text, extra) => edits.push([text, extra]),
      reply: async (text, extra) => edits.push([text, extra])
    }, deps, "clear", "bot");
    assert.equal(edits.at(-1)[0], "🤖 确认清空 bot 记忆吗？");
    assert.deepEqual(edits.at(-1)[1].reply_markup.inline_keyboard, buildMemoryClearConfirmKeyboard("bot").inline_keyboard);

    await handleMemoryManageCallback({
      chat: { id: 123 },
      editMessageText: async (text, extra) => edits.push([text, extra]),
      reply: async (text, extra) => edits.push([text, extra])
    }, deps, "clear_confirm", "bot");
    assert.match(edits.at(-1)[0], /已清空 bot 记忆 1 条/);
    assert.equal(memory.listVisible(123).filter((entry) => entry.scope === "bot").length, 0);
    memoryStore.close();
    store.close();
  });
});

test("memory middleware injects visible memory before recent conversation", async () => {
  await withTempHome(async (tempDir) => {
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "111:abc",
      allowAllUsers: false,
      allowedUserIds: [1],
      defaultEngine: "codex",
      defaultCwd: tempDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      dbPath
    };
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store, config);
    const session = manager.getOrCreate(123);
    const withConversation = manager.appendConversationTurn(session.id, {
      user: "上一轮",
      assistant: "上一轮回答"
    });
    const memoryStore = new MemoryStore(path.join(tempDir, "memory.sqlite"));
    const memory = new MemoryService({ botId: getBotIdFromToken(config.token), store: memoryStore });
    memory.saveProfile(123, "用户是后端开发。");
    memory.savePersona(123, "本 bot 负责代码任务。");

    const prompt = await applyPromptMiddlewares({
      chatId: 123,
      prompt: "继续这个代码任务",
      session: withConversation,
      engine: "codex",
      resume: null,
      includeAgentContext: true,
      memoryService: memory
    });
    assert.match(prompt, /^<user_memory/);
    assert.match(prompt, /用户是后端开发/);
    assert.match(prompt, /本 bot 负责代码任务/);
    assert.match(prompt, /<recent_conversation/);

    const slashPrompt = await applyPromptMiddlewares({
      chatId: 123,
      prompt: "/init",
      session: withConversation,
      engine: "codex",
      resume: null,
      includeAgentContext: true,
      memoryService: memory
    });
    assert.equal(slashPrompt, "/init");
    memoryStore.close();
    store.close();
  });
});

test("completeAgentProfile saves generated profile and persona into central memory", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "111:abc",
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
    const session = manager.startSetup(123);
    manager.update(session.id, { cwd: projectDir, engine: "codex", setupStep: "agent_profile" });
    const memoryStore = new MemoryStore(path.join(tempDir, "memory.sqlite"));
    const memory = new MemoryService({ botId: getBotIdFromToken(config.token), store: memoryStore });
    const engineCalls = [];
    const fakeEngine = {
      name: "codex",
      execute: async (params) => {
        engineCalls.push(params);
        return {
          response: "## 用户背景\nLin，后端开发。\n=====PERSONA=====\n## 角色与职责\n代码助手。",
          provider: "51talk-codex",
          model: "gpt-5.5"
        };
      },
      abort: () => undefined
    };
    const edits = [];
    const ctx = {
      chat: { id: 123 },
      editMessageText: async (text) => {
        edits.push(text);
      },
      reply: async () => undefined
    };

    const next = await completeAgentProfile(ctx, {
      sessionManager: manager,
      codexEngine: fakeEngine,
      claudeEngine: { ...fakeEngine, name: "claude" },
      config,
      memoryService: memory
    }, "我是 Lin，希望你当代码助手。", { edit: true });

    assert.equal(next?.setupStep, "ready");
    assert.equal(engineCalls.length, 1);
    assert.match(engineCalls[0].prompt, /=====PERSONA=====/);
    assert.match(memory.getProfile(123)?.content ?? "", /后端开发/);
    assert.match(memory.getPersona(123)?.content ?? "", /代码助手/);
    assert.equal(memory.listVisible(123).some((entry) => entry.title === "用户原始自我描述"), true);
    assert.equal(edits.some((text) => String(text).includes("已就绪")), true);
    memoryStore.close();
    store.close();
  });
});

test("token budget truncation stays within requested budget", () => {
  const value = "token ".repeat(300);
  const truncated = truncateToTokenBudget(value, 40);
  assert.equal(countPromptTokens(truncated) <= 40, true);
  assert.equal(truncated.endsWith("..."), true);
});

test("telegram engine registry creates built-in engines", () => {
  assert.deepEqual(listTelegramEngineNames().sort(), ["claude", "codex"]);
  const engines = createTelegramEngines();
  assert.equal(engines.claude.name, "claude");
  assert.equal(engines.codex.name, "codex");
});

test("telegram handler registry installs handlers in registration order", () => {
  const registry = new TelegramHandlerRegistry();
  const installed = [];
  registry.register("first", () => installed.push("first"));
  registry.register("second", () => installed.push("second"));

  registry.install({}, {});

  assert.deepEqual(registry.list(), ["first", "second"]);
  assert.deepEqual(installed, ["first", "second"]);
});

test("telegram task lifecycle registry emits completion and failure hooks", async () => {
  const registry = new TelegramTaskLifecycleRegistry();
  const events = [];
  registry.register({
    onTaskCompleted: (event) => events.push(["completed", event.chatId, event.engine]),
    onTaskFailed: (event) => events.push(["failed", event.chatId, event.engine])
  });

  await registry.emitTaskCompleted({
    chatId: 1,
    engine: "codex",
    session: { id: "s1" },
    result: { response: "ok" },
    fallbackFrom: null,
    preferredProvider: true
  });
  await registry.emitTaskFailed({
    chatId: 2,
    engine: "claude",
    session: { id: "s2" },
    error: new Error("failed")
  });

  assert.deepEqual(events, [
    ["completed", 1, "codex"],
    ["failed", 2, "claude"]
  ]);
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
  assert.match(Formatter.agentProfile("# BOT\n\n<profile>"), /<b>Bot Memory<\/b>/);
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

test("progress formatter and tool parser render structured status", () => {
  assert.deepEqual(parseToolName("mcp__codegraph__codegraph_context"), {
    raw: "mcp__codegraph__codegraph_context",
    name: "codegraph_context",
    kind: "mcp",
    mcpServer: "codegraph"
  });
  assert.equal(parseToolName("Bash").kind, "builtin");
  assert.equal(parseToolName("npm test -- --watch=false", { kind: "command" }).kind, "command");
  assert.equal(Formatter.progress({ phase: "thinking" }), "⏱️ 思考中…");
  assert.match(Formatter.progress({
    phase: "tool_calling",
    tool: "mcp__codegraph__codegraph_context"
  }, { toolCount: 3 }), /调用 MCP · <code>codegraph \/ codegraph_context<\/code>（第 3 个操作）/);
  assert.match(Formatter.progress({
    phase: "tool_calling",
    tool: "npm test",
    toolKind: "command"
  }), /执行命令 · <code>npm test<\/code>/);
  assert.match(Formatter.progress({
    phase: "tool_calling",
    tool: "Edit"
  }), /编辑文件 · <code>Edit<\/code>/);
  assert.doesNotMatch(Formatter.progress({ phase: "thinking" }), /\(\d+s\)|（\d+s）/);
});

test("progress reporter throttles updates and deletes status message", async () => {
  const calls = [];
  const reporter = new ProgressReporter({
    sendMessage: async (chatId, text) => {
      calls.push(["send", chatId, text]);
      return { message_id: 77 };
    },
    editMessageText: async (chatId, messageId, text) => {
      calls.push(["edit", chatId, messageId, text]);
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      calls.push(["delete", chatId, messageId]);
      return true;
    }
  }, 123, { throttleMs: 5 });

  await reporter.update({ phase: "thinking" });
  await reporter.update({ phase: "tool_calling", tool: "Bash" });
  await reporter.update({ phase: "writing" });
  await sleep(12);
  await reporter.update({ phase: "tool_calling", tool: "Edit" });
  await sleep(12);
  await reporter.finalize();

  assert.equal(calls.filter((call) => call[0] === "send").length, 1);
  assert.equal(calls.filter((call) => call[0] === "edit").length, 1);
  assert.deepEqual(calls.at(-1), ["delete", 123, 77]);
  assert.match(String(calls[0][2]), /整理回复/);
});

test("progress reporter skips silent, duplicate, and failed edits", async () => {
  const silentCalls = [];
  const silent = new ProgressReporter({
    sendMessage: async () => {
      silentCalls.push("send");
      return { message_id: 1 };
    },
    editMessageText: async () => {
      silentCalls.push("edit");
      return true;
    },
    deleteMessage: async () => {
      silentCalls.push("delete");
      return true;
    }
  }, 123, { silent: true, throttleMs: 5 });
  await silent.update({ phase: "thinking" });
  await sleep(10);
  await silent.finalize();
  assert.deepEqual(silentCalls, []);

  const calls = [];
  const reporter = new ProgressReporter({
    sendMessage: async (chatId, text) => {
      calls.push(["send", chatId, text]);
      return { message_id: 88 };
    },
    editMessageText: async () => {
      calls.push(["edit"]);
      throw new Error("Too Many Requests: 429");
    },
    deleteMessage: async (chatId, messageId) => {
      calls.push(["delete", chatId, messageId]);
      return true;
    }
  }, 123, { throttleMs: 5 });

  await reporter.update({ phase: "thinking" });
  await sleep(10);
  await reporter.update({ phase: "thinking" });
  await sleep(10);
  await reporter.update({ phase: "tool_calling", tool: "Bash" });
  await sleep(10);
  await reporter.finalize();

  assert.equal(calls.filter((call) => call[0] === "send").length, 1);
  assert.equal(calls.filter((call) => call[0] === "edit").length, 1);
  assert.deepEqual(calls.at(-1), ["delete", 123, 88]);
});

test("progress reporter can replace status message with final text", async () => {
  const calls = [];
  const reporter = new ProgressReporter({
    sendMessage: async (chatId, text) => {
      calls.push(["send", chatId, text]);
      return { message_id: 91 };
    },
    editMessageText: async (chatId, messageId, text, options) => {
      calls.push(["edit", chatId, messageId, text, options?.parse_mode]);
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      calls.push(["delete", chatId, messageId]);
      return true;
    }
  }, 123, { throttleMs: 5 });

  await reporter.update({ phase: "thinking" });
  await sleep(10);
  const replaced = await reporter.replaceWithHtml("<b>done</b>", "done");
  await reporter.finalize();

  assert.equal(replaced, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ["send", 123]);
  assert.match(String(calls[0][2]), /思考中/);
  assert.deepEqual(calls[1], ["edit", 123, 91, "<b>done</b>", "HTML"]);
});

test("progress reporter streams escaped response previews without duplicating timeline entries", async () => {
  const calls = [];
  const reporter = new ProgressReporter({
    sendMessage: async (_chatId, text) => {
      calls.push(["send", text]);
      return { message_id: 92 };
    },
    editMessageText: async (_chatId, _messageId, text) => {
      calls.push(["edit", text]);
      return true;
    },
    deleteMessage: async () => true
  }, 123, { throttleMs: 5 });

  await reporter.update({ phase: "writing", responseText: "<draft> 第一段" });
  await sleep(10);
  await reporter.update({ phase: "writing", responseText: "<draft> 第一段\n第二段" });
  await sleep(10);
  await reporter.finalize();

  assert.equal(calls.length, 2);
  assert.match(calls[0][1], /<blockquote>&lt;draft&gt; 第一段<\/blockquote>/);
  assert.match(calls[1][1], /第二段<\/blockquote>/);
  assert.equal((calls[1][1].match(/正在整理回复/g) ?? []).length, 1);
});

test("telegram network retry recovers transient delivery failures", async () => {
  let attempts = 0;
  const result = await withTelegramNetworkRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("Network request for 'sendMessage' failed!");
    return "sent";
  }, { delaysMs: [0, 0] });

  assert.equal(result, "sent");
  assert.equal(attempts, 3);
  assert.equal(isRetryableTelegramNetworkError(new Error("unexpected status 502")), true);
  assert.equal(isRetryableTelegramNetworkError(new Error("Bad Request: can't parse entities")), false);
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
  assert.deepEqual(buildRememberScopeKeyboard().inline_keyboard, [[
    { text: "global", callback_data: "memory:remember:scope:global" },
    { text: "bot", callback_data: "memory:remember:scope:bot" },
    { text: "auto", callback_data: "memory:remember:scope:auto" }
  ]]);
  assert.deepEqual(buildMemoryManageKeyboard().inline_keyboard, [
    [{ text: "升级为 global", callback_data: "memory:manage:promote" }],
    [{ text: "清空 bot 记忆", callback_data: "memory:manage:clear:bot" }],
    [{ text: "清空 global 记忆", callback_data: "memory:manage:clear:global" }]
  ]);
  assert.deepEqual(buildMemoryClearConfirmKeyboard("bot").inline_keyboard, [[
    { text: "确认清空", callback_data: "memory:manage:clear_confirm:bot" },
    { text: "取消", callback_data: "memory:manage:panel" }
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
  assert.deepEqual(getBaseBotCommands().map((item) => item.command), [
    "claude",
    "codex",
    "reset",
    "fresh",
    "cwd",
    "config",
    "usage",
    "remember",
    "forget",
    "memories",
    "memory",
    "pin",
    "unpin",
    "command",
    "terminal",
    "restart",
    "help"
  ]);
  assert.equal(getBaseBotCommands().find((item) => item.command === "reset")?.description, "重置会话信息");
  assert.equal(getBaseBotCommands().find((item) => item.command === "fresh")?.description, "清空聊天窗口");
  assert.equal(getBaseBotCommands().find((item) => item.command === "config")?.description, "查看或编辑 Bot 配置");
  assert.equal(getBaseBotCommands().find((item) => item.command === "usage")?.description, "查看当前会话额度");
  assert.equal(getBaseBotCommands().find((item) => item.command === "memories")?.description, "查看 Bot 记忆");
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

test("telegram custom commands remain executable beyond the menu limit", () => {
  const customCommands = Array.from({ length: 100 }, (_, index) => ({
    name: `custom_${index}`,
    params: [],
    template: `echo ${index}`,
    description: `custom ${index}`
  }));

  assert.equal(resolveMappedCommand("claude", "custom_99", customCommands)?.prompt, "/__custom_custom_99");
  const menuCommands = getChatBotCommands("claude", customCommands).map((item) => item.command);
  assert.ok(menuCommands.includes("custom_0"));
  assert.equal(menuCommands.length, 100);
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
    const handlers = new Map();
    registerDocumentHandler({
      on: (event, callback) => {
        handlers.set(event, callback);
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
      await handlers.get("message:document")({
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

test("telegram photo attachments are passed to the engine and removed after success", async () => {
  await withTempHome(async (tempDir) => {
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: tempDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      dbPath: path.join(tempDir, "telegram.sqlite")
    };
    const store = new SessionStore(config.dbPath);
    const manager = new SessionManager(store, config);
    const engineCalls = [];
    const engine = {
      name: "codex",
      execute: async (params) => {
        engineCalls.push(params);
        return { response: "图片已分析", provider: "test", model: "gpt-5.5" };
      },
      abort: () => undefined
    };
    const deps = {
      sessionManager: manager,
      claudeEngine: { ...engine, name: "claude" },
      codexEngine: engine,
      approvalManager: { request: async () => true, resolveAll: () => undefined },
      config
    };
    const handlers = new Map();
    registerDocumentHandler({ on: (event, callback) => handlers.set(event, callback) }, deps);

    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(Buffer.from([1, 2, 3, 4]));
    try {
      await handlers.get("message:photo")({
        message: {
          message_id: 42,
          photo: [{ file_id: "small" }, { file_id: "large", file_size: 4 }]
        },
        chat: { id: 123 },
        getFile: async () => ({ file_path: "photos/chart.jpg" }),
        reply: async () => undefined
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    const attached = manager.getOrCreate(123).attachments[0];
    assert.equal(attached.kind, "image");
    assert.equal(attached.mimeType, "image/jpeg");
    assert.equal(attached.sizeBytes, 4);
    await fs.stat(attached.path);

    const ok = await executePrompt({
      chat: { id: 123 },
      reply: async () => undefined,
      api: { sendChatAction: async () => true }
    }, deps, "这张图说明了什么？");
    assert.equal(ok, true);
    assert.deepEqual(engineCalls[0].imagePaths, [attached.path]);
    assert.match(engineCalls[0].prompt, /kind="image"/);
    await assert.rejects(fs.stat(attached.path), /ENOENT/);
    assert.deepEqual(manager.getOrCreate(123).attachments, []);
    store.close();
  });
});

test("editing the latest prompt reruns without the superseded native session", async () => {
  await withTempHome(async (tempDir) => {
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: tempDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      dbPath: path.join(tempDir, "telegram.sqlite")
    };
    const store = new SessionStore(config.dbPath);
    const manager = new SessionManager(store, config);
    const engineCalls = [];
    const engine = {
      name: "codex",
      execute: async (params) => {
        engineCalls.push(params);
        return {
          response: engineCalls.length === 1 ? "旧回答" : "新回答",
          sessionId: `session-${engineCalls.length}`,
          provider: "test",
          model: "gpt-5.5"
        };
      },
      abort: () => undefined
    };
    const handlers = new Map();
    registerMessageHandler({ on: (event, callback) => handlers.set(event, callback) }, {
      sessionManager: manager,
      claudeEngine: { ...engine, name: "claude" },
      codexEngine: engine,
      approvalManager: { request: async () => true, resolveAll: () => undefined },
      config
    });
    const context = {
      chat: { id: 123 },
      reply: async () => undefined,
      api: { sendChatAction: async () => true }
    };

    await handlers.get("message:text")({
      ...context,
      message: {
        message_id: 9,
        text: "旧问题",
        reply_to_message: { text: "<被引用内容>" }
      }
    });
    assert.equal(manager.getOrCreate(123).engineSessionId, "session-1");

    await handlers.get("edited_message:text")({
      ...context,
      editedMessage: {
        message_id: 9,
        text: "新问题",
        reply_to_message: { text: "<被引用内容>" }
      }
    });

    assert.equal(engineCalls.length, 2);
    assert.equal(engineCalls[1].resume, null);
    assert.doesNotMatch(engineCalls[1].prompt, /旧问题|旧回答/);
    assert.match(engineCalls[1].prompt, /新问题/);
    assert.match(engineCalls[1].prompt, /&lt;被引用内容&gt;/);
    assert.deepEqual(manager.getOrCreate(123).conversation.map((turn) => turn.user), ["新问题"]);
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

test("telegram executePrompt serializes tasks for the same chat", async () => {
  await withTempHome(async (tempDir) => {
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: tempDir,
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
    manager.update(session.id, { setupStep: "ready", engine: "codex" });

    let active = 0;
    let maxActive = 0;
    const prompts = [];
    const codexEngine = {
      name: "codex",
      execute: async (params) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        prompts.push(params.prompt);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return {
          response: `ok:${prompts.length}`,
          provider: "51talk-codex",
          model: "gpt-5.5"
        };
      },
      abort: () => undefined
    };
    const ctx = {
      chat: { id: 123 },
      reply: async () => undefined,
      api: { sendChatAction: async () => true }
    };
    const deps = {
      sessionManager: manager,
      claudeEngine: { ...codexEngine, name: "claude" },
      codexEngine,
      approvalManager: { request: async () => true },
      config
    };

    const results = await Promise.all([
      executePrompt(ctx, deps, "first"),
      executePrompt(ctx, deps, "second")
    ]);

    assert.deepEqual(results, [true, true]);
    assert.equal(maxActive, 1);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], "first");
    assert.match(prompts[1], /second/);
    assert.match(prompts[1], /first/);
    assert.equal(manager.getOrCreate(123).conversation.length, 2);
    store.close();
  });
});

test("telegram executePrompt streams progress and edits status message into result", async () => {
  await withTempHome(async (tempDir) => {
    const dbPath = path.join(tempDir, "telegram.sqlite");
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: tempDir,
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
    manager.update(session.id, { setupStep: "ready", engine: "codex" });

    const codexEngine = {
      name: "codex",
      execute: async (params) => {
        await params.onProgress?.({ phase: "thinking" });
        await sleep(8);
        await params.onProgress?.({ phase: "tool_calling", tool: "mcp__codegraph__codegraph_context" });
        await sleep(8);
        return {
          response: "ok",
          provider: "51talk-codex",
          model: "gpt-5.5"
        };
      },
      abort: () => undefined
    };

    const progressMessages = [];
    const progressEdits = [];
    const deleted = [];
    const replies = [];
    const ok = await executePrompt({
      chat: { id: 123 },
      reply: async (text) => {
        replies.push(text);
      },
      api: {
        sendChatAction: async () => true,
        sendMessage: async (_chatId, text) => {
          progressMessages.push(text);
          return { message_id: 44 };
        },
        editMessageText: async (_chatId, _messageId, text) => {
          progressEdits.push(text);
          return true;
        },
        deleteMessage: async (chatId, messageId) => {
          deleted.push([chatId, messageId]);
          return true;
        }
      }
    }, {
      sessionManager: manager,
      claudeEngine: { ...codexEngine, name: "claude" },
      codexEngine,
      approvalManager: { request: async () => true },
      config
    }, "执行一个长任务", undefined, { progressThrottleMs: 5 });

    assert.equal(ok, true);
    assert.equal(progressMessages.length, 1);
    assert.match(progressMessages[0], /思考中/);
    assert.equal(progressEdits.length, 2);
    assert.match(progressEdits[0], /调用 MCP/);
    assert.match(progressEdits[1], /✅[\s\S]*完成[\s\S]*ok/);
    assert.deepEqual(deleted, []);
    assert.equal(replies.length, 0);
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

test("model command opens telegram provider picker without starting CLI", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProviders([
      {
        name: "codex-provider",
        baseUrl: "https://api.test/v1",
        apiKey: "key",
        mode: "auto",
        level: 1,
        model: "gpt-5.5"
      }
    ]);
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: projectDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      provider: "codex-provider",
      model: "gpt-5.5",
      dbPath: path.join(tempDir, "telegram.sqlite")
    };
    const store = new SessionStore(config.dbPath);
    const manager = new SessionManager(store, config);
    const session = manager.getOrCreate(123);
    manager.update(session.id, { setupStep: "ready" });
    let executeCalls = 0;
    const fakeEngine = {
      name: "codex",
      execute: async () => {
        executeCalls += 1;
        return { response: "unexpected" };
      },
      abort: () => undefined
    };
    const commands = new Map();
    registerCommands({
      command: (name, callback) => commands.set(name, callback),
      api: { setMyCommands: async () => true }
    }, {
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
    await commands.get("model")({
      chat: { id: 123 },
      reply: async (text, extra) => {
        replies.push({ text, extra });
      }
    });

    assert.equal(executeCalls, 0);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, "🤖 重新选择你要使用的大模型吧");
    assert.equal(replies[0].extra.reply_markup.inline_keyboard[0][0].text, "codex-provider");
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

test("telegram terminal command requires confirmation for dangerous shell input", async () => {
  await withTempHome(async (tempDir) => {
    const config = {
      token: "token",
      allowAllUsers: false,
      allowedUserIds: [123],
      defaultEngine: "codex",
      defaultCwd: tempDir,
      defaultPermissionMode: "bypassPermissions",
      sessionTimeoutHours: 24,
      maxOutputLength: 4000,
      dbPath: path.join(tempDir, "telegram.sqlite")
    };
    const store = new SessionStore(config.dbPath);
    const manager = new SessionManager(store, config);
    const commands = new Map();
    let approvalRequests = 0;
    const engine = { name: "codex", execute: async () => ({ response: "ok" }), abort: () => undefined };
    registerCommands({
      command: (name, callback) => commands.set(name, callback),
      api: { setMyCommands: async () => true }
    }, {
      sessionManager: manager,
      claudeEngine: { ...engine, name: "claude" },
      codexEngine: engine,
      engines: { claude: { ...engine, name: "claude" }, codex: engine },
      approvalManager: {
        request: async () => {
          approvalRequests += 1;
          return false;
        },
        resolveAll: () => undefined
      },
      config
    });
    const replies = [];
    await commands.get("terminal")({
      chat: { id: 123 },
      match: "rm -rf /tmp/should-not-run",
      reply: async (text) => replies.push(text)
    });
    assert.equal(approvalRequests, 1);
    assert.match(String(replies.at(-1)), /已取消高风险终端命令/);
    assert.equal(manager.getOrCreate(123).status, "idle");
    store.close();
  });
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

test("codex failure formatter preserves upstream status after benign stderr", () => {
  const formatted = formatCodexFailure([
    "Reading additional input from stdin...",
    "status_code=524, bad response status code 524"
  ].join("\n"), "provider", "gpt-5.6-sol");
  assert.doesNotMatch(formatted, /Reading additional input/);
  assert.match(formatted, /status_code=524/);
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

test("codex args attach multiple images to the prompt", () => {
  const args = buildCodexArgs(
    "分析图片",
    "gpt-5.5",
    "/tmp/project",
    "default",
    undefined,
    "session-1",
    ["/tmp/a.png", "/tmp/b.jpg"]
  );
  assert.deepEqual(args.filter((item) => item === "--image"), ["--image", "--image"]);
  assert.equal(args.includes("/tmp/a.png"), true);
  assert.equal(args.includes("/tmp/b.jpg"), true);
  assert.equal(args.at(-1), "分析图片");
});

test("claude failure formatter extracts the terminal result instead of system init", () => {
  const message = formatClaudeFailure([
    JSON.stringify({ type: "system", subtype: "init", tools: ["Read", "Edit"] }),
    JSON.stringify({ type: "system", subtype: "api_retry", attempt: 10 }),
    JSON.stringify({
      type: "result",
      is_error: true,
      result: "API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)"
    })
  ].join("\n"), "", 1);
  assert.equal(message, "API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)");
  assert.doesNotMatch(message, /system|tools|api_retry/);
});

test("json line accumulator preserves events split across stdout chunks", () => {
  const events = [];
  const parser = createJsonLineAccumulator((event) => events.push(event));
  parser.push('{"type":"assis');
  parser.push('tant","text":"你好"}\n{"type":"res');
  parser.push('ult","result":"完成"}');
  parser.end();
  assert.deepEqual(events, [
    { type: "assistant", text: "你好" },
    { type: "result", result: "完成" }
  ]);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
