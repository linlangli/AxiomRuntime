# 开发路线图（Roadmap）

> 从旧 `memory-system-spec.md` 迁入。Phase 0–13 的实施顺序与交付物；多份 R 条款按 Phase 标注落地时机（见 [enforcement-decisions.md](enforcement-decisions.md)）。

## 纵向产品发布（Release）

Phase 是技术依赖顺序，Release 是用户可采用、可运营、可回滚的纵向产品闭环。下列 `Release R0-R3` 不是 `enforcement-decisions.md` 的规则编号；每个 Release 可以跨多个 Phase，但只有在对应 exit gate 全部通过后才可宣称可用。

| Release | 用户结果 | 主要 Phase | 必须通过的 exit gate |
|---|---|---|---|
| `Release R0 - Runtime Foundation` | 开发者可通过统一 Runtime 稳定调用不同 Agent/Provider，平台可看见执行、用量与失败 | 0、1、4 的必要子集 | stable contracts；单 execution 单 Transport；usage parity；identity/scope；secret-free config；审计与本地恢复基线 |
| `Release R1 - Governed Execution & Memory` | 用户获得自动但可控的跨执行记忆，并可查看、纠正、固定、遗忘 | 0.5、2、3、5、6 | Claim/Evidence 权威；自动写入 policy；scope leak=0；purge 可证明；检索质量/延迟门槛；关闭 Memory 可回稳定执行基线 |
| `Release R2 - Verified Learning` | 重复成功过程可形成经过验证的 Skill，组织可解释激活、回滚与能力增益 | 7、8、10、11 | replay/sandbox/shadow；高风险确认；确定性 LearningDecision；CapabilityGain；失败自动停用；来源与回滚完整 |
| `Release R3 - Enterprise Organizational Runtime` | 企业可联合身份、委派管理、治理共享能力，并满足合规与运营要求 | 9、12、13 + Enterprise Control Plane track | OIDC/SAML、SCIM、delegated admin、policy rollout/rollback、quota/FinOps、residency/retention/legal hold、audit export、backup/restore、SLO/RTO/RPO |

每个 Release 都必须提供：版本化 API/CLI、最小 Web 治理流程、默认安全策略、迁移与 rollback、可观测性 dashboard、运维 runbook、已知限制和升级兼容矩阵。Feature flag 可延后激活，禁止把未完成的闭环包装成已发布能力。

### `Release R0` 可交付拆分

R0 保留完整目标，但拆成三个可以独立演示、验收和回滚的增量，避免契约、数据平面、身份、审计与恢复一次性同时上线。

| Increment | 用户可见结果 | 必须交付 | 明确不阻塞本 Increment 的后续项 |
|---|---|---|---|
| `R0.1 Contracted Runtime` | CLI/Telegram 经同一 `RuntimeRequest -> ExecutionContext -> RuntimeEvent` 生命周期调用既有 Agent | canonical identity/scope/policy/event/error；Tool/Workflow/Agent Port；local adapters；secret ref migration；contract fixtures | Memory 自动写入、Web 完整治理、企业 federation |
| `R0.2 Reliable Execution Plane` | Claude/Codex/Hermes 经唯一 Transport 执行，可看到 usage、失败、retry owner 与 trace | single proxy、Usage parity、Kernel permission/idempotency/cancel、Tool side-effect、Agent event resume、基础 audit、故障恢复 | 自动学习、复杂 Workflow compensation、企业 FinOps export |
| `R0.3 Governed Operations` | 平台可管理 environment、policy revision、plugin activation、quota 和恢复状态 | local identity directory、admin mutation、policy validate/rollout/rollback、plugin lifecycle、audit query、backup/restore drill、SLO dashboard | OIDC/SAML/SCIM、multi-region、organization scope promotion（进入 R3） |

Increment gate：前一 Increment 的 contract/version/error 语义冻结并通过 replacement fixture 后才进入下一项；后续项可在 feature flag 后开发，但禁止反向修改已经发布的外部契约，除非走版本升级与 migration。R0.1/R0.2/R0.3 全部通过才可对外称为 `Release R0`。

## 关键交付风险与应对闭环

以下六项是当前目标方案的首要交付风险。应对措施、降级路径和退出门槛属于 Release gate；困难能力可以分阶段、Shadow 或切换 Adapter，但不得被静默删除。

