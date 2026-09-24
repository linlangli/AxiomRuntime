# AxiomRuntime

> 一条命令管理 Claude Code 和 Codex CLI 的多 Provider 运行环境。

AxiomRuntime 是一个以 CLI 为核心的本地 AI Runtime 基础层。它不提供模型，也不替代 Claude Code 或 Codex CLI，而是把多个 Provider（官方 API、中转站或其他兼容服务）集中管理，再以**每次进程独立注入**的方式启动原生 CLI。

它最适合这样的工作方式：同时开多个终端窗口，每个窗口使用不同的 Provider 或模型；需要时再从 Telegram 远程启动任务。窗口之间互不覆盖配置，AxiomRuntime 也不会接管你的原生 Claude Code / Codex 配置。

## 先看实现状态

README 需要区分“已经能用”和“只是规划”。下面的状态以当前仓库代码和 npm `0.0.4` 为准：

| 标记 | 含义 |
|---|---|
| ✅ | 已实现，并随 npm `0.0.4` 提供 |
| 🟡 | 有可用实现，但能力范围或接入面仍有限制 |
| 🚧 | 尚未实现，仅代表后续方向 |

| 能力 | npm `0.0.4` | 当前源码 | 说明 |
|---|---:|---:|---|
| Provider 增删改查、模型发现、优先级 | ✅ | ✅ | `ai provider`、`ai status` |
| Claude Code / Codex 启动与运行时 fallback | ✅ | ✅ | 按健康度、兼容模型和 `level` 选择 |
| 多窗口使用不同 Provider，互不影响 | ✅ | ✅ | 配置只注入对应子进程 |
| 不修改原生 Claude / Codex 配置 | ✅ | ✅ | `ai use` 的默认行为 |
| 用量统计、成本展示、会话和报告 | ✅ | ✅ | 记录新产生的请求，不补录历史 |
| Telegram 远程执行与多 Bot 隔离 | ✅ | ✅ | 带进度、审批、附件和 Provider 管理 |
| 图片生成 | ✅ | ✅ | OpenAI-compatible Images API |
| `ai set codex` 持久配置 Codex App | ✅ | ✅ | 这是显式修改原生配置的命令 |
| 本地 HTTP Runtime API | ✅ | ✅ | Bearer 鉴权，适合本机集成 |
| Telegram 显式记忆 | 🟡 | 🟡 | `/remember` 等命令可用，普通聊天不会自动记忆 |
| 自动记忆、向量检索、终端记忆 | 🚧 | 🚧 | embedding 配置已就绪，入库和召回尚未接入 |
| 加密凭证、Skill 沉淀、学习治理、插件和 Web 界面 | 🚧 | 🚧 | 仍是后续路线，不要按已实现能力使用 |

如果你通过 npm 安装，实际可用的是 npm `0.0.4` 那一列；README 会随功能发布同步更新。

## 它解决什么问题

### 1. Provider 管理从“手改配置”变成一条命令

你可以把多个 API Provider 放进统一配置中，记录名称、Base URL、API Key、默认模型、模式和优先级：

```bash
ai provider add main https://api.example.com sk-xxx
ai provider add backup https://backup.example.com sk-yyy
ai provider list
ai models main
ai check main
ai status
```

添加时会测试连通性、探测模型并建立缓存。`ai use` 会根据 Provider 健康状态、当前 CLI 可兼容的模型和 `level` 顺序选择候选；实际子进程非零退出时，还会继续尝试下一个 Provider。

### 2. 多开窗口，每个窗口使用不同 Provider

这是 AxiomRuntime 的核心使用体验：

```bash
# 窗口 A：主力 Provider
ai use claude main

# 窗口 B：备用 Provider + 指定模型
ai use claude backup claude-opus-4-6

# 窗口 C：Codex 使用另一家 Provider
ai use codex fenno gpt-5.5
```

每次 `ai use` 都为对应子进程单独准备路由和凭证。不同窗口的 Provider、模型和运行状态不会互相覆盖；并行数量只受本机资源和上游额度影响。

