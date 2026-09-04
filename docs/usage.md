# AxiomRuntime 使用指南

面向使用者的操作手册。读完这一份就能把项目用起来，不需要看架构文档。

- 想了解内部设计 → [技术架构](architecture.md)
- 想了解产品规划 → [产品需求文档](prd.md)

本文只写**当前版本真正可用**的功能。规划中的能力集中放在最后一节「还没有的功能」，不会混在正文里。

---

## 1. 这是什么

AxiomRuntime 提供一个 `ai` 命令，帮你统一管理 Claude Code 和 Codex CLI 的**服务商（Provider）**。

它解决六个日常问题：

| 问题 | AxiomRuntime 的做法 |
|---|---|
| 有多个 API 中转站，来回改环境变量很烦 | 集中配置，`ai use claude 某站` 一句话切换 |
| 某个中转站挂了，手动换很麻烦 | 按优先级自动降级到下一个可用服务商 |
| 不知道 token 花在哪 | 本地代理记录真实用量，`ai status` 查看 |
| 想在手机上用 Claude Code | Telegram Bot 远程执行 |
| 需要生成图片 | `ai image <provider> <prompt>` 调用已配置的图片 Provider 并保存结果 |
| 想让两个模型交叉审代码 | `ai review` 让 Codex 与 Claude Code 审阅、裁决并按人工选择修复 |

它**不是**模型，也不替代 Claude Code / Codex —— 这两个 CLI 需要你自己安装，AxiomRuntime 负责给它们喂对的配置并在后台记账。

---

## 2. 安装

### 前置要求

- **Node.js 22.19.0 或更高**。Node.js 20 不支持。
- Claude Code / Codex CLI 按需安装（`ai setup` 可以帮你装）。

```bash
node --version    # 先确认版本
```

### npm 安装

```bash
npm install --global @offerpilot/axiomruntime
ai --version
```

包名是 `@offerpilot/axiomruntime`，安装后的命令是 `ai`。

如果 npm 报 `EBADENGINE`，说明 Node.js 版本不够。**先升级再装**，不要忽略这个警告继续用。

### Homebrew 安装

```bash
brew tap linlangli/axiom https://gitlab.com/linlangli/axiom.git
brew install linlangli/axiom/axiomruntime
ai --version
```

Homebrew 用的是同版本的 npm tarball，校验 SHA256 后装到隔离目录，并固定使用 Homebrew 的 `node@22`。Tap 不在 GitHub，所以第一次 `brew tap` 必须带上后面那个 Git URL。

### 关于 root

全局安装可以用 root，但**运行 `ai`、Telegram 和常驻服务请用普通用户**。

root 下如果请求 Claude 的 `auto` 权限模式，AxiomRuntime 会强制降级为默认权限，并且不会把 `--dangerously-skip-permissions` 传给 Claude Code。`ai doctor` 会提示这个风险。

---

## 3. 五分钟上手

```bash
ai setup
```

这一条命令会做完所有初始化：

1. 创建配置目录 `~/.ai-gateway/` 和里面的状态文件
2. 引导你添加第一个 Provider（名称、Base URL、API Key）
3. 测试连通性、探测可用模型、设好默认模型
4. 询问是否安装缺失的 Claude Code / Codex

然后就能用了：

```bash
ai use claude      # 用默认服务商启动 Claude Code
ai use codex       # 用默认服务商启动 Codex
```

启动后就是原生的 Claude Code / Codex 界面，交互方式完全不变。区别只在于配置由 AxiomRuntime 注入、用量在后台被记录。

### 无人值守初始化

```bash
ai setup --yes --skip-tools       # 只做无交互的安全初始化
ai setup --yes --install-tools    # 顺带安装缺失的外部 CLI
ai setup --skip-provider          # 跳过 Provider 引导
```

`--yes` 不会自动授权安装第三方 CLI，必须显式加 `--install-tools`。缺少 Provider 凭证时不会猜测或伪造。

### 交互模式

```bash
ai
```

不带参数直接运行，会列出所有操作让你选。不用记命令。

