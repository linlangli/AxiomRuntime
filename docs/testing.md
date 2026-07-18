# 测试计划（Testing）

> 从旧 `memory-system-spec.md` 迁入。按子系统组织的测试策略；与 R 条款（[enforcement-decisions.md](enforcement-decisions.md)）和 Phase（[roadmap.md](roadmap.md)）对应。

## Core Memory

- scope 隔离：canonical `ScopeRef` 的 user/bot/project 不串读；legacy `global` 只在 Storage adapter 内映射为 user
- 类型化模型：Memory Unit 与 Claim/Evidence/Skill/Prospective/Constraint/Negative payload 事务一致，兼容投影不可绕过真相源
- 证据独立性：同源网页摘要、模型复述和重复 tool parse 属同一 corroboration group，不能把 pending 刷成 active
- 派生图：summary→distill→profile/skill 的每条 transform 可回溯；purge/retract 后 authority 和 Claim 状态可从 DAG 重算
- 结构化确认：claim hash 或 displayed value hash 不匹配时确认失败；模糊“都记住”不批量提升 authority
- authority 传播：external 经 summary/distill/profile/graph/skill 后 authority cap 不提升；仅具体 Claim 用户确认或白名单 tool outcome 可新增高权限 Evidence
- 身份绑定：多来源映射到同一 canonical account 后 global 记忆互通；群聊/非私聊禁用记忆（R1、R7）
- lifetime：short_term 到期清理
- 自动抽取：durable enqueue 不阻塞回复；高置信度保存，低置信度 pending（R2、R4）
- Learning Governor：相同 input hash/version 的决策确定性一致；privacy/scope/security guard 优先于 capability gain；模型输出不能直接写决策或激活
- 自动学习：每个非 incognito execution 产生最小 signal；retrieved 但未 referenced/changed outcome 的记忆不获得正 utility
- 元认知：固定 fixture 中 coverage/conflict/applicability 缺口正确选择 proceed/search/verify/ask/proceed-cautiously；question budget 与冷却期生效
- 自动压缩：不同 authority/scope/time 的事实不误合并；coverage=1.0；manifest 可回滚；压缩后 purge 派生链完整
- 智能遗忘：低边际效用投影可降温但 Evidence、审计、pin 和保留期数据不被自动物理删除
- 组织迁移：私有 Evidence 不进入 team/org candidate；单用户重复成功不足以自动提升共享 scope
- 投毒防护：external 来源候选强制 pending，指令性文本被中和（R3）
- 敏感拦截：password/token/cookie 不写入 memory
- 抽取黄金集：明确偏好/隐含偏好/一次性话题/网页注入/混合来源分别断言 active/pending/drop；`dangerousFalseActive=0`
- 注入预算：profile/persona 各有 token cap，其他按相关性裁剪，任何条目都不能突破总预算（R6）
- 迁移：旧 schema 行正确升级，profile/persona 单例不重复（R5）
- 并发：两个进程同时写同一 operation 只产生一次结果；lease 过期重领不重复抽取
- Profile 编译：Claim 更新/撤回后 snapshot 失效并重编译；敏感 profile slice 不进入无关 audience
- Profile AST：没有 source claimIds 的字段不能进入 Snapshot；仅受影响 section 增量重编译
- 前瞻/约束/负向：事件触发正确，完成后按 policy 关闭；约束强度不与 preference 混淆；成功 Skill 检索同步带回相关 failure
- 时态不确定性：fuzzy/relative/unknown 不伪造精确时间；anchor event 更新后相关查询结果可重算
- 完整性：event hash chain 在正常备份恢复后有效，手工改行、删事件和错序恢复可被发现
- 故障恢复：enqueue 后强杀、worker 模型超时、SQLite busy、磁盘满、migration 中断均有确定结果
- 隐私：no_read/no_write/incognito/audience 生效；purge 清理全部派生数据和可逆备份

## Telegram

