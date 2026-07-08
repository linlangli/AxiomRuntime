# AI Gateway 技术架构文档

## 1. 项目概览

AI Gateway (`ai-gateway`) 是一个本地 AI Provider 网关，统一管理多个 AI 服务提供商（OpenAI 兼容 API），为 Claude Code 和 Codex CLI 提供透明的路由、故障转移和用量追踪能力。同时集成了 Hermes（另一个 AI 网关）和 Telegram Bot 作为远程交互入口。

```
用户
 ├── CLI (ai use / ai add / ai status ...)
 ├── Telegram Bot (远程对话)
 └── Hermes (定时任务 / 多机器人)
         │
    ┌────┴────┐
    │ AI Gateway │
    └────┬────┘
         │
   ┌─────┼─────┐
   ▼     ▼     ▼
Provider Provider Provider
(OpenRouter/自建/...)
```

## 2. 系统架构

### 2.1 模块分层

```
src/
├── cli/                    # 表现层 - CLI 命令与交互
│   ├── commands/           # 各子命令实现
│   ├── output/             # 输出格式化 (table)
│   └── prompts/            # 交互式选择器
├── core/                   # 核心领域层
│   ├── config/             # 配置持久化 (JSON/SQLite)
│   ├── context/            # 项目上下文注入
│   ├── hermes/             # Hermes 集成
│   ├── integrations/       # 集成状态管理
│   ├── logs/               # 日志服务
│   ├── models/             # 模型发现与过滤
│   ├── providers/          # Provider 健康检查与刷新
│   ├── reports/            # 会话报告生成
│   ├── runner/             # 工具执行引擎 (核心)
│   ├── sessions/           # CLI 会话管理
│   ├── status/             # 状态诊断
│   ├── usage/              # Token 用量追踪与计费
│   └── types.ts            # 全局类型定义
└── telegram/               # Telegram Bot 子系统
    ├── engine/             # Claude/Codex 执行引擎
    ├── handlers/           # 消息/命令/回调处理
    ├── interaction/        # UI 交互 (键盘/审批/格式化)
    ├── session/            # SQLite 会话管理
    └── templates/          # 消息模板
```

### 2.2 核心数据流

**CLI 使用流程 (`ai use`)：**

```
用户选择 → resolveProviderForTool() → runTool()
                │                          │
                ▼                          ▼
        fallback.ts                  tool-runner.ts
   (Provider 优先级排序,             (构建环境变量,
    健康检查过滤,                   生成临时 Claude settings,
    模型兼容性匹配)                  spawn 子进程)
                                          │
                                          ▼
                                   child_process.spawn
                                   (claude / codex)
```

**Telegram 执行流程：**

```
Telegram Update → Grammy middleware (鉴权)
    → Handler 路由
    → SessionManager.getOrCreate()
    → Engine.execute() (ClaudeEngine / CodexEngine)
        → prepareEngineRuntime() (复用 core runner 逻辑)
        → spawnCapture() (headless 模式, 捕获 JSON stream)
        → parseClaudeOutput() → 发送回复
```

### 2.3 关键设计决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 配置存储 | JSON 文件 (`~/.ai-gateway/`) | 无依赖，便于手动编辑和版本控制 |
| Telegram 会话 | SQLite (`better-sqlite3`) | 需要查询、索引、并发安全 |
| 工具执行 | `child_process.spawn` | 需要完整 TTY 继承（CLI 模式）或 JSON stream 捕获（headless） |
| 用量追踪 | 本地 HTTP 代理 (`openai-usage-proxy`) | 透明拦截 Codex 请求，无需修改工具本身 |
| Hermes 集成 | YAML 配置同步 + launchd 重启 | 适配 Hermes 原生配置格式 |
| 模型路由 | 优先级 + 健康检查 + 兼容性过滤 | 自动故障转移，无需人工干预 |

### 2.4 核心类型体系

```typescript
Provider          // 服务商配置 (name, baseUrl, apiKey, model, mode, level)
ProviderCache     // 缓存状态 (health, models[], lastCheckedAt)
UsageEvent        // 用量事件 (tokens, provider, model, source)
SessionRecord     // CLI 会话记录
TelegramSession   // Telegram 会话 (SQLite 持久化)
HermesRobot       // Hermes 机器人配置 (provider, model, tasks[], telegram)
```

## 3. 子系统详解

### 3.1 Runner 引擎

`src/core/runner/` 是核心执行层：

- **command-resolver.ts** — 查找本地 CLI 二进制路径 (`which` + 已知候选路径)
- **tool-runner.ts** — 构建运行环境、注入 API 密钥、管理临时文件生命周期
- **fallback.ts** — Provider 候选排序：健康检查 → 模型兼容性 → 优先级
- **openai-usage-proxy.ts** — 本地 HTTP 代理，拦截 OpenAI 协议请求并提取 token 用量；支持 Responses API → Chat Completions 的协议转换

