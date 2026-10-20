# AxiomRuntime 使用指南

面向使用者的操作手册。读完这一份就能把项目用起来，不需要看架构文档。

- 想了解内部设计 → [技术架构](architecture.md)
- 想了解产品规划 → [产品需求文档](prd.md)

本文只写**当前版本真正可用**的功能。规划中的能力集中放在最后一节「还没有的功能」，不会混在正文里。

---

## 1. 这是什么

AxiomRuntime 提供一个 `ai` 命令，帮你统一管理 Claude Code 和 Codex CLI 的**服务商（Provider）**。

它解决四个日常问题：

| 问题 | AxiomRuntime 的做法 |
|---|---|
| 有多个 API 中转站，来回改环境变量很烦 | 集中配置，`ai use claude 某站` 一句话切换 |
| 某个中转站挂了，手动换很麻烦 | 按优先级自动降级到下一个可用服务商 |
| 不知道 token 花在哪 | 本地代理记录真实用量，`ai status` 查看 |
| 想在手机上用 Claude Code | Telegram Bot 远程执行 |
| 需要生成图片 | `ai image <provider> <prompt>` 调用已配置的图片 Provider 并保存结果 |

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
brew tap linlangli/axiom https://github.com/linlangli/AxiomRuntime.git
brew install linlangli/axiom/axiomruntime
ai --version
```

Homebrew 用的是同版本的 npm tarball，校验 SHA256 后装到隔离目录，并固定使用 Homebrew 的 `node@22`。Tap 名仍为 `linlangli/axiom`，第一次 `brew tap` 必须带上实际的 GitHub 仓库 URL。已经添加旧 GitLab Tap 的用户，执行 `git -C "$(brew --repo linlangli/axiom)" remote set-url origin https://github.com/linlangli/AxiomRuntime.git` 后再运行 `brew update`。

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
ai provider add 我的站 https://example.com sk-xxx gpt-5.5  # 显式模型回退
```

添加时自动完成：选择 `0..N` 优先级 → 探测 Base URL 与认证方式 → 获取模型列表 → 用每种实际存在的文本协议各一个代表模型做最多 1 token 的可用性验证 → 设 `mode: auto` → 写入配置和模型缓存 → 选择默认模型。已有 5 个自动 Provider 时会提供 `0, 1, 2, 3, 4, 5, 6`；选择已占用等级时，新 Provider 占据该等级，原 Provider 移到队尾。`level: 0` 表示只允许显式选择，不参与自动切换。全部候选均失败时不会写入 Provider。

选择优先级时，列表行首的数字**就是 level 本身**，直接输入它即可，不存在另一套行号。

纯图片 Provider（模型目录里只有 `gpt-image-*`、`dall-e-*` 这类图片模型）会被**强制存为 `level: 0`**，忽略你在列表里选的等级。原因是它没有任何可用于对话的模型：留在自动降级链上，Claude Code 或 Codex 轮转到它时只会拿到 `403 无权访问 image 分组` 或 `404`，白白浪费一跳。`ai image` 显式指定它照常可用。

Runtime 会先尝试你输入的 Base URL，再按需增加或移除末尾 `/v1`；认证只在 `Bearer`、`x-api-key`、`api-key` 等可由当前 API Key 安全派生的已知方式中选择，不会暴力猜测任意私有 header。探测成功后终端会列出最终 URL、认证方式和模型。只有超时、`429`、`5xx` 会短暂重试，确定性的认证或路径错误不会重复请求。

部分 Provider 不开放 `GET /models`，会返回 `404`、`451` 等状态。交互式添加会在自动发现失败后要求输入官网明确提供的模型名，并优先通过 Responses API（Claude 模型则通过 Messages API）做一次最小真实验证；脚本可把模型作为第四个参数传入。验证成功后只缓存该手工模型，失败则不保存配置。Runtime 不会自动猜测模型名。

### 查看

```bash
ai provider list      # 只看配置，不联网
ai models             # 交互选择并刷新一个 Provider 的完整模型列表
ai models 我的站      # 只通过 GET /models 查询指定 Provider
ai check              # 交互选择并检查一个 Provider
ai check 我的站       # 只检查指定 Provider
ai status             # 联网刷新健康度 + 看用量
```

`ai provider list` 以卡片形式展示，`level: 1` 会标注为默认服务商。API Key 显示为掩码（`sk-d****0000`）。

`ai models [provider]` 只调用选中 Provider 的 `GET /models`，更新该 Provider 的完整模型缓存并逐行列出模型名，不会调用任何模型做推理，因此不产生推理 Token。省略名称时进入交互选择；提供名称时精确匹配。模型发现失败时保留原缓存和真实健康状态。

如果 Provider 本身不开放模型目录，`ai models [provider]` 会如实报告 `404`、`451` 等目录错误；这不代表已缓存模型不可用。请用 `ai check [provider]` 对缓存模型做最小真实验证。

`ai check [provider]` 复用与 `ai status` 相同的真实验证规则，但只刷新并检查一个 Provider。省略名称时进入交互选择；提供名称时精确匹配，名称不存在会直接报错，不会退回检查其他 Provider。适合在 Provider 较多时降低等待时间和验证 Token 消耗。

验证通过的 Provider 会把健康分**直接恢复到满分**，而不是每次成功只加一点。历史上被误判扣掉的分数不会拖着不放：只要它现在真的能用，`ai status` 跑完就是干净的。

`ai status` 会先刷新模型列表，再为每个 Provider 分别选择最多一个 Claude 代表模型和一个 Codex 代表模型做真实调用验证。Codex 优先验证 Responses API，只有明确不支持时才回退 Chat Completions。对于已通过手工模型验证、但不开放 `GET /models` 的 Provider，会使用已验证缓存模型继续检查，不会因为目录返回 `451` 而误判不可用。不存在对应模型族时不会发起该协议请求；每次验证使用最短输入、把输出限制为 1 token，并且不自动重试产生 Token 的请求。代表模型验证最多等待 30 秒：明确成功显示 `ready`，明确失败显示 `provider-error`；如果本地等待超时，上游仍可能已经处理成功，因此显示 `unknown` 并保留该 Provider 的运行候选资格。

### 编辑与删除

```bash
ai provider edit
ai provider delete 我的站
```

可编辑字段：`name`、`baseUrl`、`apiKey`、`mode`、`level`、`model`。

编辑 `model` 从目标 Provider 的模型缓存选择；若提示没有缓存，先运行 `ai models <provider>`，再重新编辑。该命令只刷新模型目录，不调用推理端点；无需刷新全部 Provider 的 `ai status`。

规则：

- `mode` 只能选 `ask` 或 `auto`
- `model` 从已探测到的模型里选，不用手输
- 修改 `baseUrl` 或 `apiKey` 时先验证新配置；失败会保留原 Provider 和模型缓存
- 改 `level` 时，当前项会显示为 `current: Provider名称`；如果目标等级被占用，两个 Provider 会**交换**等级；改为 `0` 后退出自动候选链
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
- 显式指定服务商 → 不先刷新全部 Provider，直接使用该 Provider 的已缓存模型并实际尝试；即使健康缓存暂时为 `error`，也不会在请求前静默跳过
- 当前服务商不可用 → 按 `level` 顺序自动降级
- 全局一键关闭自动降级用 `ai failover off`；关闭后只尝试选定（或默认 `level: 1`）的 Provider，失败即报错不切换。`ai failover on` 恢复；无参数 `ai failover` 查看当前状态。关闭自动降级时同时停用连续响应头超时熔断，不因已有熔断或健康错误缓存跳过所选 Provider；每次 CLI 重试均实际访问上游，单次请求超时仍为 45 秒。开关在新启动的 execution 中生效，已有会话需退出后重启
- `level: 0` → 不参与自动降级；显式指定该 Provider 时只使用它
- Claude Code 只会选择提供 Claude 模型的 Provider；Codex 只会选择提供 Codex/OpenAI 兼容模型的 Provider，不会跨模型族切换
- Codex 认 `gpt`、`codex`、`grok`、`o` 系列和 `openai` 开头的模型名

### 请求级自动切换

`ai use` 只启动一个 Claude Code 或 Codex 进程，候选 Provider 由同一个 execution-scoped Transport Proxy 管理。真正带请求体的模型 `POST` 遇到连接失败、认证失败、`404`、`408`、`409`、`425`、`429`、`5xx`，或流式响应在有效内容出现前中断时，Runtime 会丢弃失败尝试，按 `level` 切到下一个 Provider，并将请求中的 `model` 改为该 Provider 的候选模型。原生 CLI 进程没有重启，因此它发送的完整会话上下文仍在同一请求中。

**一次失败不会立刻换 Provider。** Runtime 先在当前 Provider 上原地重试，只有重试额度用尽才轮转：

| 失败 | 是否原地重试 |
|---|---|
| `429` 限流、`5xx`、`408`/`409`/`425` | 重试 |
| 连接被重置 / 拒绝 / socket 挂断 | 重试 |
| 流式响应在有效内容出现前中断 | 重试 |
| `401` / `403` / `404` | 不重试，直接换下一个 Provider |
| 响应头超时 | 不重试（已经等满了一个超时窗口，重试等于再等一遍） |
| 已经输出过内容后中断 | 不重试（见下一段） |

默认每个 Provider 最多尝试 2 次（首次 + 1 次重试），两次之间退避 300ms，之后按次数翻倍。重试成功的请求**不计入**该 Provider 的失败次数、不扣健康分；重试全部失败时整段只记一次失败，不会因为重试而加速熔断。所以偶发的 429 或上游抖动现在大多在原地就消化掉了，你在 `ai log` 里会看到 `provider_retry` 而不是一串切换。

一旦已经向 Claude Code/Codex 返回文字、推理增量或工具参数，Runtime 不会自动重放，避免重复输出或重复工具调用。此时 Runtime 只记下候选 Provider，**下一个**经过代理的请求才真正切过去。`400`、`413`、`422` 等通常由请求本身导致的错误不会跨 Provider 重试。确认动作依赖你在当前 CLI 里重新提交或重试，不会抢占原生 TUI 弹出额外的 `y/n` 输入框。

### 哪些请求不会触发切换

只有**会真正产生补全的模型端点**参与降级：`/v1/messages`、`/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/embeddings`、`/v1/images/generations`、`/v1/images/edits`，其中 multipart 参考图上传不自动重试或轮转。其余辅助请求收到的 HTTP 错误原样返回给 CLI；连接失败或响应头超时则返回本地代理错误。它们都不重试、不轮转，也不计入 Provider 健康分。

最常见的一类是 Anthropic 的 `/v1/messages/count_tokens`。Claude Code 会主动调用它来估算上下文长度，而多数第三方中转站没有实现这个端点，会返回：

```json
{"error":{"message":"Invalid URL (POST /v1/messages/count_tokens)","type":"invalid_request_error"}}
```

这是**端点缺失**，不是 Provider 坏了。如果把它当成模型调用失败，一次 `count_tokens` 就会连续轮转并烧穿整条候选链，同时给每个被轮到的 Provider 记一次失败、扣一次健康分——本来完全可用的 Provider 会被误标成 `error`。现在这类请求被排除在降级之外。

**一处与上述描述不符的实际行为**（已核实，修复前请按实际行为理解）：

| 场景 | 实际行为 |
|---|---|
| 处于「等待确认切换」状态时，CLI 自发的**无关请求**（包括无请求体 `GET`）先到达 | 该请求会**替你消耗掉**待确认状态并记为已确认切换，不需要你真的重新提交 |

它不会造成重复输出或重复计费——切换本身仍然只对失败的尝试生效。影响是**落点可能比你预期的更早发生变化**：想确认这次请求最终由谁承接，用 `ai log --print --trace <traceId>` 看终止跳，而不是假设它还在启动时选定的 Provider 上。

**提示显示在哪里**：原生 CLI 的 TUI 独占终端并整屏重绘，因此 Runtime **不会**在会话期间往终端插入提示行——那会打乱 TUI 的排版。切换提示按通道分两处呈现：

- **会话期间**：已输出部分内容后中断时，提示作为协议内的错误事件写回当前响应流（Claude 用 `api_error`，Codex 用 `provider_failover_pending`），由原生 CLI 按自己的样式渲染，格式不会错乱。
- **会话结束后**：`ai use` 退出、终端所有权回到 Runtime 时，统一打印本次执行的切换汇总，包含每次切换的来源、目标、原因，以及用 `ai log --print --trace <traceId>` 查看完整链路的入口。有效输出前的自动切换不打断当前请求，只计入这份汇总。

### 怎么知道当前在用哪个 Provider

因为上面那条限制，`ai use` **运行期间**终端里看不到当前落在哪个 Provider —— 原生 TUI 的画面归它自己，Runtime 不往里插字节。目前可用的查看方式都是**事后**的：

```bash
# 退出 ai use 后，终端会打印本次执行的切换汇总（发生过切换才打印）
ai log --print --trace <traceId>   # 按链路回看这次请求试过的每个 Provider
ai session list                    # 会话记录里的服务商和模型
ai last                            # 上次选择的工具 / 服务商 / 模型
```

> 已知限制：`ai session list` 和 `ai last` 记的是**启动时选定**的 Provider。如果执行期间发生过请求级自动切换，实际承接请求的 Provider 要用 `ai log --trace` 确认。
>
`ai web` 的侧栏显示当前**默认** Provider，「运行记录 → 调用记录」按 `traceId` 分组显示近期执行事件，结果 Provider 仅取自明确的终止事件；缺少终止事件时显示「结果未知」。工具执行可能包含多次请求，不能据此推断每次请求的实际承接者。它仍不改变原生 CLI TUI 的实时显示限制；可用 `ai log --print --trace <traceId>` 查看已记录的调用过程。

### 它对你的环境做了什么

这部分值得了解，因为涉及到会不会污染你现有的配置：

**Claude Code**：生成一个临时 `--settings` 文件，把 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL` 写进去再启动。为避免 Claude 同时看到两套认证，本次子进程会移除继承的 `ANTHROPIC_AUTH_TOKEN`，临时 settings 还会用空值遮蔽用户 settings 里的同名变量；**不碰 `~/.claude/settings.json`，也不修改当前 shell。**