- headless spawn CLI 通过单一 Runtime Transport Proxy 自动注入记忆并继续获得现有 usage/cost
- 普通聊天自动写入记忆
- 切换 `/claude` `/codex` 记忆仍可用
- 统一设置/审计界面可管理自动写入的记忆
- Proxy 与 stdout stream-json 解析并行工作互不干扰
- 动态 conversation 注入优先保留最新 turn，整体不超过 1400 token；`pinnedTurns` 持久化、去重并受 3 条上限约束
- 编辑最新 prompt 会移除旧 conversation turn、清空 native `engineSessionId` 并重跑；回复文字/caption XML 转义后最多注入 800 token
- JSONL event 被任意 stdout chunk 切分时仍完整解析；有界 `responseText` 预览 HTML 转义、1500ms 节流且不重复 timeline
- 一次最多 8 个附件；文本/图片大小与 token budget 生效，Codex 收到全部 `--image`，成功清理临时文件、失败保留
- Claude 非零退出优先展示 terminal result/error；fixture 断言 `system/init` 与 retry envelope 不成为主错误
- `/terminal` 高风险命令必须 confirmation，`/restart` 必须先优雅停止再启动 replacement process

## CLI

- 现有 `startOpenAiUsageProxy` API、Responses↔Chat translation、records、metrics、usage.json 和错误 fixture 在 usage-only 迁移后全部 parity
- 同一 execution 同时启用 Usage/Memory 时只有一个 listener、一个 upstream connection path 和一次 base URL 覆写；检测第二 listener 或 self-loop 必须失败
- `ai use claude/codex` 通过 Runtime Transport Proxy 每 turn 产生完整 Pre-Read manifest、ephemeral capture、SanitizedTurnEnvelope 和 Post-Run job；raw request/tool data 不落盘
- Proxy 正确识别 Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 三种协议并按 compatibility profile 注入记忆
- Turn 状态机正确：tool continuation/retry/compaction 不重复注入，新 user message 触发新 turn，unknown relation 不自动写 semantic memory
- Protocol fixture replay：普通/stream/tool/retry/cancel/compaction/unknown event 的透传 hash、exchange relation 和 envelope 与黄金 fixture 一致
- 兼容矩阵：未知 CLI major 或 provider fingerprint 进入 shadow/passthrough，不以猜测协议保持 full
- transport 的 stopped/usage_only/extensions 与 Memory 的 disabled/passthrough/shadow_capture/read_only/full 独立生效；Memory 降级不关闭 Usage
- 熔断恢复：解析率、事件循环延迟、队列和 upstream 故障可触发降级；仅连续健康窗口和 canary replay 后半开恢复
- 资源上限：超长 SSE、arguments delta 和并行 tool call 不导致无界内存；capture truncated 时流仍完整透传且不产生 active memory
- 进程隔离：杀死 ExtensionWorker 时当前 provider stream 继续且 Memory 收窄；杀死 forwarder 时当前请求明确失败、不写成功记忆，下一请求由 supervisor 恢复
- 持久化边界：system/instructions、reasoning、Authorization、raw tool arguments/output 和附件正文注入 canary 后均不能出现在 envelope/job/event/log；只允许 hash 和 TTL 加密 sanitized ref
- TransformCoordinator：Memory patch 与 Responses↔Chat translation 顺序固定，声明 patch path 外 canonical AST 一致；Memory 关闭后现有 compatibility translation 不变
- Prompt cache：固定/动态块顺序稳定，retry/continuation 复用 manifest；cache read ratio、effective input cost 和 TTFT 满足门槛
- 本地访问控制：错误 nonce/path、未注册 execution 和 parent pid 失联不会创建 memory event
- 多租户：同 OS uid 场景明确标为单信任域；不同租户在 OS user/container 隔离测试中不能共享 listener/route lease
- 非标准 provider 格式正确降级：透传不注入不报错，CLI 正常执行
- Proxy Pre-Read 超时时 fail-open（不注入但继续转发），不阻塞 CLI 正常使用
- Proxy 安全：Authorization header 不出现在日志、envelope 或 job payload
- `--native` 按实际 adapter 正确展示 `memory capability=read-at-session-start|read-on-demand|disabled, write=disabled`，且不修改原生项目文件
- cwd 改变时 project scope 生效
- Transport/worker 进程随 `ai use` 启动/退出自动管理，不留孤儿；forwarder/worker 终态可区分
- `ai doctor transport-proxy`（兼容 `memory-proxy` alias）不泄漏正文或 header，并能报告 Usage parity、route、fingerprint、adapter、transport/memory mode、worker/circuit、cache/cost 和最近降级原因

## Tool / Workflow / Agent