### 3. 与 Claude Code、Codex 的原生配置保持独立

`ai use` 是临时注入，不是全局切换：

- **Claude Code**：生成临时 `--settings` 文件，注入 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY` 和模型，进程结束后清理；不修改 `~/.claude/settings.json`。
- **Codex CLI**：通过本次进程的 `-c model_provider=...`、Provider 的 `base_url` 和 `env_key`，配合进程级 `OPENAI_API_KEY` 环境变量完成路由；不修改全局 `auth.json` 或 `config.toml`。Codex 本身也支持环境变量，AxiomRuntime 只是把它们限制在当前进程内。
- **直接运行原生命令**：你仍然可以直接执行 `claude` 或 `codex`，它们继续使用自己的原生配置，不受 `ai use` 影响。

只有明确执行 `ai set codex` 时，AxiomRuntime 才会按你的选择持久写入 Codex 配置。这个命令与日常的临时启动是两条不同路径。

### 4. Telegram 远程控制

在手机上发一条消息，让本机的 Claude Code 或 Codex 执行任务，并把进度、结果、文件和图片发回 Telegram。它不是完成通知，而是一个真正的远程执行入口：

- 多 Bot 配置、进程、日志、会话数据库相互隔离
- 默认白名单鉴权；高风险 `/terminal` 命令必须二次确认
- 长任务编辑同一条进度消息，显示阶段、工具和回答预览
- 支持附件、图片、最近对话、引用和固定上下文
- `/provider` 可直接在手机上查看、添加、编辑、删除和检查 Provider
- Telegram 使用同一套顶层 Provider 配置和用量账本，不维护另一套路由规则

### 5. 看见用量，而不是凭感觉猜成本

Claude Code 和 Codex 的请求会经过本次执行专属的本地用量代理。Runtime 读取 Provider 返回的真实 token 和成本，写入同一份 `usage.json`：

- 有 Provider 返回的 `cost_usd` 时优先使用真实成本
- 只有 token、没有成本时，才按 `model-pricing.json` 估算
- 没有价格配置时显示未知，不伪造精确数字
- 安装 AxiomRuntime 之前产生的历史请求不会被扫描补录

## 已发布功能

### 安装与初始化

运行环境要求 Node.js `22.19.0` 或更高版本，Node.js 20 不支持。Claude Code 和 Codex CLI 是外部依赖，不会被打包进 AxiomRuntime。

```bash
node --version
npm install --global @offerpilot/axiomruntime
ai --version
ai setup
```

`ai setup` 会创建 `~/.ai-gateway/`，引导添加第一个 Provider，测试连通性、探测模型，并询问是否安装缺失的 Claude Code / Codex。

无人值守场景可以使用：

```bash
ai setup --yes --skip-tools
ai setup --yes --install-tools
ai setup --skip-provider
```

如果 npm 报 `EBADENGINE`，请先升级 Node.js，再重新安装，不要忽略警告继续运行。

### Provider、启动与诊断

```bash
ai add                                             # 交互式添加 Provider
ai provider add <name> <base-url> <api-key> [model] # /models 不可用时可显式指定模型验证
ai provider list                                   # 只读配置，不联网
ai provider edit
ai provider delete <name>

ai models [provider]                              # GET /models 后列出完整模型；省略名称时交互选择
ai check [provider]                               # 单独真实验证一个 Provider；省略名称时交互选择
ai status                                          # 真实验证 Claude/Codex 可用性、刷新模型缓存和用量
ai use claude [provider] [model]
ai use codex [provider] [model]
ai last                                            # 沿用上次选择
ai doctor                                          # 检查并安全修复内部状态
```

`ai status` 会先执行不消耗 Token 的模型发现，再为每个 Provider 最多选择一个 Claude 和一个 Codex 代表模型做真实调用；请求使用最短输入、输出上限为 1 Token，且不会自动重试产生 Token 的请求。代表模型最多等待 30 秒；如果本地超时但上游可能已经完成，状态显示为 `unknown`，不会误判为 Provider 不可用。`ai doctor` 可以重建缺失或损坏的缓存、用量和会话文件，但 Provider 配置无效时只报告，不会覆盖凭证。

如果 Provider 不开放 `GET /models`，交互式 `ai add` 会提示输入官网给出的模型名并直接验证对应协议；脚本可将模型作为第四个参数传入。只有真实模型请求成功才会保存配置，Runtime 不会自动猜测模型名。

### 会话、日志、上下文与图片

```bash
ai session list
ai session resume <session-id>
ai session clear
ai report
ai report --print <session-id>
ai log --print 100
ai context --print

