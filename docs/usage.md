# AI Runtime 使用指南（doc_2.0）

> 从旧 `USAGE.md` 迁入的用户操作手册。语言中英混合（叙述中文，命令与标识符英文原样）。面向使用者，不是架构规范；架构见 [00-overview.md](00-overview.md)。

当前 `ai` 命令提供 AI Runtime 的 Gateway 基础能力，包括 Provider 管理、Claude Code/Codex 执行、Telegram、会话、用量和诊断。Runtime 的学习、Skill、Capability 与组织级治理能力会沿用同一命令和核心架构逐步接入。

本指南只描述当前已经可用的用户操作。项目定位和未来能力见 [文档总览](README.md)。

## 内网服务

`npm run server` 启动常驻 Runtime API。必须设置 `AI_GATEWAY_SERVER_TOKEN` 或 `AI_GATEWAY_SERVER_TOKEN_FILE`；生产建议使用后者。可配置 `AI_GATEWAY_SERVER_HOST/PORT`、`AI_GATEWAY_MAX_REQUEST_BYTES`、`AI_GATEWAY_UPSTREAM_HEADERS_TIMEOUT_MS`、`AI_GATEWAY_AGENT_WORKSPACE_ROOT`、`AI_GATEWAY_AGENT_MAX_CONCURRENT_RUNS` 与 `AI_GATEWAY_AGENT_TIMEOUT_MS`。

模型调用使用 `/v1/chat/completions`、`/v1/responses` 或 `/v1/embeddings`。需要 Claude/Codex CLI 工具能力时使用 `/v1/agent/runs`，传入 `engine`、`prompt`、`workspace_id`，可选 `provider/model`；`permission_mode` 仅支持默认的 `read_only` 或显式 `workspace_write`。服务端 API 不提供 `bypassPermissions`。

## 运行环境

- Node.js `22.19.0` 或更高版本；Node.js 20 不受支持。
- 安装依赖前可运行 `node --version` 检查版本。
- Claude Code 与 Codex 是外部 CLI，按需独立安装。

## 进入交互模式

```bash
ai
```

进入交互式操作。

## 打开帮助页面

```bash
ai help
```

打开 `docs/USAGE.html` 使用指南。

## 使用 Claude Code 或 Codex

使用默认 provider 和默认模型：

```bash
ai use claude
ai use codex
```

指定 provider：

```bash
ai use claude 51talk
ai use codex 51talk
```

指定 provider 和模型：

```bash
ai use claude 51talk claude-opus-4-6
ai use codex 51talk gpt-5.5
```

规则：

- 不指定 provider 时，使用 `level: 1` 的 provider。
- 不指定模型时，使用该 provider 的默认 `model`。
- Codex 兼容 `gpt`、`codex`、`grok`、`o` 系列和 `openai` 模型名。
- 当前 provider 不可用时，按 `level` 自动降级。
- 启动 Claude Code 时，AI Gateway 会生成临时 `--settings` 文件，把 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL` 写入 settings 的 `env` 后启动；不会修改 `~/.claude/settings.json`，也不会使用 `--bare`。
- provider 的 `mode` 为 `auto` 时，启动 Claude Code 会追加 `--dangerously-skip-permissions`；`ask` 模式不会追加该参数，并会在启动前确认。
- 启动 Codex 时，AI Gateway 会通过本次子进程的 `-c model_provider=...` 参数固定所选 provider，并用 `env_key = "OPENAI_API_KEY"` 读取本次注入的 API Key。Codex 全局 `auth.json`、`config.toml` 和直接执行 `codex` 的流程不会被修改。
- 如果 provider 的 `baseUrl` 是 OpenAI 兼容地址，例如 `https://icode.51talk.biz/v1`，启动 Claude Code 时会自动注入 `https://icode.51talk.biz`；启动 Codex 时仍使用 `/v1`。
- 启动记录会写入日志，包含 provider、baseUrl、模型、启动参数和 API Key 指纹，不包含完整 API Key。

## Telegram Bot

配置：