---

## 4. 管理 Provider

Provider 就是你的 API 服务商（官方 API 或中转站）。

### 添加

```bash
ai add                                              # 交互式，推荐
ai provider add 我的站 https://example.com sk-xxx   # 一行搞定
```

添加时自动完成：写入配置 → 设 `mode: auto` → 分配下一个优先级 → 测连通性 → 探测模型 → 设默认模型。

### 查看

```bash
ai provider list      # 只看配置，不联网
ai status             # 联网刷新健康度 + 看用量
```

`ai provider list` 以卡片形式展示，`level: 1` 会标注为默认服务商。API Key 显示为掩码（`sk-d****0000`）。

`ai status` 会做一次轻量检查：验证连通性、刷新模型缓存、确认 Claude/Codex 各自的有效 Base URL 和兼容模型。**不发真实对话请求，默认不消耗 token。**

### 编辑与删除

```bash
ai provider edit
ai provider delete 我的站
```

可编辑字段：`name`、`baseUrl`、`apiKey`、`mode`、`level`、`model`。

规则：

- `mode` 只能选 `ask` 或 `auto`
- `model` 从已探测到的模型里选，不用手输
- 改 `level` 时如果目标等级被占用，两个 Provider 会**交换**等级
- 删除会同时清理配置和模型缓存

> **安全提示：`apiKey` 目前以明文保存在 `providers.json`。** 请确认该文件权限受限，且绝不提交到仓库。加密存储是规划中的能力，见第 11 节。

---

## 5. 启动 Claude Code / Codex

### 基本用法

```bash
ai use claude                          # 默认服务商 + 默认模型
ai use claude 我的站                    # 指定服务商
ai use claude 我的站 claude-opus-4-6    # 指定服务商 + 模型
ai use codex 我的站 gpt-5.5
ai last                                # 沿用上次的工具、服务商和模型
```

### 选择规则

- 不指定服务商 → 用 `level: 1` 那个
- 不指定模型 → 用该服务商的默认 `model`
- 当前服务商不可用 → 按 `level` 顺序自动降级
- Codex 认 `gpt`、`codex`、`grok`、`o` 系列和 `openai` 开头的模型名

### 它对你的环境做了什么

这部分值得了解，因为涉及到会不会污染你现有的配置：

**Claude Code**：生成一个临时 `--settings` 文件，把 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL` 写进去再启动。**不碰 `~/.claude/settings.json`。**

**Codex**：通过本次子进程的 `-c model_provider=...` 参数固定服务商，用 `env_key = "OPENAI_API_KEY"` 读注入的 Key。**不碰全局 `auth.json` 和 `config.toml`**，直接执行 `codex` 的行为不受影响。

**Base URL 自动适配**：如果你的 `baseUrl` 是 OpenAI 兼容地址（比如 `https://example.com/v1`），启动 Claude 时会自动去掉 `/v1`，启动 Codex 时保留。

**权限模式**：`mode: auto` 时非 root 启动 Claude 会追加 `--dangerously-skip-permissions`；`ask` 模式不加，并在启动前确认。

**用量记录**：两个引擎的模型请求都经过一个本次执行专属的本地代理转发，服务商返回的真实用量按服务商/模型写入 `usage.json`。终端交互方式完全不变。

**日志**：记录服务商、Base URL、模型、启动参数和 API Key 指纹，**不记完整 Key**。

### 双模型对抗审阅

`ai review` 让 Codex 与 Claude Code 交替完成「首审 → 交叉判断 → 人工选择 → 修复 → 自动提交 → 交换角色复审」：

```bash
ai review "审核一下 commitid 为 abc1234 的代码"
ai review --commit abc1234 "重点检查并发安全和资源泄漏"
ai review                         # 交互输入审阅要求，默认审 HEAD
```

第一次运行时会进入模型设置流程：选择首审引擎，再分别为 Codex 和 Claude Code 选择 Provider 与模型。配置保存在 `~/.ai-gateway/review.json`，只含 Provider 名和模型名，不保存 API Key。

