# L0 契约清单（Contracts）

> 定位：`core/contracts/` 是**零依赖**层，只放接口与类型。所有模块只 import 这里，**禁止** import 兄弟模块实现。这是"低耦合"的根。
> 铁律：契约必须 provider agnostic；跨进程执行处必须可序列化。供应商 id / SDK 类型 / 存储 schema **禁止**成为公共契约或权威外键。

契约完成的判据不是“已有接口名”，而是同时具备：版本化 TypeScript 类型、跨进程 JSON Schema、错误与取消语义、兼容策略、contract fixture 和至少两个实现之间的替换测试。没有满足这些条件的条目只能标记为 `draft`，不得被上层当成稳定 Port。

## 1. 运行时核心契约

| 契约 | 职责 | 谁产生 | 谁消费 |
|---|---|---|---|
| `PrincipalRef` | user/service/agent/team/organization 的 canonical 主体引用 | Identity/Orchestration | 全层 |
| `ScopeRef` | tenant 内的 owner/resource/audience/purpose 边界 | Orchestration | 全层 |
| `ExecutionContext` | identity/org/project/session/provider 约束/policy/trace | Orchestration | 全层 |
| `RuntimeRequest` | intent + 输入 + 请求能力 | Surfaces | Orchestration/Kernel |
| `RuntimeEvent` | append-only 生命周期证据 | 各层发射 | Learning/审计 |
| `CapabilityDescriptor` | id/version/permissions/configSchema/health/lifecycle | Adapters | Registry/Policy |
| `CapabilityInvocation` | 带幂等与 policy 上下文的能力调用 | Kernel | Capabilities |
| `PolicyDecision` | `allow/deny/require_confirmation/constrain` | Policy | Kernel/Memory |
| `OrganizationPolicySnapshot` | 组织/环境当前生效策略、配额、驻留与保留约束 | Enterprise Control Plane | Orchestration/Policy/Kernel |

### 1.1 Canonical identity、scope、policy 与 event

```typescript
type PrincipalKind = "user" | "service" | "agent" | "team" | "organization";

type PrincipalRef = {
  tenantId: string;
  kind: PrincipalKind;
  id: string;
};

type ScopeKind = "user" | "bot" | "agent" | "project" | "team" | "organization";

type ScopeRef = {
  tenantId: string;
  kind: ScopeKind;
  id: string;
  owner: PrincipalRef;
  audience: "private" | "delegated" | "shared";
  purposes: string[];
};

type PolicyEffect = "allow" | "deny" | "require_confirmation" | "constrain";

type PolicyDecision = {
  schemaVersion: 1;
  decisionId: string;
  effect: PolicyEffect;
  policyVersion: string;
  matchedRuleIds: string[];
  constraints: Record<string, unknown>;
  expiresAt?: number;
};

type RuntimeEvent<TType extends RuntimeEventType = RuntimeEventType> = {
  schemaVersion: 1;
  eventId: string;
  eventType: TType;
  eventVersion: number;
  operationId: string;
  executionId?: string;
  correlationId: string;
  causationEventId?: string;
  sequence: number;
  idempotencyKey: string;
  occurredAt: number;
  producer: string;
  actor: PrincipalRef;
  scope: ScopeRef;
  trace: TraceContext;
  payload: RuntimeEventPayloadByType[TType];
};
```

`global`、`bot`、`project` 等旧存储枚举只能作为 migration/storage alias：`global` 映射为当前 account 的 `ScopeRef{kind:"user"}`。L0、跨进程事件和新公共 API **禁止**继续传裸 scope 字符串。`RuntimeEvent.payload` 必须由 `eventType + eventVersion` 选择版本化 schema；同一 `operationId` 内 `sequence` 单调递增，`eventId/idempotencyKey` 全局稳定。execution 事件必须填写 `executionId`，admin/export/backup 等非 execution operation 可省略；`correlationId` 连接跨 operation workflow，`causationEventId` 指向直接原因。payload 禁止包含 secret、raw prompt、raw Evidence 正文或供应商 SDK 对象。

### 1.2 Enterprise policy snapshot

```typescript
type OrganizationPolicySnapshot = {
  schemaVersion: 1;
  snapshotId: string;
  tenantId: string;
  organizationId: string;
  environment: "development" | "staging" | "production";
  revision: number;
  policyBundleVersion: string;
  effectiveFrom: number;
  effectiveUntil?: number;
  residency: {
    allowedRegions: string[];
    crossRegionTransfer: "deny" | "policy_approved";
  };
  retention: {
    defaultTtlDays?: number;
    maximumTtlDays?: number;
    legalHoldIds: string[];
  };
  quotas: {
    period: "day" | "month";
    tokenLimit?: number;
    costLimitMinorUnits?: number;
    concurrencyLimit?: number;
    currency?: string;
  };
  allowedCapabilityIds: string[];
  deniedCapabilityIds: string[];
  rulesHash: string;
  approvedBy: PrincipalRef[];
  issuedAt: number;
};
```

`OrganizationPolicySnapshot` 是不可变、可缓存的生效视图，不是策略编辑模型。每个 execution 绑定一个 `snapshotId + policyBundleVersion`；过期或缺失 snapshot 时，读取类低风险操作可按明确的 bounded cache policy 继续，新的高影响执行、权限授予、scope promotion 与控制面写入必须 fail-closed。发布或回滚均创建新 revision，禁止原地覆盖历史 snapshot。

### 1.3 Enterprise resource 与 admin mutation