- Tool：input/output schema、permission、confirmation、deadline、cancel、同 key 同 input replay、同 key 不同 input conflict、`sideEffectCommitted` 与 `unknown` reconciliation
- Tool compensation：可逆写入的补偿是独立授权 invocation；补偿成功/失败均保留原始结果，失败进入 manual recovery
- Workflow：DAG validation、循环/缺失 dependency 拒绝、step 级 retry owner、transactional checkpoint+event、crash resume、signal schema 校验、重复 signal 去重与 payload conflict、timer/confirmation wait
- Workflow recovery：`best_effort_reverse/required_reverse` 逐步逆序补偿；required compensation 失败不得报告 rolled back
- Agent：event sequence 单调、断线续读、重复 event 去重、maximumSteps/cost/deadline、cancel、confirmation、result terminal 唯一
- Agent 权限：每个 `tool_request` 重新经 Kernel/Policy；Agent 更换 provider、扩大 scope、自签 capability 或绕过 confirmation 的 fixture 必须失败
- Coding Agent 分层：Telegram/CLI/API 对同一 `claude-code-agent` 或 `codex-cli-agent` descriptor 产生一致的 provider pin、permission、budget、retry owner、Usage 与 terminal event；Telegram `Engine` facade 不得直接 spawn Tool 或绕过 Orchestration
- CLI enforcement capability：`ClaudeCodeCliAgentAdapter` / `CodexCliAgentAdapter` 按版本声明 tool interception、confirmation、resume、cancel 与 isolation 支持；未知版本或不可拦截模式必须触发 descriptor/Policy 收窄，且不得伪报逐 Tool 强制授权已生效
- Adapter replacement：local 与至少一个替换 Tool/Workflow/Agent adapter 通过相同 contract/error/cancel/idempotency/recovery suite
- Durable boundary：Agent reasoning、raw tool args/output、provider run payload 不进入 RuntimeEvent、checkpoint、audit、crash dump 或 fixture

## Auth Session

- 首次登录只在浏览器人工输入
- 登录态可复用
- 登录过期会提示重新登录
- cookie/token 不出现在 prompt、日志、memory
- 非 allowlist 域名不能复用 auth profile
- redirect/punycode/相似域名/恶意网页指令不能绕过 allowlist 和 tool policy
- 敏感操作需要确认
- capability caveat：子流程只能收窄 origin/action/expiry/data limit，不能移除限制；跨 execution/agent/profile 重放失败
- 数据出口：下载 quarantine、跨域发送、popup/redirect 和超出 maxDataBytes 均被策略拦截或要求确认

## Enterprise Control Plane

- Identity federation：OIDC/SAML issuer、audience、nonce、signature、session expiry fixture；SCIM create/update/suspend/remove 幂等，外部 subject/group id 只经 `IdentityDirectoryPort` 映射，不成为权威外键
- Delegated admin：organization/project/environment 边界、role 收窄、成员移除、mid-execution membership change 与 break-glass expiry；任何目录变化都不能静默扩权
- Policy lifecycle：draft schema/semantic validation、双人审批、canary target、effective-policy inspection、production rollout、以新 revision 回滚；CLI/Web/API 同输入产生相同 `PolicyDecision`
- Plugin lifecycle：签名/SBOM/权限/依赖验证，`discovered -> validated -> approved -> active -> draining -> disabled -> removed` 全路径，in-flight invocation 固定版本，卸载依赖阻断与 rollback 保持权威数据
- Quota/FinOps：organization/project/principal 并发/token/cost 限额；`MeteringExportPort` 从稳定 cursor 幂等重放，export 故障不改写、不遗漏、不重复 UsageObserver ledger
- Compliance：region allowlist、cross-region deny、retention TTL、legal hold、export/purge completion evidence；驻留或 legal-hold 不确定时物理删除/移动 fail-closed
- Audit：管理读写本身进入审计；actor/scope/time/type 查询授权；签名 export 的完整性 checkpoint、过期与 recipient binding；AuditSink 故障阻断高影响写或在恢复界限内只缓冲脱敏签名事件
- Resilience：identity provider、Policy、AuditSink、MeteringExport、ObjectStore 分别故障注入；backup/restore 后校验 event chain、ledger revision、purge tombstone、legal hold 与 tenant isolation，测得 SLO/RTO/RPO
- Surface parity：同一管理操作经 Web/CLI/API 使用相同 core contract、approval、idempotency、错误码与 audit event；Web 的 loading/degraded/denied/partial-failure 不掩盖真实状态

## SLO / RTO / RPO

