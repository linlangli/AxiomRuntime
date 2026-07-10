# Telegram Bot 集成开发规格书

## 概述

在现有 `ai-gateway` 仓库中新增 Telegram Bot 模块，通过 Telegram 远程控制 Claude Code 和 Codex CLI 的全部能力。Bot 作为 `ai` CLI 的子命令管理（启动、停止、配置），共享仓库的配置体系和日志系统。

## 设计原则

1. **仓库内集成** — Bot 代码在 `src/telegram/` 下，与现有 `src/core/`、`src/cli/` 平级
2. **CLI 管理** — 通过 `ai telegram start|stop|status|config` 控制 Bot 生命周期
3. **能力完整** — 100% 覆盖 Claude Code 和 Codex CLI 的工具调用、权限模式、会话管理
4. **交互映射** — 所有 CLI 交互（权限确认、模式切换）映射为 Telegram inline button
5. **美观输出** — 格式化消息模板，支持代码块、diff、进度指示、折叠长输出

## 技术栈

- **现有**: Node.js 20+, TypeScript ESM，Claude Code/Codex/Hermes 作为外部本机 CLI
- **新增依赖**:
  - `grammy` — Telegram Bot 框架（轻量、TS 原生）
  - `better-sqlite3` — Bot 会话持久化

---

## 项目结构变更

```
ai-gateway/
├── src/
│   ├── cli/
│   │   ├── index.ts              # 新增 "telegram" case
│   │   └── commands/
│   │       └── telegram.ts       # ai telegram start|stop|status|config
│   ├── core/                     # 现有核心逻辑（不动）
│   └── telegram/                 # 【新增】Telegram Bot 模块
│       ├── index.ts              # Bot 入口（可独立进程运行）
│       ├── bot.ts                # Grammy 实例 + middleware 注册
│       ├── config.ts             # Bot 配置（token、白名单等）
│       ├── engine/
│       │   ├── types.ts          # 引擎公共接口
│       │   ├── claude-engine.ts  # Claude Code CLI 子进程封装
│       │   └── codex-engine.ts   # Codex CLI 子进程封装
│       ├── handlers/
│       │   ├── message.ts        # 文本消息 → 引擎调度
│       │   ├── callback.ts       # Inline button 回调处理
│       │   ├── command.ts        # Bot 命令 (/start /help /mode 等)
│       │   └── document.ts       # 文件上传处理
│       ├── interaction/
│       │   ├── approval.ts       # 权限审批队列 + Telegram button
│       │   ├── formatter.ts      # 输出格式化（代码块、diff、进度）
│       │   └── keyboards.ts      # Inline keyboard 构建器
│       ├── session/
│       │   ├── manager.ts        # 会话生命周期（创建、恢复、销毁）
│       │   └── store.ts          # SQLite 持久化
│       └── templates/
│           └── messages.ts       # 美观消息模板
├── test/
│   └── telegram/                 # Bot 测试
│       ├── claude-engine.test.ts
│       ├── codex-engine.test.ts
│       └── approval.test.ts
└── package.json                  # 新增 grammy 等依赖
```

---

## CLI 集成（`src/cli/commands/telegram.ts`）

Bot 通过 `ai telegram` 子命令管理，作为后台进程运行。

### 命令设计

```bash
ai telegram start          # 启动 Bot（后台 daemon）
ai telegram stop           # 停止 Bot
ai telegram status         # 查看 Bot 运行状态
ai telegram config         # 交互式配置（token、白名单等）
ai telegram config set <key> <value>   # 直接设置配置项
ai telegram logs           # 查看 Bot 日志（最近 50 行）
ai telegram logs -f        # 实时跟踪日志
```

### 实现方式

```typescript
// src/cli/commands/telegram.ts
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { getPaths } from '../../core/config/paths.js';

export async function runTelegramCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case 'start':
      await startBot();
      break;
    case 'stop':
      await stopBot();
      break;
    case 'status':
      await showStatus();
      break;
    case 'config':
      await configBot(rest);
      break;
    case 'logs':
      await showLogs(rest);
      break;
    default:
      console.log('Usage: ai telegram <start|stop|status|config|logs>');
  }
}

async function startBot(): Promise<void> {
  const pidFile = getPidFilePath();
  if (await isRunning(pidFile)) {
    console.log('✅ Bot 已在运行中');
    return;
  }

  // Fork 子进程运行 Bot
  const child = fork(
    resolve(import.meta.dirname, '../../telegram/index.js'),
    [],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  // 写入 PID 文件
  await writePid(pidFile, child.pid!);
  console.log(`🤖 Telegram Bot 已启动 (PID: ${child.pid})`);
}

async function stopBot(): Promise<void> {
  const pidFile = getPidFilePath();
  const pid = await readPid(pidFile);
  if (!pid) {
    console.log('⚠️ Bot 未在运行');
    return;
  }
  process.kill(pid, 'SIGTERM');
  await removePid(pidFile);
  console.log('⏹️ Bot 已停止');
}
```

### 配置存储

Bot 配置复用现有 `json-store.ts` 机制，存储在 `~/.ai-gateway/telegram.json`：