```typescript
type ResourceMetadata = {
  id: string;
  tenantId: string;
  revision: number;
  createdAt: number;
  createdBy: PrincipalRef;
  updatedAt: number;
  updatedBy: PrincipalRef;
};

type OrganizationResource = ResourceMetadata & {
  resourceType: "organization";
  displayName: string;
  status: "provisioning" | "active" | "suspended" | "deleting" | "deleted";
  defaultEnvironmentId: string;
  residencyPolicyId: string;
};

type EnvironmentResource = ResourceMetadata & {
  resourceType: "environment";
  organizationId: string;
  name: string;
  kind: "development" | "staging" | "production";
  region: string;
  isolationProfileId: string;
  status: "active" | "frozen" | "deleting" | "deleted";
};

type RoleBinding = ResourceMetadata & {
  resourceType: "role_binding";
  organizationId: string;
  environmentId?: string;
  principal: PrincipalRef;
  roleId: string;
  permissions: string[];
  scope: ScopeRef;
  validFrom: number;
  validUntil?: number;
  status: "pending" | "active" | "suspended" | "revoked";
};

type PolicyBundleRevision = ResourceMetadata & {
  resourceType: "policy_bundle_revision";
  organizationId: string;
  environmentId: string;
  bundleId: string;
  parentRevisionId?: string;
  status: "draft" | "validated" | "pending_approval" | "approved" | "canary" | "active" | "superseded" | "rejected";
  rulesHash: string;
  schemaVersion: number;
  validationReportRef?: string;
  rollout: { mode: "none" | "target_set" | "percentage"; targetIds: string[]; percentage?: number };
};

type ApprovalRequest = ResourceMetadata & {
  resourceType: "approval_request";
  organizationId: string;
  environmentId: string;
  targetType: "policy_revision" | "plugin_activation" | "scope_promotion" | "legal_hold" | "break_glass";
  targetId: string;
  requestedEffect: "publish" | "activate" | "promote" | "apply" | "release" | "grant_temporary_access";
  reason: string;
  requiredApprovals: number;
  approverRoleIds: string[];
  decisions: Array<{ principal: PrincipalRef; decision: "approve" | "reject"; reason: string; decidedAt: number }>;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  expiresAt: number;
};

type QuotaPolicy = ResourceMetadata & {
  resourceType: "quota_policy";
  scope: ScopeRef;
  period: "minute" | "hour" | "day" | "month";
  requestLimit?: number;
  tokenLimit?: number;
  costLimitMinorUnits?: number;
  concurrencyLimit?: number;
  currency?: string;
  enforcement: "warn" | "throttle" | "deny";
};

type LegalHold = ResourceMetadata & {
  resourceType: "legal_hold";
  organizationId: string;
  scopes: ScopeRef[];
  reason: string;
  authorityRef: string;
  status: "pending" | "active" | "released";
  effectiveFrom: number;
  releasedAt?: number;
  releasedBy?: PrincipalRef;
};

type AdminAction =
  | "organization.create" | "organization.suspend" | "organization.delete"
  | "environment.create" | "environment.freeze" | "environment.delete"
  | "role_binding.create" | "role_binding.revoke"
  | "policy.validate" | "policy.request_approval" | "policy.rollout" | "policy.rollback"
  | "plugin.approve" | "plugin.activate" | "plugin.drain" | "plugin.disable" | "plugin.remove"
  | "quota.publish" | "legal_hold.apply" | "legal_hold.release"
  | "audit.export" | "backup.start" | "restore.start" | "break_glass.request";

type AdminMutationPayloadByAction = {
  "organization.create": { displayName: string; defaultRegion: string };
  "organization.suspend": { organizationId: string };
  "organization.delete": { organizationId: string; exportOperationId?: string };
  "environment.create": { organizationId: string; name: string; kind: EnvironmentResource["kind"]; region: string; isolationProfileId: string };
  "environment.freeze": { environmentId: string };
  "environment.delete": { environmentId: string; exportOperationId?: string };
  "role_binding.create": { principal: PrincipalRef; roleId: string; permissions: string[]; scope: ScopeRef; validUntil?: number };
  "role_binding.revoke": { roleBindingId: string };
  "policy.validate": { policyRevisionId: string };
  "policy.request_approval": { policyRevisionId: string; requiredApprovals: number; approverRoleIds: string[]; expiresAt: number };
  "policy.rollout": { policyRevisionId: string; rollout: PolicyBundleRevision["rollout"] };
  "policy.rollback": { activePolicyRevisionId: string; restorePolicyRevisionId: string };
  "plugin.approve": { capabilityId: string; version: string; riskEvidenceRefs: string[] };
  "plugin.activate": { capabilityId: string; version: string; environmentId: string };
  "plugin.drain": { capabilityId: string; version: string; deadlineAt: number };
  "plugin.disable": { capabilityId: string; version: string };
  "plugin.remove": { capabilityId: string; version: string; exportOperationId?: string };
  "quota.publish": { quotaPolicy: Omit<QuotaPolicy, keyof ResourceMetadata | "resourceType"> };
  "legal_hold.apply": { scopes: ScopeRef[]; reason: string; authorityRef: string; effectiveFrom: number };
  "legal_hold.release": { legalHoldId: string; authorityRef: string };
  "audit.export": { query: AuditQuery; format: "jsonl" | "csv"; recipientKeyRef: string };
  "backup.start": { environmentId: string; backupProfileId: string };
  "restore.start": { environmentId: string; backupId: string; validationProfileId: string };
  "break_glass.request": { environmentId: string; requestedPermissions: string[]; expiresAt: number };
};

type AdminMutation<TAction extends AdminAction = AdminAction> = {
  schemaVersion: 1;
  mutationId: string;
  action: TAction;
  requester: PrincipalRef;
  scope: ScopeRef;
  policySnapshotId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  reason: string;
  approvalRequestId?: string;
  payload: AdminMutationPayloadByAction[TAction];
  payloadHash: string;
  trace: TraceContext;
  requestedAt: number;
};
```

所有 admin write 使用 optimistic revision check；`expectedRevision` 不匹配返回 `revision_conflict`，不得 last-write-wins。删除先进入 `deleting`，完成 dependency、legal hold、export、purge 与 audit 检查后才进入 `deleted`。`ApprovalRequest` 的 requester 不能计入自己的审批 quorum，审批决定 append-only，过期后禁止复用。

资源所有权固定如下，Enterprise Control Plane 只编排，不复制权威状态：

| Resource | 唯一语义所有者 | 持久化机制 |
|---|---|---|
| `OrganizationResource` / `EnvironmentResource` | Control Plane Resource Service | Storage Port |
| external identity / membership | `IdentityDirectoryPort` provider；Orchestration 只做 canonical binding | Directory adapter + binding ledger |
| `RoleBinding` | Policy administration；Identity Directory 只提供 membership evidence | Policy revision store |
| `PolicyBundleRevision` / `QuotaPolicy` | Policy | immutable revision store |
| `ApprovalRequest` / `AdminMutation` | Control Plane Governance Service | append-only operation/event store |
| `LegalHold` | Security/Compliance authority | immutable hold record + audit |