```bash
ai review config                 # 重新选择首审顺序、Provider 和模型
ai review config show            # 查看当前审阅配置
ai review reset                  # 清除审阅配置
```

每轮流程：

1. 首审模型只读检查目标 commit，输出带严重级别、文件、行号、证据和修复建议的问题。
2. 第二个模型独立验证每条问题，可以同意、反对、不确定或补充遗漏。
3. Runtime 为问题分配 `R1-001` 形式的稳定编号，并显示具体 Provider/模型来源；双方同意的条目标记为 `CONSENSUS`。
4. 你可以选择只修复双方共识、修复全部、按编号多选，或放弃并立即结束。
5. 首审模型只修改所选问题。Runtime 检查改动后创建本地 commit，然后交换两个模型的角色，让另一个模型审阅新 commit。
6. 没有问题时自动结束；否则继续循环，直到你选择放弃。

安全与失败边界：

- 开始审阅以及每次修复前都要求 Git 工作区干净，防止自动提交混入原有改动。
- 审阅阶段是只读；修复阶段只给受限工作区写权限。Claude Code 不获得 Bash，Codex 使用 `workspace-write` sandbox 和 `approval=never`。
- 模型不得自行 commit、amend、reset、stash 或 push；Runtime 会检测意外的 HEAD 变化并停止。
- 自动提交只发生在本地，提交信息会记录轮次、问题 ID 和两个模型；**永不自动 push**。
- Git diff 超过约 1.5 MB 会拒绝自动审阅。中断或失败后不会丢弃已有修改，也不会自动重置，请先人工检查再继续。
- 每次模型调用默认最多等待 20 分钟，可用 `AI_GATEWAY_REVIEW_TIMEOUT_MS` 调整。
- 审阅要求会在 command usage log 中脱敏；模型请求仍经过 execution-scoped Transport Proxy，真实 token 进入同一份用量账本。

## 6. 生成图片

使用已配置并探测到的图片模型生成一张图片：

```bash
ai image                                                   # 交互选择 Provider、模型并输入提示词
ai image 51talk-image "一只戴墨镜的猫，数字插画"          # 使用 Provider 默认模型
ai image 51talk-image gpt-image-2 "一只戴墨镜的猫，数字插画"  # 指定具体模型
```

规则：

- 直接运行 `ai image` 时，会依次选择 Provider、具体模型并输入提示词。
- 第一个参数是 Provider 名（例如 `51talk-image`）。第二个参数如果匹配该 Provider 的模型缓存，就作为具体模型；否则从第二个参数开始全部拼成提示词，并使用 Provider 默认模型。
- Provider 和模型必须出现在模型缓存中。命令执行前会自动刷新；也可以先运行 `ai status` 检查模型列表。如果没有 Provider，先运行 `ai add`。
- 为避免模型名与提示词歧义，指定具体模型时建议给提示词加引号，例如 `ai image 51talk-image gpt-image-2 "提示词"`。
- Runtime 按 Provider 健康状态和 `level` 顺序尝试，失败会自动切换下一个同样提供该模型的 Provider。
- `b64_json` 响应会以 `0600` 权限保存到当前目录，输出绝对路径；远程 `https` 图片响应会输出 URL，不会自动下载不受信任的地址。
- 图片生成请求最长等待 120 秒；生成服务通常比文本请求耗时更长，超过此时间会自动失败并尝试下一个 Provider。
- 图片请求复用 execution-scoped Transport Proxy；Provider 返回的真实 usage 会写入同一份 `usage.json`，不会估算图片 token。

---

## 7. 配置 Codex 桌面端

上一节的 `ai use codex` 只影响本次执行。如果你想**持久**改掉 Codex App 的配置，用 `ai set codex`。

### 切回 ChatGPT 账号

```bash
ai set codex chatgpt
```

调用 `codex login` 打开浏览器完成 OAuth，成功后把 `model_provider` 设为内建 `openai`。

### 切到自己的服务商