**Codex**：通过本次子进程的 `-c model_provider=...` 参数固定服务商，用 `env_key = "OPENAI_API_KEY"` 读注入的 Key。**不碰全局 `auth.json` 和 `config.toml`**，直接执行 `codex` 的行为不受影响。

**Base URL 自动适配**：如果你的 `baseUrl` 是 OpenAI 兼容地址（比如 `https://example.com/v1`），启动 Claude 时会自动去掉 `/v1`，启动 Codex 时保留。

**权限模式**：`mode: auto` 时非 root 启动 Claude 会追加 `--dangerously-skip-permissions`；`ask` 模式不加，并在启动前确认。

**用量记录**：两个引擎的模型请求都经过一个本次执行专属的本地代理转发，服务商返回的真实用量按服务商/模型写入 `usage.json`。终端交互方式完全不变。

**日志**：记录服务商、Base URL、模型、启动参数和 API Key 指纹，**不记完整 Key**。

### 为 Runtime 和 Provider 设置代理

```bash
ai proxy                              # 交互选择 Provider 或 Runtime 默认值
ai proxy 我的站 127.0.0.1 8081        # 只为“我的站”设置代理
ai proxy 我的站 --disable             # 清除该 Provider 的覆盖，回退 Runtime 默认值
ai proxy 127.0.0.1 8081               # 设置 Runtime 默认代理
ai proxy http://127.0.0.1:8081        # 完整 URL 仍可用
ai proxy --disable                    # 清除 Runtime 默认代理
```