`OrganizationResource.status=suspended` 禁止新 execution/admin grant，但不自动删除数据；`EnvironmentResource.status=frozen` 禁止 mutation 和新 execution，只保留授权 read/export/recovery。`deniedCapabilityIds` 优先于 `allowedCapabilityIds`；quota 多层命中时取最严格限制，任何宽 scope 规则不能重新开启窄 scope 显式 deny。

### 1.4 Runtime event catalog 与 error model

`RuntimeEvent.eventType` 是 closed catalog；新增类型或改变 payload 必须增加 `eventVersion`，禁止用自由字符串绕过 schema registry。

```typescript
type RuntimeEventType =
  | "execution.accepted" | "execution.started" | "execution.completed" | "execution.failed" | "execution.cancelled"
  | "capability.resolved" | "capability.invocation_started" | "capability.invocation_completed" | "capability.invocation_failed"
  | "workflow.started" | "workflow.checkpointed" | "workflow.waiting" | "workflow.compensating" | "workflow.completed" | "workflow.failed"
  | "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled"
  | "agent.started" | "agent.event" | "agent.completed" | "agent.failed" | "agent.cancelled"
  | "transport.request_started" | "transport.response_started" | "transport.completed" | "transport.failed"
  | "usage.recorded" | "usage.reconciled"
  | "memory.candidate_created" | "memory.claim_activated" | "memory.claim_superseded" | "memory.purged"
  | "learning.decision_recorded" | "learning.evaluation_recorded" | "learning.promotion_recorded" | "learning.rollback_recorded"
  | "policy.decision_recorded" | "security.confirmation_requested" | "security.capability_issued" | "security.capability_revoked"
  | "admin.mutation_requested" | "admin.mutation_completed" | "admin.mutation_failed"
  | "audit.export_requested" | "audit.export_completed" | "audit.export_failed";

type RuntimeEventPayloadByType = {
  "execution.accepted": { requestHash: string; policySnapshotId: string; directoryRevision: string };
  "execution.started": { startedAt: number; requestedCapabilityIds: string[] };
  "execution.completed": { outcome: "success"; resultHash: string; finishedAt: number };
  "execution.failed": { error: RuntimeError; finishedAt: number };
  "execution.cancelled": { reason: string; cancelledBy: PrincipalRef; finishedAt: number };
  "capability.resolved": { capabilityId: string; version: string; adapterId: string };
  "capability.invocation_started": { invocationId: string; capabilityId: string; inputHash: string };
  "capability.invocation_completed": { invocationId: string; outputHash: string };
  "capability.invocation_failed": { invocationId: string; error: RuntimeError };
  "workflow.started": { workflowId: string; runId: string; definitionVersion: string };
  "workflow.checkpointed": { runId: string; checkpointId: string; stateHash: string };
  "workflow.waiting": { runId: string; waitType: "signal" | "confirmation" | "timer"; waitKey: string };
  "workflow.compensating": { runId: string; stepId: string; compensationId: string };
  "workflow.completed": { runId: string; outputHash: string };
  "workflow.failed": { runId: string; failedStepId?: string; error: RuntimeError };
  "tool.started": { invocationId: string; toolId: string; sideEffect: SideEffectClass };
  "tool.completed": { invocationId: string; resultHash: string; sideEffectCommitted: boolean };
  "tool.failed": { invocationId: string; error: RuntimeError; sideEffectCommitted: boolean };
  "tool.cancelled": { invocationId: string; reason: string; sideEffectCommitted: boolean };
  "agent.started": { runId: string; agentId: string; adapterId: string };
  "agent.event": { runId: string; agentSequence: number; eventKind: AgentRunEvent["kind"]; eventHash: string };
  "agent.completed": { runId: string; resultHash: string };
  "agent.failed": { runId: string; error: RuntimeError };
  "agent.cancelled": { runId: string; reason: string };
  "transport.request_started": { requestId: string; attemptId: string; routeLeaseId: string };
  "transport.response_started": { requestId: string; attemptId: string; statusCode: number };
  "transport.completed": { requestId: string; attemptId: string; responseHash: string };
  "transport.failed": { requestId: string; attemptId: string; error: RuntimeError };
  "usage.recorded": { attemptId: string; usageRecordId: string; ledgerSequence: number };
  "usage.reconciled": { attemptId: string; usageRecordId: string; reconciliationReason: string };
  "memory.candidate_created": { candidateId: string; category: string; sourceEvidenceIds: string[] };
  "memory.claim_activated": { claimId: string; evidenceIds: string[]; decisionId: string };
  "memory.claim_superseded": { claimId: string; supersededByClaimId: string; decisionId: string };
  "memory.purged": { operationId: string; tombstoneId: string; completionEvidenceRef: string };
  "learning.decision_recorded": { learningDecisionId: string; objectiveId: string; action: string };
  "learning.evaluation_recorded": { evaluationId: string; candidateId: string; resultHash: string };
  "learning.promotion_recorded": { candidateId: string; artifactId: string; decisionId: string };
  "learning.rollback_recorded": { artifactId: string; rollbackArtifactRef: string; decisionId: string };
  "policy.decision_recorded": { decision: PolicyDecision; inputHash: string };
  "security.confirmation_requested": { confirmationId: string; actionHash: string; expiresAt: number };
  "security.capability_issued": { capabilityHandleId: string; caveatHash: string; expiresAt: number };
  "security.capability_revoked": { capabilityHandleId: string; reason: string };
  "admin.mutation_requested": { mutationId: string; action: AdminAction; payloadHash: string };
  "admin.mutation_completed": { mutationId: string; resourceId: string; resultingRevision: number };
  "admin.mutation_failed": { mutationId: string; error: RuntimeError };
  "audit.export_requested": { operationId: string; queryHash: string };
  "audit.export_completed": { operationId: string; artifactHash: string; integrityCheckpoint: string };
  "audit.export_failed": { operationId: string; error: RuntimeError };
};

type RuntimeErrorCode =
  | "invalid_request" | "unsupported_contract_version" | "schema_validation_failed"
  | "identity_unresolved" | "membership_inactive" | "scope_denied" | "tenant_isolation_failed"
  | "policy_unavailable" | "policy_denied" | "confirmation_required" | "confirmation_expired"
  | "capability_not_found" | "capability_inactive" | "capability_version_conflict" | "capability_revoked"
  | "quota_exceeded" | "rate_limited" | "deadline_exceeded" | "cancelled"
  | "revision_conflict" | "idempotency_conflict" | "dependency_conflict"
  | "provider_unavailable" | "protocol_incompatible" | "transport_failed"
  | "tool_failed" | "workflow_failed" | "compensation_failed" | "agent_failed"
  | "storage_unavailable" | "integrity_failed" | "legal_hold_blocked" | "residency_blocked"
  | "secret_unavailable" | "redaction_failed" | "audit_unavailable" | "internal_error";

type RuntimeError = {
  schemaVersion: 1;
  code: RuntimeErrorCode;
  message: string;
  retry: "never" | "same_attempt" | "new_attempt" | "after_confirmation" | "after_operator_action";
  safeDetails: Record<string, string | number | boolean>;
  causeEventId?: string;
  traceId: string;
};
```

