# AxiomRuntime 产品需求文档（PRD）

面向开发者与产品。记录产品定位、用户价值、当前能力边界与发布计划。

- 使用方法 → [使用指南](usage.md)
- 内部设计 → [技术架构](architecture.md)

**状态标记贯穿全文**：

| 标记 | 含义 |
|---|---|
| 🟢 已发布 | 当前版本可用 |
| 🟡 部分可用 | 有实现但未达目标形态，存在明确限制 |
| 🔴 规划中 | **尚未实现** |

---

## 1. 产品定位

### 一句话

AxiomRuntime 是一个 **AI Runtime**：统一执行入口 + 受治理的记忆 + 可验证的学习 + 可复用的能力沉淀。

### 北极星指标

> **每次交互让 Runtime 更强。**

会话结束时 Runtime 不重置。可操作的定义：

- 纠错率下降
- 任务成功率不下降
- 检索精度不回归

三条同时成立才算「更强」。**产物数量和召回次数不是成功指标。**

### 演进阶段

```text
① Provider Gateway            ← 当前位置
② Unified Execution Runtime
③ Governed Learning Runtime
④ Organizational Capability Platform
```

### 产品原则

| 原则 | 含义 |
|---|---|
| Runtime 是产品 | Model、Provider、Memory、Skill、Tool 都是可替换能力 |
| 接入面是适配器 | CLI / Telegram / Web / API 共享同一条执行主链，不各自实现策略 |
| 发现 ≠ 激活 | 模型和插件可以提出候选，但不能自我授权 |
| 证据优先 | 事实 confidence 来自证据，不来自被引用的次数 |
| 复用成熟能力 | 差异化在 Runtime 语义层，通用引擎通过适配器采纳 |

### 明确的非目标

- **不是模型**，不训练模型
- **不替代** Claude Code / Codex，而是给它们喂对的配置并记账
- **不做**通用向量数据库、通用工作流引擎、通用策略引擎 —— 这些通过适配器接入
- **不改写** `CLAUDE.md` / `AGENTS.md` 作为主存储，那仍由各自 `/init` 管理

---

## 2. 目标用户与场景

| 角色 | 核心诉求 | 当前满足度 |
|---|---|---|
| 个人开发者 | 多个中转站统一管理，不手改环境变量；知道钱花在哪 | 🟢 完整满足 |
| 移动办公开发者 | 手机上远程跑 Claude Code / Codex | 🟢 Telegram Bot |
| 小团队技术负责人 | 内网统一 API 入口，用量归属清晰 | 🟡 有常驻 API，无组织模型 |
| 平台/运维 | 执行可观测、失败可诊断、配置可恢复 | 🟡 有 traceId 日志关联、doctor/report 与受管配置快照，缺少统一 Kernel 事件与完整灾备演练 |
| 企业管理员 | 身份联合、策略治理、配额与合规 | 🔴 未实现 |

### 已验证的核心场景 🟢

| 场景 | 命令 | 价值 |
|---|---|---|
| 多服务商切换 | `ai use claude 某站` | 一句话切换，不动全局配置 |
| 服务商故障降级 | 自动 | 按 level 顺序自动试下一个 |
| 用量记账 | `ai status` / `ai report` | 真实用量，按服务商/模型归属 |
| 图片生成 | `ai image 51talk-image "提示词"` | 使用指定 Provider 的默认图片模型生成并安全保存 |
| 远程执行 | Telegram Bot | 手机上跑，带进度和审批 |
| Codex 桌面端配置 | `ai set codex` | 原子写 + 失败回滚 + 重启时清理旧凭证环境 |
| 环境诊断 | `ai doctor` | 自动修复损坏的内部状态文件 |
| 内网 API | `npm run server` | OpenAI 兼容 + Agent Run |

---

## 3. 当前能力清单

本机 Web 已补齐持久 Claude 连接配置、具名 Telegram Bot 生命周期、历史分页/导出与轮询、凭证轮换/有效期/Provider 与模型范围/请求频率及总次数额度，以及通过现有 Runtime API 进行对话、向量、图片、Agent 和注册只读工具的实际调用。公网成功验收绑定配置指纹，配置变化后重新验收。SSH 准备支持指纹核对、专用密钥、公钥授权与诊断；Nginx/Certbot 部署需先预览再明确确认执行，回滚限于专属站点配置。以上不代表企业统一 Policy/预算/工具授权已实现；记忆设置不属于本次补齐范围。Windows Task Scheduler 适配为 🟡，命令编排测试通过，实机验收仍是退出条件。

### 3.1 Provider 管理 🟢

| 能力 | 状态 | 说明 |
|---|---|---|
| 增删改查 | 🟢 | `ai provider add/list/edit/delete`，交互与一行式两种 |
| 连通性检查 | 🟢 | 添加时自动测试；`ai check [provider]` 单独检查一个 Provider，`ai status` 检查全部 Provider；每个 Provider 最多验证一个 Claude 和一个 Codex 代表模型，以不自动重试的 1-token 调用展示协议可用性；30 秒超时记为 `unknown` 而非误报失败 |
| 模型发现 | 🟢 | 自动探测并缓存模型目录；`ai models [provider]` 只通过 `GET /models` 刷新并列出指定 Provider 的完整模型，不产生推理 Token |
| 自适应连接配置 | 🟢 | 输入 Base URL 和 API Key 后，以零 Token 模型发现 + 每协议最多一次 1-token 成功验证，自动选择 `/v1` 与已知认证 header；目录不可用时可显式提供模型并直接验证 Responses/Messages，禁止猜测模型；全部失败则拒绝保存 |
| 优先级 | 🟢 | 添加时选择 `0..N`；正整数按顺序自动切换，占用则交换到队尾；`level: 0` 只允许显式使用。选择列表行首数字即 level 本身，不再与行号并列。纯图片 Provider 强制为 `level: 0`，不进入自动降级链 |
| 引擎兼容性过滤 | 🟢 | Claude Code 只选择 Claude 模型；Codex 只选择 `gpt`/`codex`/`grok`/`o`/`openai` 兼容模型；自动切换不跨模型族 |
| Base URL 自适配 | 🟢 | Claude 去 `/v1`，Codex 保留 |
| 健康状态缓存 | 🟢 | 写入 `.ai-cache.json` |
| Provider Key 系统托管 | 🟡 | `SecretStorePort` + `apiKeyRef`；显式迁移与回滚可用，真实 OS 持久性仍需验收；其他凭据未纳入 |
| API Key 完全不回显 | 🟢 | 列表只显示 configured/missing；编辑不预填，交互输入不回显；日志使用 SHA-256 指纹 |

### 3.2 工具执行 🟢