| 风险 | 责任边界 | 必须执行的应对 | 降级 / 回退 | 退出门槛 |
|---|---|---|---|---|
| 一次性交付范围过大 | Runtime Architecture + Release Governance | 先冻结 `R0.1` 最小公共契约，只交付一条完整 `Surface→Orchestration→Agent→Kernel→Transport→Provider→Event` 纵向链；后续能力按兼容版本和 Release 逐步加入 | 未过 gate 的 Increment 不发布，继续运行上一稳定 baseline；高级学习 flag 可关闭 | contract fixture 通过；纵向链可独立部署/观测/回滚；后续项有明确 owner、状态和 exit condition |
| Provider/协议/streaming/tool/usage 正确性 | ⑤ Transport + `UsageObserver` | 建 CLI/provider/protocol/version 兼容矩阵、脱敏 fixture corpus、SSE 状态机、tool assembly、attempt idempotency、真实 canary 与 usage parity 测试 | 未知 profile 收窄 Memory 至 `shadow_capture/passthrough`；保留已验证 compatibility/Usage；禁止猜测未知协议 | 单 execution 单 listener/upstream；声明 transform 外 AST 相等；usage exactly-once；敏感原文持久化为 0 |
| Identity、Scope、Evidence 质量不足 | ② Orchestration + Identity + ⑥ Memory + ⑧ Policy | 外部 subject 映射 canonical `PrincipalRef`；固定 directory/policy revision；SQL 查询期与 core 二次授权；Candidate add-only；按来源权威、独立证据、冲突/时态与 category policy 激活 | 身份无法解析或证据不足时 fail-closed/pending；显式 `pin/correct/forget/purge` 仍可用 | cross-tenant/cross-scope leak=0；authority fixture 确定；纠正保留 lineage；projection/backup purge 可证明 |
| 把召回相关性误判为因果收益 | ⑦ Learning Governor + `EvaluationHarness` | 分开记录 `retrieved/injected/referenced/decision_changed/outcome_changed`；固定 baseline、目标指标、样本量、置信区间；高影响产物做 Shadow/反事实抽样 | 证据不足返回 `no_artifact` 或保留 candidate，不改变生产 ranking/promotion | replay 确定；无 hard safety regression；以 `CapabilityGain` 而非召回次数或模型自评证明收益 |
| Skill 挖掘与自动激活不安全 | `ProcedureMiner` + Skill lifecycle + ④ Kernel + ⑧ Policy | 只采 verified-success episode；成熟序列挖掘；跨 execution support；anti-unification；trace alignment；typed IR；static/replay/sandbox/shadow；环境指纹与逐步执行期授权 | 保留 candidate、进入 `needs_revalidation`、重复失败 deprecate，或回到直接受治理执行 | `stepCoverage=1.0`；无 unsupported step/secret feature；postcondition 可验证；对应风险 gate 与确认 100% 通过 |
| Enterprise Control Plane 体量与运营负担 | Enterprise Control Plane Track | CP0-CP3 并行分段；Web/CLI/API 复用同一 core mutation、Policy、Audit、Usage 和 Storage 权威；不得复制数据平面或账本 | 未完成企业能力不阻塞 local R0-R2，但不得标记 enterprise-ready | Surface policy/audit parity；delegated admin 隔离；canary/rollback；quota/FinOps 对账；legal hold/residency fail-closed；恢复演练满足 RTO/RPO |

风险状态至少包含 `open | controlled | accepted_for_increment | triggered | closed`、owner、影响 Release、触发信号、最近证据、剩余风险和下一 gate。`accepted_for_increment` 只表示该风险不阻塞当前较小增量，不表示目标能力被取消；任何 hard safety regression、scope leak、重复副作用/计费或 raw secret persistence 都立即将相关 rollout 冻结为 `triggered`。

## 技术实施顺序（Phase）

### Phase 0：契约、评测与迁移保护