首个参数与已有 Provider 名精确匹配时，设置该 Provider 的 `proxyUrl`，保存在 `~/.ai-gateway/providers.json`；否则沿用 `host [port]` 形式设置 `~/.ai-gateway/runtime.json` 中的默认代理。无参数时先选目标，再显示当前地址及 `Edit proxy`、`Disable proxy`、`Cancel` 操作。`ai provider edit` 的 `proxyUrl` 字段也可编辑。新增或编辑都会先做零 Token 的代理端点 TCP 连通检查；失败时保留原配置。清除 Provider 代理只删除它的覆盖值；若 Runtime 默认代理仍存在，请求会回退到该默认值。

Provider 代理优先作用于该 Provider 的模型发现、健康探测和模型请求，包括同一会话内降级轮转到该 Provider 的请求。未配置 Provider 代理时使用 Runtime 默认代理。通过 `ai use` 启动的 Claude Code / Codex 子进程采用启动时所选 Provider 的代理环境；模型流量仍先进入本次执行的 Transport Proxy，再按实际承接请求的 Provider 选择上游代理。Runtime 自动把 `127.0.0.1`、`localhost` 和 `::1` 加入 `NO_PROXY`，避免本地代理回环。

`ai proxy` 不修改 `~/.claude`、`~/.codex` 或原生命令的永久配置；直接运行 `claude` / `codex` 不受影响。需要持久修改 Codex App 时，继续使用后文的 `ai set codex proxy`。

