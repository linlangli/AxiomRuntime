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

## 通过 npm 安装

```bash
node --version
npm install --global @offerpilot/axiomruntime
ai --version
ai setup
```

npm 包名是 `@offerpilot/axiomruntime`，安装后注册的可执行命令是 `ai`。`ai --version`、`ai version`、`ai -v` 均输出当前包版本，并且不会创建 Runtime 配置或日志。

如果 npm 显示 `EBADENGINE`，当前 Node.js 版本不满足运行要求。请先升级到 `22.19.0+`，再重新安装；不要把该警告当作可忽略的普通提示。

全局安装可以由 root 完成，但 `ai`、Telegram 和其他常驻 Runtime 进程应由专用非 root 用户运行。`ai doctor` 会提示 root 执行风险；若 root 下仍请求 Claude `auto`/`bypassPermissions`，Runtime 会把本次执行约束为默认权限、重写临时 settings，并记录 configured/effective mode，不会把 `--dangerously-skip-permissions` 传给 Claude Code。

## 通过 Homebrew 安装

```bash
brew tap linlangli/axiom https://gitlab.com/linlangli/axiom.git
brew install linlangli/axiom/axiomruntime
ai --version
ai setup
```

Homebrew Formula 使用相同版本的公开 npm tarball作为唯一代码源，校验 SHA256 后安装到隔离的 `libexec`，并固定使用 Homebrew `node@22`。如果 Tap 不在 GitHub，首次执行 `brew tap` 时需要追加 Tap 的公开 Git URL。

## 首次设置

```bash
ai setup
```

`setup` 会创建缺失的 Runtime home、`providers.json`、`.ai-cache.json`、`usage.json` 和 `sessions.json`，引导配置第一个 Provider，并在用户确认后通过 npm 安装缺失的 Claude Code/Codex。

自动化用法：

```bash
ai setup --yes --skip-tools       # 只执行无交互的安全初始化
ai setup --yes --install-tools    # 安全初始化并安装缺失的外部 CLI
ai setup --skip-provider          # 跳过 Provider 引导
```

`--yes` 不会自行授权安装第三方 CLI；必须同时使用 `--install-tools`。Provider 凭证缺失时不会猜测或生成。

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
- provider 的 `mode` 为 `auto` 时，非 root 执行 Claude Code 会追加 `--dangerously-skip-permissions`；`ask` 模式不会追加该参数，并会在启动前确认。root 下请求 `auto` 会被安全约束为默认权限，并输出如何改用非 root 用户的告警。
- 启动 Codex 时，AI Gateway 会通过本次子进程的 `-c model_provider=...` 参数固定所选 provider，并用 `env_key = "OPENAI_API_KEY"` 读取本次注入的 API Key。Codex 全局 `auth.json`、`config.toml` 和直接执行 `codex` 的流程不会被修改。
- 如果 provider 的 `baseUrl` 是 OpenAI 兼容地址，例如 `https://icode.51talk.biz/v1`，启动 Claude Code 时会自动注入 `https://icode.51talk.biz`；启动 Codex 时仍使用 `/v1`。
- 启动记录会写入日志，包含 provider、baseUrl、模型、启动参数和 API Key 指纹，不包含完整 API Key。

## 设置 Codex App 的持久 Provider

切换到 ChatGPT 账号：

```bash
ai set codex chatgpt
```

命令会调用 `codex login` 打开浏览器，由 Codex 完成 ChatGPT OAuth；成功后把用户级 `model_provider` 设置为内建 `openai`，并更新 `CODEX_HOME/auth.json`。默认 `CODEX_HOME` 是 `~/.codex`。

切换到 AI Runtime 已添加的 provider：

```bash
ai set codex provider 51talk-cq gpt-5.6-sol  # 显式选择 GPT 模型
ai set codex provider 51talk-cq              # 自动选择最新的可用 GPT 模型
ai set codex provider                         # 依次交互选择 provider 和 GPT 模型
```

也可以运行 `ai set codex`，再交互选择 `ChatGPT account`、`Configured provider` 或 `Proxy`。Provider 规则如下：

- 自定义 provider 必须已经通过 `ai provider add` 添加；命令复用它的 `name`、`baseUrl` 和 `apiKey`，模型候选只来自该 provider 已探测并缓存的 `gpt-*` 列表。
- 指定 provider 但省略 model 时，按 GPT 数字版本从新到旧选择；同版本优先 `sol`、`pro`、无 tier alias、`codex`、`terra`、`mini`、`luna`、`nano`，并优先滚动 alias 而不是日期快照。没有任何 GPT 模型时提示先运行 `ai status` 刷新模型列表，不修改 Codex 配置。
- 显式 model 必须是该 provider 列表中的 `gpt-*` id；`ai set codex provider` 则先选择 provider，再从排序后的 GPT 列表选择模型。
- `config.toml` 只写 `model_provider`、provider metadata 和本次选中的模型，不写 API Key；原有 project、MCP、plugin、feature 等无关设置会保留。
- 自定义 provider 的 Key 按 Codex 兼容格式写入 `auth.json`，权限强制为 `0600`。切换到自定义 provider 会替换当前 ChatGPT token；以后切回 ChatGPT 需要再次完成浏览器登录。
- `config.toml` 与 `auth.json` 使用临时文件原子替换；登录取消、认证结果无效或写入失败时恢复两份原文件。
- 两份文件一致后，macOS 会延迟重启已安装的 `Codex.app`；当前客户端名为 `ChatGPT.app` 时会重启该应用。找不到应用或在其他平台运行时，配置仍然成功，但需按提示手动重启。
- 日志只记录 provider 名、provider id 和是否已安排重启，不记录 API Key 或 ChatGPT token。

