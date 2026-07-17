# ⑦ Learning & Governance 学习与治理

> 遵循 doc_2.0 统一模块模板。语言中英混合，标识符英文原样。术语见 [../glossary.md](../glossary.md)。
> 关键立场：智能 = **确定性 Learning Governor + Policy**；模型只提候选与弱评估，**禁**写激活/confidence/策略状态。

## 1. 定位（一句话）

把执行证据变成候选、度量候选是否让 Runtime 更强，并由确定性 Governor + 人类授权决定候选是否成为激活的知识/技能/能力。

## 2. 单一职责边界（高内聚）

**拥有**：`LearningSignal`→`LearningDecision` 确定性状态机、`EvaluationResult` 产出、`CapabilityGain` 度量、promote/rollback/audit、`LearningObjective` 管理。

**禁止拥有**：
- **禁止**让模型直接写激活态或最终 `PolicyDecision`。
- **禁止**用 artifact 数量/retrieval 数量当成功度量——度量是 `CapabilityGain`。
- **禁止**绕过 scope/privacy/evidence/permission 边界。

## 3. 内部构件与各自单一职责

| 构件 | 单一职责 |
|---|---|
| `learning-governor` | 确定性选择：no artifact/extract/verify/ask/consolidate/evaluate/promote/rollback |
| `evaluation` | `EvaluationHarness` 版本化评测（产出证据，非授权） |
| `promotion` | scope 提升、组织级激活（需人类授权） |
| `attribution` | 从权威 outcome/evaluation 计算 retrieved/injected/referenced/decision-changed/outcome-changed，并投影为 Memory/Skill Observation |
| `audit` | provenance、可 deprecate/supersede/export/purge |

## 4. 对外/消费端口（可插拔点）

- 消费：`RuntimeEvent`（来自 ②/④）、`EvaluationHarness`、`CompressionManifest`、⑥ 的候选与证据、⑧ `PolicyEngine`。
- 产出：激活的 artifact / 保留的 candidate / rollback 记录 + `CapabilityGain`；经 `ObservabilitySinkPort` 输出非权威 attribution/lifecycle Observation。
- 评测集与评测器可换（本地基准 / 企业评测集）。

## 5. 依赖（低耦合）

只 import `L0 Contracts`。学习闭环：`RuntimeEvent → LearningSignal → LearningDecision → LearningCandidate|no artifact → EvaluationResult → PolicyDecision → active|retained|rollback → CapabilityGain`。

## 6. 数据所有权

**独占** `LearningObjective`、`LearningDecision` 记录、评测结果与 `CapabilityGain`。事实真相仍属 ⑥ 账本——本模块**只**改 utility，**禁**改事实 confidence（confidence 来自 evidence）。

## 7. 降级 / kill switch

关闭高级学习特性 → Runtime **必须**回到稳定 baseline（不学习也能正常服务）。`no artifact` 是合法且默认偏好的决策。反事实采样在预算内异步进行，故障只损失 utility 更新，**禁**影响主链路。

## 8. 产品化就绪度

❌ **结构上最不能独立**——Governor 完全由 Runtime 契约（`RuntimeEvent`/`LearningSignal`/`CapabilityGain`）定义，是核心 IP，只在闭环内有意义。评测集/评测器可作为**采纳**的外部组件，但本模块不抽取。判据见 [../extraction-readiness.md](../extraction-readiness.md)。

## 9. 现状映射

**完全待建**。当前无独立学习层；[enforcement-decisions.md](../enforcement-decisions.md) 的 Learning Governor（R33）与 R36 Skill 自愈是本模块的规范来源，尚未实现。

## 10. 验收标准