```bash
ai telegram config
ai telegram config show
ai telegram config set token <bot-token>
ai telegram config set allowAllUsers true
ai telegram config set allowedUserIds 123456789,987654321
ai telegram config set defaultEngine claude
ai telegram config set defaultPermissionMode bypassPermissions
ai telegram config set defaultCwd /path/to/project
ai telegram config set proxyUrl http://127.0.0.1:7890
```

启动和管理：

```bash
ai telegram start
ai telegram status
ai telegram logs
ai telegram logs -f
ai telegram doctor
ai telegram stop
```

说明：

- 配置保存在 `~/.ai-gateway/telegram.json`，会话保存在 `~/.ai-gateway/telegram.sqlite`。
- 默认只允许 `allowedUserIds` 里的 Telegram 用户访问；如果要开放给所有用户，显式设置 `allowAllUsers: true`。
- Telegram 远程执行 Claude Code/Codex 时复用 AI Gateway 顶层 provider；可通过 `provider` 和 `model` 配置固定 provider/model，不配置则按 `ai use` 同样的优先级自动选择。
- 首次 `/start` 或执行 `/reset` 会进入初始化流程：先选择 Provider/Model，再选择工作路径并自动确定 Claude Code/Codex。
- 工作路径步骤直接以按钮列出最多 8 个历史绝对路径，并在末尾提供“自定义”，不再先点击“已存在”。自定义路径固定创建或复用 `~/输入名称`。
- 未确定工作路径时发送普通内容会提示先确定工作路径；未确定 CLI 时发送普通内容会提示先选择 CLI。
- 选择 CLI 后只展示会话 ID、工作路径、CLI、provider、model 和权限模式。
- Bot 基础命令菜单包含 `/claude`、`/codex`、`/reset`、`/fresh`、`/cwd`、`/config`、`/usage`、Memory、上下文固定、终端和重启命令；选择 CLI 后，会在当前 chat 的 `/` 菜单追加该 CLI 的 slash 命令映射，点击后转发给当前 CLI 执行。
- Telegram Codex 执行会自动走 AI Gateway 本地 OpenAI 兼容代理；代理透明转发请求并记录 provider 返回的 usage，不改变 Codex CLI 请求和响应。
- `/usage` 优先使用 provider 响应里的 cost；如果只有 token usage，会读取 `~/.ai-gateway/model-pricing.json` 按价格表估算。价格表没有命中的模型会显示额度未知。
- 会话最多保留最近 12 个 turn，并在最多 1400 token 内从新到旧选择上下文；回复 Bot 回答后发送 `/pin` 可固定关键 turn（最多 3 条），`/unpin` 可取消。
- 回复历史文字或 caption 会把引用内容作为额外上下文注入；引用内容最多 800 token，并按不可信上下文转义。
- 编辑最新一条普通 prompt 会自动停止旧执行并用新文本重跑；重跑不会 resume 含旧问题的 native session。
- 一次最多附加 8 个文件：UTF-8 文本单文件上限 2MB，图片单文件上限 10MB。文本内容总注入预算为 3000 token；Codex 图片通过 `--image` 传入。成功执行后临时附件会清理，失败时保留以便重试。
- Claude/Codex 的完整 JSON stream event 会驱动同一条进度消息中的阶段、工具和回答预览；默认至少 1500ms 更新一次，不做逐 token 高频编辑。
- `/terminal <命令>` 在当前工作目录执行命令，最长 60 秒；高风险命令仍需 inline confirmation。`/restart` 会优雅停止当前 Bot 并启动 replacement process。
- Claude 失败时 Bot 会提取 terminal error；不会再把 `system/init` JSON 当成主错误显示。
- `full-auto` 会映射到 Claude/Codex 的跳过审批模式，但高风险命令文本仍会在 Telegram 侧强制确认。
- 如果本机不能直连 `api.telegram.org`，设置 `proxyUrl` 或环境变量 `HTTPS_PROXY` / `ALL_PROXY`。

## 添加 Provider

交互式添加：

```bash
ai add
```

直接添加：