```bash
ai set codex provider 我的站 gpt-5.6-sol   # 显式选模型
ai set codex provider 我的站               # 自动选最新可用 GPT
ai set codex provider                     # 交互依次选服务商和模型
ai set codex                              # 全交互，先选做什么
```

规则：

- 服务商必须已经通过 `ai provider add` 添加过
- 模型候选只来自该服务商**已探测缓存**的 `gpt-*` 列表。没有 GPT 模型时会让你先跑 `ai status` 刷新，**不会**改动 Codex 配置
- 省略模型时按 GPT 版本号从新到旧选，同版本优先 `sol` > `pro` > 无后缀 > `codex` > `terra` > `mini` > `luna` > `nano`，且优先滚动别名而非日期快照
- `config.toml` 只写服务商信息和选中的模型，**不写 API Key**；写入 `base_url` 前会检查末尾是否已有 `/v1`，没有则自动补上，已有则不会重复；你原有的 project、MCP、plugin 设置都保留
- API Key 写入 `auth.json`，权限强制 `0600`
- 两个文件都用临时文件原子替换。任何一步失败（登录取消、认证无效、写入失败）都会**回滚到原状**
- macOS 上配置一致后会自动重启 `Codex.app` 或 `ChatGPT.app`，并清理重启进程继承的 `OPENAI_API_KEY`，确保客户端读取刚写入的 `auth.json`；找不到应用或在其他平台，配置照样生效，但需要手动重启

> 切到自定义服务商会**替换掉当前的 ChatGPT token**。以后想切回去需要重新走一次浏览器登录。

### 设置 HTTP 代理

```bash
ai set codex proxy 127.0.0.1:7890
ai set codex proxy http://127.0.0.1:7890
ai set codex proxy off              # 清除
```

裸 `host:port` 会自动补成 `http://`。只接受不含账号密码、path、query 的 `http://` / `https://` 地址。

只改 `config.toml` 里 `[shell_environment_policy.set]` 的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`（大小写都管），该段里的其他变量和其余 Codex 设置都保留，**不动 `auth.json`**。

macOS 会同步当前登录会话的 launchd 环境，让重启后的 Codex App 也能继承代理。同步失败会回滚配置且不重启。注销或重启 macOS 后需要重新执行本命令。

---

## 8. Telegram Bot

在手机上远程跑 Claude Code / Codex。

### 建一个 Bot

```bash
ai telegram add ops                                  # 创建名为 ops 的 Bot
ai telegram config set token <bot-token> --bot ops
ai telegram config set allowedUserIds 123456789 --bot ops
ai telegram start --bot ops
```

Token 从 Telegram 的 @BotFather 获取。`allowedUserIds` 是你的 Telegram 数字 ID。

> **默认只允许白名单里的用户访问。** 想开放给所有人必须显式设置 `allowAllUsers: true` —— 这会让任何人都能在你的机器上执行命令，请谨慎。

### 日常管理

```bash
ai telegram                    # 交互式，先选操作再选 Bot
ai telegram list
ai telegram status --bot ops
ai telegram logs --bot ops -f  # 实时跟踪日志
ai telegram stop --bot ops
ai telegram edit --bot ops
ai telegram doctor --bot ops
ai telegram delete --bot ops   # 会先停止，再删配置/PID/日志/数据库
```

批量操作：

```bash
ai telegram start --all
ai telegram stop --all
ai telegram status --all
```

其他可配置项：

```bash
ai telegram config show --bot ops
ai telegram config set defaultEngine codex --bot ops
ai telegram config set defaultCwd /workspace/ops --bot ops
```

### 在 Telegram 里怎么用

首次发 `/start`（或 `/reset`）进入初始化：**先选服务商和模型 → 再选工作目录 → 自动确定引擎**。

工作目录步骤会直接列出最多 8 个历史绝对路径按钮，末尾有「自定义」。自定义路径固定创建或复用 `~/你输入的名字`。

没定工作目录或没选 CLI 就发消息，Bot 会提示你先完成这一步。

**可用命令**：`/claude`、`/codex`、`/reset`、`/fresh`、`/cwd`、`/config`、`/provider`、`/usage`、`/remember`、`/forget`、`/memories`、`/pin`、`/unpin`、`/terminal`、`/restart`、`/help`。

选定 CLI 后，该 CLI 自己的 slash 命令也会追加到 `/` 菜单里，点击直接转发执行。

**几个实用细节**：

| 能力 | 说明 |
|---|---|
| 进度显示 | 长任务会持续编辑**同一条**消息展示阶段、工具和回答预览，默认至少 1500ms 更新一次 |
| 上下文 | 保留最近 12 轮，在 1400 token 内从新到旧选择 |
| 固定上下文 | 回复某条 Bot 回答后发 `/pin` 固定关键轮次（最多 3 条），`/unpin` 取消 |
| 引用注入 | 回复历史文字会把引用内容作为额外上下文注入，上限 800 token，按不可信内容转义 |
| 编辑重跑 | 编辑最新一条 prompt 会自动停掉旧执行、用新文本重跑 |
| 附件 | 一次最多 8 个文件。文本单文件 2MB，图片单文件 10MB，文本总注入预算 3000 token |
| 服务商管理 | `/provider` 可直接在 Telegram 里增删改服务商，复用 CLI 的核心逻辑 |
| 执行命令 | `/terminal <命令>` 在工作目录执行，最长 60 秒，高风险命令仍需确认 |
| 费用 | `/usage` 优先用服务商返回的 cost，只有 token 时按 `model-pricing.json` 估算 |

**代理**：本机连不上 `api.telegram.org` 时，设置 `proxyUrl` 或环境变量 `HTTPS_PROXY` / `ALL_PROXY`。地址要带协议，例如 `http://127.0.0.1:7890`。

