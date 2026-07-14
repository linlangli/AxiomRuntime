# 服务等级、恢复与容量目标（SLO / RTO / RPO）

> 本文属于 doc_2.0 normative layer。以下数值是目标架构的初始 release gate，不代表当前实现。deployment profile 可配置得更严格；放宽必须有 time-bound exception、风险 owner、补偿控制和退出日期。

## 1. 统计口径

- SLO 按自然月、organization、environment 分别计算，禁止用测试/空闲流量稀释 production 失败。
- `availability = successful eligible operations / eligible operations`。Policy 正确拒绝、quota deny、用户 cancel 和 validation error 不计系统失败。
- latency 从 Runtime 接受已验证请求开始，到对应边界完成为止；不把用户等待 confirmation 或外部长任务时间计入平台 latency。
- 所有 percentile 使用服务端 monotonic time；每项必须同时记录 count、error ratio、p50、p95、p99 与最大 queue age。
- 发生 tenant leak、secret leak、audit accepted-event loss、重复计费或错误高风险执行时，无论月度比例如何，该 release window 直接判定失败。

## 2. Deployment profile

| Profile | 适用范围 | Availability 目标 | 维护窗口 |
|---|---|---:|---|
| `local` | 单用户本机，允许离线 | best effort，月度报告但不承诺外部 SLA | 用户控制 |
| `team` | 单区域团队服务 | ≥ 99.5% / 月 | ≤ 4 小时/月，提前通知 |
| `enterprise` | production 组织服务 | ≥ 99.9% / 月 | ≤ 2 小时/月，提前通知；核心安全修复除外 |

Availability 仅覆盖 Runtime 自有边界。第三方 provider 故障单独计为 dependency availability，但 Runtime 的正确 fallback、明确错误和不扩权行为仍计入自身 SLO。

## 3. 在线路径 SLO

| 边界 | `team` | `enterprise` | 超限行为 |
|---|---:|---:|---|
| Orchestration context build（cache hit） | p95 ≤ 50ms，p99 ≤ 120ms | p95 ≤ 30ms，p99 ≤ 80ms | identity/scope 不确定 fail-closed |
| Policy evaluation（local/cache） | p95 ≤ 30ms，p99 ≤ 80ms | p95 ≤ 20ms，p99 ≤ 50ms | privileged action fail-closed |
| Capability resolve | p95 ≤ 20ms，p99 ≤ 50ms | p95 ≤ 15ms，p99 ≤ 40ms | 不得选未批准 fallback |
| Transport 本地转发开销 | p95 ≤ 20ms，p99 ≤ 50ms | p95 ≤ 15ms，p99 ≤ 40ms | Memory 可收窄，Usage/compat 保持 |
| Memory L0 required cache | p95 ≤ 10ms | p95 ≤ 10ms | miss 转 L1 |
| Memory L1 local retrieval | p95 ≤ 100ms，p99 ≤ 200ms | p95 ≤ 80ms，p99 ≤ 160ms | 返回当前安全结果 |
| Memory L2 local semantic | p95 ≤ 300ms，p99 ≤ 500ms | p95 ≤ 250ms，p99 ≤ 450ms | route 独立降级，不阻塞主请求 |
| Admin read | p95 ≤ 300ms，p99 ≤ 800ms | p95 ≤ 200ms，p99 ≤ 500ms | 显示 degraded，不展示 stale privileged state 为 current |
| Admin mutation accept | p95 ≤ 500ms，p99 ≤ 1s | p95 ≤ 300ms，p99 ≤ 800ms | 返回 durable operation，不等待长任务完成 |

Model/provider latency 不纳入本地 Transport overhead，但必须分别展示 upstream TTFT、total latency、retry 和 fallback 时间，禁止把上游慢请求归为 Runtime 成功延迟。

## 4. Durable operation SLO