- 固化本文最终 schema（含 `memory_units + claims + evidence`）、TypeScript public API、Runtime Transport Proxy 协议（`ApiAdapter/EphemeralParsedTurn/SanitizedTurnEnvelope`）和 feature flags。
- 固化 `CandidateExtractor/RetrievalBackend/VectorRetrievalBackend/TemporalGraphProjection/WorkflowCheckpointBackend/DurableJobBackend/ProtectedPayloadCodec/ProcedureMiner/PolicyEngine/EvaluationHarness/IdentityDirectoryPort/AuditQueryPort/MeteringExportPort/ObservabilitySinkPort/ObservabilityQueryPort` 契约、`CapabilityObservation` 与 `OrganizationPolicySnapshot`；为每类建立 local reference adapter 和 provider contract fixture，业务代码不得导入第三方 backend 类型。
- 建立 R11 最小黄金集：scope 隔离、中文/英文召回、冲突、预算、forbidden leak；在任何 Retriever 改动前得到 baseline。
- 复用 LoCoMo、LongMemEval、BEAM 等公开长期记忆评测的许可兼容子集和指标实现，并增加本项目 scope/authority/purge/skill 数据集；所有外部 benchmark 必须固定版本、模型栈和 token/retrieval budget。
- 增加端到端 QA 基线：知识更新、时序推理、证据不足拒答、stale-memory error、unsupported personalization。
- 建立 Memory Simulation Harness 最小场景和 Proxy fixture corpus；所有随机时间、模型输出和 embedding 使用可重放 seed/stub。
- 冻结现有 `startOpenAiUsageProxy` facade、Responses↔Chat translation、records、metrics、usage.json 与错误语义为 transport parity baseline；记录现有测试和真实脱敏流量样本。
- 固化"单 execution 单 listener/route/base URL 覆写"不变量、Extension API、Transform Patch schema、Ephemeral/Sanitized 数据边界和 route-loop 检测契约。
- 实现 migration runner、SQLite Online Backup、恢复演练、文件权限检查。
- 实现 `memory_policies` 与 `--incognito`，确保自动写入上线前已有关闭和 purge 能力。
- 建立依赖 ADR、SBOM、许可证/CVE 扫描、数据出境清单和 adapter 退出测试；托管服务不得成为 local profile 的隐式依赖。
- 退出条件：空库/旧库 migration 可重入；故障注入中断后可恢复；`forbiddenLeak=0`；公开类型通过 TypeScript contract test。

### Phase 0.5：智能学习控制面

- 在 `core/memory` 内实现 `LearningObjective`、`LearningSignal`、`LearningDecision` 和确定性 `LearningGovernor`，通过 Runtime Learning and Governance 契约接入，不新增独立产品边界。
- migration 预建 learning decisions、memory attribution、compression manifest、goal/capability relation 投影；实现 metric/governor/evaluator/compiler version registry。
- 建立不确定性决策表和主动问题预算；固定 proceed/search/verify/ask/proceed-cautiously fixture。
- 为自动抽取、自动激活、自动压缩、主动学习、因果归因和 scope promotion 建立独立 feature flag 与稳定 baseline。
- 建立 Capability Gain dashboard 的事件与查询接口；初期只读展示 baseline，不允许未校准指标驱动 production promotion。
- 退出条件：相同输入和版本产生相同 LearningDecision；模型不能直接激活或扩权；关闭所有智能 flag 可回到 Phase 0 baseline；每个决策可解释 reason code、预算和目标。

### Phase 1：Core Memory 抽离 + 身份地基 + 只读链路