`safeDetails` 使用按 error code 注册的 allowlist，禁止保存 raw prompt、tool args/output、secret、authorization 或供应商原始 body。`same_attempt` 只允许未产生外部副作用的瞬时操作；已进入 `sideEffectCommitted=true` 的调用禁止自动重试。`internal_error` 不得向用户暴露 stack，完整诊断只进入脱敏受限日志。

Event ordering 与 terminal invariant：

- `execution.accepted` 最多一次，之后是 `execution.started`，最终只能有一个 `execution.completed|failed|cancelled`。
- capability/tool/agent/transport invocation 的 `*_started` 最多一次且恰有一个 terminal；Workflow 可多次 checkpoint/wait/compensate，但 `completed|failed` 只能一个。
- provider/worker replay 使用相同 `eventId/idempotencyKey`，consumer 必须去重；reconciliation 产生新的 `*.reconciled` 或纠正事件，不删除旧事件。
- producer 必须使用 schema registry 验证 `(eventType,eventVersion,payload)` 后再 append；unknown future version 可隔离/透传到兼容存储，但禁止 materialize 为权威状态。
- `RuntimeError.retry` 是 owner decision 的输入，不是自动重试命令；Kernel/Workflow/Transport 中只能有一个明确 retry owner。

## 2. 学习与治理契约

| 契约 | 职责 |
|---|---|
| `LearningObjective` | 版本化能力目标、scope、度量、硬安全回归、最小证据 |
| `LearningSignal` | 归一化执行结果/纠错/复用/失败/成本/延迟 |
| `LearningDecision` | 确定性：no artifact / extract / verify / ask / consolidate / evaluate / promote / rollback |
| `LearningCandidate` | 提议的知识/技能/工作流 + 证据 |
| `EvaluationResult` | 确定性 + 模型辅助质量证据 |
| `UncertaintyAssessment` | 事实/检索/冲突/时序/适用性/策略/目标不确定性 + 下一步 |
| `CapabilityGain` | baseline vs candidate + 样本数 + 硬回归 |
| `CompressionManifest` | 源证据 → 编译投影的可逆映射 |

## 3. 传输契约

| 契约 | 职责 |
|---|---|
| `TransportRouteLease` | 执行绑定的 listener route/upstream/engine/owner/expiry/连接预算 |
| `TransportExtension` | 有界观测或声明式 patch 贡献者，**禁止**拥有 listener 或转发请求 |
| `TransportTransformManifest` | 有序兼容+扩展 patch，带 allowed paths、before/after hash、rollback |
| `SanitizedTurnEnvelope` | 单回合可持久化证据：allowlist 元数据+hash+加密 TTL 引用，**禁**原始 header/prompt |
| `SanitizedExecutionEnvelope` | 执行级聚合，引用多个 turn envelope，不复制原始传输内容 |

## 4. 可替换能力与后端契约（Ports，各由 Adapter 实现）

| 契约 | 可插拔点 | 本地实现 | 企业实现 |
|---|---|---|---|
| `ModelProviderPort` | 模型生成/流式/tool-call 协议 | 本地/CLI adapter | 托管模型 provider |
| `ToolPort` | 类型化工具调用与结果 | 本地工具/MCP | 企业工具目录 |
| `WorkflowExecutorPort` | 可恢复 workflow 执行 | 内置执行器 | LangGraph/企业编排器 |
| `AgentAdapterPort` | Agent runtime 适配，不拥有权限 | `ClaudeCodeCliAgentAdapter` / `CodexCliAgentAdapter` | 企业 Agent runtime |
| `CandidateExtractor` | 记忆抽取 | 内置 | Mem0 风格 |
| `RetrievalBackend` | 词法/语义/实体/时序检索 | SQLite FTS5 | Postgres/OpenSearch |
| `VectorRetrievalBackend` | 向量召回 | sqlite-vec | pgvector/Qdrant |
| `TemporalGraphProjection` | 时序图投影（可重建） | 时序 SQL | Graphiti 兼容 |
| `WorkflowCheckpointBackend` | thread 级 checkpoint | 本地 | LangGraph 风格 |
| `DurableJobBackend` | operation-id/lease/retry/dead-letter | SQLite 队列 | 成熟 MQ |
| `ProtectedPayloadCodec` | 审计加密 + 密钥管理 | OS SecretStore | KMS/HSM |
| `ObjectStore` | artifact/大对象的版本化读写与 purge | 本地 content-addressed store | S3 兼容对象存储 |
| `SecretStore` | secret ref 的 get/set/delete/rotate | Keychain/libsecret/DPAPI | KMS/HSM/Vault |
| `AuditSink` | append-only 脱敏审计事件 | 本地签名日志 | 企业不可变审计存储 |
| `ObservabilitySinkPort` / `ObservabilityQueryPort` | 非权威 trace/metric/log 投影与授权查询 | JSONL + OTel file/console | OTLP/APM/可观测平台 |
| `IdentityDirectoryPort` | identity federation、membership 与 delegated role 查询 | 本地账号目录 | OIDC/SAML + SCIM/企业目录 |
| `AuditQueryPort` | 按 scope/time/type/actor 查询与导出审计证据 | 本地签名日志索引 | SIEM/不可变审计仓 |
| `MeteringExportPort` | 从 UsageObserver 权威账本导出 attribution/showback 数据 | JSON/CSV exporter | FinOps/billing exporter |
| `ProcedureMiner` | Skill 候选挖掘（PrefixSpan） | 内置 | 外部序列挖掘 |
| `PolicyEngine` | 确定性无副作用求值 | 内置规则 | OPA/Cedar |
| `EvaluationHarness` | 版本化评测 | 本地基准 | 企业评测集 |

