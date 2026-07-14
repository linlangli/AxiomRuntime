# AI Runtime 使用指南（doc_2.0）

> 从旧 `USAGE.md` 迁入的用户操作手册。语言中英混合（叙述中文，命令与标识符英文原样）。面向使用者，不是架构规范；架构见 [00-overview.md](00-overview.md)。

当前 `ai` 命令提供 AI Runtime 的 Gateway 基础能力，包括 Provider 管理、Claude Code/Codex 执行、Hermes、Telegram、会话、用量和诊断。Runtime 的学习、Skill、Capability 与组织级治理能力会沿用同一命令和核心架构逐步接入。

本指南只描述当前已经可用的用户操作。项目定位和未来能力见 [文档总览](README.md)。

## 运行环境

- Node.js `22.19.0` 或更高版本；Node.js 20 不受支持。
- 安装依赖前可运行 `node --version` 检查版本。
- Claude Code、Codex 与 Hermes 是外部 CLI，按需独立安装。

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
- 当前 provider 不可用时，按 `level` 自动降级。
- 启动 Claude Code 时，AI Gateway 会生成临时 `--settings` 文件，把 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL` 写入 settings 的 `env` 后启动；不会修改 `~/.claude/settings.json`，也不会使用 `--bare`。
- provider 的 `mode` 为 `auto` 时，启动 Claude Code 会追加 `--dangerously-skip-permissions`；`ask` 模式不会追加该参数，并会在启动前确认。
- 如果 provider 的 `baseUrl` 是 OpenAI 兼容地址，例如 `https://icode.51talk.biz/v1`，启动 Claude Code 时会自动注入 `https://icode.51talk.biz`；启动 Codex 时仍使用 `/v1`。
- 启动记录会写入日志，包含 provider、baseUrl、模型、启动参数和 API Key 指纹，不包含完整 API Key。

## 管理 Hermes 机器人

进入 Hermes 交互模式：

```bash
ai hermes
```

可选择：

```text
status
use
add
list
clear
delete
import
export
exit
```

直接命令：

```bash
ai hermes status
ai hermes use <机器人名称>
ai hermes add
ai hermes list
ai hermes edit
ai hermes clear
ai hermes delete
ai hermes import <文件路径>
ai hermes import-local
ai hermes export
ai hermes export <机器人名称>
ai hermes export --include-secrets --recipient <key-id>
ai hermes import <文件路径> --allow-secret-import
```

也可以从 `ai use` 进入：

```bash
ai use hermes <机器人名称>
```

添加机器人：

```bash
ai hermes add
```

流程：

```text
输入机器人名称
选择 AI Gateway provider
选择默认模型
选择 mode
按需配置 Telegram 绑定
保存
```

说明：