- 将 `src/telegram/memory` 迁移为 `src/core/memory`，Telegram 仅保留兼容 adapter，现有行为不变。
- 落地 accounts/identity_links、`AiExecutionContext`、安全的 `project_id` 派生和群聊硬守卫。
- 实现 `CapabilityObservation` 单一 emission helper、JSONL local projection 和 `ObservabilityQueryPort`；完成 Memory `plan→route→filter→rank→budget→compile→inject` 调用树、逐 route 授权/耗时/错误与 `complete|sampled|partial` 标记。
- 实现 local profile：SQLite/FTS5/trigram、reference RRF、可选 sqlite-vec、PolicyEngine reference evaluator 和 OpenTelemetry trace adapter；保持所有成熟 backend 未安装时仍有稳定 baseline。
- 在现有 `startOpenAiUsageProxy` facade 下引入 `core/transport-proxy` 单一数据平面，先以 usage-only 模式保持当前 Codex/Telegram、translation、records、metrics 和 usage 写入行为不变；禁止启动第二 Memory server。
- 分离最小 TransportForwarder 与隔离 ExtensionWorker；实现 TransformCoordinator、UsageObserver、MemoryExtension、RedactionGateway、listener registry、route lease/loop detector 和 bounded IPC。
- 实现 ProtocolExchange、TurnCorrelator、adapter registry、EphemeralParsedTurn→SanitizedTurnEnvelope、fixture replay 与 raw-persistence schema guard。
- 实现 ProxyCompatibilityProfile、transport/memory 独立模式、健康指标、熔断、preflight fingerprint、cache/cost metrics、`ai doctor transport-proxy`（兼容 `memory-proxy` alias）和管理员收窄模式；未知 CLI major 默认 shadow/passthrough。
- 所有入口（Telegram headless spawn、CLI TUI spawn）统一通过 Transport Proxy；保留 `--native` 直连模式与临时只读 MCP fallback。
- 退出条件：现有 Usage Proxy 全部测试零行为回退且 parity=100%；每 execution 只有一个 listener/upstream；Telegram/CLI 同一 fixture 产生相同注入 id；retry/continuation/compaction 不重复写；未知事件透传；声明 transform 外 canonical AST 一致；持久化 raw 敏感字段为 0；worker 崩溃当前 stream 继续，forwarder 崩溃当前请求明确失败且下一请求恢复；cache/cost 门槛通过；Proxy 转发开销 p95 小于 20ms、L1 Pre-Read p95 小于 100ms。

### Phase 2：持久化 Post-Run 与自动记忆 MVP

- 实现 execution_runs、memory_jobs 和 local `DurableJobBackend` 的 worker lease/retry/dead-letter；同时提供成熟队列 contract fixture，Post-Run 同步只做 durable enqueue，worker 不依赖队列 SDK 类型。
- 实现 `ProtectedPayloadCodec` local adapter、密钥轮换/rewrap/篡改拒绝 fixture 和 KMS/HSM contract fixture；禁止业务代码实现 AEAD/KDF 或接触裸主密钥。
- 每 turn 写轻量 episode/envelope；本地启发式筛选后才调用廉价专用抽取模型，按会话空闲/结束合批。抽取通过 `CandidateExtractor`，优先复用 Mem0-style ADD-only pipeline 或等价成熟实现；无论 provider 输出何种 update/delete 意图，落地层都只追加 Candidate/Evidence proposal。
- 自动保存明确 user-stated 的 `preference/fact/task_note`；写入 Claim 与不可变 Evidence；隐含推断进入 pending；模型不能直接更新或删除。
- 接入 Learning Governor：每个 execution 写最小 LearningSignal；低风险自动记忆按 category policy 激活，其余选择 pending/verify/ask/no-artifact。
- 实现敏感过滤、provenance、Derivation DAG、结构化 confirmation、origin-bound authority、corroboration group、版本化 category policy schema + PolicyEngine adapter、分区 memory_events 和管理界面的 `pin/correct/forget`。
- 退出条件：进程在 enqueue 后强杀，重启仍能完成且不重复写；external 经过摘要/转述/蒸馏后仍永不 active；同源重复证据不触发升级；用户回复延迟只增加一次本地 SQLite 入队时间。

### Phase 3：长期/短期/项目分层与治理

- 启用 canonical schema 中的 lifetime、project、status、完整时态字段；自动 TTL、Claim 冲突候选和软删除。
- Profile 改为由 active Claim 编译的 audience-specific snapshot，不再允许模型整体覆写画像正文。
- 启用 Profile AST 增量编译、prospective/constraint/negative typed payload 和 Event Pattern DSL；失败经验与相关成功 Skill 同时召回。
- 完成 export/delete/purge、审计历史、privacy audience 与跨来源绑定告知。
- 增加 profile/persona 单例并发测试和 project scope 跨 bot 行为测试。
- 退出条件：scope/identity 泄漏为零；purge 后正文、向量、episode、可逆审计 payload 和备份均不可恢复。

### Phase 4：Auth Session Broker（并行 track，不阻塞 Phase 1-3）

> 本阶段是体量接近独立项目的子系统（Playwright + 加密 + Keychain + 域名白名单 + 人工登录流），与记忆核心解耦。可与 Phase 1-3 并行推进，其未完成不应阻塞记忆分层和检索增强。