**多 Bot 隔离**：每个 Bot 的配置、PID、日志、会话分别存在 `~/.ai-gateway/telegram/bots/<name>.json|.pid|.log|.sqlite`。在某个 Bot 里改服务商只影响它自己。

> 兼容性说明：旧的位置参数写法（`ai telegram start ops`）仍然可用，但新脚本建议用显式 `--bot`。旧的单 Bot 配置 `telegram.json` 首次会自动迁移为名为 `default` 的 Bot。存在命名 Bot 时，不带目标的 `start`/`stop`/`status` 作用于**全部** Bot，自动化脚本请显式指定。

---

## 9. 会话、报告与诊断

### 会话

```bash
ai session list                    # 列出最近会话
ai session                         # 交互选择并继续
ai session resume <session-id>      # 继续指定会话
ai session clear                   # 清空记录
```

每次 `ai use` 都会记一条会话，包含工具、服务商、模型、项目路径、起止时间和退出状态。

> 当前是**复用启动参数**继续，不承诺恢复 Claude/Codex 的原生聊天上下文。`ai session clear` 只清 AxiomRuntime 的记录，不删 Claude Code / Codex 自己的历史。

### 报告

```bash
ai report                    # 交互选择
ai report <session-id>
ai report --print <session-id>   # 直接打印到终端
```

写入 `~/.ai-gateway/reports/<session-id>.md`，包含会话上下文、真实 token 汇总、工具和模型、服务商快照。**不写 API Key，不估算 token。**

### 诊断

```bash
ai doctor                     # 默认会自动做安全修复
ai doctor --local             # 不联网
ai doctor --no-fix            # 只诊断
ai doctor --strict            # 有 error 时返回非零退出码
ai doctor --deep --tool codex # 深度检查，会真实调用模型
```

`ai doctor` 检查配置文件完整性、Node.js 版本、`better-sqlite3` 原生依赖、Claude/Codex CLI 是否存在、服务商连通性、模型探测、默认模型是否有效。

**自动修复行为**：创建缺失的目录和状态文件；损坏的 `.ai-cache.json`、`usage.json`、`sessions.json` 先备份成 `*.invalid-<时间戳>` 再重建。**`providers.json` 无效时只报告，绝不自动覆盖你的凭证。**