| Operation | `team` | `enterprise` | 完成定义 |
|---|---:|---:|---|
| RuntimeEvent accepted → AuditSink durable | p95 ≤ 5s | p95 ≤ 2s | 已签名、可查询或进入有界 recovery journal |
| Usage observed → ledger durable | p95 ≤ 5s | p95 ≤ 2s | 同 upstream attempt 最多一条 contribution |
| Post-Run durable enqueue | p95 ≤ 50ms | p95 ≤ 30ms | job id 可查询，正文已脱敏/保护 |
| Policy canary publish | ≤ 5 分钟 | ≤ 2 分钟 | targets 可验证，effective revision 可查询 |
| Policy rollback | ≤ 10 分钟 | ≤ 5 分钟 | 新 revision 生效，旧历史保留 |
| Plugin drain | 由 invocation deadline 决定，默认 ≤ 30 分钟 | 默认 ≤ 15 分钟 | 无新 invocation，in-flight 有终态 |
| Audit/Metering export ≤ 1GB | ≤ 60 分钟 | ≤ 15 分钟 | recipient-bound artifact + hash + checkpoint |
| Purge（不受 Legal Hold） | ≤ 24 小时 | ≤ 4 小时 | 派生链、projection、blob、key 与 tombstone 均有证据 |
| SCIM create/update/suspend/remove | ≤ 15 分钟 | ≤ 5 分钟 | directoryRevision 可见；remove 后不再签发新 capability |

超过完成目标时 operation 保持真实状态并告警，禁止改写为 success。deadline 到期但副作用未知时进入 `manual_recovery`。

## 5. RTO / RPO

| 数据/服务类别 | `local` | `team` | `enterprise` |
|---|---:|---:|---:|
| Runtime execution/control service RTO | ≤ 4h | ≤ 60m | ≤ 30m |
| Policy / identity cached-read RTO | ≤ 4h | ≤ 30m | ≤ 15m |
| Authoritative Claim/Evidence RTO | ≤ 8h | ≤ 2h | ≤ 60m |
| Usage ledger / accepted audit event RPO | latest completed local backup | 0 after durable accept | 0 after durable accept |
| Policy/config revision RPO | ≤ 24h | ≤ 5m | ≤ 1m |
| Claim/Evidence RPO | ≤ 24h | ≤ 5m | ≤ 1m |
| Rebuildable vector/graph/profile projection RPO | rebuildable | rebuildable | rebuildable |
| Artifact blob RPO | ≤ 24h | ≤ 15m | ≤ 5m |

`RPO=0 after durable accept` 表示系统已经向调用方确认 durable 后不得丢失；确认前失败可由同一 idempotency key 重试。可重建 projection 不承诺逐项备份，但 source Claim/Evidence、compiler version 与 manifest 必须满足对应 RPO。

## 6. 容量与背压

- 每个 environment 必须声明 `maximumConcurrentExecutions`、`maximumQueuedJobs`、`maximumQueueAgeMs`、`maximumAuditBufferBytes`、`maximumUsageJournalBytes` 和 export concurrency。
- 达到 concurrency/queue limit 返回 `quota_exceeded` 或 throttle，禁止无界排队。
- Memory channel 饱和只收窄 Memory；Usage channel 饱和是显式 degraded fault，启用有界 metadata journal/reconciliation。
- recovery journal 达上限时，高影响 admin write fail-closed；普通执行可继续但必须明确 Usage/Audit degraded，不得报告 healthy。
- 单 tenant 不得消耗超过其 quota 的 worker、queue、export 或 index rebuild capacity；企业 profile 必须验证 noisy-neighbor 隔离。

## 7. 告警与 error budget

- 快速燃烧：1 小时消耗月度 error budget ≥ 10% 触发 page；6 小时 ≥ 25% 触发 release freeze。
- 慢速燃烧：3 天消耗 ≥ 50% 触发 capacity/reliability review。
- 任一 hard safety regression 立即冻结相关 policy/plugin/learning rollout，不等待 error budget。
- SLO 失败必须记录受影响 scope、开始/结束时间、root cause、数据完整性结果、临时控制、owner 与退出条件。

## 8. 恢复演练验收

`team` 每季度、`enterprise` 每月执行恢复演练，至少覆盖：主数据库不可用、AuditSink 不可用、Usage worker 崩溃、Policy revision 错误发布、Identity provider 中断、queue backlog、对象存储区域故障、SecretStore/KMS key rotation 和 legal hold 下的 purge 请求。

恢复完成后必须验证：tenant isolation、event hash chain、Usage ledger sequence、Claim/Evidence provenance、purge tombstone、legal hold、policy effective revision、plugin activation revision、checkpoint 可恢复性和所有 accepted operation 的唯一终态。