| 能力 | 状态 | 说明 |
|---|---|---|
| 启动 Claude Code | 🟢 | 临时 `--settings`，不碰 `~/.claude/settings.json`；execution scope 删除进程继承的 `ANTHROPIC_AUTH_TOKEN`，并以空值遮蔽用户 settings 中的同名变量，避免与 Provider API Key 冲突 |
| 启动 Codex | 🟢 | `-c model_provider=` + `env_key`，不碰全局 `auth.json`/`config.toml` |
| 运行时降级 | 🟡 | `ai use` 在同一原生 CLI 会话内对**会产生补全的模型端点**做请求级切换；失败先在当前 Provider 原地重试（限流/`5xx`/连接层错误可重试，`401`/`403`/`404` 直接换），重试耗尽才轮转，已有输出则等待用户重新提交/重试确认。辅助端点（`/v1/messages/count_tokens` 等中转站常未实现的路径）的 `404` 不触发轮转，也不计入健康分。`ai failover off` 一键全局关闭跨 Provider 自动降级（候选链折叠为单候选，只尝试选定或默认 Provider，失败即报错不轮转；原地重试不受影响）。待确认状态仅由带请求体的模型 POST（不含 multipart）消费；GET、空请求和辅助端点不确认 |
| 健康分恢复 | 🟢 | 一次真实成功探测把 `healthScore` 直接置满，不靠固定步长累加填坑，避免误判造成的低分长期滞留 |
| 切换提示不破坏 TUI | 🟢 | 会话期间提示走协议内错误事件由原生 CLI 渲染，退出后再打印切换汇总；父进程不在 TUI 重绘期间写终端 |
| Runtime 出站代理 | 🟢 | `ai proxy` 可选择 Provider 或 Runtime 默认值；Provider 的 `proxyUrl` 优先、缺省时回退默认值，清除覆盖后恢复回退；新增或编辑先做零 Token 连通检查。探测和 Transport Proxy 上游按实际 Provider 路由；不修改原生 CLI 配置 |
| root 权限约束 | 🟢 | UID 0 下 `bypassPermissions` 强制降级为 `default` |
| 会话记录 | 🟢 | 启动配置、最近成功 `actualProvider/actualModel`、请求关联、路径、起止及真实退出状态 |
| 会话续用 | 🟡 | 有 `nativeSessionId` 时在原项目续用原生上下文；Claude 显式 ID，Codex 仅唯一 metadata 候选；旧记录退回启动设置，上游兼容性需验收 |
| 统一 Agent 契约 | 🔴 | Telegram `Engine` 仍是本地兼容 facade，直接 spawn CLI |
| 工具调用逐步授权 | 🔴 | Agent 提议的工具动作尚未回到统一 Kernel 授权 |

### 3.3 用量与成本 🟢

| 能力 | 状态 | 说明 |
|---|---|---|
| 真实用量采集 | 🟢 | execution-scoped 本地代理，解析真实响应 |
| Codex App 本机用量 | 🟢 | 显式开启后只读桌面会话真实 Token，按实际 Provider/模型归属，复用唯一账本；内部 JSONL 格式适配，云端任务不覆盖 |
| Anthropic + OpenAI 双协议 | 🟢 | Claude 走 `/v1/messages`，Codex 走 OpenAI 兼容 `/v1` |
| streaming 用量合并 | 🟢 | input/cache/output 在同一响应内合并 |
| 服务商返回成本优先 | 🟢 | 有 `cost_usd` 用真实值 |
| 本地定价估算 | 🟢 | `model-pricing.json`，美元/百万 token |
| 唯一账本 | 🟢 | Telegram 投影同一批 records，不产生第二份 |
| Codex Provider URL 规范化 | 🟢 | 持久配置 `base_url` 时保证末尾恰好一个 `/v1` |
| 历史补录 | ❌ 刻意不做 | 避免归错服务商或重复计数 |
| 幂等计费键 | 🟡 | 目标是从 attempt 身份派生，保证 exactly-once |
| 组织/项目用量归属 | 🔴 | 当前只按服务商聚合 |

### 3.4 图片生成 🟢

| 能力 | 状态 | 说明 |
|---|---|---|
| CLI 图片生成 | 🟢 | `ai image [provider] [model] [prompt]`；支持完全交互、Provider 默认模型和显式模型 |
| 多图输出与混合尺寸 | 🟢 | 交互式 `Image prompt` 与命令行共用确定性规划，明确数量/像素尺寸拆成 1–8 个顺序任务；`--count` / `--size` 提供确定性参数入口，冲突报错，模糊要求交互式按缺失字段追问，补数量/尺寸不覆盖原始 prompt 或参考图；能识别句中独立分句的数量，4K/手机/PC 无像素值时追问，纯数字不作为图片描述。无额外 LLM 解析成本；任意自然语言理解、宽高比自动映射不在范围内 |
| 批次结果与尺寸验证 | 🟢 | 每项 `n: 1`，共享单个 Transport Proxy；全部返回项在 8 张上限内保存/报告，失败保留已成功文件并继续，任一失败退出码 1。base64 实际尺寸校验，不符保存并报失败；URL 尺寸未验证。已知 DALL·E 限制预检，其他尺寸能力由 Provider 实际响应决定；不保证跨图一致性 |
| 标准 images API | 🟢 | 调用 OpenAI-compatible `/v1/images/generations` |
| 本地参考图 | 🟢 | 重复 `--image <path>` 或交互逐张添加参考图，multipart `/v1/images/edits`；最多 8 张 PNG/JPEG/WebP，单张 ≤20 MiB、合计 ≤40 MiB，全部按内容校验后按序上传；服务商/模型须支持相应单图或多图编辑，不支持 mask 或 Responses 图片工具 |
| 参考图隐私与失败边界 | 🟢 | 上传前本地校验，文件名使用通用名称；不记录图片内容、提示词和原始文件名；所选 Provider 不可用直接失败，不自动重试或跨 Provider fallback；文生图行为保持兼容 |
| 图片安全落盘 | 🟢 | 支持 `b64_json`，限制响应/图片大小并以 `0600` 保存 |
| URL 响应 | 🟢 | 仅输出无凭证的 `https` URL，不自动下载 |
| 图片 usage | 🟢 | 复用唯一 Transport Proxy/UsageObserver 记录真实 usage |

### 3.5 Telegram Bot 🟢

| 能力 | 状态 | 说明 |
|---|---|---|
| 多 Bot 隔离 | 🟢 | 配置/PID/日志/会话按 bot 分离 |
| 白名单鉴权 | 🟢 | 默认只允许 `allowedUserIds` |
| 引导式初始化 | 🟢 | 服务商 → 模型 → 工作目录 → 引擎 |
| 流式进度 | 🟢 | 编辑同一条消息，1500ms 节流 |
| 上下文管理 | 🟢 | 最近 12 轮，1400 token 预算 |
| 固定上下文 | 🟢 | `/pin` 最多 3 条 |
| 引用注入 | 🟢 | 800 token 上限，按不可信内容转义 |
| 编辑重跑 | 🟢 | 编辑最新 prompt 自动停旧执行重跑 |
| 附件 | 🟢 | 8 个文件；文本 2MB、图片 10MB；注入 3000 token |
| 服务商管理 | 🟢 | `/provider` 复用 CLI 核心逻辑 |
| 命令执行 | 🟢 | `/terminal`，60 秒上限，高风险需确认 |
| 显式记忆 | 🟢 | `/remember` `/forget` `/memories` |
| 自动记忆 | 🔴 | **普通聊天不自动记录** |
| 代理支持 | 🟢 | `proxyUrl` 或 `HTTPS_PROXY`/`ALL_PROXY`；交互显示当前状态和编辑/关闭选项，分离输入 host/port，并在保存前验证端点与 Telegram `getMe`，失败回退旧配置 |