### 4.1 Enterprise control-plane Ports

```typescript
type DirectoryMembership = {
  schemaVersion: 1;
  membershipId: string;
  principal: PrincipalRef;
  organizationId: string;
  projectIds: string[];
  roleIds: string[];
  status: "active" | "suspended" | "removed";
  validFrom: number;
  validUntil?: number;
  directoryRevision: string;
};

interface IdentityDirectoryPort {
  resolvePrincipal(input: {
    tenantId: string;
    issuer: string;
    subject: string;
  }): Promise<PrincipalRef | null>;
  getMemberships(input: {
    principal: PrincipalRef;
    organizationId?: string;
    asOf: number;
  }): Promise<DirectoryMembership[]>;
  getRevision(input: { tenantId: string }): Promise<string>;
}

type AuditQuery = {
  requester: PrincipalRef;
  scope: ScopeRef;
  policySnapshotId: string;
  actor?: PrincipalRef;
  eventTypes?: string[];
  occurredFrom: number;
  occurredUntil: number;
  cursor?: string;
  limit: number;
};

type AuditPage = {
  events: RuntimeEvent[];
  nextCursor?: string;
  integrityCheckpoint: string;
};

interface AuditQueryPort {
  query(input: AuditQuery): Promise<AuditPage>;
  requestExport(input: {
    query: AuditQuery;
    format: "jsonl" | "csv";
    recipientKeyRef: string;
    idempotencyKey: string;
  }): Promise<ExportOperation>;
  getExport(input: {
    requester: PrincipalRef;
    operationId: string;
  }): Promise<ExportOperation>;
  cancelExport(input: {
    requester: PrincipalRef;
    operationId: string;
    reason: string;
  }): Promise<ExportOperation>;
}

type MeteringExportCursor = {
  ledger: "usage_observer";
  afterSequence: number;
};

type ExportOperation = {
  operationId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  artifactRef?: string;
  artifactHash?: string;
  error?: RuntimeError;
};

interface MeteringExportPort {
  export(input: {
    requester: PrincipalRef;
    scope: ScopeRef;
    policySnapshotId: string;
    from: number;
    until: number;
    cursor?: MeteringExportCursor;
    dimensions: Array<"organization" | "project" | "principal" | "provider" | "model" | "capability">;
    format: "jsonl" | "csv";
    idempotencyKey: string;
  }): Promise<ExportOperation & {
    nextCursor?: MeteringExportCursor;
    sourceLedgerRevision: string;
  }>;
  getExport(input: {
    requester: PrincipalRef;
    operationId: string;
  }): Promise<ExportOperation>;
  cancelExport(input: {
    requester: PrincipalRef;
    operationId: string;
    reason: string;
  }): Promise<ExportOperation>;
}
```

这些 Port 只暴露 Runtime canonical id。`IdentityDirectoryPort` 不签发 capability；`AuditQueryPort` 不修改事件且查询本身也写审计；`MeteringExportPort` 只读取 UsageObserver 权威账本，禁止形成第二套 usage/cost record。分页 cursor 必须 opaque、tenant-bound、带有效期；export 是 durable operation，支持幂等重试、状态查询、取消与过期清理。调用方取消后 worker 必须停止生成新 artifact；已生成 artifact 按 `expiresAt` 清理。`policy_denied/policy_unavailable/integrity_failed` 禁止自动重试，`storage_unavailable/audit_unavailable` 可按相同 idempotency key 有界重试。

### 4.2 Tool / Workflow / Agent execution contracts

三类执行能力共享 `ExecutionContext`、`PolicyDecision`、deadline、idempotency 与 `RuntimeError`，但责任不同：Tool 是一次类型化动作；Workflow 是可 checkpoint、signal、resume、compensate 的状态机；Agent 是外部 reasoning/execution runtime adapter。Agent 与 Workflow 最终调用 Tool 时仍必须逐次经过 Execution Kernel 权限检查。