- 新增 `ai auth login/list/status/logout/clear`
- Playwright/Browser storage state 使用成熟 AEAD/secret-store library 加密保存，禁止自研密码算法、KDF 或密钥封装格式
- macOS Keychain 保存加密密钥
- Linux libsecret/受限加密文件与 Windows DPAPI SecretStore adapter
- Browser 自动化执行前检查登录态
- 模型只能使用 execution-bound、签名、短时有效的 capability handle，不能读取 secret；跨 execution 自动失效
- 完成重定向 allowlist、数据分类、类型化动作和高危确认威胁测试

### Enterprise Control Plane Track（并行 track，`Release R3` 前完成）

该 track 复用 Phase 0 的 L0 contract，并与 Memory/Skill 后续 Phase 并行推进；它不引入第二数据平面或新的权威账本。

1. **CP0 Foundation**：tenant/organization/environment 资源模型；local `IdentityDirectoryPort/AuditQueryPort/MeteringExportPort` reference adapter；admin mutation envelope；不可变 revision 与 durable export operation。
2. **CP1 Identity & Policy**：OIDC/SAML federation、SCIM provisioning、delegated role、bounded session、break-glass；policy draft/validate/approve/effective inspection/canary rollout/rollback。
3. **CP2 Capability & Operations**：plugin approval/lifecycle、quota/budget/concurrency、usage attribution/showback、审计查询与 recipient-bound export、Web/CLI/API surface parity。
4. **CP3 Compliance & Resilience**：residency、retention、legal hold、purge completion evidence、backup/restore、DR runbook、SLO/RTO/RPO、故障演练与签名验收报告。

退出条件：外部 identity 只映射 canonical id；同一 mutation 在 Web/CLI/API 产生同一 Policy/审计结果；directory/policy/audit/metering/storage 故障不扩权、不丢 accepted audit、不复制 Usage ledger；production policy/plugin 可 canary 与 rollback；legal hold/residency 不确定时删除/移动 fail-closed；恢复演练满足声明的 RTO/RPO。

### Phase 5：检索增强

- FTS5 索引（中文用 `trigram` 或外挂分词器，见「数据存储 · CJK 分词」；上线前做 CJK 召回验证）
- alias/synonym 表
- MemoryQueryPlanner + Mem0-style 多信号检索：required + semantic + BM25/FTS + entity/alias + recent + temporal + episode + constraint/negative
- 记忆使用统计
- 优先复用成熟 BM25/分词/entity linking/fusion 实现；本文 reference RRF 作为确定性 fallback，禁止自行实现 ANN 或 cross-encoder
- 导入公开长期记忆 benchmark adapter，R11 CI 同时对比 Phase 1 baseline 和固定外部数据集
- 退出条件：CJK 短词 fallback 通过，质量指标不回退，p95 满足配置阈值

### Phase 6：向量搜索

- 已完成前置：`ai memory embedding` 配置和探测专用 embedding provider
- embedding 生成：保存/更新记忆时生成向量
- local 使用 sqlite-vec；team/enterprise 使用 pgvector、Qdrant 或等价成熟向量库，统一实现 `VectorRetrievalBackend`，禁止自行实现 ANN index
- vector contract suite 验证检索期间应用 tenant/user/scope/audience/purpose/status/time metadata filter；只支持账号全库召回后过滤的 provider 不得上线
- 语义召回接成熟 local/remote reranker provider；本地仍执行 scope/authority/temporal/conflict 后处理
- 大量记忆下的预算优化
- model_key 双索引切换、失败重试、离线回填与回滚
- 退出条件：切模型期间不混维度；vector 关闭时无错误回退 FTS；评测集证明语义用例有增益

### Phase 7：语义蒸馏与 Skill 候选

- 批量 episode 蒸馏为语义事实和 skill candidate，蒸馏任务幂等
- 冲突检测
- 重复合并
- Profile Compiler 周期性更新版本化 snapshot
- 自动 Consolidation 按重复、增长、干扰、里程碑和周期触发；生成 CompressionManifest，完成 source coverage、冲突拆分、Shadow QA 和原子发布后才替换热层投影
- 自动冷热迁移与边际效用降温；Evidence、审计、用户 pin 和 purge 派生链不因压缩物理删除
- ContextCompiler 输出 Letta-style versioned Memory Blocks；attach/detach/shared 仅操作 projection，任何 Agent block edit 转 ADD-only candidate
- 可回滚 memory history
- 退出条件：蒸馏重放不重复产物；来源证据可追溯；失败不会标记 episode 已消费；summary source coverage=1.0；token 至少下降 20%；任务成功不回退且 stale-memory error 不上升；manifest 可回滚