### 3.6 记忆 🟡

**这是当前与目标差距最大的模块。**

| 能力 | 状态 |
|---|---|
| 中央 SQLite 记忆库 | 🟢 |
| `global` / `bot` 两级 scope | 🟢 |
| prompt 注入 `<user_memory>` | 🟢 |
| 短期记忆 TTL | 🟢 |
| embedding 配置与探测 | 🟢 `ai memory embedding` |
| 关键词打分检索 | 🟡 `scoreMemory()` |
| **向量检索** | 🔴 只有配置命令，检索未接入 |
| **自动抽取** | 🔴 全靠显式 `/remember` |
| Claim / Evidence 账本 | 🔴 |
| 5 级 scope | 🔴 当前 2 级 |
| 多源召回 + RRF 融合 | 🔴 |
| 冲突与时序消解 | 🔴 |
| 终端 `ai use` 接入记忆 | 🔴 **仅 Telegram 生效** |
| 凭证隔离 / 登录态托管 | 🔴 credential 类直接抛错 |
| 版本化 migrations | 🔴 直建表，无 migrations |

### 3.7 诊断与运维 🟢

| 能力 | 状态 | 说明 |
|---|---|---|
| `ai doctor` | 🟢 | 配置完整性、Node 版本、原生依赖、CLI 存在性、连通性、模型探测 |
| 自动安全修复 | 🟢 | 损坏内部文件备份为 `*.invalid-<时间戳>` 后重建 |
| `providers.json` 保护 | 🟢 | 无效时**只报告，绝不覆盖凭证** |
| 深度检查 | 🟢 | `--deep` 真实调模型，执行前确认 |
| 结构化日志 | 🟢 | 记录 API Key 指纹，不记完整 Key |
| 会话报告 | 🟢 | `ai report`，不写 Key、不估 token |
| 项目上下文 | 🟢 | `ai context`，自动排除敏感文件 |
| 执行日志关联 | 🟢 | 新模型请求独立 `traceId`，关联父 `executionId` / `sessionId`；Web 显示已观测用量、成本及终止耗时，旧记录保持未知；完整实时状态仍待实现 |
| 统一 Kernel 观测契约 | 🔴 | 无 `CapabilityObservation` |
| OpenTelemetry 导出 | 🔴 | |
| 受管配置备份 / 恢复 | 🟢 | 受限权限快照，恢复保留当前调用凭证，测试覆盖撤销凭证不复活 |
| 完整灾备恢复演练 | 🔴 | 配置快照不覆盖数据库、用量账本和 Codex 用户配置；尚无全量恢复验收 |

### 3.8 常驻 API 服务 🟢

| 路由 | 状态 |
|---|---|
| `POST /v1/chat/completions` | 🟢 |
| `POST /v1/responses` | 🟢 |
| `POST /v1/embeddings` | 🟢 |
| `POST /v1/images/generations` | 🟢 |
| `POST /v1/images/edits` | 🟢 |
| `GET /v1/models` | 🟢 |
| `POST /v1/agent/runs` | 🟢 |
| `POST /v1/tools/execute` | 🟢 仅 `runtime.status`、`providers.list` 两个注册只读工具 |

安全约束 🟢：

- **必须**设置 `AI_GATEWAY_SERVER_TOKEN` / `AI_GATEWAY_SERVER_TOKEN_FILE`，或启用开放配置并创建能力凭证；托管 API 只使用后者
- 环境变量服务 Token 使用 **constant-time 比较**；能力凭证仅保存 SHA-256 摘要，逐请求检查能力与 Provider/模型范围、有效期和请求额度
- Agent Run **禁止任意 cwd**，只接受规范化 `workspace_id`
- 默认 `read_only`；**服务端 API 不暴露 `bypassPermissions`**
- 请求体、Agent 并发、Agent 执行超时都有上限（默认 42 MiB / 2 并发 / 10 分钟）

### 3.9 完全未实现 🔴

| 能力 | 说明 |
|---|---|
| 企业 Web 治理与远程多租户 | 本机基础控制面已实现，企业管理与完整实时 trace 尚未实现 |
| Skill 自动沉淀 | 程序性记忆整套未实现 |
| 受治理学习闭环 | LearningSignal → Decision → Candidate → 评测 → 激活 |
| Policy Engine | 确定性策略求值 |
| L0 Contracts 层 | `src/core/contracts` 目录不存在 |
| 独立 Transport Proxy 模块 | 职责仍在 `openai-usage-*.ts` |
| Auth Session Broker | 浏览器登录态托管 |
| 多租户 / 组织隔离 | 当前单机单用户 |
| 企业身份（OIDC/SAML/SCIM） | |
| 插件体系 | `plugins/` 目录不存在 |
| 桌面客户端 | |
| Scheduler 接入面 | |

---

### 3.10 可投入使用边界与待完善项（2026-10-24）

基线审计为 `develop` 的 `26a21a2`，当时 303 项测试通过；本轮继续完善既有能力，317 项测试与前端类型检查通过，`smoke:package` 在隔离安装的 npm 包上验证 CLI、鉴权 API、历史备份/回滚及控制面 HTML/JS/CSS。本次没有调用真实付费模型、Telegram 或远程 SSH/Nginx，也没有执行 Windows 实机验收；这些不能由自动化测试结果推定通过。

| 采用范围 | 当前可投入使用的部分 | 仍需完善或验收 |
|---|---|---|
| 个人本机 | Provider 管理、Claude/Codex 启动、Runtime/Provider 代理、持久 Codex 配置、图片生成与参考图、用量和诊断 | Provider Key 可显式迁移至 OS 凭据库；OS 解锁/持久性及原生 CLI 与 Provider 兼容性需目标环境验证 |
| 本机管理面 | Web 配置、用量、调用/会话/日志查询、配置快照与恢复、帮助中心 | 新请求已有独立 trace/session 与终止落点；SQLite 用量/会话分页和有界日志读取可用，完整聚合及长期容量仍待验收 |
| 手机远程执行 | Telegram 多 Bot、白名单、进度、附件与显式记忆 | Engine 生命周期仍位于 Telegram adapter；没有统一逐工具授权，需控制可访问用户和工作目录 |
| 小团队 API | 对话、向量、图片、Agent 和注册只读工具；能力凭证、轮换、范围、有效期、请求频率与次数限制 | 不提供租户隔离、组织身份或 Token/金额预算；先完成目标环境真实授权调用验收 |
| 常驻与公网接入 | macOS/Linux 用户服务、SSH 隧道、Nginx/TLS 预览与确认部署 | 平台服务、DNS/TLS 与端到端链路需实机验收；Windows Task Scheduler 仍为 🟡；无完整灾备恢复或长时间 SLO 验收 |
| 记忆与学习 | Telegram 显式记忆、关键词检索、embedding 配置与探测 | 自动抽取、向量召回、终端记忆、Claim/Evidence、Skill 学习与治理尚未实现 |

优先级与退出条件：