```bash
ai provider add 51talk https://example.com sk-xxx
```

添加时会自动完成：

- 写入 `providers.json`。
- 默认设置 `mode` 为 `auto`。
- 默认设置 `level` 为下一个可用等级。
- 测试 provider 连通性。
- 探测可用模型。
- 设置默认模型。

## 编辑 Provider

```bash
ai provider edit
```

可编辑字段：

```text
name
baseUrl
apiKey
mode
level
model
```

`apiKey` 是交互式凭证输入，不是 `providers.json` 的持久化字段。命令将凭证写入 `SecretStore`，配置只保存 `apiKeyRef`；编辑时不回显原值，留空表示保持现有凭证。

规则：

- `mode` 从 `ask` 和 `auto` 中选择。
- `level` 从当前 provider 数量生成的等级中选择。
- 如果选择的 `level` 已被占用，会和对应 provider 交换等级。
- `model` 从已探测到的模型中选择，不手动输入。

## 列出 Provider

```bash
ai provider list
```

列出 `providers.json` 中的 provider 配置：

```text
level
name
baseUrl
credentialStatus
mode
model
```

列表只显示 `configured/missing/unavailable` 等凭证状态，禁止显示 API Key 或可用于解析 secret 的内部信息。

`ai provider list` 只展示配置，不刷新健康度。

终端会以卡片形式展示，每个 provider 单独一块，`level: 1` 会标记为默认 provider。

## 删除 Provider

```bash
ai provider delete
ai provider delete 51talk
```

删除会同时清理 provider 配置和模型缓存。

## 配置记忆检索模型

```bash
ai memory embedding
ai memory embedding set
ai memory embedding set jina https://api.jina.ai/v1 jina_xxx jina-embeddings-v3 --type jina
ai memory embedding test "ping"
ai memory embedding clear
```

- `ai memory embedding`（不带参数）进入交互菜单，可查看、设置、测试或清空 embedding 配置。`ai memory vector` 是等价别名。
- 这组配置只服务记忆检索，不参与 Claude Code / Codex 聊天 provider 选择。
- 参数顺序为 `name baseUrl apiKey model`；`--type` 取 `jina` 或 `openai-compatible`。
- `--type jina` 会默认写入 `retrieval.query` 和 `retrieval.passage`，可用 `--query-task` / `--passage-task` 覆盖；`--dimensions` 指定向量维度。
- `set` 后会调用 embeddings 接口做一次轻量验证；加 `--skip-test` 可跳过。
- 配置只保存在本机 `~/.ai-gateway/memory.json`，日志会脱敏 API Key。

## 查看状态

```bash
ai status
```

执行时会轻量刷新所有 provider：

- 检查连通性。
- 刷新模型缓存。
- 不发送真实对话请求。
- 默认不消耗 token。

终端会按 provider 分块展示，避免小窗口表格错位。展示内容：

```text
level
name
Claude 状态
Claude 实际 baseUrl
Codex 状态
Codex 实际 baseUrl
配置 baseUrl
apiKey
mode
健康度
最近检查时间
token 使用量
使用占比
```

`ai status` 是轻量检查：它验证 provider 连通性、模型列表、Claude/Codex 各自的有效 baseUrl 和兼容模型，不发送真实对话请求。

token 使用量来自 `usage.json` 中真实记录的 provider usage。AI Gateway 自己发起且 provider 返回 usage 的请求会累计，例如 `ai doctor --deep`；Telegram Codex 执行也会通过本地代理记录 provider usage。

## 会话

列出最近 session：

```bash
ai session list
```

进入交互模式，选择最近 session 继续：

```bash
ai session
```

指定 session 继续：

```bash
ai session resume <session-id>
```

清空所有 session：

```bash
ai session clear
```

说明：

- 每次 `ai use` 启动 Claude/Codex 时会记录一条 session。
- session 记录 tool、provider、model、项目路径、开始时间、结束时间和退出状态。
- 当前版本是复用启动参数继续，不承诺恢复 Claude/Codex 原生聊天上下文。
- `ai session clear` 只清空 AI Gateway 的 session 记录，不删除 Claude Code 或 Codex 自己的历史记录。