### Phase 8：检索质量与时序正确性（Tier 1）

- 扩充 Phase 0 已落地的检索评测 harness、黄金集和 CI 回归闸
- 完整时态模型：event/asserted/observed/ingested/transaction time、fuzzy/relative/unknown、precision、timezone、recurrence 和 event anchor（R12）
- fact_key 归一 + 冲突检测与消解（R13）
- R11 评测集补矛盾/时序用例，基线阈值写入 baseline.json

### Phase 9：知识图谱、回流与三层记忆（Tier 2）

- 通过 `TemporalGraphProjection` 接入 Graphiti-compatible 时序图，复用 Episode provenance、entity linking、双时态 validity、增量 invalidation 和 hybrid traversal；Entity/Claim/Event/Episode/Action/Outcome/Artifact 全部回指权威 Claim/Evidence（R14）
- local profile 未启用图 backend 时只保留 SQLite temporal/alias fallback，不自行实现功能不完整的图数据库或 Graphiti 克隆
- 检索有用性拆分为多维 utility；启用确定性使用信号和廉价 Judge，反事实仍在 Phase 11 异步采样（R15）
- 启用 `memory_episodes` 的长窗口蒸馏与情景/语义/程序三层检索（表从 Phase 2 已开始积累，R16）
- 图层与回流全部可降级回退到 Phase 8 基线
- 退出条件：关闭任一 Tier 2 flag 即回到 Phase 8 结果；多跳/回流在独立套件有可测增益

### Phase 10：Skill 自沉淀（程序性记忆）

- `skills + skill_versions` + candidate→syntactically_valid→historically_replayable→sandbox_validated→shadow_validated→active→needs_revalidation→deprecated 生命周期
- 归纳型（`ProcedureMiner` 复用成熟 PrefixSpan/序列挖掘实现）+ 示范型（用户确认）双来源；通用挖掘算法不得手写，输出仍是 ADD-only Skill candidate
- mining 主链（R36）：intent_key 分桶 → 序列聚类（support≥3、跨≥3 execution）→ anti-unification 参数化 → trace alignment（stepCoverage=1.0）→ replay/sandbox/shadow；冷启动经示范/导入/跨 scope 迁移 seed，均不降低风险门槛
- 失败自愈：`needs_revalidation` 后用新增成功 episode 自动重挖生成 ADD-only 新版本，连续失败 ≥2 次标 deprecated 并移出候选池，坏经验不污染后续挖掘（R36）
- 生成结构化 Skill IR，执行 schema validation、trace alignment、static risk analysis、sandbox replay 和 shadow invocation
- Skill 注入 + Post-Run 回流强化 + 蒸馏合并/参数化/版本取代；环境指纹变化时强制重验证
- 实现 Skill `match→select→apply→step→outcome` Observation；每个 step 关联实际 `CapabilityInvocation`，显示 confirmation/guardrail/deviation/postcondition 和贡献归因，不保存步骤正文。
- 高危护栏、external 不自动执行、跨 scope 提升需显式、全程 memory_events 留痕
- Skill 仅作为 advisory 程序记忆，运行时 permission policy 独立生效
- 退出条件：success criteria 可验证或经用户确认；exit code 不能单独计成功；DSL 禁止项无法编码；高危动作 100% 触发确认；未通过对应风险等级 replay/sandbox/shadow 的 Skill 不得 active

### Phase 11：主动回忆、因果反馈与 Shadow Memory

- 暴露受限只读 `MemoryService.search`，主模型每 turn 默认最多一次迭代式补查
- 增加多维 utility：answer/action contribution、failure attribution、harm、redundancy、correction 和 token opportunity cost；对高影响记忆异步采样 counterfactual replay
- 启用元认知不确定性、目标条件检索和主动学习问题策略；按 question value、冷却期和每日预算选择 search/verify/ask/proceed-cautiously
- 启用 retrieved→injected→referenced→decision_changed→outcome_changed 归因链和 Capability Gain；未证明贡献的召回不更新 utility
- 建立 production/candidate 双策略 Shadow Memory，比较 Planner、ranking、embedding、Policy 和 compiler 结果
- EvaluationHarness 复用固定版本的 LoCoMo/LongMemEval/BEAM 指标实现、成熟 tracing/eval SDK 与本项目长期 Simulation；外部 Judge 只能产生 evaluation evidence，不能直接 promotion
- 退出条件：主动补查和提问不产生 scope/authority 泄漏；不会在冷却期重复低价值问题；candidate policy 不影响生产结果；端到端 QA 有统计显著增益且 stale-memory error 不上升