```typescript
type SideEffectClass = "none" | "read" | "reversible_write" | "external_write" | "irreversible";

type InvocationControl = {
  executionId: string;
  invocationId: string;
  idempotencyKey: string;
  deadlineAt: number;
  policyDecisionId: string;
  capabilityHandleId?: string;
  trace: TraceContext;
};

type ToolDescriptor = {
  toolId: string;
  version: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  sideEffect: SideEffectClass;
  requiredPermissions: string[];
  supportsCancellation: boolean;
  compensationToolId?: string;
};

type ToolInvocation = InvocationControl & {
  tool: ToolDescriptor;
  scope: ScopeRef;
  input: unknown;
  inputHash: string;
  confirmationId?: string;
};

type ToolResult = {
  invocationId: string;
  status: "succeeded" | "failed" | "cancelled" | "unknown";
  output?: unknown;
  outputHash?: string;
  error?: RuntimeError;
  sideEffectCommitted: boolean;
  compensationAvailable: boolean;
  startedAt: number;
  finishedAt: number;
};

interface ToolPort {
  describe(): Promise<ToolDescriptor>;
  invoke(input: ToolInvocation, signal: AbortSignal): Promise<ToolResult>;
  getResult(input: { invocationId: string; requester: PrincipalRef }): Promise<ToolResult | null>;
  compensate?(input: {
    original: ToolInvocation;
    originalResult: ToolResult;
    control: InvocationControl;
    reason: string;
  }, signal: AbortSignal): Promise<ToolResult>;
}

type WorkflowStep = {
  stepId: string;
  capabilityId: string;
  inputMapping: Record<string, string>;
  dependsOn: string[];
  retryPolicy: { maximumAttempts: number; backoffMs: number; retryableCodes: RuntimeErrorCode[] };
  compensationStepId?: string;
  sideEffect: SideEffectClass;
};

type WorkflowDefinition = {
  workflowId: string;
  version: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  signalSchemas: Record<string, Record<string, unknown>>;
  steps: WorkflowStep[];
  compensationMode: "none" | "best_effort_reverse" | "required_reverse";
  maximumRunMs: number;
};

type WorkflowRunState = {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  status: "queued" | "running" | "waiting" | "compensating" | "succeeded" | "failed" | "cancelled" | "manual_recovery";
  currentStepIds: string[];
  completedStepIds: string[];
  checkpointId?: string;
  waitingFor?: { type: "signal" | "confirmation" | "timer"; key: string; expiresAt?: number };
  error?: RuntimeError;
  revision: number;
  updatedAt: number;
};

interface WorkflowExecutorPort {
  start(input: {
    definition: WorkflowDefinition;
    context: ExecutionContext;
    control: InvocationControl;
    input: unknown;
  }): Promise<WorkflowRunState>;
  resume(input: { runId: string; checkpointId: string; expectedRevision: number; requester: PrincipalRef }): Promise<WorkflowRunState>;
  signal(input: { runId: string; key: string; payload: unknown; idempotencyKey: string; requester: PrincipalRef }): Promise<WorkflowRunState>;
  cancel(input: { runId: string; reason: string; requester: PrincipalRef }): Promise<WorkflowRunState>;
  getState(input: { runId: string; requester: PrincipalRef }): Promise<WorkflowRunState | null>;
}

type AgentRunRequest = {
  runId: string;
  agentId: string;
  agentVersion: string;
  context: ExecutionContext;
  control: InvocationControl;
  objective: string;
  input: unknown;
  allowedCapabilityIds: string[];
  maximumSteps: number;
  maximumCostMinorUnits?: number;
};

type AgentRunEventBase = {
  runId: string;
  sequence: number;
  payloadHash: string;
  occurredAt: number;
};

type AgentRunEvent =
  | AgentRunEventBase & { kind: "status"; payload: { phase: string; safeSummary?: string } }
  | AgentRunEventBase & { kind: "message_delta"; payload: { ephemeralText: string } }
  | AgentRunEventBase & { kind: "tool_request"; payload: { toolId: string; input: unknown; inputHash: string; proposedSideEffect: SideEffectClass } }
  | AgentRunEventBase & { kind: "checkpoint"; payload: { checkpointId: string; stateHash: string } }
  | AgentRunEventBase & { kind: "confirmation_request"; payload: { confirmationId: string; actionHash: string; expiresAt: number } }
  | AgentRunEventBase & { kind: "result"; payload: { result: unknown; resultHash: string } }
  | AgentRunEventBase & { kind: "error"; payload: { error: RuntimeError } };

type AgentRunState = {
  runId: string;
  status: "queued" | "running" | "waiting_confirmation" | "succeeded" | "failed" | "cancelled";
  lastSequence: number;
  resultHash?: string;
  error?: RuntimeError;
  updatedAt: number;
};

interface AgentAdapterPort {
  start(input: AgentRunRequest): Promise<AgentRunState>;
  events(input: { runId: string; afterSequence: number; requester: PrincipalRef }, signal: AbortSignal): AsyncIterable<AgentRunEvent>;
  submitConfirmation(input: { runId: string; confirmationId: string; approved: boolean; requester: PrincipalRef }): Promise<AgentRunState>;
  cancel(input: { runId: string; reason: string; requester: PrincipalRef }): Promise<AgentRunState>;
  getState(input: { runId: string; requester: PrincipalRef }): Promise<AgentRunState | null>;
}
```

执行语义：

- Tool 的 `idempotencyKey` 只覆盖同一逻辑副作用；同 key 不同 `inputHash` 返回 `idempotency_conflict`。
- `unknown` 表示调用方无法证明副作用是否提交，必须进入 reconciliation/manual recovery，禁止自动重试。
- Workflow checkpoint 必须在步骤状态与 outbox/event 同一提交边界落地；恢复只能从已提交 checkpoint 继续。
- `WorkflowDefinition.signalSchemas` 的 key 是唯一允许的 signal name；`signal()` 必须先按对应 JSON Schema 验证 `payload`。同一 `runId + key + idempotencyKey` 重放返回原结果，同 key 但不同 payload hash 返回 `idempotency_conflict`，未声明 signal 返回 `schema_validation_failed`。
- `WorkflowStep.inputMapping` 的 key 是目标 JSON Pointer、value 是只读 source JSON Pointer；禁止任意表达式、动态代码或 secret 插值。
- `required_reverse` 的 compensation 失败进入 `manual_recovery` 并触发高优先级审计；禁止伪报 workflow 已回滚。
- Agent event 必须按 `sequence` 单调、可续读、可去重；`tool_request` 只是提议，Execution Kernel 重新求值权限后才可执行。
- `message_delta.ephemeralText` 只允许存在于实时 Surface stream，进入 `RuntimeEvent` 时只能保存 hash/长度/分类后的摘要；其他 payload 按 `kind` 使用独立 JSON Schema。
- Agent adapter 不得自行切换 provider、签发 capability、扩大 `ScopeRef`、绕过 confirmation 或把 reasoning 原文写入 durable event。

## 5. 角色限制（供应商输出边界）

- extractor 只能**追加** candidate/evidence，**禁止**更新或删除权威 `Claim`。
- vector/graph/entity/rerank 返回候选或可重建投影；检索期**必须**套用 Runtime 提供的授权过滤。
- checkpoint 存可恢复 thread 状态，**独立于**跨执行 Memory 真相。
- durable-job 保 operation-id/lease/retry/dead-letter/purge/trace，**禁**向 worker 暴露队列 SDK 类型。
- model/tool/workflow/agent adapter 只执行已授权的 `CapabilityInvocation`，**禁止**自行选择第二个 provider、扩大 `ScopeRef` 或签发 capability。
- object/secret/audit backend 只提供机制，**禁止**重定义 retention、purge、authority 或审计语义。
- policy engine 评估无副作用 bundle，**禁**调模型/网络/改存储。
- evaluator 产出版本化证据，**禁**直接晋升 artifact。

### 5.1 Plugin lifecycle

`CapabilityDescriptor.lifecycle` 使用统一状态机：

```text
discovered -> validated -> approved -> active -> draining -> disabled -> removed
                         \-> failed ----^          \-> failed
```