`--deep` 会用当前最高优先级的可用服务商验证真实推理链路，**可能消耗 token**，执行前会要求确认。没有可用服务商时保留普通诊断结果并说明如何配置，不会调模型。

如果 `codex` 不在 PATH，还会额外检查 `/Applications/Codex.app/Contents/Resources/codex`。

### 日志与上下文

```bash
ai log                  # 打开日志文件
ai log --print 100      # 打印最近 100 条
ai context              # 生成项目上下文到 .ai-gateway/context.md
ai context --print
```

日志包含使用痕迹、报错、健康检查、降级策略执行和诊断记录，文件在 `~/.ai-gateway/.ai-gateway.log`。

`ai context` 汇总项目路径、Git 分支和最近提交、`git status`、`git diff --stat`、`package.json` scripts、文件树摘要、关键文档摘要和最近日志。自动排除 `node_modules`、`dist`、`.git`、`providers.json`、`usage.json`、`.env`、`*.key`、`*.pem` 等。

---

## 10. 其他能力

### 内网 API 服务

```bash
npm run server
```

启动常驻 HTTP 服务。**必须**设置 `AI_GATEWAY_SERVER_TOKEN` 或 `AI_GATEWAY_SERVER_TOKEN_FILE`（生产环境建议用后者）。

可用路由：

| 路由 | 用途 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容对话 |
| `POST /v1/responses` | OpenAI Responses 协议 |
| `POST /v1/embeddings` | 向量化 |
| `GET /v1/models` | 模型列表 |
| `POST /v1/agent/runs` | 需要 Claude/Codex 工具能力时用 |

`/v1/agent/runs` 传 `engine`、`prompt`、`workspace_id`，可选 `provider`/`model`。`permission_mode` 只支持默认的 `read_only` 或显式 `workspace_write` —— **服务端 API 不提供 `bypassPermissions`。**

其他环境变量：`AI_GATEWAY_SERVER_HOST/PORT`、`AI_GATEWAY_MAX_REQUEST_BYTES`、`AI_GATEWAY_UPSTREAM_HEADERS_TIMEOUT_MS`、`AI_GATEWAY_AGENT_WORKSPACE_ROOT`、`AI_GATEWAY_AGENT_MAX_CONCURRENT_RUNS`、`AI_GATEWAY_AGENT_TIMEOUT_MS`。

### 配置记忆检索的向量模型

```bash
ai memory embedding                  # 交互菜单
ai memory embedding set jina https://api.jina.ai/v1 jina_xxx jina-embeddings-v3 --type jina
ai memory embedding test "ping"
ai memory embedding clear
```

参数顺序是 `name baseUrl apiKey model`，`--type` 取 `jina` 或 `openai-compatible`。`ai memory vector` 是等价别名。

`--type jina` 默认写入 `retrieval.query` 和 `retrieval.passage`，可用 `--query-task` / `--passage-task` 覆盖，`--dimensions` 指定维度。`set` 后会做一次轻量验证，`--skip-test` 可跳过。

> 这组配置**只为记忆检索准备**，不参与 Claude/Codex 的聊天服务商选择。配置保存在 `~/.ai-gateway/memory.json`，同样以明文存 `apiKey`，请限制文件权限。
>
> 注意：**向量检索本身尚未实现**，当前记忆匹配用的是关键词打分。这条命令是为后续能力做的前置准备。

### 帮助

```bash
ai help          # 打开 HTML 命令手册
ai --version
```

---

## 11. 配置文件

配置目录默认 `~/.ai-gateway/`，可用 `AI_GATEWAY_HOME` 覆盖：

```bash
AI_GATEWAY_HOME=/path/to/config ai provider list
```

### 你可以直接编辑的

**`providers.json`** —— 服务商配置：

```json
[
  {
    "name": "我的站",
    "baseUrl": "https://example.com",
    "apiKey": "sk-xxx",
    "mode": "auto",
    "level": 1,
    "model": "claude-opus-4-6"
  }
]
```