## 6. 生成图片

使用已配置并探测到的图片模型生成一张或多张图片：

```bash
ai image                                                   # 交互选择 Provider、模型并输入提示词
ai image 51talk-image "生成3张咖啡店宣传图：一张1024x1024方图、一张1536x1024横图、一张1024x1536竖图，保持统一风格"
ai image 51talk-image "咖啡店宣传海报" --count 3 --size 1024x1024
ai image 51talk-image "一只戴墨镜的猫，数字插画"          # 使用 Provider 默认模型
ai image 51talk-image gpt-image-2 "一只戴墨镜的猫，数字插画"  # 指定具体模型
ai image 51talk-image "保持人物一致，改成水彩风格" --image "./参考图.png"
ai image 51talk-image "将图1人物融入图2场景" --image "./人物.png" --image "./场景.jpg"
ai image 51talk-image gpt-image-2 "替换背景为海边" --image "C:\My Pictures\人物.jpg"
```

规则：

- 直接运行 `ai image` 时，会依次选择 Provider、具体模型、生成方式（文生图 / 参考本地图片），参考图模式逐张输入本地文件路径，留空结束（达到 8 张自动结束），最后输入提示词。只有 Provider/模型、没有提示词时也会询问生成方式；已有提示词的旧用法不增加交互。交互路径可带成对引号。
- 交互式只需在 `Image prompt` 中描述明确数量与像素尺寸，与命令行提示词使用同一个规划器。例如“生成3张……一张1024x1024、一张1536x1024、一张1024x1536”。支持中文数字及 `Generate three images` 等明确英文数量，`x` / `×` / `*` 尺寸分隔符；同尺寸可写“生成3张1024x1024图片”。逐图要求建议用逗号、顿号或分号分隔，共同风格保留给每张图。此功能按明确句式解析，不调用额外模型，不保证理解任意自由表达。
- 可用 `--count 1..8` / `--count=3` 和 `--size WIDTHxHEIGHT` / `--size=auto`。未说明数量默认 1 张，未说明尺寸使用 Provider 默认。参数指定对应字段；与提示词明确数量或尺寸冲突时先报错，不静默覆盖。最多规划 8 张；像素宽高本地限制 64–8192、总像素 ≤16,777,216，实际 Provider 限制可能更低。
- “多张”“一套”但未说明数量，或多张“不同尺寸”但未给出像素尺寸，会在交互式按缺失字段追问数量或尺寸，原始提示词和参考图保持不变；带提示词的命令行用法直接报错，需修改提示词或补参数。场景内物体数量和引号内文字不作为输出数量；不从横竖版、比例或用途猜测像素尺寸。也能识别句子中间独立分句的“2张图片”；“参考这几张图片”不会被当作输出数量。数量追问可直接回答 `2`，只补充数量；尺寸追问按输出顺序输入 `2160x3840,3840x2160`，仅补充尺寸，不要只填张数。`4K`、手机屏幕或 PC 屏幕未给像素尺寸时会追问，提示上述 4K 手机/PC 尺寸作为示例，由用户明确输入后使用，实际支持以 Provider 为准。纯数字不作为图片描述。
- 每个任务独立请求 `n: 1` 并传入自己的 `size`，依次执行，保持共同风格但不保证跨图人物/版式完全一致；整批复用一个 Transport Proxy。不原地重试生成请求；文生图在 `ai failover on` 时可按现有请求级规则切换到提供同模型的 Provider，`off` 时不跨站；参考图始终不自动重试或跨站。
- 已知 `dall-e-2` / `dall-e-3` 的尺寸限制在上传前检查；其他模型目录不提供可靠尺寸能力，以 Provider 实际响应为准，不静默替换尺寸。base64 图片通过 `image-size` 读取真实尺寸；不符时仍保存文件、报告尺寸差异并将任务标记失败。URL 输出只报告链接与尺寸未验证，不自动下载。
- 保存响应中的全部图片，整批最多接收 8 张；文件名包含任务序号和请求尺寸。逐任务汇报结果，单张失败继续后续任务，已成功文件保留；任一任务失败时命令退出码为 1，不自动重跑整批。上游额外返回图片计入 8 张上限，达到上限后剩余任务不再发请求。
- 重复 `--image <path>` 或 `--image=<path>` 指定多张本地参考图，可放在位置参数前后，按输入顺序上传；路径有空格时加引号。最多 8 张，单张最大 20 MiB，合计最大 40 MiB。支持按文件内容识别的 PNG、JPEG、WebP；不支持 GIF、目录、远程 URL 或 mask。所有文件在任何图片上传前完成校验，不修改原图；输出仍为新文件。
- 参考图模式调用 multipart `/v1/images/edits`，不是将路径拼进提示词。Provider 和模型必须支持该接口及所选的单图或多图编辑能力；模型列表中存在不代表支持图片编辑，服务端仍可能返回格式、尺寸或能力错误。当前不实现 Responses 图片工具等非兼容接口。
- 参考图会上传给所选 Provider；**不会自动重试或向其他 Provider fallback**，所选 Provider 不健康时也不会偷偷换站。仅指定模型而未指定 Provider 时，按原有健康/顺序规则选择一个可用 Provider。请只选择可信服务商，失败后明确选择其他服务商重新运行。
- 第一个参数是 Provider 名（例如 `51talk-image`）。第二个参数如果匹配该 Provider 的模型缓存，就作为具体模型；否则从第二个参数开始全部拼成提示词，并使用 Provider 默认模型。
- Provider 和模型必须出现在模型缓存中。命令执行前会自动刷新；也可以先运行 `ai status` 检查模型列表。如果没有 Provider，先运行 `ai add`。
- 为避免模型名与提示词歧义，指定具体模型时建议给提示词加引号，例如 `ai image 51talk-image gpt-image-2 "提示词"`。
- 文生图按 Provider 健康状态与候选顺序选择，自动切换受 `ai failover on/off` 控制；参考图模式不跨 Provider 切换。
- `b64_json` 响应会以 `0600` 权限保存到当前目录，输出绝对路径；远程 `https` 图片响应会输出 URL，不会自动下载不受信任的地址。
- 每张图片请求等待响应头上限为 120 秒；文生图开启自动降级后可尝试下一个 Provider，参考图失败直接报告，不自动重试或换站。
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
- 如果旧版本在 Provider 表中留下指向 `dist/cli/codex-auth.js` 的 auth command，重新执行 `ai set codex provider ...` 会在写入新配置时清理该过期引用；单纯构建项目不会修改你的 Codex 配置
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