- discovery 只解析 manifest，不执行插件代码；进入 `validated` 前完成签名、schema、权限、依赖和兼容检查。
- `approved/active` 只能由 `PolicyDecision` 和具备相应 authority 的操作者触发，模型与插件不能自激活。
- 升级采用版本并存与流量 drain；in-flight invocation 固定到解析时版本，新 invocation 才能切换候选版本。
- rollback 必须恢复上一已验证 descriptor、配置引用和 adapter 版本，不回滚或删除权威 Runtime 数据。
- uninstall 先进入 `draining`，完成引用、export、purge 和 dependency 检查后才可 `removed`；仍被 active capability 依赖时必须拒绝。

## 6. 运行时可观测性契约（跨层，Observability）

> 定位：可观测性是**贯穿全层**的一等契约，不是某个模块的私有埋点。`ExecutionContext.trace`（§1）是 traceId 的唯一源头，各层只派生 spanId、不另起 trace 体系。R17（memory 链路）、Q5（Capability 度量）、10-adapters 的 OpenTelemetry adopt 都是本契约的**具体落地**，此处定义它们共同遵守的传播规则。

```typescript
type TraceContext = {
  traceId: string;          // Orchestration 在 ExecutionContext 创建时生成，全链路唯一
  spanId: string;           // 当前层/操作的 span
  parentSpanId?: string;    // 上游 span，构成因果树
  layer: "surface" | "orchestration" | "capability" | "execution" | "transport" | "memory" | "learning" | "policy" | "security";
  source: "telegram" | "cli" | "web" | "desktop" | "api" | "browser" | "scheduler";
};

type CapabilityKind =
  | "memory" | "knowledge" | "skill" | "model" | "tool"
  | "workflow" | "agent" | "retrieval" | "learning" | "policy";

type CapabilityObservationAction =
  | "capability.resolve" | "capability.invoke" | "capability.result"
  | "memory.plan" | "memory.retrieve.route" | "memory.filter" | "memory.rank"
  | "memory.budget" | "memory.compile" | "memory.inject" | "memory.skip"
  | "memory.extract" | "memory.candidate" | "memory.conflict" | "memory.write"
  | "memory.feedback" | "memory.compress"
  | "skill.match" | "skill.select" | "skill.apply" | "skill.step"
  | "skill.outcome" | "skill.distill" | "skill.validate" | "skill.lifecycle";

type ObservationLink = {
  traceId: string;
  spanId: string;
  relation: "caused_by" | "continued_by" | "evaluated_by" | "compensated_by";
};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type CapabilityObservation<TAction extends CapabilityObservationAction = CapabilityObservationAction> = {
  schemaVersion: 1;
  observationId: string;
  action: TAction;
  trace: TraceContext;
  operationId: string;
  executionId?: string;
  capability: {
    kind: CapabilityKind;
    capabilityId: string;
    version?: string;
    adapterId?: string;
    invocationId?: string;
  };
  scope: {
    tenantId: string;
    kind: ScopeKind;
    subjectIdHash: string;
    audience: ScopeRef["audience"];
  };
  status: "started" | "succeeded" | "failed" | "cancelled" | "skipped" | "degraded";
  occurredAt: number;
  durationMs?: number;
  links: ObservationLink[];
  runtimeEventIds: string[];
  payload: JsonObject;
};

interface ObservabilitySinkPort {
  tryEmit(observation: CapabilityObservation): "accepted" | "dropped";
  flush(input: { deadlineAt: number }): Promise<{ accepted: number; exported: number; dropped: number }>;
}

type ObservationQuery = {
  requester: PrincipalRef;
  policySnapshotId: string;
  scope: ScopeRef;
  traceId?: string;
  executionId?: string;
  capabilityKinds?: CapabilityKind[];
  actionPrefixes?: Array<"capability" | "memory" | "skill">;
  statuses?: CapabilityObservation["status"][];
  occurredFrom: number;
  occurredUntil: number;
  view: "summary" | "explain" | "internal";
  cursor?: string;
  limit: number;
};

type ObservationViewRecord = {
  viewSchemaVersion: 1;
  observationId: string;
  action: CapabilityObservationAction;
  trace: Pick<TraceContext, "traceId" | "spanId" | "parentSpanId" | "layer" | "source">;
  operationId?: string;
  executionId?: string;
  capability: {
    kind: CapabilityKind;
    capabilityId?: string;
    version?: string;
    adapterId?: string;
    invocationId?: string;
  };
  scope: Pick<CapabilityObservation["scope"], "kind" | "audience">;
  status: CapabilityObservation["status"];
  occurredAt: number;
  durationMs?: number;
  links?: ObservationLink[];
  runtimeEventIds?: string[];
  payload: JsonObject;
  redactedFields: string[];
};

type ObservationCompleteness = {
  state: "complete" | "sampled" | "partial";
  reasons: Array<
    | "sampling_policy" | "sink_drop" | "export_lag" | "retention_boundary"
    | "trace_open" | "missing_parent" | "projection_corrupt"
  >;
  droppedEstimate: number | null;
  projectionWatermarkAt: number;
  traceState: "open" | "closed" | "unknown";
};

type ObservationPage = {
  observations: ObservationViewRecord[];
  nextCursor?: string;
  completeness: ObservationCompleteness;
};

interface ObservabilityQueryPort {
  query(input: ObservationQuery): Promise<ObservationPage>;
}
```

`CapabilityObservation` 是可丢弃、可采样、非权威的诊断 envelope；每个 `action` 的 payload 必须按 R17 注册的 closed JSON Schema 校验。`RuntimeEvent` 继续承担 durable lifecycle/audit evidence，Observation 只能通过 `runtimeEventIds` 引用它，禁止根据缺失 Observation 推断操作未发生。同步调用和子调用使用 parent/child span；Post-Run、distill、evaluation 等异步 job 继承 `traceId` 并使用 `ObservationLink`，禁止伪造为仍在原同步调用栈中。

调用点只调用一次 `ObservabilitySinkPort.tryEmit()`；local JSONL、OpenTelemetry trace/metric/log 和企业 OTLP exporter 都是该 Port 后的 projection adapter，禁止在业务代码分别重复埋点。`tryEmit()` 必须是有界、非阻塞操作；queue 满时增加低基数 `observability_dropped_total{action_family,reason}` 并丢弃 Observation，不得阻塞 Runtime、Memory 或 Skill。