### 3.2 Telegram Bot

基于 `grammy` 框架，特点：

- 双引擎 (Claude / Codex)，headless JSON stream 模式
- SQLite 会话持久化，支持多 chat 并发
- 权限审批机制 (dangerous command confirmation)
- 工作目录管理、会话历史恢复
- Provider 用量追踪（每个 session 独立统计）

### 3.3 Hermes 集成

与本地 Hermes 实例的双向同步：

- AI Gateway providers → Hermes config.yaml
- 本地 Hermes 配置 → AI Gateway 导入
- 支持 launchd / CLI 两种重启方式
- Robot 管理（CRUD、导入导出、Provider 切换联动）

## 4. 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript (ESM, Node.js ≥ 22) |
| 构建 | tsc (零打包器) |
| 运行时 | Node.js |
| Telegram | grammy ^1.44 |
| 数据库 | better-sqlite3 (仅 Telegram 会话) |
| HTTP | undici (provider 健康检查), node:http (proxy) |
| 网络代理 | https-proxy-agent |
| Claude SDK | @anthropic-ai/claude-code (Telegram headless) |
| 测试 | node:test (内置) |

## 5. 优化建议

### 5.1 架构层面

**P0 - 高优先级**

1. **hermes-service.ts 文件过大（1800+ 行）**
   - 当前将 YAML 解析、Provider 同步、Robot CRUD、导入导出、配置修复全部堆在一个文件
   - 建议拆分为：`hermes-yaml.ts` (YAML 操作)、`hermes-sync.ts` (同步逻辑)、`hermes-import.ts` (导入导出)、`hermes-repair.ts` (自修复)

2. **缺少错误边界与重试机制**
   - Provider 健康检查和 Telegram engine 执行没有重试逻辑
   - 建议在 `fallback.ts` 的 `resolveProviderForTool` 中加入运行时故障转移（当前只在选择阶段排除 error 状态的 provider，运行时失败后不会自动切换）

3. **配置热更新**
   - 当前 JSON 文件每次操作都重新读取/写入，无缓存无锁
   - 多进程（Telegram + CLI）并发操作同一文件有数据竞争风险
   - 建议至少加文件锁（`proper-lockfile`），或统一用 SQLite 管理所有持久化

**P1 - 中优先级**

4. **OpenAI Usage Proxy 可观测性不足**
   - 代理错误静默吞掉 (`catch(() => undefined)`)，应接入结构化日志
   - 缺少请求延迟、失败率等指标收集

5. **命令解析缺少框架**
   - `cli/index.ts` 使用 raw `switch` 路由，参数靠手动解析 `args[]`
   - 如果命令继续增长，建议引入轻量 CLI 框架（如 `citty` 或 `clerc`）

6. **Telegram Session 缺少并发控制**
   - 同一 chat 快速连续发消息可能触发多个 engine 进程
   - SessionManager 虽有 `status` 字段，但没有 mutex/队列机制

### 5.2 代码质量

7. **`isRecord` 辅助函数重复定义**
   - 至少在 `tool-runner.ts`、`hermes-service.ts`、`claude-engine.ts`、`providers-store.ts` 各有一份
   - 应抽为共享 util

8. **类型安全改进**
   - `normalizeProviderShape` 中大量 `as Partial<Provider>` 断言可以用 `zod` 或 `valibot` 替代
   - Hermes 导入导出也是手动校验，缺乏 schema validation

9. **测试覆盖**
   - 当前 `test/` 目录在 build 后用 `node --test` 运行
   - 核心逻辑（fallback 策略、proxy 协议转换、YAML 解析）应增加单元测试

### 5.3 性能

10. **Provider 健康检查串行执行**
    - `refreshAllProviders` 逐个检查可以改为 `Promise.allSettled` 并发

11. **Usage 文件追加写入**
    - `usage.json` 用 readAll → append → writeAll 模式，事件增多后 I/O 开销线性增长
    - 建议改为 append-only JSONL 格式或迁移到 SQLite

12. **Telegram Bot 启动时同步刷新所有 chat 菜单**
    - `refreshStoredChatCommandMenus` 对大量活跃 session 是 O(n) 的 API 调用，应限流或延迟

### 5.4 安全

13. **临时 Claude settings 文件权限**
    - 已正确设置 `0o600`，做得好
    - 但 `os.tmpdir()` 在共享主机环境下仍有被枚举风险，建议用 `mkdtemp` 创建私有目录

14. **Telegram 鉴权粒度**
    - 当前只支持 userId allowlist 或 allowAll
    - 建议增加命令级别权限控制（如只允许查询不允许执行）