**代理**：本机连不上 `api.telegram.org` 时，设置 `proxyUrl` 或环境变量 `HTTPS_PROXY` / `ALL_PROXY`。交互新增或编辑 Bot 时会分别询问主机/IP与端口；输入 `127.0.0.1` 和 `8081` 会自动保存为 `http://127.0.0.1:8081`。已有代理会先显示当前地址并提供编辑、关闭和取消选项；新地址会先做零 Token 端点连通检查，再通过该代理调用 Telegram `getMe`。失败时提示并回退：新增 Bot 不保存代理，编辑已有 Bot 则保留旧代理。旧的 `host:port` 和完整 URL 仍兼容。

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
ai log --print --trace trc_70d90ad64d1846bf   # 只看这一条调用链路
ai context              # 生成项目上下文到 .ai-gateway/context.md
ai context --print
```

日志包含使用痕迹、报错、健康检查、降级策略执行和诊断记录，文件在 `~/.ai-gateway/.ai-gateway.log`。

**按调用链路查看**：HTTP 请求、Telegram Provider 尝试、一次 `ai use` 的候选解析、切换与终止事件复用入口 `traceId`。带有该 ID 的日志会在 `--print` 输出中显示 `trace:` 行，可配合 `--trace` 按顺序查看已记录的过程。历史日志及部分工具代理、任务生命周期事件缺少该字段，不会被推测关联；日志窗口内缺少终止事件时，最终结果和 Provider 可能无法确认：

```
1. [WARN ] strategy / fallback_skip_provider          legacy-gw 熔断中跳过
2. [WARN ] strategy / runtime_server_provider_fallback openrouter HTTP 429
3. [INFO ] strategy / runtime_server_request_settled   由 zhipu 承接（第 2 跳，fellBack=true）
```

内网 API 服务的 `x-request-id` 响应头即该请求的 `traceId`，可直接用它反查链路。

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

`ai help` 用系统默认程序打开独立的 `USAGE.html`。`ai web` 的「帮助中心 → 命令手册」复用同一份手册内容，完整提供命令索引、安装配置、模型使用、服务管理、记忆配置、消息接入、状态诊断、会话报告和配置文件。命令索引可按分组筛选，顶部搜索覆盖所有命令、参数与详细规则；点击搜索结果可阅读完整说明。命令和整段示例均可一键复制，详细规则可展开或收起；界面沿用本地面板的纸张卡片、柔和配色与响应式目录。复制命令不会执行命令或修改配置。

### 本地 Web 控制面板

本地源码或 `npm link` 安装若打开后显示 `{"error":"Not found."}`，请在项目根目录执行 `npm ci --prefix web` 和 `npm run build:web:console`，然后刷新页面。控制面需要 `dist/web/control/console.html` 及其静态资源；只运行 `tsc` 不会生成这些文件。完整构建使用 `npm run build`。

公网门户 [axiom.offerpilot.life](https://axiom.offerpilot.life/) 提供安装步骤、命令参考与当前能力边界，可复制安装命令。页面中的终端用量和 Telegram 对话均为示例；查看本机真实用量、日志或配置请使用下方 `ai web`。

```bash
ai web
```

命令启动仅监听 `127.0.0.1` 的临时端口并打开浏览器；终端保持运行，按 `Ctrl+C` 关闭。打开链接含一次运行有效的访问 token；不要把链接发给别人。控制面板可查看 Provider 健康缓存、真实用量趋势、最近日志与会话，添加/编辑/删除或检查 Provider，也可执行与 `ai set codex` 等价的持久配置操作。添加或改动 Provider 地址、API Key 会先进行真实探测，可能产生少量 Token。

Web 控制面的「本地配置」提供「服务配置、模型路由、工具配置、网络代理、消息接入、记忆设置、配置维护」七个二级分类。可以在浏览器编辑 Provider、自动切换、Codex 持久配置、Runtime/Provider 出站代理、具名 Telegram Bot 和 embedding 连接；提交前会展示变更预览，写入前自动创建本机快照，失败由 core 保留旧配置。Claude Code 用户级区域只读，复制 `ai use claude` 在终端执行。Codex App/CLI 在同一 `CODEX_HOME` 下共享用户级配置；旧聊天不会迁移，请新建聊天。配置维护可恢复最近 20 个受限权限快照，但不包含用量账本、数据库或 Codex 用户配置。

「对外服务」提供「反代接入、能力开放、访问控制、接入测试」四个二级分类。页面编辑 API 上游和公网 HTTPS 入口，按接口能力勾选开放项，为每个调用方创建独立凭证并可撤销，凭证只在创建时显示一次，落盘只保留摘要。它会生成 Nginx 片段和 curl 示例；Web 不会写远程服务器，也不会把本机管理页面暴露出去。启动 API 服务时可使用这份能力配置，逐请求检查全局开放能力和凭证权限。

保存开放配置并创建凭证后，在运行 Runtime 的机器执行 `npm run server`；默认监听 `127.0.0.1:8080`，可用 `AI_GATEWAY_SERVER_HOST` / `AI_GATEWAY_SERVER_PORT` 修改。首次启用开放配置需重启已运行的 API 服务，之后能力关闭与凭证撤销逐请求生效。旧的 `AI_GATEWAY_SERVER_TOKEN` / `AI_GATEWAY_SERVER_TOKEN_FILE` 仍支持，但也受全局开放能力范围限制。反代片段中的上游地址从反代服务器视角填写；Runtime 在另一台电脑时先建立 VPN 或隧道。单个 Provider／模型限制、限流额度与组织权限仍未实现。

「用量统计」支持最近 7/30/70 个 UTC 自然日和 Provider 筛选。趋势图可切换总量/输入/输出；调用活动采用 GitHub 式按周排列的 7 天小方格，短区间保留浅色日历上下文，不拉伸方格或改变排列语义，统计数字只来自当前筛选区间；Provider 占比使用圆角、无间隔分段、轻量涂鸦纹理和可切换图例的环形图。成本卡片右上角的设置按钮可以按 Provider/模型编辑输入、输出和可选 Cache Read 价格（美元/百万 token）。Provider 下拉完整列出当前所有配置、历史 usage 和已有价格键，直接选择即可切换；模型下拉列出对应 Provider 缓存目录、默认模型、历史 usage 模型和已有价格键，也可选择「手动输入模型…」填写模型 ID。切换 Provider 会更新模型和价格，保存后当前区间立即重算；未配置价格的事件会单独提示且不计入成本。点击趋势或活动日期进入「运行记录 → 调用记录」，保留 UTC 日期筛选。图表只反映 Runtime 已记录的 usage，不包含未经过 Runtime 的直接调用。

升级后若仍有旧版 `ai web` 进程运行，请在原终端按 `Ctrl+C`，重新运行 `ai web` 打开新版页面；旧数据无需迁移。新版界面遇到旧服务响应时会提示重启，避免使用缺失字段。

「运行记录」分为三个页面：

- **调用记录**：基于最近 300 条日志，按 `traceId` 归组执行，优先显示结果、模型、Provider 和时间；支持结果、切换、重试、Provider 和搜索筛选。点击打开侧边详情，查看结果摘要、Provider 过程、中文事件时间线和可展开的原始字段。重试与跨 Provider 切换分别计数，配对的切换计划和应用事件只计一次。缺少终止事件显示「结果未知」，不推断正在运行；结果 Provider 仅取终止事件，耗时未记录时明确显示事件跨度。一次工具执行可能包含多次请求，目前不提供逐调用 Token/成本推算。
- **工具会话**：最近 30 次工具启动与退出，展示工具、初始模型/Provider、启动时间、运行时长、退出结果与退出码。未记录结束时间显示「尚无退出记录」，不能视为进程存活。仅当日志明确记录与本地会话相同的 `sessionId` 时提供关联调用入口；不按时间或 Provider 猜测关联，也不展示聊天内容。
- **系统日志**：按「模型请求 / 服务检查 / 配置变更 / 系统运行」分类，支持级别、Provider、分类、日期和搜索筛选。事件先显示中文说明，展开查看脱敏后的 `action`、`level`、`traceId` 等原始字段；存在明确调用关联时可直接打开调用详情。没有 `traceId` 的事件仅保留在日志中，不生成调用记录。

公网门户 `https://axiom.offerpilot.life/` 是独立部署的静态介绍页，不连接本机配置、不提供远程控制，也不包含在 npm 包内。默认分支的 GitHub Actions 会先测试并构建 `web/dist/portal/`，再用受限的 `axiom-portal-deploy` SSH 账号上传不可变 release、原子切换 `current` symlink，并用线上首页内容做健康检查；失败会自动恢复上一 release。SSH 主机公钥和私钥通过 `portal-production` Environment Secrets 注入，私钥不进仓库。服务器证书和 Nginx SNI 分流属于一次性运维配置。门户发布需要先把改动合并到默认分支；原 GitLab CI 文件保留。