| 优先级 | 待完善项 | 责任与退出条件 |
|---|---|---|
| P1 | 可靠执行与凭证边界 | 待确认切换、会话归属、原生续用、信号退出、Agent 并发与断连取消已补回归；Provider OS 迁移、轮换、快照及回滚 fixtures 通过。既有 `undici` high advisory 已通过固定升级 `8.12.3` 与回归关闭，生产 npm 审计 0 项；Runtime/发布维护者仍须验收真实 OS 凭据库及平台二进制 |
| P1 | 发布能力与安装一致性 | `npm run link` 已同步，构建/清理使用跨平台 Node API；隔离打包安装 smoke 通过，CI 加入三平台 matrix。发布维护者仍按 release tag 核对能力，实际远端 CI 与正式 npm 发布需在授权发版时验收 |
| P2 | 运维与容量 | `ai history` 的 SQLite 迁移、幂等、索引分页、备份/恢复/回滚及损坏失败关闭已补齐；Runtime/部署维护者仍负责目标 OS 服务生命周期、真实 Provider/Telegram/公网调用、长时间容量/SLO 与完整灾备演练 |
| P2 | Runtime 执行地基 | Runtime 维护者按 R0.1–R0.3 交付 Contracts、统一 Kernel、权限/取消/幂等、稳定事件、插件与治理边界；保持既有 CLI/API 契约 |
| P3 | 记忆与可验证学习 | 记忆能力维护者按既有 Phase 先抽离 core 与身份/scope，再引入受治理的自动候选、检索、评测、激活与回滚，不以 embedding 配置替代记忆闭环 |

适用结论：当前可用于个人日常工作与受控小团队试用；完整 R0、企业多租户和「每次交互积累组织能力」的学习闭环仍未达到验收门槛。

## 4. 发布计划

Phase 是技术依赖顺序，**Release 是用户可采用、可运营、可回滚的纵向闭环**。一个 Release 可跨多个 Phase，但**只有 exit gate 全部通过才可宣称可用**。

| Release | 用户结果 | 状态 |
|---|---|---|
| **R0 Runtime Foundation** | 开发者可通过统一 Runtime 稳定调用不同 Agent/Provider，平台可看见执行、用量与失败 | 🟡 进行中 |
| **R1 Governed Execution & Memory** | 用户获得自动但可控的跨执行记忆，可查看、纠正、固定、遗忘 | 🔴 |
| **R2 Verified Learning** | 重复成功过程形成经验证的 Skill，可解释激活、回滚与能力增益 | 🔴 |
| **R3 Enterprise Organizational Runtime** | 企业可联合身份、委派管理、治理共享能力，满足合规与运营要求 | 🔴 |

每个 Release **必须**提供：版本化 API/CLI、最小 Web 治理流程、默认安全策略、迁移与 rollback、可观测性 dashboard、运维 runbook、已知限制、升级兼容矩阵。

> Feature flag 可以延后激活。**禁止把未完成的闭环包装成已发布能力。**

### R0 拆分为三个增量

R0 保留完整目标，但拆成三个可独立演示、验收和回滚的增量，避免契约、数据平面、身份、审计与恢复一次性上线。

| 增量 | 用户可见结果 | 必须交付 |
|---|---|---|
| **R0.1 Contracted Runtime** | CLI/Telegram 经同一 `RuntimeRequest → ExecutionContext → RuntimeEvent` 生命周期调用既有 Agent | canonical identity/scope/policy/event/error；Tool/Workflow/Agent Port；local adapters；secret ref migration；contract fixtures |
| **R0.2 Reliable Execution Plane** | Claude/Codex 经唯一 Transport 执行，可见 usage、失败、retry owner 与 trace | 单代理、Usage parity、Kernel 权限/幂等/取消、Tool 副作用、Agent event resume、基础 audit、故障恢复 |
| **R0.3 Governed Operations** | 平台可管理 environment、policy revision、plugin activation、quota 与恢复状态 | local identity directory、admin mutation、policy validate/rollout/rollback、plugin lifecycle、audit query、backup/restore 演练、SLO dashboard |

**增量 gate**：前一增量的 contract / version / error 语义冻结并通过替换 fixture 后才进入下一项。后续项可在 feature flag 后开发，但**禁止反向修改已发布的外部契约**，除非走版本升级与 migration。三个增量全部通过才可对外称 `Release R0`。

### R0 已交付的受限增量 🟢

`ai set codex chatgpt | provider [name] [model] | proxy <endpoint|off>` 通过 core integration service 显式同步 Codex 用户级配置，成功后重启桌面客户端。

已具备：原子写、provider/auth 失败回滚、proxy 配置 + macOS 环境回滚、凭证 `0600`、无 secret 的凭证日志 fixture。

Provider 已有受限 `SecretStorePort` 增量；这不代表全部凭据统一托管、统一 Admin mutation/audit 或完整 R0 gate 已完成。

### Phase 顺序（技术依赖）

| Phase | 主题 | 状态 |
|---|---|---|
| 0 | 契约、评测与迁移保护 | 🔴 |
| 0.5 | 智能学习控制面 | 🔴 |
| 1 | Core Memory 抽离 + 身份地基 + 只读链路 | 🔴 |
| 2 | 持久化 Post-Run 与自动记忆 MVP | 🔴 |
| 3 | 长期/短期/项目分层与治理 | 🔴 |
| 4 | Auth Session Broker（并行 track） | 🔴 |
| 5 | 检索增强（FTS5 / BM25 / 多信号） | 🔴 |
| 6 | 向量搜索 | 🟡 仅 embedding 配置就绪 |
| 7 | 语义蒸馏与 Skill 候选 | 🔴 |
| 8 | 检索质量与时序正确性 | 🔴 |
| 9 | 知识图谱、回流与三层记忆 | 🔴 |
| 10 | Skill 自沉淀（程序性记忆） | 🔴 |
| 11 | 主动回忆、因果反馈与 Shadow Memory | 🔴 |
| 12 | 多 Agent、Team Scope 与多模态 Artifact | 🔴 |
| 13 | 完整性证明与可逆 Parametric Promotion | 🔴 |
| CP0–CP3 | Enterprise Control Plane（并行 track，R3 前完成） | 🔴 |

可观测性（R17/R18）**贯穿全程，不单列 Phase**。

---

## 5. 关键交付风险

以下六项是首要交付风险。应对措施、降级路径和退出门槛属于 Release gate。**困难能力可以分阶段、Shadow 或换 Adapter，但不得被静默删除。**