```json
{
  "token": "123456:ABC-DEF...",
  "allowedUserIds": [123456789],
  "defaultEngine": "claude",
  "defaultCwd": "/Users/user/projects",
  "defaultPermissionMode": "bypassPermissions",
  "sessionTimeoutHours": 24,
  "maxOutputLength": 4000
}
```

---

## 核心模块设计

### 1. 引擎接口 (`telegram/engine/types.ts`)

两个引擎共享统一接口，方便切换。

```typescript
export interface ExecutionResult {
  sessionId?: string;
  response: string;
  toolCalls?: ToolCallResult[];
  filesChanged?: string[];
  diff?: string;
  cost?: number;
  duration?: number;
}

export interface ToolCallResult {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  status: 'success' | 'error';
}

export interface PermissionRequest {
  id: string;
  tool: string;
  description: string;
  command?: string;        // Bash 命令（如果是 Bash 工具）
  filePath?: string;       // 文件路径（如果是文件工具）
  params: Record<string, unknown>;
}

export type PermissionHandler = (req: PermissionRequest) => Promise<boolean>;

export interface EngineExecuteParams {
  chatId: number;
  prompt: string;
  cwd: string;
  resume?: string;
  permissionMode?: string;
  allowedTools?: string[];
  onPermission: PermissionHandler;
  onProgress?: (update: ProgressUpdate) => void;
  signal?: AbortSignal;
}

export interface ProgressUpdate {
  phase: 'thinking' | 'tool_calling' | 'writing' | 'done';
  message?: string;
  tool?: string;
}

export interface Engine {
  name: string;
  execute(params: EngineExecuteParams): Promise<ExecutionResult>;
  abort(chatId: number): void;
}
```

---

### 2. Claude Code Engine (`telegram/engine/claude-engine.ts`)

通过外部 `claude` CLI 子进程执行。AI Gateway 负责解析本机 CLI、生成临时 settings 注入 provider 环境变量、捕获 `stream-json` 输出，并把 Telegram 侧的权限模式映射为 Claude Code 启动参数。

```typescript
import { spawn } from 'node:child_process';

export class ClaudeEngine implements Engine {
  readonly name = 'claude';
  private processes: Map<number, ChildProcess> = new Map();

  async execute(params: EngineExecuteParams): Promise<ExecutionResult> {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', params.model,
      params.prompt,
    ];
    const child = spawn('claude', args, {
      cwd: params.cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_HEADLESS: '1',
        ANTHROPIC_API_KEY: params.provider.apiKey,
        ANTHROPIC_BASE_URL: params.provider.baseUrl,
      },
    });
    this.processes.set(params.chatId, child);
    return captureAndParseClaudeOutput(child);
  }

  abort(chatId: number): void {
    this.processes.get(chatId)?.kill('SIGTERM');
    this.processes.delete(chatId);
  }
}
```

**Claude Code 完整能力覆盖清单**:
- ✅ 多轮对话 (sessionId resume)
- ✅ 所有内置工具 (Read, Write, Edit, Bash, Agent, WebFetch, WebSearch, NotebookEdit)
- ✅ MCP 服务器工具调用
- ✅ 权限拦截与远程审批
- ✅ 子 Agent 调度
- ✅ permission mode 切换 (default / acceptEdits / bypassPermissions)
- ✅ 工作目录切换
- ✅ 会话历史恢复 (resume)
- ✅ 执行中断 (AbortController)
- ✅ CLAUDE.md 配置自动加载
- ✅ 自定义 allowedTools
- ✅ maxTurns 控制

---

### 3. Codex Engine (`telegram/engine/codex-engine.ts`)

Codex 通过子进程调用，完整支持三种审批模式。