### 维护者发布与 CI 配置

源码仓库为 `https://github.com/linlangli/AxiomRuntime`。GitHub 托管 runner 执行测试、门户构建与 SSH 部署，无需在服务器安装 Actions runner。branch push 和 PR 执行 `npm test` 与 `npm --prefix web run typecheck`；默认分支 push 在测试成功后发布门户，`v*` tag push 单独触发 npm 发布。

在仓库 Settings → Environments 创建并配置：

- `portal-production`：只允许 `main` branch。Variables 添加 `PORTAL_SSH_HOST`；`PORTAL_SSH_USER`、`PORTAL_DEPLOY_ROOT`、`PORTAL_HEALTH_URL` 可选，默认依次为 `axiom-portal-deploy`、`/srv/axiomruntime-portal`、`https://axiom.offerpilot.life/`。Secrets 添加 `PORTAL_SSH_PRIVATE_KEY_B64` 和 `PORTAL_SSH_KNOWN_HOSTS`。使用专用部署账号和已核对的主机公钥。
- `npm-production`：只允许 `v*` tag，无需添加 npm Secret。在 npm 包 `@offerpilot/axiomruntime` 的 Settings → Trusted Publisher 创建 GitHub Actions connection，填写 owner `linlangli`、repository `AxiomRuntime`、workflow filename `publish.yml`、environment `npm-production`，只启用 `Allow npm publish`。如果显示 `Pending validation`，须在页面给定截止时间前完成一次获准的新版本发布；仅保存连接不代表发布认证已经验证。