设置 Codex App 的 HTTP 代理：

```bash
ai set codex proxy 127.0.0.1:7890
ai set codex proxy http://127.0.0.1:7890
ai set codex proxy off                    # 清除本命令管理的代理变量
```

也可以运行 `ai set codex` 后选择 `Proxy`。裸 `host:port` 会规范化为 `http://host:port`；仅接受不含账号密码、path、query 或 fragment 的 `http://` / `https://` origin。命令只更新 `config.toml` 的 `[shell_environment_policy.set]` 中大小写 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`，保留该 table 的其他变量以及其余 Codex 设置，不修改 `auth.json`。macOS 还会同步当前登录会话的 user launchd environment，让重启后的 `Codex.app` / `ChatGPT.app` 继承代理；同步失败会恢复原 config 且不重启，注销或重启 macOS 后需重新运行本命令。其他平台仍会写入 Codex 子进程环境配置，但 Codex App 自身的桌面环境需由用户设置后手动重启。代理地址在 command usage log 中整体脱敏。

`ai set codex` 与 `ai use codex` 的作用域不同：前者显式修改 Codex App 的持久用户配置；后者只为本次子进程注入 provider，不修改全局 Codex 配置。

## Telegram Bot

多 Bot 管理统一使用 `--bot <name>` 指定目标：

```bash
ai telegram                 # 交互选择操作，再选择目标 Bot
ai telegram --bot ops       # 预选 ops，再进入交互菜单
ai telegram add ops
ai telegram add support
ai telegram list

ai telegram config show --bot ops
ai telegram config set token <bot-token> --bot ops
ai telegram config set allowedUserIds 123456789,987654321 --bot ops
ai telegram config set defaultEngine codex --bot ops
ai telegram config set defaultCwd /workspace/ops --bot ops
ai telegram edit --bot ops
```

针对指定 Bot 启动、停止、检查、查看日志或删除：

```bash
ai telegram start --bot ops
ai telegram stop --bot ops
ai telegram status --bot ops
ai telegram logs --bot ops
ai telegram logs --bot ops -f
ai telegram doctor --bot ops
ai telegram delete --bot ops
```

批量启动、停止或查看全部命名 Bot：

```bash
ai telegram start --all
ai telegram stop --all
ai telegram status --all
```

说明：

- `--bot=<name>` 与 `--bot <name>` 等价。旧位置参数写法（例如 `ai telegram start ops`、`ai telegram config ops`、`ai telegram remove ops`）继续兼容；推荐新脚本使用显式 `--bot`。
- 裸 `ai telegram` 会先选择操作，再列出可操作的 Bot；启动、停止和状态菜单还提供 `all bots`，删除菜单会要求二次确认。带 `--bot` 进入交互菜单时会跳过第二次 Bot 选择。
- `edit` 是命名 Bot 的交互式编辑入口；`delete` 会先停止目标 Bot，再删除该 Bot 的 config、PID、log 和 SQLite 文件。旧 `remove` 仍是 `delete` 的兼容别名。
- legacy `telegram.json` 首次会自动迁移为命名 Bot `default`；删除 `default` 后，`list`、生命周期命令和 Bot 服务不会再从 legacy 配置把它重建出来。无目标 `ai telegram config` 仍可管理 legacy global config。
- `config set ... --bot <name>` 只写目标 Bot 的配置，不改全局配置或其他 Bot；命令日志和终端输出会脱敏 `token`。
- 命名 Bot 配置、PID、日志和会话分别保存在 `~/.ai-gateway/telegram/bots/<name>.json|.pid|.log|.sqlite`。未指定 `--bot` 的 legacy 配置继续使用 `~/.ai-gateway/telegram.json` 和 `telegram.sqlite`。
- 为保持兼容，存在命名 Bot 时，不带目标的 `start`、`stop`、`status` 仍作用于全部命名 Bot；自动化脚本应显式使用 `--bot` 或 `--all`。
- 默认只允许 `allowedUserIds` 里的 Telegram 用户访问；如果要开放给所有用户，显式设置 `allowAllUsers: true`。
- 多 Bot 配置彼此隔离；在 Bot 内选择 Provider、模型或权限模式时，只更新当前 Bot 的配置，不会从全局 `telegram.json` 覆盖该 Bot 的访问白名单。
- Telegram 远程执行 Claude Code/Codex 时复用 AI Gateway 顶层 provider；可通过 `provider` 和 `model` 配置固定 provider/model，不配置则按 `ai use` 同样的优先级自动选择。
- 首次 `/start` 或执行 `/reset` 会进入初始化流程：先选择 Provider/Model，再选择工作路径并自动确定 Claude Code/Codex。
- 工作路径步骤直接以按钮列出最多 8 个历史绝对路径，并在末尾提供“自定义”，不再先点击“已存在”。自定义路径固定创建或复用 `~/输入名称`。
- 未确定工作路径时发送普通内容会提示先确定工作路径；未确定 CLI 时发送普通内容会提示先选择 CLI。
- 选择 CLI 后只展示会话 ID、工作路径、CLI、provider、model 和权限模式。
- Bot 基础命令菜单包含 `/claude`、`/codex`、`/reset`、`/fresh`、`/cwd`、`/config`、`/provider`、`/usage`、Memory、上下文固定、终端和重启命令；选择 CLI 后，会在当前 chat 的 `/` 菜单追加该 CLI 的 slash 命令映射，点击后转发给当前 CLI 执行。
- `/provider` 以按钮列出全部 AI Provider。点击条目可编辑名称、Base URL、API Key、默认模型、模式和优先级，也可二次确认后删除；列表底部可添加 Provider。Bot 复用 `ai provider` 的核心 CRUD、连通性检查、模型发现、排序和缓存逻辑，不直接修改配置文件。
- Provider API Key 在详情中只显示“已配置”，不会写入 Bot 应用日志；输入 Key 后 Bot 会尽力立即删除该 Telegram 消息。添加或编辑的未完成表单只保存在当前 Bot 进程中，进程重启后需重新开始操作。
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

> **当前实现：`apiKey` 以明文保存在 `providers.json`。** 目标架构要求凭证写入 `SecretStore`、配置只保留 `apiKeyRef`（见 [modules/03-capabilities.md](modules/03-capabilities.md)），但 `SecretStore` 尚未实现。因此当前必须自行保护 `providers.json` 的文件权限，且不要提交到仓库。
>
> 选择 `apiKey` 编辑时，当前值会作为输入默认值显示；这同样是尚未收敛到目标行为的已知差异。

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
API Key
mode
model
```