```typescript
import { spawn, type ChildProcess } from 'node:child_process';

type CodexApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';

export class CodexEngine implements Engine {
  readonly name = 'codex';
  private processes: Map<number, ChildProcess> = new Map();

  async execute(params: EngineExecuteParams): Promise<ExecutionResult> {
    const approvalMode = this.mapPermissionMode(params.permissionMode);
    const startTime = Date.now();

    const args = [
      '--approval-mode', approvalMode,
      '--quiet',
      '--output-format', 'json',
    ];
    args.push(params.prompt);

    return new Promise((resolve, reject) => {
      const proc = spawn('codex', args, {
        cwd: params.cwd,
        env: { ...process.env },
        signal: params.signal,
      });

      this.processes.set(params.chatId, proc);

      let stdout = '';
      let stderr = '';

      proc.stdout!.on('data', (chunk) => {
        stdout += chunk.toString();
        // 解析流式 JSON 事件，发送进度
        this.parseStreamEvents(chunk.toString(), params.onProgress);
      });

      proc.stderr!.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        this.processes.delete(params.chatId);
        if (code === 0) {
          resolve(this.parseOutput(stdout, Date.now() - startTime));
        } else {
          reject(new Error(stderr || `Codex exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        this.processes.delete(params.chatId);
        reject(err);
      });
    });
  }

  abort(chatId: number): void {
    const proc = this.processes.get(chatId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(chatId);
    }
  }

  private mapPermissionMode(mode?: string): CodexApprovalMode {
    switch (mode) {
      case 'bypassPermissions': return 'full-auto';
      case 'acceptEdits': return 'auto-edit';
      default: return 'suggest';
    }
  }

  private parseOutput(raw: string, duration: number): ExecutionResult {
    try {
      const data = JSON.parse(raw);
      return {
        response: data.summary ?? data.message ?? raw,
        toolCalls: data.actions?.map((a: any) => ({
          tool: a.type,
          input: a.input ?? {},
          output: a.output ?? '',
          status: a.status ?? 'success',
        })),
        filesChanged: data.files_changed ?? [],
        duration,
      };
    } catch {
      return { response: raw, duration };
    }
  }

  private parseStreamEvents(chunk: string, onProgress?: (u: ProgressUpdate) => void): void {
    if (!onProgress) return;
    // Codex 输出的每一行可能是一个 JSON 事件
    for (const line of chunk.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'tool_call') {
          onProgress({ phase: 'tool_calling', tool: event.tool });
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
  }
}
```

**Codex 完整能力覆盖清单**:
- ✅ 代码生成与修改
- ✅ 三种审批模式 (suggest / auto-edit / full-auto)
- ✅ 沙箱执行
- ✅ 多模型切换
- ✅ 流式事件解析
- ✅ 执行中断

---

### 4. 权限审批交互 (`telegram/interaction/approval.ts`)

CLI 的每一个权限 prompt 映射为 Telegram inline button，阻塞等待用户响应。

```typescript
import { InlineKeyboard, type Bot } from 'grammy';
import type { PermissionRequest } from '../engine/types.js';

interface PendingApproval {
  id: string;
  chatId: number;
  messageId?: number;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

export class ApprovalManager {
  private pending = new Map<string, PendingApproval>();
  private readonly TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟超时自动拒绝

  constructor(private bot: Bot) {}

  async request(chatId: number, req: PermissionRequest): Promise<boolean> {
    const id = req.id;
    const text = this.formatMessage(req);
    const keyboard = this.buildKeyboard(id);

    const msg = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.expire(id, msg.message_id, chatId);
        resolve(false);
      }, this.TIMEOUT_MS);

