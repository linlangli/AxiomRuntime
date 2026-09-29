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
| 平台/运维 | 执行可观测、失败可诊断、配置可恢复 | 🟡 有日志/doctor/report，无统一 trace |
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
| API Key 加密 | 🔴 | **明文存 `providers.json`** |
| API Key 完全不回显 | 🟡 | 当前显示掩码（首末 4 位），目标只显示「已配置/缺失」 |

### 3.2 工具执行 🟢

| 能力 | 状态 | 说明 |
|---|---|---|
| 启动 Claude Code | 🟢 | 临时 `--settings`，不碰 `~/.claude/settings.json`；execution scope 删除进程继承的 `ANTHROPIC_AUTH_TOKEN`，并以空值遮蔽用户 settings 中的同名变量，避免与 Provider API Key 冲突 |
| 启动 Codex | 🟢 | `-c model_provider=` + `env_key`，不碰全局 `auth.json`/`config.toml` |
| 运行时降级 | 🟡 | `ai use` 在同一原生 CLI 会话内对**会产生补全的模型端点**做请求级切换；失败先在当前 Provider 原地重试（限流/`5xx`/连接层错误可重试，`401`/`403`/`404` 直接换），重试耗尽才轮转，已有输出则等待用户重新提交/重试确认。辅助端点（`/v1/messages/count_tokens` 等中转站常未实现的路径）的 `404` 不触发轮转，也不计入健康分。**一处偏差**：待确认状态在读请求体之前消费，不区分方法，CLI 自发的无关请求会替用户确认切换 |
| 健康分恢复 | 🟢 | 一次真实成功探测把 `healthScore` 直接置满，不靠固定步长累加填坑，避免误判造成的低分长期滞留 |
| 切换提示不破坏 TUI | 🟢 | 会话期间提示走协议内错误事件由原生 CLI 渲染，退出后再打印切换汇总；父进程不在 TUI 重绘期间写终端 |
| Runtime 出站代理 | 🟢 | `ai proxy` 可选择 Provider 或 Runtime 默认值；Provider 的 `proxyUrl` 优先、缺省时回退默认值，清除覆盖后恢复回退；新增或编辑先做零 Token 连通检查。探测和 Transport Proxy 上游按实际 Provider 路由；不修改原生 CLI 配置 |
| root 权限约束 | 🟢 | UID 0 下 `bypassPermissions` 强制降级为 `default` |
| 会话记录 | 🟢 | 工具、服务商、模型、路径、起止、退出状态 |
| 会话续用 | 🟡 | **复用启动参数**，不恢复 Claude/Codex 原生聊天上下文 |
| 统一 Agent 契约 | 🔴 | Telegram `Engine` 仍是本地兼容 facade，直接 spawn CLI |
| 工具调用逐步授权 | 🔴 | Agent 提议的工具动作尚未回到统一 Kernel 授权 |

### 3.3 用量与成本 🟢

| 能力 | 状态 | 说明 |
|---|---|---|
| 真实用量采集 | 🟢 | execution-scoped 本地代理，解析真实响应 |
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
| 标准 images API | 🟢 | 调用 OpenAI-compatible `/v1/images/generations` |
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
| 统一执行 trace | 🔴 | 无 `CapabilityObservation` |
| OpenTelemetry 导出 | 🔴 | |
| 备份 / 恢复演练 | 🔴 | |

### 3.8 常驻 API 服务 🟢

| 路由 | 状态 |
|---|---|
| `POST /v1/chat/completions` | 🟢 |
| `POST /v1/responses` | 🟢 |
| `POST /v1/embeddings` | 🟢 |
| `GET /v1/models` | 🟢 |
| `POST /v1/agent/runs` | 🟢 |

安全约束 🟢：

- **必须**设置 `AI_GATEWAY_SERVER_TOKEN` 或 `..._FILE`
- Bearer Token **constant-time 比较**
- Agent Run **禁止任意 cwd**，只接受规范化 `workspace_id`
- 默认 `read_only`；**服务端 API 不暴露 `bypassPermissions`**
- 请求体、并发、执行超时都有上限（默认 16 MiB / 2 并发 / 10 分钟）

### 3.9 完全未实现 🔴

| 能力 | 说明 |
|---|---|
| `ai web` 控制面板 | 命令存在但提示暂未实现 |
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

**不代表** `SecretStore`、统一 Admin mutation/audit 或完整 R0 gate 已完成。

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

## 8. Web 控制面方向 🔴

```bash
ai web    # 命令存在，提示暂未实现
```

Web 是**企业控制面的操作界面**，不是 Provider 配置页的放大版，**不拥有独立业务逻辑**。所有写操作调用与 CLI/API 相同的核心契约，并显示 policy decision、影响 scope、revision、审批状态与 rollback 入口。

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

