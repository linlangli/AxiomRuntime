# ④ Execution Kernel 执行内核

> 遵循 doc_2.0 统一模块模板。语言中英混合，标识符英文原样。术语见 [../glossary.md](../glossary.md)。

## 1. 定位（一句话）

执行受治理的工作：权限检查、重试、幂等、取消、隔离、副作用分级，并发出结构化执行事件。

## 2. 单一职责边界（高内聚）

**拥有**：执行计划、执行期权限检查（调 `PolicyEngine`）、retry/idempotency/cancellation、隔离、side-effect 分级、结构化 `RuntimeEvent`。

**禁止拥有**：
- **禁止**自定义策略——策略求值属 ⑧，内核只**消费** `PolicyDecision`。
- **禁止**让 memory/skill 授予权限——权限在此**执行期**检查。
- **禁止**直接持有 upstream 连接——转发属 ⑤ Transport。

## 3. 内部构件与各自单一职责

| 构件 | 单一职责 |
|---|---|
| `planner` | 生成受治理执行计划 |
| `permission` | 执行期权限检查（`PolicyDecision` 驱动） |
| `retry/idempotency` | 单请求重试所有权、幂等键 |
| `isolation` | 副作用分级与隔离 |
| `tool-runner` | 工具调用编排（授权后） |
| `workflow-supervisor` | checkpoint、signal、resume、compensation 与 manual recovery 编排 |
| `agent-supervisor` | Agent event 续读、budget/step limit、tool proposal 再授权、cancel |

## 4. 对外/消费端口（可插拔点）

- 消费：`CapabilityInvocation`、`PolicyDecision`、⑤ Transport（转发）、⑥ Memory（注入/回流）。
- 发出：结构化 `RuntimeEvent`（供 ⑦ 学习与审计）。
- Tool/Workflow/Agent 经 Adapter 插入，内核只依赖 `ToolPort/WorkflowExecutorPort/AgentAdapterPort`。

执行状态与故障规则：

- Tool 在调用前固化 `inputHash + idempotencyKey + SideEffectClass + PolicyDecision`；返回 `unknown` 时停止自动化并进入 reconciliation。
- Workflow 每个 step 独立授权、独立幂等；checkpoint 与 step event 使用 transactional outbox 或等价原子边界。
- cancel 从 Surface 传播至 Workflow/Agent/Tool 和 Transport；无法确认取消结果时不得写 `cancelled` 终态，必须写 `unknown/manual_recovery`。
- retry 只能由明确 owner 执行。Transport、Workflow step、Tool adapter 与 Agent adapter 禁止对同一失败叠加隐藏重试。
- compensation 是新 invocation，拥有自己的 policy、idempotency、deadline、event 与 failure；补偿失败禁止覆盖原始失败。

## 5. 依赖（低耦合）

只 import `L0 Contracts`。调 Policy 求值、Transport 转发、Memory 注入均经契约。**禁止** import 这些模块的具体实现。

## 6. 数据所有权

内核**不持久化真相**，只产生 append-only 执行事件。幂等键保证重试不重复副作用；副作用真相由目标系统持有。

## 7. 降级 / kill switch

`PolicyEngine` 不可用 → **fail-closed**（拒绝执行，绝不放行未授权动作）。工具执行器故障隔离到单次调用。取消/超时**必须**可靠传播，**禁**留下不可回收的挂起副作用。

## 8. 产品化就绪度

❌ **不独立成产品**——执行内核是 Runtime 治理的核心，与契约/事件深度耦合，脱离闭环无意义。判据见 [../extraction-readiness.md](../extraction-readiness.md)。

## 9. 现状映射

`src/core/runner/`（`fallback.ts`、`tool-runner.ts`、`engine-registry.ts`）是雏形，**应当**重组进内核；其中的 transport 相关部分（`openai-usage-*.ts`）**必须**剥离到 ⑤。

## 10. 验收标准

- 权限在**执行时**检查；memory 或 skill **无法**授予权限。
- 不可逆/高影响动作**必须**有显式授权（`PolicyDecision.effect=require_confirmation`）。
- 重试/兼容重试**不产生**重复副作用或重复计费（配合 ⑤ 幂等键）。
- crash 后从最后已提交 Workflow checkpoint 恢复，不重复已提交 Tool side effect；无法判定的步骤进入 manual recovery。
- Agent 的每个 `tool_request` 重新经过 Kernel，Agent 自身不能扩大 permission/scope 或绕过 confirmation。
- Runtime event catalog 中 start/terminal 一一配对；一个 invocation 只能有一个 terminal state，reconciliation 以新事件纠正而不改写历史。
- 模型变化时，安全/scope/权限行为保持确定。

## 11. 相关文档

- 整体架构：[../00-overview.md](../00-overview.md)｜策略：[08-policy.md](08-policy.md)｜传输：[05-transport-proxy.md](05-transport-proxy.md)
- 权威边界（英文）：[../AI_RUNTIME_ARCHITECTURE.md](../AI_RUNTIME_ARCHITECTURE.md) §2 Execution Kernel
- 量化服务等级：[../service-level-objectives.md](../service-level-objectives.md) §3–5

---

## 附：分层延迟预算（从 memory-system-spec 迁入）

> **Appendix Status: SUPPORTING SPEC** — 具体 release gate 以 `service-level-objectives.md` 为准。
>
> 本附录保留 legacy `memory-system-spec.md` 的分层延迟预算作为 supporting material；当前行为以 [../enforcement-decisions.md](../enforcement-decisions.md) R27、identifier 以 [../contracts.md](../contracts.md) 为准，附录不得覆盖正文 ownership。

### 分层延迟预算（R27 延迟预算）

Pre-Read 的 300ms deadline 只覆盖快速本地路径，不要求远程 Planner、远程 embedding、复杂图搜索、NLI 和现场 Profile 编译都在同一预算内完成。

| 延迟层 | 默认预算 | 内容 | 超时行为 |
|--------|----------|------|----------|
| L0 required cache | 10ms | policy、constraint、预编译 profile、bot profile | 缓存 miss 转 L1 |
| L1 local retrieval | 100ms | SQLite scope、FTS、recent、prospective trigger | 返回当前结果 |
| L2 local semantic | 300ms | 本地 query embedding、vector、受限 graph、temporal | 独立 route 降级 |
| L3 deliberative | 异步/迭代式 | LLM Planner、复杂多跳、remote reranker、反事实 | 通过 `memory.search` 补查 |

Profile 必须预编译；远程网络请求不得放在 Pre-Read 事务内。首次请求只使用 L0-L2，L3 结果不能迟到后偷偷改变已发送 prompt，只能作为受限补查结果进入后续模型步骤。