ai image                                          # 交互选择 Provider、模型和提示词
ai image <provider> "一只戴墨镜的猫"
ai image <provider> <model> "数字插画"
```

图片生成调用已配置 Provider 的 OpenAI-compatible `/v1/images/generations`。`b64_json` 会以 `0600` 权限保存到当前目录；远程 `https` 图片只输出 URL，不会自动下载不受信任的地址。图片请求最长等待 120 秒，失败后会尝试下一个兼容 Provider。

### AI Runtime 代理

```bash
ai proxy                                      # 交互输入主机/IP与端口
ai proxy 127.0.0.1 8081                       # 自动补为 http://127.0.0.1:8081
ai proxy http://127.0.0.1:8081                # 也兼容完整 URL
ai proxy off                                  # 清除
```

该代理保存在 `~/.ai-gateway/runtime.json`，用于 AxiomRuntime 自身请求，以及通过 `ai use` 启动的 Claude Code / Codex。它不会修改两个原生 CLI 的永久配置；本地 execution-scoped Transport Proxy 会自动加入 `NO_PROXY`，避免代理回环。

### Codex App 的持久配置

如果需要让 Codex App 或直接执行的 `codex` 持续使用某个 Provider，显式运行：

```bash
ai set codex provider <provider> <gpt-model>
ai set codex provider <provider>
ai set codex chatgpt
ai set codex proxy 127.0.0.1:7890
ai set codex proxy off
```

这条命令会原子更新 Codex 的 `config.toml` / `auth.json`，保留无关配置，失败时回滚；macOS 上会尝试重启 Codex App，并清理重启进程继承的 `OPENAI_API_KEY`，避免旧凭证覆盖刚选择的 Provider。切换到自定义 Provider 会替换当前 ChatGPT token，切回官方账号时需要重新登录。

### Telegram Bot

```bash
ai telegram add ops
ai telegram config set token <bot-token> --bot ops
ai telegram config set allowedUserIds <telegram-user-id> --bot ops
ai telegram start --bot ops
```

常用管理命令：

```bash
ai telegram list
ai telegram status --bot ops
ai telegram logs --bot ops -f
ai telegram edit --bot ops
ai telegram stop --bot ops
ai telegram delete --bot ops
```

Bot 中可使用 `/claude`、`/codex`、`/reset`、`/fresh`、`/cwd`、`/config`、`/provider`、`/usage`、`/remember`、`/forget`、`/memories`、`/pin`、`/unpin`、`/terminal`、`/restart` 和 `/help`。如果本机无法直连 Telegram API，可在新增或编辑 Bot 时按提示分别输入代理主机/IP与端口；也兼容直接设置完整地址：

```bash
ai telegram config set proxyUrl http://127.0.0.1:7890 --bot ops
```

## 🟡 记忆：现在能做什么、不能做什么

当前记忆能力只接入 Telegram，且以**显式操作**为主：

```text
/remember 记住：这个项目使用 pnpm
/memories
/forget <memory-id>
```

已经实现：

- Telegram 中的 `global` / `bot` 两级 scope
- 显式新增、查看、删除和固定记忆
- 最近会话与可见记忆注入当前 Telegram prompt
- SQLite 存储和短期记忆 TTL
- embedding Provider 的配置和连通性检查

尚未实现：

- 普通聊天自动抽取和自动写入
- 终端 `ai use` 的记忆接入
- 向量入库、向量召回和语义搜索
- Claim / Evidence 权威账本、多源召回、冲突与时序处理
- credential 类记忆的安全存储

因此，`ai memory embedding` 目前只是为未来检索准备模型配置；它不会让当前记忆自动变成向量搜索。

## 本地 Runtime API

从源码构建后，可以启动带 Bearer 鉴权的本地 HTTP 服务：

```bash
npm install
npm run build
AI_GATEWAY_SERVER_TOKEN='replace-me' npm run server
```

已实现路由：

| 路由 | 用途 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容对话 |
| `POST /v1/responses` | OpenAI Responses 协议 |
| `POST /v1/embeddings` | 向量化接口 |
| `GET /v1/models` | 当前模型列表 |
| `POST /v1/agent/runs` | 受控的 Claude/Codex Agent Run |

服务只接受受控 `workspace_id`，默认只读，限制请求体、并发和执行时长；不提供任意目录访问，也不提供 `bypassPermissions`。

## 配置文件与安全边界

默认配置目录是 `~/.ai-gateway/`，可以用 `AI_GATEWAY_HOME` 覆盖：

```text
~/.ai-gateway/providers.json       Provider 配置
~/.ai-gateway/runtime.json         Runtime 代理等运行配置
~/.ai-gateway/.ai-cache.json       模型缓存、健康状态和上次选择
~/.ai-gateway/usage.json           用量账本
~/.ai-gateway/model-pricing.json   本地成本估算价格
~/.ai-gateway/sessions.json        CLI 会话记录
~/.ai-gateway/memory.json          embedding 配置
~/.ai-gateway/memory.sqlite        Telegram 记忆
~/.ai-gateway/telegram/bots/       多 Bot 配置、PID、日志和数据库
~/.ai-gateway/reports/             会话报告
~/.ai-gateway/.ai-gateway.log      结构化日志
```

请注意：

- `providers.json` 和 `memory.json` 中的 API Key 当前仍是明文保存。请限制目录权限，绝不要提交到仓库；加密凭证库尚未实现。
- `ai use` 的临时注入文件会在进程结束后清理；`ai set codex` 是例外，因为它就是明确的持久配置操作。
- 配置写入使用文件锁、临时文件和原子重命名，降低 CLI 与 Telegram 并发写入时损坏文件的风险。
- 日志不会记录完整 API Key，但会记录脱敏指纹；Provider 名称、模型和部分运行元数据会进入日志。
- root 用户运行 Claude 的自动权限模式时，Runtime 会收紧权限，不会传递官方禁止 root 使用的危险参数。
- Telegram 默认只允许白名单用户；如果显式开启 `allowAllUsers`，任何能访问 Bot 的人都可能在你的机器上执行命令。

## 🚧 尚未实现与未来路线

以下内容不要按当前功能使用：

1. **更完整的记忆**：自动抽取、向量检索、终端接入、Claim / Evidence、冲突和时序治理。
2. **可复用能力沉淀**：把经过验证的重复流程沉淀为 Skill 或 Workflow，并支持评测、激活和回滚。
3. **统一 Runtime 契约**：统一 CLI、Telegram、HTTP 的身份、权限、事件、取消、幂等和恢复语义。
4. **更完整的安全能力**：加密凭证、登录态托管、细粒度策略和可审计的权限决策。
5. **更多接入面**：Web、桌面、调度和插件体系。当前 `ai web` 只是占位命令。

这些是产品路线，不是已经发布的功能。README、使用指南和产品文档会继续按 🟢 / 🟡 / 🔴 状态同步。

## 开发

```bash
npm install
npm run build
npm test
npm link
```

完整命令说明见：

- [使用指南](./docs/usage.md)
- [技术架构](./docs/architecture.md)
- [产品需求文档](./docs/prd.md)
- [HTML 命令手册](./docs/USAGE.html)

## 许可

本项目当前未在 README 中声明开源许可证。使用前请以仓库中的许可证文件和项目发布说明为准。