### Phase 12：多 Agent、Team Scope 与多模态 Artifact Memory

- 增加 agent-private/project-shared/team-shared/delegated scope 与 owner/readers/writers/delegation/purpose policy
- 子 Agent 默认只能写 episode/candidate；提升共享 semantic memory 需要 owner policy
- 建立加密 Artifact Store，支持 image/document/audio/UI region 的 hash、观察结果、区域引用和多模态 embedding
- 增加签名 append-only event replication、causal parents、Lamport time、team key rotation 和 deterministic materializer
- 启用 project→team→organization promotion proposal；私有 Evidence 不迁移，跨主体/跨环境验证和 owner policy 决定共享激活
- 退出条件：跨 Agent purpose limitation 和撤销测试全部通过；离线并发可确定性合并；删除 artifact 时全部派生 Claim 可定位、重算或失效；purge tombstone 和 key destruction 传播到所有已注册副本

### Phase 13：完整性证明与可逆 Parametric Promotion

- `memory_events` 建立按 account+stream 分区的 previous_hash/event_hash 链和本机签名 checkpoint，备份/恢复后执行完整性校验
- 高频稳定且非敏感的记忆按 rule→local classifier→prompt/context adapter→可选 model adapter 分级提升；保留 source Claim/Evidence、base model、版本、评测和撤销路径
- 编译产物在 shadow/replay 通过前不进入生产；来源撤回或 Claim supersede 时自动失效
- 退出条件：篡改、删除事件、错序恢复能够被检测；前三类 promotion 可确定性撤销并回到 plaintext memory 基线；Model Adapter 未满足 opt-in/样本/评测门槛时保持 experimental

### 贯穿全程：可观测性（不单列 Phase）

- **R17 Capability Observability**：Phase 0 固化 `CapabilityObservation`/Sink/Query schema；Phase 1 完成 Memory 逐 route explain 与 generic resolve/invoke/result；Phase 2 连接异步 Post-Run span link；Phase 10 完成 Skill step/outcome/lifecycle；JSONL/OTel/dashboard 只投影同一次 emit。
- **查询体验**：提供 `ai trace show`、`ai memory explain`、`ai skill explain` 与 Web Timeline/Memory/Skill/Capability/Cost/Error 视图；全部经 `ObservabilityQueryPort` 与 Policy，显示 sampling/drop completeness，不读取原始 JSONL。
- **安全与性能**：高影响/失败/lifecycle trace 100% 保留，普通成功 read 可采样；指标禁止高基数 id；同步 emit p95≤2ms、p99≤5ms，exporter 故障不改变 Runtime 行为。
- **R18 Telegram 中间态**：Phase 2 随自动记忆一起上，复用 `ProgressReporter` 扩展 `phase`；引擎 `thinking` 改用 `⏱️`，记忆态 `🧠 回忆中/已调用 N 条`、技能态 `🧩 套用/沉淀《名》`、写入 `📝 记住新偏好`（skill 相关随 Phase 10 补齐），只显状态不泄内容。

## 相关文档

- [enforcement-decisions.md](enforcement-decisions.md)
- [testing.md](testing.md)
- [00-overview.md](00-overview.md)
- [service-level-objectives.md](service-level-objectives.md)

## Web 企业控制面方向

Command:

```bash
ai web
```

Web 是 Enterprise Control Plane 的操作界面，不是 Provider 配置页面的放大版，也不拥有独立业务逻辑。所有写操作调用与 CLI/API 相同的 L0/core contract，并显示 policy decision、影响 scope、revision、审批状态与 rollback 入口。

Planned capabilities:

- **Organization & Identity**：tenant/organization/environment、OIDC/SAML、SCIM sync、member、role、delegated admin、break-glass 审计。
- **Policy & Approvals**：policy draft/diff/validate/approve、effective-policy inspection、canary rollout、rollback、待确认动作队列。
- **Capabilities & Plugins**：发现、风险/权限清单、版本兼容、审批、激活、draining、disable、replacement 状态。
- **Memory & Learning Governance**：Claim/Evidence 查看与纠正、pin/forget/purge、candidate/evaluation、Skill promotion/rollback、CapabilityGain 与 Shadow 对比。
- **Execution & Audit**：execution trace、失败原因、permission decision、审计查询/签名导出、数据生命周期操作与完成证据。
- **FinOps & Reliability**：Provider health、usage/cost/latency、组织/项目/主体归属、quota/budget、SLO、告警、backup/restore 与 DR 演练状态。
- **Provider / Agent Operations**：Provider/model 配置、排序与刷新；Hermes robot 的状态、绑定、task、迁移、清理与错误，但 secret 只显示 ref/status，禁止回显明文。

最小发布顺序：R0 提供 execution/provider/usage/audit 只读视图与受控配置；R1 增加 Memory 用户控制；R2 增加 learning/Skill promotion；R3 补齐 identity/policy/plugin/FinOps/compliance/DR。每个页面必须有 empty/loading/degraded/permission-denied/partial-failure 状态，危险操作必须展示影响范围、二次确认和 operation progress。

## 附：原始 Todo 清单（从 SPEC §12 迁入）

> **Appendix Status: DEPRECATED REFERENCE** — 仅用于追溯旧需求；Release/Phase 正文是唯一交付顺序，禁止从本清单直接立项。
>
> 保留原始三级优先级分组；部分条目已被上文 Phase 计划覆盖，以 `（见 Phase N）` 标注，此处仍保留原文以保持忠实。

### High Priority

- Automatic provider fallback.
- `ai doctor`. （见 Phase 1）
- `ai last`.
- Local proxy mode with an OpenAI-compatible endpoint. （见 Phase 1）
- Stable Runtime contracts for execution events, learning objectives, learning signals, learning decisions, uncertainty, evaluation, and capability gain. （见 Phase 0 / 0.5）
- Governed memory Phase 0/0.5 foundations: migrations, evaluation baseline, deterministic Learning Governor, feature flags, and rollback baseline. （见 Phase 0 / 0.5）
- Mature capability adapter foundation: add-only extractor, hybrid retrieval, temporal graph projection, workflow checkpoint, policy engine, evaluation harness, local fallback profiles, dependency ADR/SBOM, and provider replacement tests. （见 Phase 0）
- Unified Runtime Transport Proxy migration behind the existing Usage facade: parity tests, single listener, transform coordinator, isolated workers, MemoryExtension modes, route-loop detection, recursive redaction, cache/cost gates, kill switch, and diagnostics. （见 Phase 1）
- Smart routing command: `ai do`.
- Git workflow commands: `ai review`, `ai fix`, `ai commit`, `ai pr`.
- Project-level profile: `.ai-gateway/project.json`.
- Project-level last selection: `ai last --cwd`.
- Unified MCP and skill management.
- Sensitive file protection. （见 Phase 0）
- Project-level default provider/model.
- Token usage statistics.
- Web provider list. （见上文 Web 控制面板方向）
- Web drag-and-drop level ordering. （见上文 Web 控制面板方向）
- Web default model switching. （见上文 Web 控制面板方向）

### Medium Priority

- Unified MCP management for Claude Code and Codex CLI.
- Unified skills registry with per-client adapters.
- Context packaging: `ai context`.
- Task modes: `ai task bugfix`, `ai task review`, `ai task refactor`, `ai task docs`.
- Session aliases: `ai save <name>`, `ai resume <name>`.
- Model fallback chains.
- Model and provider benchmark: `ai bench`.
- Rule-based routing by task, project, directory, or file type.
- Command replay: `ai replay`.
- Model aliases: `fast`, `cheap`, `best`.
- Task-based default models: `coding`, `review`, `fast`, `cheap`.
- Provider/model latency benchmark.
- Provider error details.
- Cost estimation.
- Daily and weekly budgets with warnings.
- Session history.

### Low Priority

- Automatically choose Claude or Codex based on task.
- Team shared configuration.
- Full per-terminal isolation for cache, logs, and last selection.
- Flutter desktop app.
- Advanced rule-based routing.
