# ⑧ Policy Engine 策略引擎

> 遵循 doc_2.0 统一模块模板。语言中英混合，标识符英文原样。术语见 [../glossary.md](../glossary.md)。

## 1. 定位（一句话）

确定性、无副作用地对类型化 bundle 求值，产出 `PolicyDecision.effect`（`allow | deny | require_confirmation | constrain`）——横切所有层，在 recall/execution **之前**被调用。

## 2. 单一职责边界（高内聚）

**拥有**：策略规则求值、`PolicyDecision` 产出、激活授权判定。

**禁止拥有**：
- **禁止**调模型、网络或改存储（**必须**无副作用）。
- **禁止**生成内容或执行动作——只**判定**。
- **禁止**被 memory/skill 绕过授予权限。

## 3. 内部构件与各自单一职责

| 构件 | 单一职责 |
|---|---|
| `evaluator` | 类型化 bundle → `PolicyDecision` 纯函数求值 |
| `rules` | 版本化策略规则集 |
| `activation-gate` | 能力/artifact 激活判定 |

## 4. 对外/消费端口（可插拔点）

- 暴露：`PolicyEngine`（本地内置规则 / OPA / Cedar 可换）。
- 消费：类型化、无副作用的 evaluation bundle。
- 换引擎不改调用方——`PolicyDecision` 契约稳定。

## 5. 依赖（低耦合）

只 import `L0 Contracts`。作为横切被 ④/⑥/⑦ 调用。**禁止** import 任何模块实现，**禁**反向依赖。

## 6. 数据所有权

**独占**策略规则集、revision 与生效 `OrganizationPolicySnapshot` 的策略语义。求值本身无状态、无副作用；控制面编排 draft/approval/rollout，但不能自行改写 Policy；决策记录作为 append-only 证据由调用方发为 `RuntimeEvent`。

## 7. 降级 / kill switch

**不可降级**——安全关键。引擎不可用 → 全局 **fail-closed**（拒绝需授权的动作）。**禁**因 Policy 故障而放行未授权执行或激活。

## 8. 产品化就绪度

🔄 **采纳而非抽取**——它本就是 OPA/Cedar 的薄适配层，直接用成熟产品，不必自造独立产品。判据见 [../extraction-readiness.md](../extraction-readiness.md)。

## 9. 现状映射

**待建**。当前策略散落各处；本层将其收敛为确定性、无副作用引擎，企业 profile 接 OPA/Cedar。

## 10. 验收标准

- 求值**无**任何副作用（不调模型/网络/存储）。
- memory 或 skill **无法**通过 Policy 授予权限。
- 模型变化时，安全、tenant scope、权限判定保持确定。
- 高影响/不可逆动作返回 `require_confirmation` 而非静默 `allow`。
- policy draft 必须先 schema/semantic validation，再经批准生成不可变 revision；production 支持 target/canary rollout 与以新 revision 完成的 rollback，禁止原地改写历史 bundle。
- 调用方可查询指定 `PrincipalRef + ScopeRef + snapshotId` 的 effective policy 与 `matchedRuleIds`；控制面、CLI 与 API 对同一输入必须得到同一 `PolicyDecision`。
- Policy 不可用或 snapshot 过期时，新 privileged grant、plugin activation、scope promotion、legal-hold 变更与高影响执行 fail-closed。

## 11. 相关文档

- 执行内核：[04-execution-kernel.md](04-execution-kernel.md)｜安全：[09-security.md](09-security.md)
- 权威边界（英文）：[../AI_RUNTIME_ARCHITECTURE.md](../AI_RUNTIME_ARCHITECTURE.md) §6 Governance and Security Invariants

---

# 附：Policy Automata（从 memory-system-spec 迁入）

> **Appendix Status: SUPPORTING SPEC** — automata 是规则表达参考；canonical `PolicyDecision` 与企业 revision lifecycle 以正文/L0 为准。
>
> 每个 category 独立状态机是 ⑧ `PolicyEngine` 的规则形态；决策记录作为 append-only 证据（见本文 §6）。相关 enforcement 决策见 [../enforcement-decisions.md](../enforcement-decisions.md)。标识符与配置键英文原样。

## A. 每 category 独立状态机

统一 confidence 阈值只作为默认兜底。每个 category 必须配置独立状态机：接受哪些 Evidence、最低 authority、独立证据数、验证器、自动激活许可、过期策略和冲突策略。

```typescript
type ActivationPolicy = {
  category: string;
  acceptedEvidence: EvidenceRule[];
  minimumIndependentEvidence: number;
  minimumAuthority: string;
  automaticActivationAllowed: boolean;
  requiredVerifiers: string[];
  expirationPolicy: string;
  conflictPolicy: string;
};
```

默认规则：明确语言偏好一次用户陈述可 active；隐式偏好需要跨 session 的独立行为；项目依赖需要用户陈述或 manifest/tool 验证；external fact 永不自动 active；高危 Skill 需要多次 outcome、replay 和确认。

## B. 版本化 PolicyEngine 契约

Policy 不得扩散成散落在业务代码中的 `if/else`，也不再自行发明通用 Policy DSL。实现依赖版本化 `PolicyEngine` 契约：默认 policy schema 只表达 accepted evidence、最低 authority、独立证据数、verifier、冲突策略、过期/重验证策略和允许的状态迁移动作；它可以编译为 OPA/Rego、Cedar 或等价成熟确定性 evaluator，也必须提供无外部服务的本地 reference evaluator。policy 不允许执行任意脚本、网络请求、数据库写入或模型调用。

```yaml
category: project_dependency
policyVersion: 1
acceptedEvidence:
  - user_stated
  - tool_verified:package_manifest
minimumAuthority: tool_verified
minimumIndependentEvidence: 1
automaticActivationAllowed: true
conflict:
  cardinality: single
  strategy: newest_verified
expiry:
  strategy: revalidate_on_artifact_change
```

每次 Policy 决策必须保存 `policy_engine + policy_bundle_hash + policy_version + matched_rules + rejected_rules + final_action`，同一候选可以在 Shadow Policy 下并行求值但只能由 production policy 提交状态。更换 OPA/Cedar/本地 evaluator 时，相同 bundle fixture 的 authority boundary 和 final action 必须一致，否则不得切换 production。