      this.pending.set(id, {
        id,
        chatId,
        messageId: msg.message_id,
        resolve,
        timeout,
      });
    });
  }

  resolve(id: string, approved: boolean): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    entry.resolve(approved);
    this.pending.delete(id);
    // 更新消息状态
    this.updateMessage(entry, approved);
  }

  resolveAll(chatId: number, approved: boolean): void {
    for (const [id, entry] of this.pending) {
      if (entry.chatId === chatId) {
        clearTimeout(entry.timeout);
        entry.resolve(approved);
        this.pending.delete(id);
        this.updateMessage(entry, approved);
      }
    }
  }

  private buildKeyboard(id: string): InlineKeyboard {
    return new InlineKeyboard()
      .text('✅ 允许', `perm:approve:${id}`)
      .text('❌ 拒绝', `perm:deny:${id}`)
      .row()
      .text('✅ 后续全部允许', `perm:approve_all:${id}`)
      .text('⏭️ 跳过此工具', `perm:skip:${id}`);
  }

  private formatMessage(req: PermissionRequest): string {
    const lines = [
      `🔐 <b>权限请求</b>`,
      ``,
      `🔧 <b>工具:</b> <code>${esc(req.tool)}</code>`,
    ];

    if (req.command) {
      lines.push(`💻 <b>命令:</b>`);
      lines.push(`<pre>${esc(truncate(req.command, 300))}</pre>`);
    } else if (req.filePath) {
      lines.push(`📄 <b>文件:</b> <code>${esc(req.filePath)}</code>`);
    }

    if (req.description) {
      lines.push(`📋 ${esc(truncate(req.description, 200))}`);
    }

    lines.push(``, `⏰ <i>5分钟内未响应将自动拒绝</i>`);
    return lines.join('\n');
  }

  private async updateMessage(entry: PendingApproval, approved: boolean): Promise<void> {
    if (!entry.messageId) return;
    const status = approved ? '✅ 已允许' : '❌ 已拒绝';
    try {
      await this.bot.api.editMessageReplyMarkup(entry.chatId, entry.messageId, {
        reply_markup: new InlineKeyboard().text(status, 'noop'),
      });
    } catch { /* 消息可能已过期 */ }
  }

  private expire(id: string, messageId: number, chatId: number): void {
    this.pending.delete(id);
    this.bot.api.editMessageReplyMarkup(chatId, messageId, {
      reply_markup: new InlineKeyboard().text('⏰ 已超时', 'noop'),
    }).catch(() => {});
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
```

---

### 5. 消息模板 (`telegram/templates/messages.ts`)

美观、信息密度高、适配 Telegram HTML。

```typescript
import type { ExecutionResult, ProgressUpdate } from '../engine/types.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

export const Msg = {
  // ━━━━━━ 任务生命周期 ━━━━━━

  taskStarted(engine: string, prompt: string): string {
    const icon = engine === 'claude' ? '🤖' : '⚡';
    return [
      `${icon} <b>${engine === 'claude' ? 'Claude Code' : 'Codex'}</b>`,
      ``,
      `┌ 📝 <i>${esc(truncate(prompt, 120))}</i>`,
      `└ ⏳ 处理中...`,
    ].join('\n');
  },

  taskProgress(update: ProgressUpdate): string {
    const icons: Record<string, string> = {
      thinking: '⏱️ 思考中',
      tool_calling: '🔧 调用工具',
      writing: '✍️ 编写中',
      done: '✅ 完成',
    };
    const base = icons[update.phase] ?? '⏳ 处理中';
    return update.tool ? `${base}: <code>${esc(update.tool)}</code>` : base;
  },

  taskCompleted(result: ExecutionResult): string {
    const parts: string[] = [];

    parts.push(`✅ <b>完成</b>`);

    // 主要响应
    if (result.response) {
      parts.push(``);
      parts.push(esc(truncate(result.response, 2500)));
    }

    // 变更文件列表
    if (result.filesChanged?.length) {
      parts.push(``);
      parts.push(`📁 <b>变更文件:</b>`);
      for (const f of result.filesChanged.slice(0, 10)) {
        parts.push(`  ├ <code>${esc(f)}</code>`);
      }
      if (result.filesChanged.length > 10) {
        parts.push(`  └ <i>...还有 ${result.filesChanged.length - 10} 个文件</i>`);
      }
    }

    // 工具调用摘要
    if (result.toolCalls?.length) {
      parts.push(``);
      parts.push(`🔧 <b>工具调用:</b> ${result.toolCalls.length} 次`);
      const summary = new Map<string, number>();
      for (const tc of result.toolCalls) {
        summary.set(tc.tool, (summary.get(tc.tool) ?? 0) + 1);
      }
      const items = [...summary.entries()].map(([t, n]) => `<code>${t}</code>×${n}`);
      parts.push(`  ${items.join(' · ')}`);
    }

    // 底部元信息
    const meta: string[] = [];
    if (result.duration) meta.push(`⏱ ${(result.duration / 1000).toFixed(1)}s`);
    if (result.cost) meta.push(`💰 $${result.cost.toFixed(4)}`);
    if (meta.length) {
      parts.push(``);
      parts.push(`<i>${meta.join(' · ')}</i>`);
    }

    return parts.join('\n');
  },

  taskFailed(error: string): string {
    return [
      `❌ <b>执行失败</b>`,
      ``,
      `<pre>${esc(truncate(error, 1500))}</pre>`,
    ].join('\n');
  },

  taskAborted(): string {
    return `⏹️ <b>已终止</b>`;
  },

  // ━━━━━━ 代码与 Diff ━━━━━━

  codeBlock(code: string, lang?: string): string {
    const content = truncate(code, 3500);
    return `<pre><code class="language-${lang ?? ''}">${esc(content)}</code></pre>`;
  },

  diffBlock(diff: string): string {
    const lines = diff.split('\n').slice(0, 40);
    const formatted = lines.map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) return line;
      if (line.startsWith('+')) return `+ ${line.slice(1)}`;
      if (line.startsWith('-')) return `- ${line.slice(1)}`;
      return `  ${line}`;
    }).join('\n');
    return `<pre>${esc(formatted)}</pre>`;
  },

  // ━━━━━━ 会话 ━━━━━━

  sessionInfo(session: {
    id: string;
    engine: string;
    cwd: string;
    permissionMode: string;
    messageCount: number;
    createdAt: string;
  }): string {
    return [
      `📋 <b>当前会话</b>`,
      ``,
      `┌ 🆔 <code>${session.id.slice(0, 8)}</code>`,
      `├ 🤖 引擎: <code>${session.engine}</code>`,
      `├ 📂 目录: <code>${esc(session.cwd)}</code>`,
      `├ 🔒 模式: <code>${session.permissionMode}</code>`,
      `├ 💬 消息: ${session.messageCount}`,
      `└ ⏱️ 创建: ${session.createdAt}`,
    ].join('\n');
  },

  // ━━━━━━ 帮助 ━━━━━━

  help(): string {
    return [
      `🤖 <b>AI CLI Telegram Bot</b>`,
      ``,
      `<b>━━ 基本使用 ━━</b>`,
      `直接发消息即与默认引擎对话`,
      ``,
      `<b>━━ 命令 ━━</b>`,
      `/claude <code>指令</code> — Claude Code 执行`,
      `/codex <code>指令</code> — Codex 执行`,
      `/mode <code>模式</code> — 权限模式`,
      `/cwd <code>路径</code> — 工作目录`,
      `/new — 新建会话`,
      `/resume — 恢复上次会话`,
      `/stop — 终止执行`,
      `/session — 会话详情`,
      `/history — 历史会话`,
      `/config — 设置面板`,
      ``,
      `<b>━━ 权限模式 ━━</b>`,
      `<code>default</code> — 逐一审批`,
      `<code>auto-edit</code> — 自动允许文件编辑`,
      `<code>full-auto</code> — 全自动（危险操作仍确认）`,
      ``,
      `<b>━━ 快捷操作 ━━</b>`,
      `• 回复消息 → 追加上下文`,
      `• 发送文件 → 附加为上下文`,
      `• /stop → 立即终止`,
    ].join('\n');
  },

  // ━━━━━━ 设置面板 ━━━━━━

  configPanel(config: {
    engine: string;
    permissionMode: string;
    cwd: string;
  }): string {
    return [
      `⚙️ <b>设置</b>`,
      ``,
      `🤖 引擎: <code>${config.engine}</code>`,
      `🔒 模式: <code>${config.permissionMode}</code>`,
      `📂 目录: <code>${esc(config.cwd)}</code>`,
    ].join('\n');
  },

  welcome(name: string): string {
    return [
      `👋 你好 <b>${esc(name)}</b>`,
      ``,
      `我是 AI CLI Bot，可以远程控制 Claude Code 和 Codex。`,
      `直接发消息开始，或输入 /help 查看命令。`,
    ].join('\n');
  },
};
```

---

### 6. 会话管理 (`telegram/session/manager.ts`)

每个 Telegram user/chat 对应独立的 AI 会话。

```typescript
import type { SessionStore } from './store.js';