### 8.1 调用链路可视化（R0 设计基线）🔴

设计稿位于 `docs/AxiomRuntime.pen`，含运行时纵览、服务商、使用与日志、命令中心、帮助中心五屏。其中"使用与日志"页确立了 **调用链路（trace）视图** 作为 Execution & Audit 的默认形态：日志不以扁平事件流呈现，而按 `requestId` 聚合成一次请求的完整 provider 调用链路。

链路卡片的每一跳（hop）必须展示：provider 的 `level`、provider 名称、触发的日志 `action`、该跳结果（成功 / 失败 / 跳过）、耗时，以及来自日志 `metadata` 的原因说明。四类典型链路必须可区分：直连成功、自动切换后成功、熔断跳过后降级、全部候选失败。

数据来源均为已落库的 `writeLog` 事件，Web 只做聚合与呈现，不重算路由。

链路聚合键是 `LogEvent.traceId` 🟢：一次请求 / 一条消息 / 一次 `ai use` 在入口处生成一个 traceId，之后候选解析、每次切换、终止跳全部复用它。HTTP 入口直接复用 `requestId` 作为 traceId，`x-request-id` 响应头因此可直接反查链路。历史日志没有该字段，读取方必须容忍缺失。

| 链路语义 | 日志 action | 关键 metadata |
|---|---|---|
| 候选解析 | `provider_resolved` / `provider_resolved_exact` | `provider`、`tool`、`model`、`requestedProvider` |
| 熔断 / 健康 / 无模型跳过 | `fallback_skip_provider` | `reason`（`circuit_open` / `health_error` / `no_compatible_model`）、`level`、`circuitOpenUntil` |
| 请求级切换 | `runtime_server_provider_fallback` | `requestId`、`attempt`、`totalCandidates`、`level`、`error` |
| 会话级切换 | `fallback_applied` / `runtime_fallback_retry` / `runtime_provider_fallback_retry` | `from`、`to`、`nextModel`、`attempt`、`error` |
| 终止跳（成功） | `runtime_server_request_settled` / `tool_run_settled` / `runtime_provider_settled` | `provider`、`attempt`、`fellBack`、`status` |
| 终止跳（全败） | `runtime_server_candidates_exhausted` / `tool_candidates_exhausted` / `runtime_provider_candidates_exhausted` | `attempted`、`totalCandidates`、`status` |

每条链路都以一个终止跳收尾，`fellBack` 直接回答"这次请求是否发生过自动切换"，`attempt` / `totalCandidates` 给出第几跳落地。

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
| "使用与日志"页列表首项"进行中"链路卡 | 已经过的每一跳（level / provider / action / 结果 / 耗时 / 原因），以及是否处于「等待用户重新提交以确认切换」状态与继续方式 | 该 traceId 下尚无终止跳的日志序列 |

判定"进行中"的依据是该 traceId 还没有出现终止跳（`*_settled` / `*_candidates_exhausted`）。链路过滤器因此增加「进行中」一档。等待确认状态对应请求级 failover 的 `confirmation_required`：Runtime 已选好候选但不自动重放，Web 需说明"重新提交或重试即确认切换"，而不是显示为失败。

侧栏卡是可复用组件，任何 Web 页面都能看到当前 provider，不需要先进入日志页。**secret 仍只显示 ref/status，不回显 API Key。**

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
| **API Key 明文存储** | `providers.json` / `memory.json` 需自行限制文件权限 | `SecretStore` + `apiKeyRef`（R0.1） |
| **记忆只在 Telegram 生效** | 终端 `ai use` 无记忆 | 记忆核心迁到 `src/core/memory`（Phase 1） |
| **无自动记忆** | 必须显式 `/remember` | Phase 2 |
| **向量检索未接入** | `ai memory embedding` 只是前置配置 | Phase 6 |
| **会话续用不恢复原生上下文** | 只复用启动参数 | 依赖上游 CLI 能力 |
| **运行期间看不到当前 Provider** | 原生 TUI 独占终端，只能退出后看切换汇总或 `ai log --trace` | Web 实时视图（§8.1） |
| **`ai last` / 会话记录只存启动时 Provider** | 请求级自动切换不回写，实际承接者需查 trace | 代理切换回调写回会话存储 |
| **无关请求会替用户确认切换** | 待确认状态在读请求体前消费且不区分方法，CLI 自发探测即可消耗掉 | 消费待确认状态前先判定是带请求体的模型 POST |
| **用量不补录历史** | 装代理版本前的请求不计入 | 刻意设计，避免归错账 |
| **单机单用户** | 无组织/项目用量归属 | R3 |
| **掩码 API Key 会显示** | 录屏分享需注意 | 收敛为只显示「已配置/缺失」 |
| **编辑时 apiKey 预填当前值** | 同上 | 同上 |
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