> **当前实现显示掩码后的 API Key**（保留首末各 4 位，例如 `sk-d****0000`），不是完整值。目标态是只显示 `configured/missing/unavailable` 凭证状态、不泄露任何 secret 片段；录屏或截图分享前请注意这一差异。

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
- 配置只保存在本机 `~/.ai-gateway/memory.json`，日志会脱敏 API Key。但配置文件本身当前以明文保存 `apiKey`（与 `providers.json` 同样待迁移到 `SecretStore`），请限制文件权限。

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

`apiKey` 与 `ai provider list` 一样显示掩码值（保留首末各 4 位）。

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

默认不消耗 token，也不读取或修改项目源码。命令会自动执行安全修复：创建缺失的 Runtime home/状态文件；损坏的 `.ai-cache.json`、`usage.json`、`sessions.json` 会先备份为 `*.invalid-<timestamp>` 再重建。`providers.json` 无效时只报告问题，绝不自动覆盖凭证。

检查内容：

```text
providers.json
.ai-cache.json
usage.json
sessions.json
Node.js 版本
better-sqlite3 原生依赖
Claude Code CLI
Codex CLI
provider 连通性
模型探测
配置字段是否合法
默认模型是否存在
```

常用诊断模式：

```bash
ai doctor --local              # 不访问 Provider 网络
ai doctor --no-fix             # 只诊断，不自动修复
ai doctor --strict             # 存在 error 时返回非零退出码
ai doctor --deep --tool codex
ai doctor --deep --tool claude
```

如果 `codex` 不在 PATH，AI Gateway 会额外检查常见安装位置：

```text
/Applications/Codex.app/Contents/Resources/codex
```

深度检查：

```bash
ai doctor --deep --tool codex
```

会使用当前最高优先级可用 provider 验证真实推理链路，可能消耗 token，执行前需要确认。

规则：

- 默认从 `level` 最小的可用 provider 开始。
- 当前 provider 不可用时，自动降级到下一个 provider。
- 如果没有任何 provider 可用，会保留普通诊断结果并说明如何配置 Provider，不使用大模型。
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
    "apiKey": "sk-xxx",
    "mode": "auto",
    "level": 1,
    "model": "claude-opus-4-6"
  }
]
```

新增或轮换凭证使用 `ai provider add/edit`，不要手工编辑 `apiKey`。

> **当前 `apiKey` 是明文字段。** 目标架构为 `apiKeyRef` + `SecretStore`（`"apiKeyRef": "secret://provider/<name>"`），迁移完成后 legacy `apiKey` 只作一次性 migration input。在此之前请确保 `providers.json` 权限受限，且绝不提交到仓库。

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