export interface Session {
  id: string;
  chatId: number;
  engine: 'claude' | 'codex';
  engineSessionId?: string;    // Claude Code 的 sessionId（用于 resume）
  cwd: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions';
  approveAll: boolean;         // 用户点了"后续全部允许"
  status: 'idle' | 'running' | 'waiting_approval';
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
}

export class SessionManager {
  constructor(private store: SessionStore) {}

  getOrCreate(chatId: number, defaults: Partial<Session>): Session {
    const existing = this.store.getByChatId(chatId);
    if (existing && existing.status !== 'idle') return existing;
    if (existing) {
      this.store.touch(existing.id);
      return existing;
    }
    return this.store.create({
      chatId,
      engine: (defaults.engine ?? 'claude') as Session['engine'],
      cwd: defaults.cwd ?? process.env.DEFAULT_CWD ?? process.cwd(),
      permissionMode: (defaults.permissionMode ?? 'default') as Session['permissionMode'],
      approveAll: false,
      status: 'idle',
      messageCount: 0,
    });
  }

  update(id: string, patch: Partial<Session>): void {
    this.store.update(id, patch);
  }

  newSession(chatId: number): Session {
    // 关闭旧会话，开启新的
    this.store.closeByChatId(chatId);
    return this.getOrCreate(chatId, {});
  }

  getHistory(chatId: number, limit = 10): Session[] {
    return this.store.listByChatId(chatId, limit);
  }
}
```

---

### 7. Bot 主体 (`telegram/bot.ts`)

```typescript
import { Bot, session } from 'grammy';
import { loadTelegramConfig } from './config.js';
import { ClaudeEngine } from './engine/claude-engine.js';
import { CodexEngine } from './engine/codex-engine.js';
import { ApprovalManager } from './interaction/approval.js';
import { SessionManager } from './session/manager.js';
import { SessionStore } from './session/store.js';
import { registerCommands } from './handlers/command.js';
import { registerMessageHandler } from './handlers/message.js';
import { registerCallbackHandler } from './handlers/callback.js';
import { registerDocumentHandler } from './handlers/document.js';

export async function createBot() {
  const config = loadTelegramConfig();
  const bot = new Bot(config.token);

  // 基础设施
  const store = new SessionStore(config.dbPath);
  const sessionManager = new SessionManager(store);
  const claudeEngine = new ClaudeEngine();
  const codexEngine = new CodexEngine();
  const approvalManager = new ApprovalManager(bot);

  // 鉴权 middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !config.allowedUserIds.includes(userId)) {
      await ctx.reply('⛔ 无权限使用此 Bot');
      return;
    }
    return next();
  });

  // 注册各 handler
  registerCommands(bot, { sessionManager, config });
  registerCallbackHandler(bot, { approvalManager, sessionManager });
  registerDocumentHandler(bot, { sessionManager });
  registerMessageHandler(bot, {
    sessionManager,
    claudeEngine,
    codexEngine,
    approvalManager,
    config,
  });

  return bot;
}
```

---

### 8. 消息处理流程 (`telegram/handlers/message.ts`)

```typescript
import type { Context, Bot } from 'grammy';
import { Msg } from '../templates/messages.js';
import type { ApprovalManager } from '../interaction/approval.js';
import type { SessionManager, Session } from '../session/manager.js';
import type { Engine, ProgressUpdate } from '../engine/types.js';