## 生成 Session 报告

交互选择 session 并生成报告：

```bash
ai report
```

指定 session：

```bash
ai report <session-id>
```

直接在终端打印：

```bash
ai report --print <session-id>
```

报告会写入：

```text
~/.ai-gateway/reports/<session-id>.md
```

报告包含 session context、真实 token 汇总、工具和模型、provider 快照、当前 session 画像和用户画像。报告不会写入 API Key，也不会估算 token。

## 查看日志

```bash
ai log
```

打开日志文件。

终端打印最近日志：

```bash
ai log --print
ai log --print 100
```

`--print` 会按日志条目分块展示，适合快速查看最近错误和策略执行记录。

日志包括：

```text
使用痕迹
报错信息
provider 健康检查
fallback 策略执行
doctor 诊断记录
```

日志文件：

```text
.ai-gateway.log
```

## 生成项目上下文

```bash
ai context
```

生成并打开：

```text
.ai-gateway/context.md
```

终端打印：

```bash
ai context --print
```

上下文包括：

```text
项目路径
Git 分支和最近 commit
git status
git diff --stat
package.json scripts
文件树摘要
关键文档摘要
最近 AI Gateway 日志
```

默认排除：

```text
node_modules
dist
build
.git
.ai-gateway
providers.json
.ai-cache.json
usage.json
.ai-gateway.log
.env
*.key
*.pem
```

## 检查本地环境

```bash
ai doctor
```

默认不消耗 token。

检查内容：

```text
providers.json
.ai-cache.json
usage.json
Claude Code CLI
Codex CLI
provider 连通性
模型探测
配置字段是否合法
level 是否冲突
默认模型是否存在
```

如果 `codex` 不在 PATH，AI Gateway 会额外检查常见安装位置：

```text
/Applications/Codex.app/Contents/Resources/codex
```

深度检查：

```bash
ai doctor --deep
```

会使用当前最高优先级可用 provider 验证真实推理链路，可能消耗 token，执行前需要确认。

规则：

- 默认从 `level` 最小的可用 provider 开始。
- 当前 provider 不可用时，自动降级到下一个 provider。
- 如果没有任何 provider 可用，自动回到普通 `ai doctor`，不使用大模型。
- 如果 provider 返回 usage，会写入 `usage.json` 并反映到 `ai status`。
- 如果 provider 没有返回 usage，不会估算 token。

## 继续上次会话

```bash
ai last
```

继续使用上次选择的工具、provider 和模型。

## 打开 Web 控制面板

```bash
ai web
```

规划中的命令。当前基础版会提示暂未实现。

## 配置文件

用户可直接编辑：

```text
~/.ai-gateway/providers.json
~/.ai-gateway/model-pricing.json
```

示例：

```json
[
  {
    "name": "51talk",
    "baseUrl": "https://example.com",
    "apiKeyRef": "secret://provider/51talk",
    "mode": "auto",
    "level": 1,
    "model": "claude-opus-4-6"
  }
]
```

`apiKeyRef` 由 CLI/SecretStore 管理。手工编辑配置时可修改已有 ref，但不得把明文 API Key 写入 JSON；新增或轮换凭证使用 `ai provider add/edit`。

`model-pricing.json` 用于给只返回 token usage、不返回 cost 的模型估算费用。单位是美元 / 百万 token，可按模型名或 `provider/model` 配置：

```json
{
  "51talk-codex/gpt-5.5": {
    "inputPerMillionUsd": 1,
    "outputPerMillionUsd": 3
  }
}
```

内部文件：

```text
~/.ai-gateway/.ai-cache.json
~/.ai-gateway/usage.json
~/.ai-gateway/sessions.json
~/.ai-gateway/reports/
~/.ai-gateway/exports/
~/.ai-gateway/.ai-gateway.log
```

除非调试问题，否则不要手动修改内部文件。

如需临时使用其它配置目录：

```bash
AI_GATEWAY_HOME=/path/to/config ai provider list
```