| 风险 | 责任边界 | 应对 | 降级 | 退出门槛 |
|---|---|---|---|---|
| **一次性交付范围过大** | Runtime 架构 + Release 治理 | 先冻结 R0.1 最小公共契约，只交付一条完整纵向链 | 未过 gate 的增量不发布，继续跑上一 baseline | contract fixture 通过；纵向链可独立部署/观测/回滚 |
| **协议/streaming/tool/usage 正确性** | ⑤ Transport + UsageObserver | CLI/provider/protocol 兼容矩阵、脱敏 fixture、SSE 状态机、attempt 幂等、canary 与 usage parity | 未知 profile 收窄 Memory 到 `shadow_capture`/`passthrough`，保留已验证行为 | 单 execution 单 listener/upstream；usage exactly-once；敏感原文持久化为 0 |
| **Identity / Scope / Evidence 质量不足** | ② Orchestration + ⑥ Memory + ⑧ Policy | 外部 subject 映射 canonical `PrincipalRef`；固定 revision；查询期与 core 二次授权；Candidate ADD-only | 身份不可解析或证据不足时 fail-closed/pending，`pin/correct/forget/purge` 仍可用 | 跨 tenant/scope leak = 0；纠正保留 lineage；purge 可证明 |
| **把召回相关性误判为因果收益** | ⑦ Learning Governor | 分开记录 `retrieved/injected/referenced/decision_changed/outcome_changed`；固定 baseline 与置信区间；高影响做 Shadow | 证据不足返回 `no_artifact`，不改生产 ranking | replay 确定；无 hard safety regression；以 `CapabilityGain` 证明 |
| **Skill 挖掘与自动激活不安全** | ProcedureMiner + Kernel + Policy | 只采 verified-success episode；成熟序列挖掘；跨 execution support；typed IR；static/replay/sandbox/shadow | 保留 candidate、进入 `needs_revalidation`、重复失败 deprecate | `stepCoverage = 1.0`；postcondition 可验证；高危 gate 100% 通过 |
| **企业控制面体量与运营负担** | Enterprise Control Plane Track | CP0–CP3 并行分段；Web/CLI/API 复用同一 core mutation/Policy/Audit/Usage 权威 | 未完成企业能力不阻塞 local R0–R2，但**不得标记 enterprise-ready** | Surface parity；delegated admin 隔离；canary/rollback；恢复演练满足 RTO/RPO |

风险状态取值：`open | controlled | accepted_for_increment | triggered | closed`，附 owner、影响 Release、触发信号、最近证据、剩余风险、下一 gate。

`accepted_for_increment` 只表示不阻塞当前增量，**不表示目标能力被取消**。任何 hard safety regression、scope leak、重复副作用/计费或 raw secret persistence **立即**将相关 rollout 冻结为 `triggered`。

---

## 6. 验收标准