export function registerMessageHandler(bot: Bot, deps: {
  sessionManager: SessionManager;
  claudeEngine: Engine;
  codexEngine: Engine;
  approvalManager: ApprovalManager;
  config: any;
}) {
  bot.on('message:text', async (ctx) => {
    // 跳过命令（以 / 开头的已被 command handler 处理）
    if (ctx.message.text.startsWith('/')) return;

    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const session = deps.sessionManager.getOrCreate(chatId, deps.config);

    // 防止重入
    if (session.status === 'running') {
      await ctx.reply('⏳ 任务执行中，请等待完成或发送 /stop 终止');
      return;
    }

    // 发送状态消息
    const statusMsg = await ctx.reply(Msg.taskStarted(session.engine, text), {
      parse_mode: 'HTML',
    });

    // 标记运行中
    deps.sessionManager.update(session.id, {
      status: 'running',
      messageCount: session.messageCount + 1,
    });

    try {
      const engine = session.engine === 'claude' ? deps.claudeEngine : deps.codexEngine;

      // 进度更新（编辑状态消息）
      let lastUpdate = 0;
      const onProgress = async (update: ProgressUpdate) => {
        const now = Date.now();
        if (now - lastUpdate < 2000) return; // 节流：2秒最多更新一次
        lastUpdate = now;
        try {
          await ctx.api.editMessageText(
            chatId, statusMsg.message_id,
            Msg.taskStarted(session.engine, text) + '\n\n' + Msg.taskProgress(update),
            { parse_mode: 'HTML' }
          );
        } catch { /* 编辑失败忽略 */ }
      };

      const result = await engine.execute({
        chatId,
        prompt: text,
        cwd: session.cwd,
        resume: session.engineSessionId,
        permissionMode: session.permissionMode,
        onPermission: async (req) => {
          if (session.approveAll) return true;
          deps.sessionManager.update(session.id, { status: 'waiting_approval' });
          const approved = await deps.approvalManager.request(chatId, req);
          deps.sessionManager.update(session.id, { status: 'running' });
          return approved;
        },
        onProgress,
      });

      // 保存引擎会话 ID
      deps.sessionManager.update(session.id, {
        engineSessionId: result.sessionId,
        status: 'idle',
      });

      // 删除状态消息，发送结果
      await ctx.api.deleteMessage(chatId, statusMsg.message_id);
      await sendResult(ctx, result);

    } catch (error: any) {
      deps.sessionManager.update(session.id, { status: 'idle' });
      await ctx.api.deleteMessage(chatId, statusMsg.message_id);

      if (error.name === 'AbortError') {
        await ctx.reply(Msg.taskAborted(), { parse_mode: 'HTML' });
      } else {
        await ctx.reply(Msg.taskFailed(error.message), { parse_mode: 'HTML' });
      }
    }
  });
}

async function sendResult(ctx: Context, result: ExecutionResult): Promise<void> {
  const text = Msg.taskCompleted(result);

  // 短消息直接发
  if (text.length <= 4000) {
    await ctx.reply(text, { parse_mode: 'HTML' });
    return;
  }

  // 长消息：摘要 + 文件
  const summary = [
    `✅ <b>完成</b>`,
    ``,
    result.filesChanged?.length
      ? `📁 变更 ${result.filesChanged.length} 个文件`
      : `💬 输出过长，详见附件`,
  ].join('\n');

  await ctx.reply(summary, { parse_mode: 'HTML' });

  // 完整输出作为文件
  const { InputFile } = await import('grammy');
  const buffer = Buffer.from(result.response, 'utf-8');
  await ctx.replyWithDocument(
    new InputFile(buffer, 'output.md'),
    { caption: '📄 完整输出' }
  );

  // Diff 单独发送
  if (result.diff) {
    const diffBuf = Buffer.from(result.diff, 'utf-8');
    await ctx.replyWithDocument(
      new InputFile(diffBuf, 'changes.diff'),
      { caption: '📝 变更详情' }
    );
  }
}
```

---

### 9. Callback 处理 (`telegram/handlers/callback.ts`)

处理所有 inline button 点击。

```typescript
import type { Bot } from 'grammy';
import type { ApprovalManager } from '../interaction/approval.js';
import type { SessionManager } from '../session/manager.js';

export function registerCallbackHandler(bot: Bot, deps: {
  approvalManager: ApprovalManager;
  sessionManager: SessionManager;
}) {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // 权限审批回调: perm:approve:<id> / perm:deny:<id> / perm:approve_all:<id>
    if (data.startsWith('perm:')) {
      const [, action, id] = data.split(':');

      if (action === 'approve') {
        deps.approvalManager.resolve(id!, true);
        await ctx.answerCallbackQuery({ text: '✅ 已允许' });
      } else if (action === 'deny') {
        deps.approvalManager.resolve(id!, false);
        await ctx.answerCallbackQuery({ text: '❌ 已拒绝' });
      } else if (action === 'approve_all') {
        deps.approvalManager.resolve(id!, true);
        deps.sessionManager.update(
          deps.sessionManager.getOrCreate(chatId, {}).id,
          { approveAll: true }
        );
        await ctx.answerCallbackQuery({ text: '✅ 后续操作将自动允许' });
      } else if (action === 'skip') {
        deps.approvalManager.resolve(id!, false);
        await ctx.answerCallbackQuery({ text: '⏭️ 已跳过' });
      }
      return;
    }

    // 设置面板回调: config:engine:claude / config:mode:full-auto 等
    if (data.startsWith('config:')) {
      const [, category, value] = data.split(':');
      const session = deps.sessionManager.getOrCreate(chatId, {});

      if (category === 'engine') {
        deps.sessionManager.update(session.id, { engine: value as any });
        await ctx.answerCallbackQuery({ text: `已切换到 ${value}` });
      } else if (category === 'mode') {
        deps.sessionManager.update(session.id, { permissionMode: value as any });
        await ctx.answerCallbackQuery({ text: `模式: ${value}` });
      }

      // 更新设置面板消息
      await ctx.editMessageText(Msg.configPanel({
        engine: value === 'engine' ? value : session.engine,
        permissionMode: category === 'mode' ? value! : session.permissionMode,
        cwd: session.cwd,
      }), { parse_mode: 'HTML', reply_markup: buildConfigKeyboard(session) });
      return;
    }

    await ctx.answerCallbackQuery();
  });
}
```

---

### 10. Bot 命令 (`telegram/handlers/command.ts`)

```typescript
import { InlineKeyboard, type Bot } from 'grammy';
import { Msg } from '../templates/messages.js';
import type { SessionManager } from '../session/manager.js';