`ObservabilityQueryPort` 是受 Policy 控制的诊断查询，不是日志文件透传。它必须把内部 `CapabilityObservation` 投影成 `ObservationViewRecord`，并按 action + view 的 closed output schema 删除未授权字段；`summary/explain/internal` 分别应用独立 allowlist。cursor 必须 opaque、签名、tenant/scope/view/filter-bound 且带有效期；修改原查询后复用 cursor 必须返回 `invalid_cursor`。`requester.tenantId`、`scope.tenantId` 与 cursor tenant 不一致默认拒绝；平台级跨租户调查必须使用针对目标 tenant 的独立 break-glass permission、短时授权并写审计，且仍保持“一次查询一个 tenant”，禁止跨 tenant 混页或复用 cursor。`view=internal` 本身不能绕过 tenant isolation。

`completeness.state=complete` 仅在 trace 已关闭、查询时间位于 retention 内、投影 watermark 已越过 trace terminal，且没有匹配该 trace 的已知 sampling/drop/gap 时返回；仅因有意采样缺失时为 `sampled`；sink drop、export lag、retention 截断、trace 尚未关闭、缺 parent 或投影损坏均为 `partial` 并列出 `reasons`。`droppedEstimate=null` 表示无法可靠估算，禁止用 `0` 伪装无丢失。分页只切分结果，不改变 completeness；所有页必须固定同一 query cutoff 与 watermark。

各层最小埋点职责（每个 span 必挂同一 `traceId`，`action` 命名归各模块规范）：

| 层 | 最小 span | 关键 attribute（禁正文/secret） | 规范来源 |
|---|---|---|---|
| Surfaces | 请求进入/回复送出 | source、intentKey、耗时 | [01-surfaces.md](modules/01-surfaces.md) |
| Orchestration | traceId 生成、路由决策 | engine、provider、policy 结果 | [02-orchestration.md](modules/02-orchestration.md) |
| Execution | 引擎调用生命周期 | engine、tool 事件计数、exit 类别 | [04-execution-kernel.md](modules/04-execution-kernel.md) |
| Transport | route lease、metrics parity | listener/upstream、token/cost、熔断态 | [05-transport-proxy.md](modules/05-transport-proxy.md) |
| Capability | resolve→invoke→result | capability/version/adapter、permission result、耗时/错误 | [03-capabilities.md](modules/03-capabilities.md) |
| Memory | plan→route retrieval→filter→rank→budget→compile→inject→extract→write | route/filter reason、memoryId/分数/长度/耗时（R17） | [enforcement-decisions.md](enforcement-decisions.md) R17 |
| Skill | match→select→apply→step→outcome→lifecycle | skill/version/trigger、step/capability、guardrail、偏离与结果归因（R17） | [enforcement-decisions.md](enforcement-decisions.md) R17 |
| Learning | signal/decision/evaluation/promotion | 四项 Capability 度量随 traceId（Q5） | enforcement-decisions.md Q5 |

硬规格：

- **单一 traceId 贯穿**：从 Surfaces 进入到 Learning 回流共用一个 traceId，`ai log --trace <id>` 能跨层按序还原一次执行。
- **脱敏一致**：任何层的 span attribute **禁**写 prompt、memory 正文、secret、raw Evidence；正文一律以长度/hash 代替（对齐 R17 与安全边界）。
- **失败不阻断**：可观测性是 best-effort，埋点异常**绝不**影响主链路或用户回复。
- **后端非权威**：telemetry backend（OTel exporter）**不是**审计账本；权威证据仍是 `RuntimeEvent` 与加密审计（对齐 [10-adapters-plugins.md](modules/10-adapters-plugins.md) OTel adopt 边界）。
- **传播标准**：跨进程/跨服务传播采用 W3C Trace Context；`local` profile 用 OTel file/console exporter 降级，语义不变。
- **指标低基数**：`traceId`、`executionId`、`memoryId`、`skillId`、`invocationId`、user/project id 只能出现在受限 trace/log，不得成为 metric label；metric label 只允许 action family、capability kind、status、route、adapter family、error code 和 deployment profile。
- **查询授权**：按 trace、principal、scope、Memory/Skill id 查询 Observation 必须重新执行 Policy；普通用户只查看自己的脱敏 explain view，运营者查看聚合指标，原始内部 id 与跨租户关联只对授权审计角色开放。

## 7. 相关文档

- 分层与依赖规则：[00-overview.md](00-overview.md)
- 术语一致性：[glossary.md](glossary.md)

## 8. 核心公开接口（从 memory-system-spec 迁入）

> 从 `memory-system-spec.md` 迁入，是记忆/学习子系统对外的**唯一公开 facade**。描述终局架构（Phase 13）；当前代码只落地到 Telegram Memory Phase 1。相关规范性强制条款（R*）见 [enforcement-decisions.md](enforcement-decisions.md)。标识符英文原样。

```typescript
type MemoryPreReadResult = {
  traceId: string;
  prompt: string;
  injectedMemoryIds: number[];
  injectedSkillIds: string[];
  authCapabilities: AuthCapability[];
  diagnostics: { retrieved: number; injected: number; tokenCount: number };
};

type MemoryPostRunReceipt = {
  traceId: string;
  jobId: string;       // 已持久化，进程退出后仍可消费
  acceptedAt: number;
};

interface MemoryService {
  preRead(input: MemoryPreReadInput): Promise<MemoryPreReadResult>;
  search(input: BoundedMemorySearchInput): Promise<MemorySearchResult>;
  enqueuePostRun(input: MemoryPostRunInput): Promise<MemoryPostRunReceipt>;
  list(query: MemoryListQuery): Promise<MemoryPage>;
  pin(input: ExplicitMemoryInput): Promise<MemoryEntry>;
  correct(input: MemoryCorrectionInput): Promise<MemoryEntry>;
  forget(input: MemoryForgetInput): Promise<void>;
  purge(input: MemoryPurgeInput): Promise<PurgeReport>;
  export(input: MemoryExportInput): Promise<string>;
}
```

`search` 是给主模型和受信 Agent 使用的受限只读接口，不是数据库查询透传：必须执行与 `preRead` 相同的 canonical identity、scope、privacy、authority、时态和 token budget 过滤；默认每个 turn 最多调用 1 次、最多返回 8 条、最多 1200 tokens。调用方不能指定其他 `user_id`，也不能要求读取 deleted、secret、原始 Evidence 正文或 auth storage。