新增或轮换凭证请用 `ai provider add/edit`，不要手改 `apiKey`。

**`model-pricing.json`** —— 给只返回 token 不返回费用的模型估算成本。单位是**美元/百万 token**，可按模型名或 `服务商/模型` 配置：

```json
{
  "我的站/gpt-5.5": {
    "inputPerMillionUsd": 1,
    "outputPerMillionUsd": 3
  }
}
```

### 内部文件（除调试外不要手改）

```text
~/.ai-gateway/.ai-cache.json        模型缓存和健康状态
~/.ai-gateway/usage.json            用量账本
~/.ai-gateway/sessions.json         会话记录
~/.ai-gateway/memory.json           记忆检索的 embedding 配置
~/.ai-gateway/review.json           双模型审阅的引擎、Provider 与模型选择
~/.ai-gateway/memory.sqlite         Telegram 记忆库
~/.ai-gateway/telegram/bots/        各 Bot 的配置、PID、日志、会话
~/.ai-gateway/reports/              会话报告
~/.ai-gateway/.ai-gateway.log       日志
```

配置写入使用**临时文件 + 原子重命名**，并配合文件锁，避免 CLI 和 Telegram 并发时互相覆盖。

---

## 12. 常见问题

**装完 `ai` 找不到命令**
检查 npm 全局 bin 是否在 PATH 里：`npm bin -g`。

**npm 报 EBADENGINE**
Node.js 版本低于 22.19.0。升级后重新安装，别忽略警告。

**`ai status` 显示服务商不健康**
先跑 `ai doctor --local` 排除本地配置问题，再检查 Base URL 和 API Key。注意 Base URL 要不要带 `/v1` 取决于服务商。

**Codex 一直弹 ChatGPT 登录页**
这通常是 `requires_openai_auth` 造成的 —— 该开关会让 Codex 只认 `auth.json` 是否存在，不认 `OPENAI_API_KEY` 环境变量。AxiomRuntime 的服务商注入**不会**设置这个开关，靠 `env_key` 完成认证。如果仍然出现，检查是不是别的工具改过你的 `config.toml`。

**Telegram Bot 没反应**
按顺序查：`ai telegram status --bot <名字>` → `ai telegram logs --bot <名字>` → 确认 `allowedUserIds` 里有你的 ID → 确认能连上 `api.telegram.org`（可能需要 `proxyUrl`）。

**`ai status` 里的 token 统计不全**
统计从「安装了支持统一代理的版本之后」产生的新请求开始生效。旧版本里没走代理的历史**不会**被扫描补录 —— 这是刻意的，避免把 token 归错服务商或重复计数。

**用量按什么聚合**
按服务商的精确名称。同一服务商下不同模型会合并展示，但每条事件仍保留实际模型。不同服务商名称不合并。

---

## 13. 还没有的功能

这一节列出**尚未实现**的能力，避免你按文档去找找不到的东西。完整规划见 [产品需求文档](prd.md)。

| 功能 | 当前状态 |
|---|---|
| `ai web` 控制面板 | 命令存在但会提示暂未实现 |
| 自动记忆 | 普通聊天**不会**自动记录。目前只有 Telegram 的显式 `/remember` |
| 记忆的向量检索 | 只有 embedding 配置命令；实际检索用关键词打分 |
| 终端 `ai use` 接入记忆 | 记忆目前只在 Telegram 生效 |
| API Key 加密存储 | 明文保存在 `providers.json` / `memory.json` |
| Skill 自动沉淀 | 未实现 |
| 多租户 / 组织隔离 | 未实现，当前是单机单用户 |
| 企业身份对接（OIDC/SAML/SCIM） | 未实现 |
| 插件体系 | 未实现 |
| 桌面客户端 | 未实现 |

已知的实现差异（会逐步收敛）：

- `ai provider list` 和 `ai status` 显示掩码 API Key（保留首末 4 位）。目标是只显示「已配置 / 缺失」状态，录屏分享前请注意
- 编辑 `apiKey` 时当前值会作为输入默认值显示