> 以下 4 条是**模块级**核心门槛；智能闭环的**完整 9 条验收**（含异步、压缩 coverage、组织提升、回滚等）见附录 [N. 智能闭环验收标准](#n-智能闭环验收标准)。

- 学得的 artifact **无**证据与 policy 评估**不得**激活。
- 交互可产生自动学习信号，但模型输出**不能**绕过确定性激活策略。
- Runtime 能解释为何 learned/asked/verified/consolidated/promoted/ignored/rolled back。
- "更强" 操作定义：纠错率下降 且 任务成功率不降 且 检索精度不回归（SPEC Q5）。
- Skill 正向复用必须同时具备 postcondition success、task success、无 hard regression 与明确贡献证据；仅 match/apply 或任务碰巧成功不得计入 `CapabilityGain`。
- distill/validate/lifecycle/promotion 与来源 execution 通过 span link 可追溯；Observation 缺失只影响诊断完整度，不能改变权威 `LearningDecision` 或 promotion 结果。

## 11. 相关文档

- 账本：[06-memory.md](06-memory.md)｜能力层与 Skill 激活：[03-capabilities.md](03-capabilities.md)｜整体：[../00-overview.md](../00-overview.md)
- 强制条款：[../enforcement-decisions.md](../enforcement-decisions.md) — Learning Governor（R33）、Skill Mining 与自愈（R36）、Capability 四项度量（Q5）
- 落地时机：[../roadmap.md](../roadmap.md) — Phase 7（语义蒸馏与 Skill 候选）、Phase 10（Skill 自沉淀）、Phase 11（因果反馈与 Shadow Memory）
- 契约：[../contracts.md](../contracts.md) §2 学习与治理契约
- 权威边界（英文）：[../AI_RUNTIME_ARCHITECTURE.md](../AI_RUNTIME_ARCHITECTURE.md) §4 Governed Learning Loop

---

# 附：学习与治理详细规范

> **Appendix Status: SUPPORTING SPEC** — 学习细节必须保持 ADD-only candidate、deterministic Governor、Policy/Human activation 与 rollback 边界。

> 本附从旧 `memory-system-spec.md` 迁入。标识符英文原样。

## A. Learning Governor 契约

`LearningGovernor` 不自行生成内容，只消费结构化信号并输出可审计决策：

```typescript
type LearningSignal = {
  id: string; executionRunId: string;
  kind: "task_outcome" | "user_correction" | "memory_used" | "skill_followed"
      | "constraint_applied" | "failure" | "cost" | "latency" | "policy_event";
  source: "deterministic" | "user" | "tool_verified" | "model_judged";
  value: unknown; evidenceIds: string[]; createdAt: number;
};

type LearningAction =
  | "no_artifact" | "extract_claim" | "extract_goal" | "extract_constraint"
  | "extract_negative" | "mine_skill" | "request_verification" | "ask_user"
  | "schedule_consolidation" | "schedule_shadow_eval"
  | "propose_scope_promotion" | "rollback_artifact";

type LearningDecision = {
  id: string; operationId: string; userId: string;
  objectiveIds: string[]; signalIds: string[]; candidateIds: string[];
  action: LearningAction; reasonCodes: string[];
  policyVersion: string; governorVersion: string;
  budgetReservation: { modelCalls: number; tokens: number; replayRuns: number; questions: number };
  requiresHumanAuthority: boolean; createdAt: number;
};
```

### A.1 决策顺序（固定，缺一步即保留 reason code）

`privacy/scope guard → secret/taint guard → objective relevance → uncertainty → expected capability gain → cost budget → category automata → human authority`。

模型**不能**直接写 `LearningDecision`。相同 `operationId + governorVersion + inputHash` **必须**得同一 action；模型候选差异只作输入证据，**不得**改变确定性权限边界。

### A.2 默认动作选择

1. 明确、低风险、user-stated 且 category policy 允许 → 可自动 active 候选。
2. 隐含偏好/单次失败/external/冲突事实 → pending 或验证，**不**以高模型置信度跳过。
3. 重复成功且后置可验证 → Skill candidate，**不**直接 active。
4. 证据不足且不影响当前目标 → `no_artifact`（默认偏好，避免每轮都变长记忆）。
5. 证据不足但显著影响当前目标 → 在补查/验证/提问中选预期价值最高、成本最低者。

## B. 因果归因（区分"召回"与"产生价值"）

> 本节为简述，**权威全量规范见 [I 节](#i-因果归因与真实学习反馈权威全量)**；两者冲突以 I 节为准。此处保留概览以便顺读。

分离 `retrieved / injected / referenced / decision-changed / outcome-changed`。确定性信号优先于 Judge：约束实际阻止了禁止动作、Skill id 被执行计划引用且后置通过、唯一事实值进入工具参数。Judge 只标记 `unknown` 样本的弱归因。高影响候选采用异步 ablation/counterfactual replay；**频繁召回或与成功相关不能单独证明因果贡献**。

## C. Skill Mining、参数化与自愈（R36）

自主链：感知相似 → 泛化成参数 → 对齐防幻觉 → 失败自愈。模型只在受限步骤提候选，聚类阈值/参数判定/对齐/降级自愈全由确定性规则 + `LearningGovernor` 裁决。

**① 相似度与聚类**：`ProcedureMiner` 只消费 `result_status='success'` 且 `outcome_evidence_json` 非空的 episode。按归一化 `intentKey` 分桶，桶内用成熟 PrefixSpan 做序列挖掘（**禁**手写）。候选硬门槛：`support ≥ minSupport`(默认 3)、跨 `≥ distinctExecutions`(默认 3) 次独立 execution、`outcome_evidence` 可验证。`args_hmac`/secret/capability 只用于判等，**永不**进序列特征或 IR。

**② anti-unification 参数化**：对齐位置跨 ≥2 episode 取值不同 → 升 `TypedSlot`；恒定 → 保留 argsTemplate 常量；源自 secret/capability → 永不升 slot，运行时重取。`enum` 仅在取值集合 `≤ maxEnumCardinality`(默认 8) 时用。模型**不得**新增未在对齐结果出现的 slot。

**③ trace alignment（防幻觉门）**：`AlignmentReport` 通过条件全满足（缺一即 fail，**禁**靠 confidence 绕过）：`stepCoverage=1.0`、`unsupportedSteps` 空、`orderConsistent=true`、tool 步骤名精确匹配、argsTemplate 常量一致、slot 落在推断类型域。治理步骤（assert/confirm/checkpoint/rollback）不要求 episode 支撑但须过 static risk analysis。

**④ 自愈闭环**：进入 `needs_revalidation` 后，用新产生的成功 episode 重走 ①–③ + sandbox/shadow 生成新版本候选（ADD-only）。通过则 supersede 旧版、`remineFailures` 归零；失败则 +1；`≥ maxRemineFailures`(默认 2) 标记 `deprecated` 并把该版本及 evidence episode **移出 mining 候选池**（坏经验不得污染后续挖掘）。

**⑤ environment fingerprint**：`EnvironmentConstraint{key, matcher: exact|semver_range|oneof|present, value, critical}`。全满足才按风险等级执行；仅非关键不满足 → 降级 advisory；任一 `critical` 不满足 → 该版本不可用并触发 ④，**禁**盲目回退旧 active 版本。

**⑥ 因果贡献**：`followed` 判定对齐覆盖 `≥ followThreshold`(默认 0.8)，否则记 `deviated` 不计正贡献；`followed` 且 postcondition 全通过且无用户纠正才写 `action_contribution` 正信号；反事实在每日预算内异步采样，只更新 utility，**不**写事实 confidence。

**⑦ 冷启动 seed**：示范型（用户确认的一次成功，无需 minSupport）/ 显式导入（草案→schema→alignment→replay）/ 跨 scope 迁移（重求值 environmentFingerprint，private Evidence 不随迁移）。任何 seed 都**不豁免**对应风险等级的 replay/sandbox/shadow 与高危确认。

## D. Skill 验证等级

```text
candidate → syntactically_valid → historically_replayable
→ sandbox_validated → shadow_validated → active
→ needs_revalidation / deprecated
```

第一版 Skill DSL 只允许 `sequence/tool/assert/branch/confirm/checkpoint/rollback`；**禁**任意循环、动态工具名、自修改 Skill、运行时拼 shell、读未声明环境变量、用未声明 capability。风险分级：只读 Skill replay+shadow 后可 active；本地可回滚写需 sandbox；部署/发送/外部写即使 active 也逐步确认；转账与生产数据破坏类**永不**获无人确认自动执行权限。

## E. 默认智能体验

本闭环把自动记忆、自动沉淀、自动学习和自动压缩连接成可度量整体，不新增独立产品或平行控制面：实现仍属 `core/memory`，通过 Runtime 的 `RuntimeEvent`/`LearningCandidate`/`EvaluationResult`/`PolicyDecision` 契约接入本层。模型负责理解、归纳与提出候选；`LearningGovernor` 是版本化确定性编排器，**不能**签发工具 capability，也**不能**绕过人类对安全、共享和不可逆动作的最终权限。

| 用户体验 | 系统默认行为 | 治理边界 |
|----------|--------------|----------|
| 自动记忆 | 每次有效 execution 均持久化最小 Episode 和学习信号；命中本地筛选后异步抽取 Claim/Goal/Constraint/Failure 候选 | secret、incognito、scope 不明和 external 指令不写 active |
| 自动沉淀 | 相似成功经验自动聚类为 Procedure/Skill candidate，失败自动沉淀为带环境条件的 Negative Memory | Skill active 仍需对应风险等级的 replay/sandbox/shadow/确认 |
| 自动学习 | 根据任务结果、用户纠正、实际复用、成本与风险更新多维 utility，自动安排验证、重排实验和候选提升 | 使用次数不能提高事实 confidence；模型自评不能单独触发提升 |
| 自动压缩 | 在重复、干扰、增长或周期阈值触发时自动生成摘要、Profile Snapshot、Skill 参数化和冷热分层 | Claim/Evidence/Episode 来源不被压缩产物覆盖；purge 继续沿派生链生效 |
| 主动补全 | 信息缺口影响当前目标时，系统自动选择补查、验证或询问一个最小问题 | 问题受打扰预算、隐私策略和当前任务影响约束 |
| 智能遗忘 | 自动降温、归档冗余投影、失效旧摘要并减少无效注入 | 不因低频删除受保留策略保护的原始证据、审计和用户 pin |
| 组织学习 | 经跨用户、跨环境验证的局部经验成为 project/team/org candidate | 私有 Evidence 不出原 scope；共享提升由 owner policy 和组织权限批准 |

用户不需要发出"记住""总结"或"沉淀技能"命令。`pin/correct/forget/purge/export` 始终保留为显式控制面；系统只有在 durable job 已写入后才能显示"正在学习"，只有 active 状态提交成功后才能显示"已记住"。

## F. Runtime Learning Objective

每个学习产物必须声明它支持的 Runtime 目标，**禁止**把保存数量、召回次数或 Judge 自评分当作最终成功指标：

```typescript
type LearningObjective = {
  id: string;
  scope: "user" | "project" | "team" | "organization";
  scopeId: string;
  goalIds: string[];
  metricVersion: string;
  weights: {
    taskSuccess: number;
    correctionReduction: number;
    successfulReuse: number;
    latencyReduction: number;
    costReduction: number;
    staleMemoryError: number;
    harmfulAction: number;
    privacyOrPolicyViolation: number;
  };
  minimumEvidence: { executions: number; distinctPrincipals: number; environments: number };
  status: "draft" | "active" | "paused" | "retired";
};

type CapabilityGain = {
  objectiveId: string;
  evaluationWindow: { from: number; to: number };
  baselineVersion: string;
  candidateVersion: string;
  metricSamples: Record<string, { value: number; sampleCount: number; confidenceInterval?: [number, number] }>;
  aggregate: number;
  regressions: string[];
};
```

默认聚合语义是：任务成功、纠正减少、有效复用、延迟和成本改善为正项；陈旧记忆错误、有害动作、隐私或策略违规为硬负项。出现 `privacyOrPolicyViolation > 0`、`forbiddenLeak > 0` 或高风险动作回归时，不论 aggregate 多高都**禁止** production promotion。权重、阈值、归一化和采样窗口必须记录 `metricVersion`，**禁止**直接覆盖历史版本。

## G. 目标条件记忆与 Capability Graph

现有 prospective memory 承载 Goal/Commitment；新增关系投影而非新增真相源：

```text
Organization Goal
  -> Team Objective
  -> Project Goal
  -> Current Plan
  -> Execution Step

Evidence -> Claim -> Procedure -> Skill -> Capability
```

`memory_goal_links(unit_id, goal_unit_id, relation, confidence, evidence_id)` 的 `relation` 仅允许 `supports | blocks | risk_to | prerequisite_for | produced_by`。`capability_edges(from_kind, from_id, to_kind, to_id, edge_type, source_ids_json, projector_version)` 保存 `requires | composes | validates | supersedes` 投影。两者均可从 Goal、Claim、Episode、Skill 和 EvaluationResult 重建，不是新的事实源。

Retriever 在相关性相近时优先支持当前 active goal 的记忆；Learning Governor 优先验证阻塞目标或高风险目标的缺口。目标变化只改变检索和学习优先级，**不得**重写事实 confidence，也**不得**让组织目标越过租户、隐私或用户权限。

## H. 元认知不确定性与主动学习

每次 Pre-Read 或受限 `memory.search` 产生结构化不确定性：

```typescript
type MemoryUncertainty = {
  queryId: string;
  factConfidence: number;
  retrievalCoverage: number;
  conflictRisk: number;
  temporalAmbiguity: number;
  skillApplicability: number;
  policyAmbiguity: number;
  goalImpact: "low" | "medium" | "high";
  missingEvidenceKinds: string[];
  recommendedAction: "proceed" | "search_more" | "verify" | "ask_user" | "proceed_cautiously";
  reasonCodes: string[];
};
```

`recommendedAction` 由本地决策表产生。模型可以报告缺口，但**不能**自行提高 coverage 或降低 policy ambiguity。默认规则：安全策略冲突**必须** fail-closed；普通事实覆盖不足可补查；高目标影响且一个答案能显著降低不确定性时才询问用户；低影响问题保守继续，避免频繁打断。

主动问题按以下价值排序：

```text
QuestionValue = expectedUncertaintyReduction * goalImpact * decisionReversibility
                - interruptionCost - privacyCost - answerCollectionCost
```

每个 execution 默认最多主动询问 1 个问题，每个账号每日有 question budget；同一 unresolved claim 在冷却期内**不得**重复询问。用户回答写成绑定具体 Claim/value hash 的 Evidence；"都可以""你决定"等回答**不能**被泛化为长期偏好。

## I. 因果归因与真实学习反馈（权威全量）

> 本节为因果归因的完整规范，取代 B 节的简述；两者冲突时以本节为准。

系统必须区分"召回"与"产生价值"：

```text
retrieved -> injected -> referenced -> decision_changed -> outcome_changed
```

```sql
CREATE TABLE memory_attributions (
  execution_run_id    TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  unit_id             TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,
  retrieval_rank      INTEGER,
  injected            INTEGER NOT NULL CHECK (injected IN (0,1)),
  referenced          INTEGER NOT NULL CHECK (referenced IN (0,1)),
  decision_changed    TEXT NOT NULL CHECK (decision_changed IN ('yes','no','unknown')),
  outcome_contribution TEXT NOT NULL CHECK (outcome_contribution IN ('positive','neutral','negative','unknown')),
  attribution_method  TEXT NOT NULL CHECK (attribution_method IN ('deterministic','user','tool','judge','counterfactual')),
  evaluator_version   TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (execution_run_id, unit_id, evaluator_version)
);
```

确定性信号优先于 Judge：例如约束实际阻止了禁止动作、Skill id 被执行计划引用且后置条件通过、唯一事实值进入工具参数。Judge 只能标记 `unknown` 样本的弱归因。高影响候选采用异步 ablation/counterfactual replay；频繁召回或与成功相关**不能**单独证明因果贡献。

Utility 更新仅使用原始计数和版本化聚合器，**不覆盖**事实 confidence。负贡献超过 category 阈值时自动降低检索权重、进入 shadow 或加入 review queue；安全回归立即停用相关编译产物，但保留来源和回滚记录。

## J. 自动压缩、巩固与智能遗忘

压缩采用"真相源不变、投影可替换、原文按保留策略管理"的原则。自动触发条件：

- 同一 fact key 存在 3 条以上等价 active Claim 投影；
- 单账号热层 token footprint 超过配置阈值；
- 最近评测窗口的 redundancy 或 interference 超阈值；
- 50 个以上未巩固 Episode、会话结束、项目里程碑或每周周期触发；
- Profile/Skill/Goal 的 source Claim 发生变更或撤回；
- 检索延迟、stale-memory error 或 token opportunity cost 回归。

固定流水线：cluster candidates → authority/scope/temporal partition → contradiction split → deterministic dedupe → model-assisted summary/parameterization → source coverage validation → shadow retrieval comparison → atomic publish manifest → old projection cool/archive。

```typescript
type CompressionManifest = {
  id: string;
  ownerUserId: string;
  scope: ScopeRef;
  kind: "dedupe" | "summary" | "profile" | "skill_parameterization" | "cold_tier";
  sourceUnitIds: string[];
  sourceEvidenceIds: string[];
  outputUnitIds: string[];
  compilerVersion: string;
  inputHash: string;
  coverage: number;
  unresolvedConflicts: string[];
  tokenBefore: number;
  tokenAfter: number;
  qualityDelta: number;
  rollbackArtifact: string;
  status: "candidate" | "shadow_validated" | "active" | "invalidated" | "rolled_back";
};
```

发布门槛：source coverage **必须**为 1.0；不同 authority、scope、audience 或有效时间的事实**不能**被合并为一个无条件摘要；未解决冲突**必须**保留为结构化 conflict；Shadow QA **不得**降低任务成功或提高 stale-memory error。压缩后 token 至少下降 20% 才发布 summary 类产物，否则选择去重/降温或 `no_artifact`。

冷热层语义：hot 是可直接注入的 active 投影；warm 是可检索的 Claim/Episode；cold 是加密、可回源但默认不参与检索的历史内容。自动遗忘优先执行降温、失效投影和归档，**不**直接物理删除 Evidence、审计、用户 pin 或法定保留数据。物理删除只由 TTL、用户 `forget/purge`、组织保留策略或合法数据生命周期触发。

边际效用用于处理干扰：若某记忆长期未产生正贡献、与更高 authority 新事实重复、持续造成 token 浪费或错误召回，则降低热度；若删除它会破坏 Claim、Skill、Profile、审计或 purge 可追溯性，则保留来源但从热检索层移除。

## K. 组织知识迁移

scope promotion 是候选复制和重新治理，**不是**修改原记忆 scope：

```text
private/user evidence
  -> generalized project candidate
  -> cross-principal team validation
  -> organization capability candidate
  -> owner/policy approval
```

推广时只携带允许共享的归一化模式、脱敏参数和可验证评测；private Evidence、原始对话和个人画像保持原 scope。默认最低门槛由 `LearningObjective.minimumEvidence` 指定，team/org 候选**必须**包含多个 distinct principals 或明确的 owner demonstration，并在不同 environment fingerprint 上验证。单个用户重复成功**不能**自动成为组织事实或组织 Skill。

## L. 持久化、任务与事件

新增表**必须**通过 migration 创建：

```sql
CREATE TABLE learning_objectives (
  id                    TEXT PRIMARY KEY,
  owner_user_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope                 TEXT NOT NULL CHECK (scope IN ('user','project','team','organization')),
  scope_id              TEXT NOT NULL,
  goal_ids_json         TEXT NOT NULL DEFAULT '[]',
  metric_version        TEXT NOT NULL,
  weights_json          TEXT NOT NULL,
  minimum_evidence_json TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('draft','active','paused','retired')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX idx_learning_objectives_active
ON learning_objectives (scope, scope_id, status);

CREATE TABLE learning_signals (
  id                   TEXT PRIMARY KEY,
  execution_run_id     TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN (
                         'task_outcome','user_correction','memory_used','skill_followed',
                         'constraint_applied','failure','cost','latency','policy_event'
                       )),
  source               TEXT NOT NULL CHECK (source IN ('deterministic','user','tool_verified','model_judged')),
  value_json           TEXT NOT NULL,
  evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
  signal_version       TEXT NOT NULL,
  created_at           INTEGER NOT NULL
);

CREATE INDEX idx_learning_signals_execution
ON learning_signals (execution_run_id, kind, created_at);
```

```sql
CREATE TABLE learning_decisions (
  id                   TEXT PRIMARY KEY,
  operation_id         TEXT NOT NULL UNIQUE,
  user_id              TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  objective_ids_json   TEXT NOT NULL,
  signal_ids_json      TEXT NOT NULL,
  candidate_ids_json   TEXT NOT NULL,
  action               TEXT NOT NULL,
  reason_codes_json    TEXT NOT NULL,
  policy_version       TEXT NOT NULL,
  governor_version     TEXT NOT NULL,
  budget_json          TEXT NOT NULL,
  requires_human       INTEGER NOT NULL CHECK (requires_human IN (0,1)),
  input_hash           TEXT NOT NULL,
  created_at           INTEGER NOT NULL
);

CREATE INDEX idx_learning_decisions_user
ON learning_decisions (user_id, created_at);

CREATE TABLE compression_manifests (
  id                   TEXT PRIMARY KEY,
  owner_user_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope                TEXT NOT NULL CHECK (scope IN ('global','bot','project','team','agent')),
  scope_id             TEXT,
  kind                 TEXT NOT NULL,
  source_ids_json      TEXT NOT NULL,
  output_ids_json      TEXT NOT NULL,
  compiler_version     TEXT NOT NULL,
  input_hash           TEXT NOT NULL,
  metrics_json         TEXT NOT NULL,
  rollback_artifact    TEXT NOT NULL,
  status               TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  CHECK (
    (scope = 'global' AND scope_id IS NULL) OR
    (scope != 'global' AND scope_id IS NOT NULL)
  )
);

CREATE INDEX idx_compression_manifests_scope
ON compression_manifests (owner_user_id, scope, scope_id, status, updated_at);
```

`compression_manifests.scope/scope_id` 是 legacy storage encoding，不是公共契约：`global` 必须映射为 `ScopeRef{kind:"user", id:owner_user_id}`，其他值由 `scope_id` 还原。manifest 进入 compiler、event、Policy 或 API 前必须携带完整 `ScopeRef`；不同 `tenantId/owner/audience/purposes` 即使 storage alias 相同也禁止合并。

```sql
CREATE TABLE memory_goal_links (
  unit_id              TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,
  goal_unit_id         TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,
  relation             TEXT NOT NULL CHECK (relation IN (
                         'supports','blocks','risk_to','prerequisite_for','produced_by'
                       )),
  confidence           REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_id          TEXT REFERENCES memory_evidence(id) ON DELETE SET NULL,
  projector_version    TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (unit_id, goal_unit_id, relation, projector_version)
);

CREATE TABLE capability_edges (
  from_kind            TEXT NOT NULL CHECK (from_kind IN ('claim','procedure','skill','capability','goal')),
  from_id              TEXT NOT NULL,
  to_kind              TEXT NOT NULL CHECK (to_kind IN ('claim','procedure','skill','capability','goal')),
  to_id                TEXT NOT NULL,
  edge_type            TEXT NOT NULL CHECK (edge_type IN ('requires','composes','validates','supersedes')),
  source_ids_json      TEXT NOT NULL,
  projector_version    TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (from_kind, from_id, to_kind, to_id, edge_type, projector_version)
);
```

所有 `*_json` 写入前**必须**通过版本化 schema 校验并使用 canonical JSON 计算 input/event hash。`memory_goal_links.goal_unit_id` 在 Service 层**必须**验证为 prospective Goal；`capability_edges` 因为连接 Memory 与 Capability Registry 的多种 id 不建立单表外键，但 materializer **必须**验证端点存在、scope 可读且 source ids 可追溯，否则不发布该 edge。`rollback_artifact` 是加密 content-addressed artifact ref，**不**保存明文快照路径。

`memory_jobs.type` **必须**扩展为 `evaluate | consolidate | replay | revalidate | promote`，继续使用 operation id、lease、重试、dead-letter 和加密 TTL payload。新增事件至少包括：`learning.signal_recorded`、`learning.decision_made`、`learning.question_requested`、`learning.evaluation_completed`、`memory.consolidation_started`、`memory.compression_published`、`memory.projection_invalidated`、`memory.tier_changed`、`capability.promotion_proposed`、`capability.promotion_rejected` 和 `capability.rollback`。

## M. Feature Flags 与降级

```text
memory.autoWrite            default=false until Phase 2 exit criteria pass
memory.autoActivateLowRisk default=false until category policy is calibrated
memory.autoConsolidate      default=false until compression replay passes
memory.activeLearning       default=false until question budget/UX passes
memory.causalAttribution    default=shadow
memory.scopePromotion       default=proposal_only
memory.parametricPromotion  default=experimental
```

关闭任一智能能力**必须**回到稳定的 Claim/Evidence + FTS/required baseline，**不得**破坏读取、显式 pin/correct/forget/purge 或主任务执行。Feature flag 只控制启用，不代表缺失功能已经交付。

## N. 智能闭环验收标准

> 本节是智能闭环的**完整验收清单**；模块级 4 条核心门槛见正文 [10. 验收标准](#10-验收标准)。

- 100% execution 产生可关联的最小 outcome signal，`incognito/no_write` 只保留允许的脱敏运行指标。
- 自动抽取和自动压缩均在用户回复后异步执行；同步路径仅 durable enqueue。
- 重复闲聊不会持续增长长期记忆；明确稳定偏好可在一个后台周期内生效。
- 用户纠正后，旧 Claim 不再无提示注入；受影响 Profile、summary、Skill 和 graph projection 自动失效或重编。
- 压缩前后 source coverage=1.0、purge 可达性不下降、任务成功不回退、stale-memory error 不上升，并达到配置的 token reduction。
- 系统能在固定 fixture 中正确选择 proceed/search/verify/ask/proceed_cautiously，且不会重复询问同一低价值问题。
- memory retrieved **不能**自动计为 useful；只有确定性、用户、工具或版本化评测归因才能更新 utility。
- team/org promotion 不携带 private Evidence，且未通过跨主体/跨环境门槛时保持 proposal。
- 任一候选策略、压缩器、排序器或 Governor 回归时可关闭 flag 并恢复稳定 baseline；所有 active 产物可追溯和回滚。

## O. 可验证 Skill IR

Skill 的事实源不再是自然语言 `steps_json`，而是版本化、可验证和可回滚的 Skill IR。自然语言 `<steps>` 仅是 Context Compiler 生成的显示投影。

```typescript
type SkillIR = {
  id: string;
  version: number;
  trigger: IntentMatcher;
  preconditions: Assertion[];
  parameters: TypedSlot[];
  steps: SkillStep[];
  postconditions: Assertion[];
  rollbackSteps: SkillStep[];
  invariants: Assertion[];
  requiredCapabilities: string[];
  riskClass: "low" | "medium" | "high" | "critical";
  environmentFingerprint: EnvironmentConstraint[];
  evidenceEpisodeIds: string[];
};

type SkillStep =
  | { type: "tool"; tool: string; argsTemplate: object }
  | { type: "assert"; assertion: Assertion }
  | { type: "branch"; condition: Assertion; then: SkillStep[]; else: SkillStep[] }
  | { type: "confirm"; risk: string }
  | { type: "checkpoint"; rollbackTo: string };
```

Skill 升级流水线固定为：candidate mining → 参数归一 → LLM 生成 IR → schema 校验 → episode trace alignment → 静态风险分析 → sandbox replay → shadow invocation → validated → active。任何一步失败都**不能**通过提高 confidence 绕过。环境指纹变化、工具 major version 变化或失败率越界时自动降为 `needs_revalidation`。

## P. Profile AST 与增量编译

Profile Compiler 输出结构化 AST，不直接生成不可追踪的整段画像：

```typescript
type ProfileAst = {
  communication: ProfileField[];
  identity: ProfileField[];
  domain: ProfileField[];
  relationships: ProfileField[];
  safety: ProfileField[];
  projects: ProfileField[];
};

type ProfileField = {
  claimIds: string[];
  normalizedValue: unknown;
  sensitivity: "public" | "private" | "sensitive";
  allowedAudiences: string[];
};
```

确定性 renderer 将 AST 编译成 prompt block；没有 `claimIds` 的字段**不得**进入 Snapshot。Claim 更新、撤回或 audience policy 变化时只重编受影响 section，并通过 dependency index 失效旧 snapshot。

## Q. 事件触发 DSL

Prospective Memory 使用受限 Event Pattern DSL，**禁止**存任意脚本：

```typescript
type EventPattern =
  | { type: "execution_started"; projectId?: string }
  | { type: "intent_detected"; intentKey: string }
  | { type: "tool_before"; tool: string; action?: string }
  | { type: "time"; schedule: string; timezone: string }
  | { type: "entity_mentioned"; entityId: string }
  | { type: "state_changed"; claimKey: string };
```

Constraint 增加 `overridability = overridable | confirmation_required | non_overridable`；这里只描述用户/项目约束，system safety policy 始终在其上。Negative Memory **必须**绑定 environment fingerprint、failure signature、error class 和适用前置条件，单次失败**不能**泛化成全局禁用规则。

## R. Event Hypergraph 逻辑投影

Temporal Event Hypergraph 是本产品在 `TemporalGraphProjection` 上定义的逻辑视图，不要求实现自有图数据库、图查询语言、entity linker 或时序图算法。它是可删除、可重建、版本化的物化投影，**不是**真相源。每个 node/edge 保存 `source_unit_ids/source_evidence_ids/extractor_version/resolution_version/authority_cap/index_generation`。删除或撤回 Evidence 时，相关边进入 invalid 状态并由后台 job 重建。

默认**不**自行重写完整的时序图抽取、entity linking、双时态 invalidation 和图遍历引擎。`TemporalGraphProjection` 优先接入 Graphiti-compatible adapter，复用其 Episode provenance、validity window、增量构图、prescribed/learned ontology 和 hybrid graph retrieval；可选择 Neo4j、FalkorDB、Neptune 或后续兼容 backend。Graphiti/Zep 的 episode、entity、edge id 只作为 projection id，**必须**映射回本项目 Claim/Evidence id。`local` profile 未启用图引擎时使用 SQLite temporal/alias 查询作为降级，**不**在本地重新实现一个功能不完整的 Graphiti 克隆。

实体消解顺序固定为：确定性 key → 同 scope 用户 alias → 模型 resolution candidate。模型候选低于阈值或存在多个匹配时**不能**自动 merge。图查询使用预算化 path search：默认 maxDepth=2、maxNodes=40、maxEdges=60、maxPaths=10；每条可注入路径**必须**回源 active Claim/Evidence。

## S. 分级 Memory Utility 与反事实采样

Utility 不再压成单一模型判断，拆成：`retrieval_utility/answer_contribution/action_contribution/harm_score/token_cost/correction_rate`。

1. 每轮使用确定性信号：tool 参数引用、唯一事实值、constraint compliance、Skill id、用户纠正。
2. 歧义批次使用廉价 Judge，输出 supported/redundant/unused/contradicted/harmful；只能小幅更新 utility，**不能**提高事实 confidence。
3. 对新 active、高频注入、被纠正、高风险约束和候选 ranking 做离线 counterfactual：A 使用原上下文，B 移除单条或一组记忆，再由固定 judge 比较。
4. Shadow ranking 长期比较任务成功、用户纠正、重复提问、token 成本和 stale-memory error。

反事实**必须**异步、采样、缓存且受每日预算限制，**禁止**为每次回答全量双跑。

## T. 分级 Parametric Promotion

> 概述见 [06-memory.md R 节](06-memory.md#r-shadow-memory完整性与可逆-parametric-promotion)；本节为四级分级的权威全量规范。

Parametric Promotion 按可逆性分级：

1. **Compiled Rule**：确定性语言、格式、路由和约束规则。
2. **Local Classifier**：intent、memory type、risk、retrieval route 分类器。
3. **Prompt/Context Adapter**：版本化 renderer、system fragment、tool preference adapter。
4. **Model Adapter/LoRA**：仅显式 opt-in、固定 base model、足够脱敏样本、独立评测和可删除 artifact 时启用。

前三级是默认生产路径；第四级保持实验状态，但功能不删除。所有编译产物写 registry，包含 source Claim/Evidence、base model、compiler version、eval report、status 和 rollback artifact。来源撤回或评测回退时自动失效。

## U. 长期 Memory Simulation Harness

除单元和检索黄金集外，**必须**建立可重复的长期仿真：虚拟用户跨月会话、偏好变化、项目切换、事实纠正、恶意网页、Skill 成功/失败、成员加入/移除、删除/purge 和设备离线冲突。

仿真输出至少包括 memory growth、duplicate rate、contradiction rate、profile drift、authority laundering、stale-memory error、unsupported personalization、Skill degradation、purge completeness、task success 和 token cost。所有 learned ranking、Policy 变更、Skill 自动 active、复制协议和 parametric promotion 均**必须**通过对应仿真门槛。