- 所有 [service-level-objectives.md](service-level-objectives.md) 在线路径在目标 profile 负载下输出 count/p50/p95/p99/error ratio/queue age，低样本量不得伪报 percentile
- availability 排除正确 policy deny、quota deny、validation error 与用户 cancel，但包含错误 fallback、错误 success、stale privileged state 和内部 timeout
- durable accept 后注入进程/主机/存储故障，验证 Usage ledger 与 accepted audit event `RPO=0`；确认前重试使用相同 idempotency key
- `team`/`enterprise` 按 cadence 执行数据库、AuditSink、Usage worker、Policy rollout、Identity provider、queue、ObjectStore、KMS 故障恢复并实测 RTO
- fast/slow error-budget burn、release freeze 与 hard safety regression 告警使用可控时钟 fixture 验证
- noisy-neighbor：单 tenant 达 quota、queue/export/index rebuild 上限不影响另一 tenant 的 latency、availability 或数据边界

## 检索质量与增强（Phase 0、5-10）

- 评测 harness：黄金集跑通，`forbiddenLeak=0`，`recall@10` 不低于 baseline（R11）
- 时序：事实被取代后默认只召回新值，`asOf` 查询返回历史快照（R12）
- 冲突：先 A 后 B 的单值事实正确 supersede；external 来源不触发取代只进 pending（R13）
- 图谱：两条 relation edge/三个节点查询（人→项目→事实）召回正确；实体别名不碎裂；图层关闭时回退无报错（R14）
- 回流：cited 提升有用率并影响 tiebreak；contradicted 触发消解且不误伤"否定做法"（R15）
- 三层：单轮只写 episode 不同步调抽取模型；蒸馏批量消费 `distilled_at IS NULL`（R16）
- Skill：满足 success criteria 的三个独立 run 才生成 validated skill；单独 exit code 0 不计成功；高危 skill 执行前必确认；external skill 不自动 active
- Planner：时间、实体、失败经验、约束和 Skill 查询生成正确 route；Planner 不能输出 SQL/user id 或越权 scope
- 主动回忆：受限 search 调用次数、条数和 token cap 生效；与 Pre-Read 使用同一过滤和排序路径
- 端到端：测量 memory-assisted accuracy、stale-memory error、unsupported personalization、abstention accuracy、temporal update accuracy 和 contradiction resolution accuracy
- Skill IR：每个步骤可回映 episode signature；sandbox replay/shadow 未通过时不能 active；环境指纹变化进入 needs_revalidation
- Shadow：candidate ranking/policy/compiler 只记差异，不改变生产 injected ids 或数据库状态
- 延迟分层：L0/L1/L2 分别满足预算；L3 不阻塞首次 prompt，也不迟到修改已发送上下文
- 图索引：删除 source Evidence 后边失效并可重建；所有注入 path 可回源 active Claim/Evidence；超预算查询确定性截断
- Utility：Judge 不能提高事实 confidence；counterfactual 只在异步采样队列执行并满足每日预算

## 长期仿真、复制与 Promotion

- 长期仿真：跨月偏好变化、项目切换、事实纠正、恶意网页、Skill 退化、成员撤销、设备离线冲突和 purge 场景可固定 seed 重放
- 演化指标：memory growth、duplicate、contradiction、profile drift、authority laundering、stale error、Skill degradation 和 purge completeness 达到基线
- 事件复制：离线设备产生并发 Evidence 后 deterministic materializer 收敛到同一状态；wall clock 不决定冲突胜负
- Team key：成员移除后不能解密新事件；key rotation 和 purge tombstone 能传播到已注册副本
- Artifact：删除 blob 后派生 Evidence/Claim/embedding 全部撤回或重算，无孤儿 Observation
- Promotion：rule/classifier/context adapter 撤销后行为回到 plaintext baseline；LoRA 未 opt-in 或评测不足时无法切 active

## 可观测性（R17/R18）