GitLab 中的变量不会自动复制；账号无法访问时，部署 SSH key 可重新生成。GitHub npm 发版通过 OIDC 获取短期凭证并生成 provenance，无需迁移或保存 `NPM_TOKEN`。workflow 使用支持 OIDC 的 `npm@11.11.0`，仅 npm job 有 `id-token: write` 权限。保留的 GitLab CI 仍使用原有 `NPM_TOKEN`。

macOS 双击 `发布.command`，或运行 `npm run release` 打开发布助手。助手使用 GitHub CLI `gh` 检查登录和发布 workflow，在临时目录合并远端 `main`、安装根目录与 `web` 依赖、验证版本并运行完整测试，经确认后推送 release commit 与 tag，等待 `Publish npm` Actions 结果。npm Trusted Publisher 必须提前配置；助手不能通过 GitHub API 读取 npm 端信任状态。tag 提交必须包含在默认分支中，tag 版本必须等于 `package.json.version`。Homebrew 发布仍单独从 npm `latest` tarball 计算 SHA256，不重复发布 npm。迁移已有 Git 历史时先备份本机 refs；未提交修改和 GitLab Issues、CI variables、artifacts 不属于 Git push 的内容。

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

**`runtime.json`** —— 运行时全局默认值。`proxyUrl` 是未在 Provider 上单独配置时的默认代理；`failoverDisabled: true` 会关闭 Provider 自动降级切换（失败只报错不换路）。这两个字段建议用 `ai proxy` / `ai failover` 命令改，不要手写：

```json
{
  "proxyUrl": "http://127.0.0.1:8081",
  "failoverDisabled": true
}
```

**`model-pricing.json`** —— 给只返回 token 不返回费用的模型估算成本。单位是**美元/百万 token**，可按模型名或 `服务商/模型` 配置。也可以在 `ai web` →「用量统计」→ 成本卡片右上角设置按钮中编辑；Web 通过 core pricing API 校验并原子写入，不会回显任何 Provider 密钥：

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
- `ai web` 的侧栏显示默认 Provider，不是请求级实时承接者；`ai use` 运行期间的准确切换结果仍需用 `ai log --trace` 核实
- `ai session list` / `ai last` 记的是**启动时**选定的 Provider，执行期间发生的请求级自动切换不回写，实际承接者用 `ai log --trace` 确认