export function registerCommands(bot: Bot, deps: {
  sessionManager: SessionManager;
  config: any;
}) {
  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name ?? 'there';
    await ctx.reply(Msg.welcome(name), { parse_mode: 'HTML' });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(Msg.help(), { parse_mode: 'HTML' });
  });

  // /claude <prompt> — 强制用 Claude Code
  bot.command('claude', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    deps.sessionManager.update(session.id, { engine: 'claude' });
    // 触发消息处理（移除 /claude 前缀）
    ctx.message!.text = ctx.match;
    // 让 message handler 接管
  });

  // /codex <prompt> — 强制用 Codex
  bot.command('codex', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    deps.sessionManager.update(session.id, { engine: 'codex' });
    ctx.message!.text = ctx.match;
  });

  // /mode <mode>
  bot.command('mode', async (ctx) => {
    const mode = ctx.match.trim();
    const validModes = ['default', 'auto-edit', 'acceptEdits', 'full-auto', 'bypassPermissions'];
    if (!validModes.includes(mode)) {
      await ctx.reply(`❌ 无效模式。可选: <code>${validModes.join(' | ')}</code>`, {
        parse_mode: 'HTML',
      });
      return;
    }
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    deps.sessionManager.update(session.id, { permissionMode: mode as any });
    await ctx.reply(`🔒 权限模式已切换为: <code>${mode}</code>`, { parse_mode: 'HTML' });
  });

  // /cwd <path>
  bot.command('cwd', async (ctx) => {
    const cwd = ctx.match.trim();
    if (!cwd) {
      const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
      await ctx.reply(`📂 当前目录: <code>${session.cwd}</code>`, { parse_mode: 'HTML' });
      return;
    }
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    deps.sessionManager.update(session.id, { cwd });
    await ctx.reply(`📂 工作目录已切换: <code>${cwd}</code>`, { parse_mode: 'HTML' });
  });

  // /new — 新建会话
  bot.command('new', async (ctx) => {
    deps.sessionManager.newSession(ctx.chat.id);
    await ctx.reply('🆕 已创建新会话');
  });

  // /stop — 终止当前任务
  bot.command('stop', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    if (session.status === 'idle') {
      await ctx.reply('💤 当前没有运行中的任务');
      return;
    }
    // 通过 engine abort
    // Engine 实例需要从外部注入或通过事件通知
    await ctx.reply(Msg.taskAborted(), { parse_mode: 'HTML' });
  });

  // /session — 查看当前会话
  bot.command('session', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    await ctx.reply(Msg.sessionInfo({
      id: session.id,
      engine: session.engine,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      messageCount: session.messageCount,
      createdAt: session.createdAt,
    }), { parse_mode: 'HTML' });
  });

  // /config — 设置面板
  bot.command('config', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    const keyboard = new InlineKeyboard()
      .text('🤖 Claude', 'config:engine:claude')
      .text('⚡ Codex', 'config:engine:codex')
      .row()
      .text('🔓 default', 'config:mode:default')
      .text('✏️ auto-edit', 'config:mode:acceptEdits')
      .text('🚀 full-auto', 'config:mode:bypassPermissions')
      .row()
      .text('🆕 新会话', 'config:action:new')
      .text('📂 改目录', 'config:action:cwd');

    await ctx.reply(Msg.configPanel({
      engine: session.engine,
      permissionMode: session.permissionMode,
      cwd: session.cwd,
    }), { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // /history — 历史会话
  bot.command('history', async (ctx) => {
    const sessions = deps.sessionManager.getHistory(ctx.chat.id, 10);
    if (!sessions.length) {
      await ctx.reply('📭 暂无历史会话');
      return;
    }
    const lines = sessions.map((s, i) =>
      `${i + 1}. <code>${s.id.slice(0, 8)}</code> · ${s.engine} · ${s.messageCount}条 · ${s.createdAt}`
    );
    await ctx.reply(`📜 <b>历史会话</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  // /resume [id] — 恢复会话
  bot.command('resume', async (ctx) => {
    const targetId = ctx.match.trim();
    if (!targetId) {
      // 恢复最近的会话
      const sessions = deps.sessionManager.getHistory(ctx.chat.id, 1);
      if (!sessions.length) {
        await ctx.reply('📭 没有可恢复的会话');
        return;
      }
      await ctx.reply(`♻️ 已恢复会话 <code>${sessions[0]!.id.slice(0, 8)}</code>`, {
        parse_mode: 'HTML',
      });
      return;
    }
    await ctx.reply(`♻️ 已恢复会话 <code>${targetId}</code>`, { parse_mode: 'HTML' });
  });
}
```

---

## 安全设计

### 鉴权

- **白名单制**：只有 `allowedUserIds` 列表中的 Telegram user ID 才能使用
- **配置加密**：token 存储在本地 `~/.ai-gateway/telegram.json`，文件权限 600
- **无远程配置**：所有配置只能通过本机 `ai telegram config` 修改

### 危险操作强制确认

即使在 `bypassPermissions` / `full-auto` 模式下，以下操作仍发 inline button 确认：

```typescript
const ALWAYS_CONFIRM_PATTERNS = [
  /rm\s+(-rf?|--recursive)/,
  /git\s+push\s+.*--force/,
  /git\s+reset\s+--hard/,
  /DROP\s+(TABLE|DATABASE)/i,
  /sudo\s+/,
  /chmod\s+777/,
  />\s*\/dev\//,
];
```

---

## 依赖变更 (package.json)

在现有 package.json 中新增：

```json
{
  "dependencies": {
    "grammy": "^1.30.0",
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

---

## CLI 入口变更

在 `src/cli/index.ts` 的 switch 中新增：

```typescript
case "telegram":
  await runTelegramCommand(args);
  break;
```

---

## 实现优先级

### Phase 1 — 核心链路 (MVP)

1. `src/telegram/` 目录初始化 + 类型定义
2. `telegram/config.ts` — 读取 `~/.ai-gateway/telegram.json`
3. `telegram/engine/claude-engine.ts` — Claude Code CLI 子进程封装
4. `telegram/bot.ts` — Grammy 实例 + 鉴权 middleware
5. `telegram/handlers/message.ts` — 消息 → 引擎 → 返回结果
6. `telegram/interaction/approval.ts` — 权限请求 → inline button
7. `telegram/handlers/callback.ts` — 按钮回调处理
8. `telegram/templates/messages.ts` — 格式化输出
9. `src/cli/commands/telegram.ts` — `ai telegram start|stop|status`
10. 接入 CLI 入口

### Phase 2 — 引擎与会话

11. `telegram/engine/codex-engine.ts` — Codex 子进程封装
12. `telegram/session/store.ts` — SQLite 持久化
13. `telegram/session/manager.ts` — 会话生命周期
14. `telegram/handlers/command.ts` — 全部 Bot 命令
15. 长消息分片 + 文件发送

### Phase 3 — 体验优化

16. 进度更新（编辑消息显示当前阶段）
17. `telegram/handlers/document.ts` — 文件上传作为上下文
18. `/config` 设置面板 inline keyboard
19. 错误重试 + 超时处理
20. `ai telegram logs` 日志查看

---

## 关键注意事项

### Claude Code CLI

- 设置环境变量 `CLAUDE_CODE_HEADLESS=1`，确保无 TTY 也能运行
- 通过临时 settings 和环境变量注入 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`
- 使用 `--output-format stream-json --verbose` 获取结构化输出
- 每次执行后解析 CLI 输出中的 session id，用于下次 resume 多轮对话
- 通过终止子进程实现 /stop

### Codex CLI

- `--quiet --output-format json` 获取结构化输出
- 通过 `spawn` 的 `signal` 选项传入 AbortSignal
- `cwd` 在 spawn 时指定
- 没有官方的会话恢复机制，每次是独立执行

### Telegram 限制

- 单条消息 ≤ 4096 字符
- 消息编辑频率约 30 次/分钟（进度更新需节流）
- HTML parse_mode 只支持有限标签
- Bot 在群组中需要 @ 提及或设置 privacy mode off

### 进程管理

- Bot 作为 detached 子进程运行
- PID 文件存储在 `~/.ai-gateway/telegram.pid`
- SIGTERM 优雅关闭（finish pending, cleanup）
- 崩溃时通过 `ai telegram status` 检测并重启

---

## 测试策略

```bash
# 构建
npm run build

# 单元测试
npm test -- --filter telegram

# 手动测试 checklist
- [ ] ai telegram config set token <token>
- [ ] ai telegram start → Bot 在线
- [ ] 发消息 → Claude Code 执行 → 返回结果
- [ ] 触发权限请求 → inline button 出现
- [ ] 点击允许 → 继续执行
- [ ] 点击拒绝 → 终止该工具调用
- [ ] /stop → 终止执行中的任务
- [ ] /codex <指令> → Codex 执行
- [ ] /mode full-auto → 切换后不再请求权限
- [ ] /cwd /tmp → 后续任务在 /tmp 执行
- [ ] /new → 清除上下文
- [ ] /resume → 恢复多轮对话
- [ ] 超长输出 → 文件附件发送
- [ ] ai telegram stop → Bot 下线
- [ ] ai telegram status → 显示运行状态
```