> 跨层传播契约见 [contracts.md §6](contracts.md#6-运行时可观测性契约跨层observability)：traceId 源自 `ExecutionContext.trace`，Surfaces→Orchestration→Execution→Transport→Memory→Learning 共用同一 traceId。

- 跨层链路：同一执行的 surface/execution/transport/memory/learning span 共享 traceId，`ai log --trace <id>` 能跨层按序还原，非仅 memory 内部
- Event catalog：每个 `RuntimeEventType + eventVersion` 有 valid/invalid fixture；自由 eventType、缺失 operationId/actor、错误 payload、unknown materializer version 均被拒绝或隔离
- Terminal invariant：execution/capability/tool/agent/transport 每个 operation 恰有一个 terminal；Workflow 多 checkpoint 后仍只有一个 terminal；replay 不重复 materialize
- Error catalog：每个 `RuntimeErrorCode` 的 `safeDetails` allowlist、retry classification、用户呈现和 audit redaction 有 fixture；raw provider body/stack/secret 无法进入 event
- Observation 调用链：一次执行的 `memory.plan→retrieve.route→filter→rank→budget→compile→inject` 与异步 `extract→candidate→conflict→write→feedback` 共用同一 `traceId`，`ai log --trace <id>` 能按序还原
- Observation schema：每个 `CapabilityObservationAction` 有 valid/invalid fixture；未知 action、超限数组、未注册字段、非 JSON value 和缺失 terminal status 被拒绝或确定性截断
- Capability tree：每个 resolved invocation 恰有 `capability.resolve→invoke→result`，Memory/Skill 专用 span 关联实际 Tool/Workflow/Agent/Model invocation，不产生第二个通用 terminal
- Memory explain：固定 fixture 可还原 `plan→retrieve.route*→filter→rank→budget→compile→inject`；逐 route 的授权过滤、hit/error/cache/fallback/latency 与最终 injected ids 一致
- Skill explain：固定 fixture 可还原 `match→select→apply→step*→outcome`；step 关联实际 invocation，confirmation/guardrail/deviation/postcondition 与执行证据一致，Agent 偏离不误记正向复用
- 异步因果：Post-Run、distill、validate、evaluation 使用同 trace 的 `continued_by/evaluated_by` link，不增加同步请求 duration，也不因 job retry 复制 attribution
- Query authorization：`summary/explain/internal` 三套 closed schema、tenant/scope/view/filter/cutoff-bound cursor、跨 scope deny、查询审计与过期 cursor；修改过滤器后复用 cursor 返回 `invalid_cursor`，普通用户不能看到 internal canonical id 或其他 principal/tenant trace
- Sampling/completeness：error/degraded/policy deny/high-impact/write/lifecycle/debug trace 不被 sampling policy 丢弃；normal/critical queue、reserved capacity、spool replay 与 exhaustion 有故障注入；`complete` 仅用于 closed/caught-up/no-gap trace，sampling 为 `sampled`，open/drop/lag/retention/missing-parent/corruption 为 `partial`
- Usage ownership：Cost & Latency fixture 按 operation/execution/invocation 关联，再由权威 RuntimeEvent 解析 upstream attempt；pending/unavailable/not-billable 可区分，Observation store 中 token/cost/ledger revision 复制数为 0
- 指标基数：自动扫描 metric labels，拒绝 trace/execution/principal/project/memory/skill/invocation id；只允许注册的低基数 label
- Sink 故障：queue full、JSONL 锁超时、OTLP timeout、exporter crash 时 drop metric 增长，Memory/Skill/Usage/response bytes/Policy/retry owner 与无 Observability baseline 一致
- 开销：同步 `tryEmit` 在目标负载下 p95≤2ms、p99≤5ms；Observation 不进入 prompt、Context Compiler token budget 或 durable Memory job 正文
- Observation 脱敏：`memory.*` payload 不含 memory 正文与 secret，`content` 只出现长度/hash
- 守卫调用链：非私聊命中 `memory.skip` 且 reason=`non_private`，不产生 retrieve/inject Observation（R7）
- Telegram 中间态：私聊显示 `🧠 回忆中/已调用 N 条`，N 与 `memory.inject` Observation 一致；非私聊不显示任何记忆态
- Emoji 不冲突：引擎思考态为 `⏱️`，`🧠` 仅记忆、`🧩` 仅技能、`📝` 仅写入；三处文档与 `Formatter.progress` 一致
- 技能态：命中 active skill 显示 `🧩 套用《名》`（同步）；蒸馏出 validated/active skill 显示 `🧩 沉淀《名》`（异步，candidate 不提示）；只显 name 不显 steps
- 中间态不泄内容：进度消息不出现记忆/技能正文、步骤、id、分数；`📝`/`🧩 沉淀` 为异步追加，不阻塞回复（R2）

## 相关文档

- [roadmap.md](roadmap.md)
- [enforcement-decisions.md](enforcement-decisions.md)
- [00-overview.md](00-overview.md)