- Hermes 机器人配置保存到 `~/.ai-gateway/hermes.json`，可手动编辑。
- `hermes.json` 只保留用户需要配置的字段，不写入内部状态、来源或时间戳。
- 机器人只保存 provider 名称，不保存 API Key。
- Telegram 不是必填项，可通过 `ai hermes edit` 添加或修改。
- Hermes cron job 不会作为机器人导入，只会作为该机器人下面的 task。
- task 的定时规则不写入 `hermes.json`，需要通过和机器人聊天或后续 task 管理功能修改。
- 启动时会从 `providers.json` 读取 provider 的 `apiKeyRef`、`baseUrl` 和模型信息，再从 `SecretStore` 解析实际凭证。
- 启动 Hermes 时会使用 AI Gateway 管理的独立机器人运行目录，例如 `~/.ai-gateway/hermes/<机器人名称>/`。
- 每次启动都会从 `providers.json` 读取当前 provider 引用，由 `SecretStore` 向受监督进程注入凭证，避免读取全局 `~/.hermes/config.yaml` 后串用其它 API Key。
- `ai hermes use` 不会读取你的全局 `~/.hermes/config.yaml`，会使用独立机器人运行目录。
- `ai provider add/edit/delete` 修改 provider 后只记录顶层 provider 变化；下一次执行 Hermes 相关命令时会检测变化，同步本机 Hermes 原生配置，并在需要运行时生效时重启 Hermes gateway。
- `ai hermes add/edit/import-local` 会把 AI Gateway 的 provider 列表写入本机 Hermes 原生配置，让 Telegram 中的 `/model` 只显示 AI Gateway 配置过的 provider。
- 自动同步会把 provider/model/baseUrl 和 `apiKeyRef` 写入机器人隔离配置；实际 API Key 优先经环境或 OS credential channel 注入。兼容旧 Hermes 时只允许使用隔离 `HERMES_HOME` 下权限 `0600` 的短生命周期配置，由 supervisor 清理，禁止把密钥写入全局 `~/.hermes/config.yaml`。
- 自动同步会替换 Hermes 原生配置里旧的 `providers` / `custom_providers` 块，并清理重复块，避免 `/model` 能选中但实际执行时报 `Unknown provider`。
- 同步前会刷新所有 provider 的模型，并用最小请求验证每个模型是否真的能调用；Telegram `/model` 只展示验证通过的模型，没有可调用模型的 provider 不会显示。
- 可调用性验证使用 `max_tokens: 1` 的轻量请求，产生的 token 会记录到使用量中；模型列表不会写进 `providers.json`。
- 如果本机 Hermes 版本的 Telegram `/model` 只读取 `default_model`，或点击 AI Gateway provider 后没有把 `providers` 配置传给切换逻辑，同步时会自动给 Hermes 打兼容补丁；补丁前会保留 `.ai-gateway.bak` 备份。
- 同步/自愈也会补 Hermes 请求兼容逻辑：如果历史对话里出现空工具名，会在发送给 OpenAI 兼容接口前清理，避免 `Invalid input[*].name` 这类 400 错误。
- Telegram `/model` 选择 AI Gateway provider/model 后，会保存到本机 Hermes 默认配置；下次执行 `ai hermes status/list` 会自动同步回 `hermes.json`。
- 隔离运行时不会加载 Hermes 原生 provider 凭证入口，避免 `anthropic`、`copilot`、`openai-codex` 等 provider 混入 `/model`；不覆盖用户拥有的全局 `.env` 或 `auth.json`。
- `list` 会先做轻量自愈，再列出机器人配置；轻量自愈只使用本地配置和模型缓存，不做模型可调用性探测，不额外消耗 token。
- `edit` 可修改机器人名称、默认 provider、默认 model、mode 和 Telegram 绑定。
- `status` 会先做轻量自愈，再检查 Hermes CLI、provider 是否存在、provider 健康度、模型缓存和 Telegram 绑定状态。
- `clear` 会清空该机器人的 AI Gateway 管理状态、记忆、tasks 和本机 Hermes cron jobs 中属于该机器人的条目，保留机器人名称、provider、model、mode 和 Telegram 绑定。
- `delete` 会删除机器人配置和 AI Gateway 管理状态。
- `export` 默认导出 secret-free 复刻包，包含机器人配置、Telegram 绑定、tasks schedule、provider 引用和可移植模型元数据，不包含 API Key。传入机器人名称时只导出单个机器人。
- 需要迁移凭证时使用 `ai hermes export --include-secrets --recipient <key-id>`；命令要求确认并生成接收方绑定、有有效期的加密 bundle。目标机器用 `ai hermes import <file> --allow-secret-import` 显式导入，凭证直接进入 `SecretStore`，不会写入普通 JSON。
- `import` 默认只导入 secret-free bundle；缺失 provider 凭证时提示在目标机器重新配置。旧版可能含明文 secret 的导出文件必须先显示安全告警和导入预览，未经 `--allow-secret-import` 拒绝处理 secret 字段。
- `import-local` 会自动扫描本机 `~/.hermes/config.yaml`、`~/.hermes/channel_directory.json` 和 `~/.hermes/cron/jobs.json`，先把本机 Hermes provider 导入 AI Gateway provider 配置，再导入 Hermes 默认机器人和该机器人下面的 tasks，并立即同步本机 Hermes 配置、重启 gateway。
- 已导入后即使把 `hermes-default` 改名，再执行 `import-local` 也会按 Telegram chatId 或 task id 识别为同一个机器人，不会重复新增。
- `import-local --overwrite` 会用本机 Hermes 配置覆盖同名 provider 和同名机器人。

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
- 首次 `/start` 或执行 `/reset` 会进入初始化流程：先选择工作路径，再选择 Claude Code/Codex。
- 工作路径可从历史记录选择，也可以点“自定义”后输入名称；自定义路径固定创建或复用 `~/输入名称`。
- 未确定工作路径时发送普通内容会提示先确定工作路径；未确定 CLI 时发送普通内容会提示先选择 CLI。
- 选择 CLI 后只展示会话 ID、工作路径、CLI、provider、model 和权限模式。
- Bot 默认命令菜单只保留 `/claude`、`/codex`、`/reset`、`/fresh`、`/cwd`、`/config`、`/usage` 和 `/help`；选择 CLI 后，会在当前 chat 的 `/` 菜单追加该 CLI 的 slash 命令映射，点击后转发给当前 CLI 执行。
- Telegram Codex 执行会自动走 AI Gateway 本地 OpenAI 兼容代理；代理透明转发请求并记录 provider 返回的 usage，不改变 Codex CLI 请求和响应。
- `/usage` 优先使用 provider 响应里的 cost；如果只有 token usage，会读取 `~/.ai-gateway/model-pricing.json` 按价格表估算。价格表没有命中的模型会显示额度未知。
- 文件上传支持 UTF-8 文本附件，下一条 prompt 会自动带上附件内容。
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

删除会同时清理 provider 配置和模型缓存，并同步本机 Hermes provider 列表。

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
~/.ai-gateway/hermes.json
~/.ai-gateway/hermes-state.json
~/.ai-gateway/hermes/<机器人名称>/
~/.ai-gateway/reports/
~/.ai-gateway/exports/
~/.ai-gateway/.ai-gateway.log
```

除非调试问题，否则不要手动修改内部文件。

如需临时使用其它配置目录：

```bash
AI_GATEWAY_HOME=/path/to/config ai provider list
```