完整判据见 [技术架构 §14](architecture.md#14-架构验收标准)。产品视角的关键门槛：

### 可插拔性

- 新增 surface 调用 Runtime 能力**不复制**任何领域策略
- 新增 provider **不改动**能力层或 surface 契约
- 关闭某个 surface，其余行为不变
- 换 deployment profile（本地 ↔ 企业）**不改**任何 Runtime 语义

### 执行正确性

- 权限在**执行时**检查；memory 或 skill **无法**授予权限
- 不可逆动作**必须**显式授权
- 重试**不产生**重复副作用或重复计费
- 同一 Agent 从 Telegram / CLI / API 发起时，副作用、确认、预算、取消、终态**一致**

### 学习正确性

- 无证据与策略评估的 artifact **不得**激活
- Runtime 能解释为何 learned / asked / verified / consolidated / promoted / ignored / rolled back
- **召回频次不提升事实 confidence**
- Scope 晋升**不迁移**私有 evidence

### 用户可控性

- 关闭 Memory 能回到稳定执行基线
- `pin` / `correct` / `forget` / `purge` 全程可用
- 旧的手动记忆命令**只能在**统一审计界面和显式纠错能力完整替代后移除。**不允许先移除用户纠错入口**

---

## 7. 性能与可靠性目标

> 以下是**目标架构的初始 release gate，不代表当前实现**。`local` profile 为 best effort。

### Deployment profile

| Profile | 适用 | 可用性目标 |
|---|---|---|
| `local` | 单用户本机，允许离线 | best effort，不承诺外部 SLA |
| `team` | 单区域团队服务 | ≥ 99.5% / 月 |
| `enterprise` | production 组织服务 | ≥ 99.9% / 月 |

Policy 正确拒绝、quota deny、用户 cancel 和 validation error **不计**系统失败。第三方 provider 故障单独计为 dependency availability。

### 在线路径延迟目标 🔴

| 边界 | `team` | `enterprise` |
|---|---:|---:|
| Orchestration context build（cache hit） | p95 ≤ 50ms | p95 ≤ 30ms |
| Policy evaluation | p95 ≤ 30ms | p95 ≤ 20ms |
| Capability resolve | p95 ≤ 20ms | p95 ≤ 15ms |
| **Transport 本地转发开销** | p95 ≤ 20ms | p95 ≤ 15ms |
| Memory L1 本地检索 | p95 ≤ 100ms | p95 ≤ 80ms |
| Memory L2 本地语义 | p95 ≤ 300ms | p95 ≤ 250ms |
| Observation 同步 enqueue | p95 ≤ 2ms | p95 ≤ 2ms |

Model / provider 延迟**不纳入**本地 Transport overhead，但必须分别展示 upstream TTFT、总延迟、retry 和 fallback 时间。**禁止把上游慢请求归为 Runtime 成功延迟。**

### 当前单机实现的实际限制 🟢

| 项 | 值 |
|---|---|
| 常驻服务绑定 | 宿主机 loopback |
| 模型请求最大 body | 16 MiB |
| upstream headers 超时 | 45 秒 |
| Provider 熔断 | 仅自动降级开启时启用；关闭时每次重试实际访问选定 Provider，不因既有熔断或健康错误缓存跳过；运行失败不打开持久化 circuit。传输策略在 execution 启动时确定 |
| Agent Run 并发 | 2 |
| Agent Run 超时 | 10 分钟 |

达到限制**必须**显式返回 `413` 或 `429`，**不得**无界排队。

### 容量与背压原则

- **Memory channel 饱和只收窄 Memory**
- **Usage channel 饱和是显式 degraded fault**，启用有界 journal / 对账，**绝不**静默报告健康
- 单 tenant 不得消耗超过配额的 worker / queue / export capacity

### 硬失败判定

发生以下任一项，无论月度比例如何，该 release window **直接判定失败**：

- tenant leak
- secret leak
- audit accepted-event loss
- 重复计费
- 错误的高风险执行

---

## 8. Web 控制面方向 🟡

公网门户按 Web Landing 设计呈现蓝黑色首屏、三栏终端示例、Bento 能力区、五步执行流程、四步安装、命令参考、Telegram 示例与能力状态表。验收覆盖桌面和移动端、导航锚点、安装命令复制与静态资源可达性；示例明确标记，`ai use` 临时配置与 `ai set codex` 持久配置分别说明，旧聊天不迁移的限制必须保留。本机 Web 标为部分实现，不将企业治理描述为已交付。

```bash
ai web    # 启动本机基础控制面板
```

Web 是**企业控制面的操作界面**，不是 Provider 配置页的放大版，**不拥有独立业务逻辑**。所有写操作调用与 CLI/API 相同的核心契约，并显示 policy decision、影响 scope、revision、审批状态与 rollback 入口。

本机启动验收要求：控制面静态入口缺失或无法读取时，在监听端口和打开浏览器前失败，明确提示源码构建或 npm 重装步骤；正常构建需验证首页及其引用的静态资源可访问。

🟢 本机控制面已拆分为运行总览、用量统计、本地配置、运行记录、对外服务、帮助中心六个一级页面。用量统计支持 7/30/70 个 UTC 自然日筛选、Provider 汇总表、Token 趋势、GitHub 式周列 × 7 天小方格调用活动和带圆角轻量涂鸦纹理的占比图；短区间保留至少 70 天日历上下文，区间外日期以淡灰格标识，不作为零用量计入统计。成本卡片支持通过 core pricing API 按 Provider/模型维护美元/百万 token 价格，Provider 完整下拉列表合并当前配置、历史 usage 和已有价格键，模型下拉合并缓存目录、默认模型、历史 usage 模型和已有价格键，并支持手动输入模型；切换 Provider 时刷新对应模型和价格，空模型目录清除上一 Provider 的模型；按当前日期与 Provider 筛选计算成本，未定价事件单独计数；区间内空日期补零，点击日期跳转运行记录。数据来自唯一 usage 账本，包括 Runtime 代理和显式启用后的 Codex App 本机采集；不推测其他未采集的外部调用。App 采集不生成 Runtime 调用链路或工具会话。

🟢 运行记录分为调用记录、工具会话、系统日志。调用列表按执行归组，侧边详情展示结果、Provider 过程与中文时间线；同 Provider 重试与跨 Provider 切换分开计数，缺少终止事件显示结果未知，结果 Provider 仅取明确终止证据。工具会话显示初始配置、起止、时长和退出码，调用关联只接受明确且匹配的 `sessionId`。系统日志按模型请求/服务检查/配置变更/系统运行分类，支持级别、Provider、分类和搜索筛选。最近记录摘要仍取 300 条日志和 30 次会话；完整历史区支持日志、调用、会话、用量分页查询、搜索、CSV/JSON 下载与每 2 秒刷新。新模型请求按独立 `traceId` 展示观测到的用量、成本来源、耗时及父 `executionId`，旧记录缺失关联时保持未知；下载只含白名单字段并防止 CSV 公式注入。

🟢 帮助中心的命令手册与 `ai help` 打开的 `docs/USAGE.html` 同源，完整覆盖命令索引、安装配置、模型使用、服务管理、记忆配置、消息接入、状态诊断、会话报告、凭据与历史、配置文件。`ai secrets` / `ai history` 的详细用法直接导航到凭据与历史，完整列出状态、迁移、备份、恢复及显式回滚的适用前提和限制；会话续用与请求日志筛选同步写入相应分类。验收要求正文规则、参数、注意事项及代码示例完整保留；支持命令分组筛选、跨分类全文搜索、详细说明导航、命令/整段示例复制、展开/收起与移动端目录。复制只写入剪贴板，不执行命令或配置写入。

🟡 本地配置支持通过 core API 编辑 Provider、路由、Codex、Runtime/Provider 出站代理、Telegram Bot 和 embedding 连接；写入前展示变更预览，核心服务负责校验、原子写入、失败回滚和受限权限备份。Claude Code 用户连接可持久编辑并备份原文件；Bot 支持启停、重启与删除配置，删除保留会话/日志。记忆设置保留现状。

🟡 对外服务支持按部署方式生成 API 上游、配置公网入口、选择已实现能力、创建可撤销的能力凭证、生成 Nginx 片段和调用示例。Runtime server 可按请求检查全局能力白名单与凭证能力；凭证支持 Provider/模型白名单、有效期、轮换、每分钟请求数和持久请求总额度；额度不是 Token/金额预算。组织权限仍未实现。SSH 模式支持显式确认的 Nginx/Certbot 部署计划；复杂网关和同机部署保留管理员边界。

对外服务的「反代接入」采用单一流程：选择部署位置 → 连接服务器 → 设置访问地址，一次只展开当前步骤；同机部署跳过 SSH。能力、凭证、API 只以准备状态和跳转入口呈现，不构成第二套引导。SSH 信息通过「保存并连接服务器」连续完成保存与连接，连接管理与首次密钥准备按需展开。生成/复用本机密钥不依赖服务器信息；扫描与诊断保留只读可用性，不受隧道运行/自启的配置锁影响。按钮直接说明缺少的输入或锁定原因，不能只显示灰色禁用状态。桌面与窄屏均需保持字段可读、操作可达，配置保存和隧道连通不替代最终授权调用验收。

🟢 反代接入采用分步引导，支持同机反代或 Web 管理反向 SSH 隧道。上游按模式自动生成（同机 8080、远端隧道 18080），无需手填。隧道支持保存本机密钥路径、后台连接/断开、自启、SSH 控制连接状态与远端端口验证，复用 macOS/Linux 用户服务；默认不自启，不支持的平台保留明确限制。Web 已提供独立核对后信任指纹、本机专用密钥生成、一次性密码公钥授权与诊断；非交互认证、服务器 TCP 转发权限与 curl 仍为运行前置条件，不能把进程运行当作端到端成功；远端 Nginx/TLS 可通过预览后确认的自动部署完成；不适用环境使用手动片段。验收覆盖输入约束、argv/loopback 边界、自动上游、独立生命周期、API 先决条件、配置修改保护、本机与远端检查区分及本机管理鉴权。

🟢 本机 API 后台生命周期支持 `ai server start/status/restart/enable/disable/stop` 与 Web 同源操作，退出管理面板后持续运行。macOS 使用 launchd 登录自启，Linux 使用 systemd 用户服务（无登录持续运行需管理员配置 linger）；默认不自启。启用前要求能力与有效凭证，停止同时禁用自启，禁用自启不停止当前进程；状态与日志来源明确。Windows 增加当前用户 Task Scheduler 适配，命令编排测试通过后仍需 Windows 实机 gate；无用户服务管理器的 Linux 和容器不承诺托管支持；前台开发方式仍可用。系统服务定义与命令编排通过隔离测试，实际目标环境仍需检查管理器状态、健康及真实授权调用，普通保存不自动开启公网或部署远程主机，执行部署必须预览并明确确认。

启动引导验收要求：四个对外服务分类持续展示能力、有效凭证与 API 状态；缺项按顺序提供可操作入口，启动按钮在准备不足时先导航，避免只返回笼统错误。未过期且与已保存能力相交才算有效凭证。SSH 配置允许在 API 启动前单独保存，跨分类保留草稿；完成准备后可返回连接步骤，实际连接仍须 API 运行，不自动创建凭证或开放能力。

🟢 图片对外 API 支持 `POST /v1/images/generations` JSON 生成与 `POST /v1/images/edits` multipart 参考图编辑，分别由 `images` / `image_edits` 能力控制；Web 可勾选、创建最小权限凭证并切换对应调用示例。验收覆盖生成与编辑字节透传、URL/Base64 响应、图片模型路由、用量归属、无效请求/体积限制、权限交集和实时撤销。图片请求不自动重试或切换，防止重复计费；不托管图片、不承诺 Provider URL 永久有效。API 与 SSH 隧道可由 Web 托管；Web 可完成 SSH 准备并按计划部署 Nginx/TLS；外部端口、DNS 与服务器权限仍需准备，不能以保存页面或健康检查成功代替真实调用验收。

🟢 公网门户 `axiom.offerpilot.life` 已部署为独立静态站点；门户构建不进入 npm 包，也不读取本机控制面。GitHub Actions 在默认分支测试成功后构建门户，通过 `portal-production` Environment 的 Variables/Secrets 和最小权限 SSH 账号发布不可变 release，健康检查失败自动 rollback；原 `.gitlab-ci.yml` 保留。证书续期、Nginx SNI 分流和服务器初始化属于部署前置运维步骤。

仓库迁移交付门槛：GitHub `linlangli/AxiomRuntime` 保留本机已有的 branch/tag 历史，PR 测试不使用部署 Secrets；门户 Environment 只接受 `main` branch，npm Environment 只接受 `v*` tag。npm 发布必须校验默认分支包含该提交、tag 与包版本一致，并通过完整测试和前端类型检查；使用 npm OIDC Trusted Publisher，绑定该仓库、`publish.yml` 与 `npm-production`，无需长期 `NPM_TOKEN`。GitLab CI/CD variables 不会自动迁移，SSH 专用凭证必须重新注入。使用 GitHub 托管 runner，无生产服务器 runner 依赖；线上首次 Actions 运行成功才算迁移验收通过，npm 实际发布需在下次明确授权的新版本发版时验证，不为验收重发历史版本。npm 新连接若显示 `Pending validation`，维护者须在页面截止时间前完成授权发布，否则重新核对信任连接。维护者负责推送 workflow、配置部署 Secrets 与 npm 信任连接并完成首次运行；未完成项属于迁移运维 gate，不改变既有 Runtime 能力状态。

| 模块 | 内容 |
|---|---|
| Organization & Identity | tenant/organization/environment、OIDC/SAML、SCIM、role、delegated admin、break-glass 审计 |
| Policy & Approvals | policy draft/diff/validate/approve、effective-policy inspection、canary rollout、rollback、待确认队列 |
| Capabilities & Plugins | 发现、风险/权限清单、版本兼容、审批、激活、draining、disable |
| Memory & Learning Governance | Claim/Evidence 查看与纠正、pin/forget/purge、candidate/evaluation、Skill promotion/rollback、CapabilityGain |
| Execution & Audit | execution trace、失败原因、permission decision、审计查询与签名导出 |
| FinOps & Reliability | Provider health、usage/cost/latency、归属、quota/budget、SLO、告警、backup/restore、DR |
| Provider / Agent Operations | Provider/model 配置与刷新；Agent 状态与错误。**secret 只显示 ref/status，禁止回显明文** |

发布顺序：R0 提供 execution/provider/usage/audit 只读视图与受控配置 → R1 增加 Memory 用户控制 → R2 增加 learning/Skill promotion → R3 补齐 identity/policy/plugin/FinOps/compliance/DR。

每个页面必须有 `empty` / `loading` / `degraded` / `permission-denied` / `partial-failure` 状态。危险操作必须展示影响范围、二次确认和 operation progress。

### 8.1 运行记录与调用详情 🟡

设计稿位于 `docs/AxiomRuntime.pen`。当前控制面将 Execution & Audit 落在「运行记录」页，分为「调用记录 / 工具会话 / 系统日志」三个四字标签。🟢 调用记录按 `traceId` 聚合最近日志中的一次执行，列表优先显示结果、模型、Provider、时间，侧边详情展示结果摘要、Provider 过程、中文时间线与可展开的原始字段。工具会话展示启动配置、时长和退出结果；系统日志按模型请求、服务检查、配置变更、系统运行分类，支持级别/Provider/分类筛选及明确关联调用的跳转。「本地配置」和「对外服务」分别管理本机运行方式与远程能力授权。

🟢 验收行为：明确区分执行成功、执行失败、结果未知；缺少终止事件不推断正在运行，HTTP 失败响应不能被标成成功。重试与跨 Provider 切换分别计数，配对的切换计划/应用事件不重复计数，路由保留重复回跳。结果 Provider 仅取自终止事件，未记录耗时则显示事件跨度；无 `traceId` 的独立事件不生成调用。工具会话仅凭明确且匹配的 `sessionId` 关联调用，缺少退出记录不声称进程存活。每个标签有独立搜索提示和空状态；图表日期入口默认进入调用记录并保留日期。🟡 新请求已有独立 trace、终止耗时、实际路由和观测用量/成本；父执行可能包含多个请求，旧日志缺少关联时保持未知，完整逐跳 `level`/耗时与统一事件流仍待补齐。

数据来源均为已落库的 `writeLog` 事件；`src/core/web/execution-history.ts` 提供只读、脱敏的状态与关联投影，Web 负责中文展示，不重算路由或新增 usage ledger。

链路聚合键是 `LogEvent.traceId` 🟢：HTTP 请求 / Telegram Provider 尝试 / `ai use` 启动过程各自使用入口 ID。工具代理中的新模型请求有独立 `traceId`，通过 `executionId` 关联父执行，通过 `sessionId` 关联会话；辅助请求不计入模型调用摘要。内网 API 入口使用 `requestId` 作为 traceId，`x-request-id` 响应头可反查链路。历史日志及部分生命周期事件没有关联字段，读取方必须容忍缺失；不通过时间或 Provider 补关联。

| 链路语义 | 日志 action | 关键 metadata |
|---|---|---|
| 候选解析 | `provider_resolved` / `provider_resolved_exact` | `provider`、`tool`、`model`、`requestedProvider` |
| 熔断 / 健康 / 无模型跳过 | `fallback_skip_provider` | `reason`（`circuit_open` / `health_error` / `no_compatible_model`）、`level`、`circuitOpenUntil` |
| 请求级切换 | `runtime_server_provider_fallback` | `requestId`、`attempt`、`totalCandidates`、`level`、`error` |
| 会话级切换 | `fallback_applied` / `runtime_fallback_retry` / `runtime_provider_fallback_retry` | `from`、`to`、`nextModel`、`attempt`、`error` |
| 终止跳（上游响应 / 工具成功） | `runtime_server_request_settled` / `tool_run_settled` / `runtime_provider_settled` | `provider`、`attempt`、`fellBack`、`status`；HTTP 响应须按 `status` 判定成功或失败 |
| 终止跳（全败） | `runtime_server_candidates_exhausted` / `tool_candidates_exhausted` / `runtime_provider_candidates_exhausted` | `attempted`、`totalCandidates`、`status` |

完整链路应以明确终止事件收尾，但有限日志窗口或中断执行可能缺少它，此时结果未知。`fellBack`、`attempt` / `totalCandidates` 仅在已记录时作为原始证据展示。

CLI 侧已可读同一条链路 🟢：

```bash
ai log --print --trace trc_70d90ad64d1846bf   # 只打印该链路的各跳，按时间先后排列
```

侧栏的"自动切换路由"卡展示 level 阶梯上各 provider 的切入 / 切出次数与熔断状态，对应 `Provider.level` 与 `ProviderCache` 的 `consecutiveFailures` / `circuitOpenUntil` / `healthScore`。

#### 实时 provider 可见性 🔴

原生 CLI 的 TUI 独占终端，Runtime 不能在会话期间往终端写提示（见 §3.2「切换提示不破坏 TUI」）。因此**"当前正在用哪个 provider"在 `ai use` 运行期间于终端内不可见**，只能在退出后从切换汇总或 `ai log --trace` 回看。Web 面板补齐这个缺口，设计稿确立两处落点：

| 位置 | 内容 | 数据来源 |
|---|---|---|
| 侧栏"当前 provider"卡（`Sidebar` 可复用组件，五屏共享） | 正在承接的 provider 名、`level`、model、是否已发生切换及第几跳、当前 traceId | 最近一条同 traceId 的 `provider_resolved*` / `runtime_server_provider_fallback` 事件 |
| 「运行记录 → 调用记录」的「结果未知」记录 | 当前日志窗口内的 Provider、action、原因与结果证据 | 该 traceId 下缺少明确终止事件的日志序列 |

缺少终止事件只能判定「结果未知」，不能据此判断「进行中」。实时 Provider、进程存活与等待确认状态仍为 🔴，由 Runtime 可查询的活跃执行/确认契约提供证据后才能开放；当前页面仅在时间线显示 `confirmation_required` 的等待确认事件，不把它当作执行成功或失败。

侧栏卡是可复用组件，任何 Web 页面都能看到当前 provider，不需要先进入日志页。**secret 仍只显示 ref/status，不回显 API Key。**

### 8.2 Codex App 可视化配置（R0 设计基线）🔴

“本地配置 / 工具配置”页把已实现的 `ai set codex` core integration service 呈现为可查看、可确认、可回滚的 Web 管理操作。页面说明 Codex App、CLI 与 IDE extension 在同一 `CODEX_HOME` 下共享用户级 `config.toml`，同时区分 CLI `-c` 的进程级临时覆盖。页面读取并展示当前 `model_provider`、model、proxy、`config.toml` / `auth.json` 托管状态，但 API Key 只显示 configured/missing，不回显明文。

🟢 本机用量采集设置已交付：Web「本地配置 → 工具配置」和 `ai set codex usage on|off|status|map <codex-provider-id> <provider-name>` 共用 core API，可编辑采集开关、Codex 目录和 Provider 映射。默认关闭；启用后在 dashboard 刷新或 `ai status` 时同步真实计数，按 Provider/模型汇入现有图表、价格估算与周用量。验收覆盖自动匹配与未知 ID 显式归属、映射后补计本次启用以来的记录、Cache Read 不重复计数、CLI/SDK 与 Runtime 代理排除、并发/文件重读/归档/游标恢复去重、关闭后保留数据且重新启用不补计关闭期间，以及异常格式或目录不可读时主面板继续可用。采集不保存对话和凭证，不修改 Codex 原生配置，不要求重启 App；内部 JSONL 格式兼容与云端运行仍是明确边界。

设置区必须覆盖三种与 CLI 等价的模式：`chatgpt`、`provider [name] [model]`、`proxy <endpoint|off>`。提交前显示等价 CLI 命令、目标配置 diff、重启需求、备份与失败回滚语义；提交后显示 operation progress 和最终 restart 状态。Web 不自行拼装或写入 TOML/JSON，所有读写复用同一 core integration API。

Provider 切换只更新 Codex App 用户级配置，不迁移已有原生历史 session。确认区必须明确说明：旧聊天继续发送时可能仍访问原 Provider 并返回权限错误，用户应新建聊天；未来若提供 session migration，必须作为独立能力标记，不能由配置写入结果暗示已经完成。

---

## 9. 命令路线图 🔴

以下命令**尚未实现**，按优先级列出。

### 高优先级

| 命令 | 用途 |
|---|---|
| `ai do` | 智能路由，自动选工具和模型 |
| `ai review` / `ai fix` / `ai commit` / `ai pr` | Git 工作流 |
| `.ai-gateway/project.json` | 项目级 profile |
| `ai last --cwd` | 项目级上次选择 |
| 统一 MCP 与 Skill 管理 | 跨 Claude Code / Codex |
| 项目级默认服务商与模型 | |

### 中优先级

| 命令 | 用途 |
|---|---|
| `ai task bugfix\|review\|refactor\|docs` | 任务模式 |
| `ai save <name>` / `ai resume <name>` | 会话别名 |
| `ai bench` | 模型与服务商基准 |
| `ai replay` | 命令重放 |
| `ai auth login/list/status/logout/clear` | 登录态托管（Phase 4） |
| `ai trace show` / `ai memory explain` / `ai skill explain` | 可观测性查询 |
| 模型 fallback 链 | |
| 模型别名 `fast` / `cheap` / `best` | |
| 按任务/项目/目录/文件类型的规则路由 | |
| 日/周预算与告警 | |

### 低优先级

| 项 | 说明 |
|---|---|
| 按任务自动选 Claude 或 Codex | |
| 团队共享配置 | |
| 按终端完全隔离缓存/日志/上次选择 | |
| 桌面客户端 | |

---

## 10. 已知限制

用户会实际遇到的限制，按影响排序。

| 限制 | 影响 | 计划 |
|---|---|---|
| **全部凭据未统一托管** | Provider 可显式 OS 迁移；记忆与外部原生认证文件沿用现状 | 真实 OS 验收；其他凭据另行规划，不在本轮范围 |
| **记忆只在 Telegram 生效** | 终端 `ai use` 无记忆 | 记忆核心迁到 `src/core/memory`（Phase 1） |
| **无自动记忆** | 必须显式 `/remember` | Phase 2 |
| **向量检索未接入** | `ai memory embedding` 只是前置配置 | Phase 6 |
| **旧会话或歧义记录无原生 ID** | 明确退回启动设置；有 ID 才传给原生 resume | 维护上游 CLI 兼容 fixtures，真实工具验收 |
| **运行期间看不到当前 Provider** | 原生 TUI 独占终端，只能退出后看切换汇总或 `ai log --trace` | Web 实时视图（§8.1） |
| **用量不补录历史** | 装代理版本前的请求不计入 | 刻意设计，避免归错账 |
| **单机单用户** | 无组织/项目用量归属 | R3 |
| **Telegram Engine 是本地 facade** | 与 CLI 执行路径未完全统一 | R0.1 |
| **无版本化 migrations** | 记忆表直建 | Phase 0 |
| **Node.js ≥ 22.19.0 硬要求** | Node 20 不可用 | 不变 |

---

## 11. 依赖治理

采用第三方能力时**每个依赖**都需要：

ADR、pinned version、SBOM、许可与漏洞审查、数据出境分类、contract fixtures、超时/熔断行为、kill switch、导出/purge 行为、质量-延迟-成本对比、**已测试的替换路径**。

> **托管服务不得成为 `local` profile 的隐式依赖。**

设计参考（**是设计来源和可替换 provider，不是强制依赖**）：Mem0 的 ADD-only 抽取与多信号检索、Graphiti/Zep 的时序上下文图、Letta 的 memory blocks、LangGraph 的 checkpointer/store 分离、OPA/Cedar 的策略求值、OpenTelemetry。

---

## 12. 文档职责

| 文档 | 内容 | 读者 |
|---|---|---|
| [usage.md](usage.md) | 怎么用 | 使用者 |
| [architecture.md](architecture.md) | 怎么设计的 | 开发者 |
| 本文 | 为什么做、做到哪一步、接下来做什么 | 开发者 + 产品 |

文档是「完成」的一部分。产品方向或验收行为变更**必须**在同一次变更里更新本文。使命、北极星或三条硬不变量的变更**需要明确的人工批准**。
