# 术语表（中英对照·一致性锁）

> 用途：中英混合文档的一致性基线。**每个概念只有一个中文译名**，杜绝同义词漂移。
> 铁律：**英文列是代码里的权威符号，写文档时原样保留、不译**；中文列仅供叙述可读，不得作为代码标识符或权威外键。

## 1. 分层与角色

| 中文（叙述用） | English（权威符号，勿译） | 说明 |
|---|---|---|
| 接入面 | Surfaces | CLI/Telegram/Web/API/Scheduler |
| 编排层 | Orchestration | 身份/租户/scope/session 归一化 |
| 能力层 | Capabilities | 版本化能力契约 |
| 执行内核 | Execution Kernel | 权限/幂等/重试/隔离 |
| 传输代理 | Transport Proxy | 单一数据平面 |
| 记忆子系统 | Memory subsystem | 账本 + 检索 |
| 学习与治理 | Learning & Governance | 确定性学习决策 |
| 策略引擎 | Policy Engine | 无副作用求值 |
| 安全 | Security | 凭证/脱敏/隔离/权限 |
| 适配器/插件 | Adapters / Plugins | 供应商细节 |
| 存储 | Storage | per-contract 后端 |

## 2. 核心契约（L0，勿译）

| 中文 | English | 说明 |
|---|---|---|
| 执行上下文 | `ExecutionContext` | identity/org/project/session/policy/trace |
| 运行时请求 | `RuntimeRequest` | intent + 输入 + 请求能力 |
| 运行时事件 | `RuntimeEvent` | append-only 生命周期证据 |
| 能力描述符 | `CapabilityDescriptor` | id/version/permissions/lifecycle |
| 策略决策 | `PolicyDecision` | `allow/deny/require_confirmation/constrain` |
| 学习候选 | `LearningCandidate` | 待评证据 |
| 学习信号 | `LearningSignal` | 归一化执行结果 |
| 学习决策 | `LearningDecision` | 确定性动作选择 |
| 能力收益 | `CapabilityGain` | baseline vs candidate 度量 |
| 脱敏回合信封 | `SanitizedTurnEnvelope` | 可持久化证据 |
| 传输路由租约 | `TransportRouteLease` | 执行绑定 listener/route |
| 传输扩展 | `TransportExtension` | 有界观测/patch，不拥有 listener |
| 变更清单 | `TransportTransformManifest` | 有序 patch + before/after hash |
| 主体引用 | `PrincipalRef` | tenant-bound canonical identity |
| 作用域引用 | `ScopeRef` | owner/audience/purpose 边界 |
| 组织策略快照 | `OrganizationPolicySnapshot` | execution 绑定的不可变生效策略 |
| 管理变更 | `AdminMutation` | 经 revision/policy/approval 的控制面写入 |
| 工具端口 | `ToolPort` | 一次类型化动作 |
| 工作流执行端口 | `WorkflowExecutorPort` | checkpoint/signal/resume/compensation |
| Agent 适配端口 | `AgentAdapterPort` | 受限外部 Agent execution |
| 副作用等级 | `SideEffectClass` | none/read/reversible/external/irreversible |
| 运行时错误 | `RuntimeError` | closed code + retry classification |

## 3. 记忆与检索（勿译标识符）

| 中文 | English | 说明 |
|---|---|---|
| 账本 | Ledger | Claim/Evidence + `memory_units` |
| 主张 | `Claim` | 可变事实 |
| 证据 | `Evidence` | 不可变、ADD-only |
| 治理头 | `memory_units` | 统一生命周期 |
| 检索流水线 | Recall pipeline | Planner→召回→RRF→Compiler |
| 上下文编译器 | Context Compiler | token 预算内编译注入 |
| 融合排序 | RRF | `Σ sourceWeight/(60+rank)` |
| 候选抽取器 | `CandidateExtractor` | add-only 抽取契约 |
| 检索后端 | `RetrievalBackend` | 语义/词法/实体/时序 |
| 向量检索后端 | `VectorRetrievalBackend` | 向量召回 |
| 程序挖掘器 | `ProcedureMiner` | Skill 候选挖掘 |
| 工作记忆 | Working Memory | thread 级 checkpoint，与账本分离 |

## 4. 学习与治理（勿译）

| 中文 | English | 说明 |
|---|---|---|
| 学习总管 | Learning Governor | 确定性状态机 |
| 评测框架 | `EvaluationHarness` | 版本化评测，产出证据非授权 |
| 压缩清单 | `CompressionManifest` | 可逆投影映射 |
| 晋升 | promote | 需策略+人类授权 |
| 回滚 | rollback | 回到权威 Claim/Evidence |
| 遗忘 | forget | 先冷却/失效/归档，再物理删除 |

## 5. 规范动词（固定映射）

服务等级相关标识符固定使用 `SLO`（服务等级目标）、`RTO`（恢复时间目标）、`RPO`（恢复点目标）和 `error budget`（错误预算），不得用模糊的“高可用”“快速恢复”替代量化门槛。

| 中文 | English |
|---|---|
| 必须 | must |
| 禁止 | must not |
| 应当 | should |
| 可 | may |
