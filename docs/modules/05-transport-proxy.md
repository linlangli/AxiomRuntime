# ⑤ Transport Proxy 传输代理

> 本文档遵循 doc_2.0 **统一模块模板**（定位→职责边界→端口→依赖→数据所有权→可插拔点→降级→产品化就绪度→现状映射→验收）。其余模块文档同构。
> 语言：中英混合，标识符英文原样。术语见 [../glossary.md](../glossary.md)。

## 1. 定位（一句话）

单一数据平面：为每次执行提供**唯一** listener / route / upstream，转发请求、观测用量、注入记忆——一个 provider-agnostic 的 Runtime Transport Proxy。

## 2. 单一职责边界（高内聚）

**拥有**：本地监听、route lease、已验证 upstream 连接、header 策略、兼容转换（Responses/Chat）、streaming、backpressure、隔离的扩展分发。

**禁止拥有**（划清边界，防 god-module）：
- **禁止**做 provider 选择（属 ③ provider-routing）。
- **禁止**做记忆策略/学习决策（属 ⑥/⑦）。
- **禁止**加第二个 Memory HTTP 代理，**禁止**链式 `Memory Proxy → Usage Proxy → provider`。
- **禁止**把原始 header/prompt/reasoning/tool 参数写入持久层。

## 3. 内部构件与各自单一职责

| 构件 | 单一职责 | 铁律 |
|---|---|---|
| `transport-core` | 解码、路由、upstream、streaming、字节投递 | 唯一 listener/route/upstream |
| `TransformCoordinator` | 唯一请求变更者：canonical AST → Memory patch → 兼容 transform | manifest 外路径**必须**语义不变 |
| `UsageObserver` | 唯一用量/成本写入者 | 对 payload 只读；唯一写 `usage.json` |
| `MemoryExtension` | 有界观测 + allowlist 指令注入 | **禁**拥有 listener、**禁**转发、**禁**写第二份用量账 |

## 4. 对外/消费端口（可插拔点）

- 暴露：`TransportRouteLease`、`TransportExtension`、`TransportTransformManifest`。
- 消费：`SanitizedTurnEnvelope` / `SanitizedExecutionEnvelope`（向 ⑥/⑦ 提供脱敏证据）。
- 扩展以 `TransportExtension` 注册；`UsageObserver` 与 `MemoryExtension` 互不依赖，任一崩溃**禁止**拖垮 Facade。

## 5. 依赖（低耦合）

只 import `L0 Contracts`。**禁止** import provider-routing / memory 的具体实现——它们通过契约与事件交互。兼容 facade `startOpenAiUsageProxy()` 仅作单一数据平面之上的视图，**禁**保留第二个 server。

## 6. 数据所有权

- `UsageObserver` 独占 `usage.json` 与计量状态；幂等键由 `executionId+requestId+attemptId+provider event id+seq` 派生，兼容重试/CLI 重试/replay **禁止**重复计费。
- 任何 recovery journal 有界、TTL 控制，只含 allowlist 计量元数据与 hash。

## 7. 降级 / kill switch

- Transport mode：`stopped | usage_only | extensions`。
- Memory mode：`disabled | passthrough | shadow_capture | read_only | full`，两者**独立**。
- Memory 健康只能**收窄** Memory mode，**禁止**因此关掉已验证 Usage 或兼容行为；模型**禁止**放宽 mode 或闭合 circuit。
- Memory worker 故障 → 收窄/禁用 Memory，forwarder 继续；forwarder 进程整体故障可失败当前 TCP 请求，supervisor 恢复 listener，**禁**谎报透明续传或伪造学习证据。

## 8. 产品化就绪度（可否独立成产品）

**✅ 最强候选**（对标 LiteLLM/OpenRouter），差异化在"用量成本账 + 治理注入钩子"。跨线需补：①in-process Port 的**网络版契约**(HTTP/gRPC)；②自持配置 schema；③独立发版 SDK；④依赖闭包隔离；⑤自身边缘 authN/authZ。dogfooding：Runtime 自身也通过同一契约消费它。判据见 [../extraction-readiness.md](../extraction-readiness.md)。

## 9. 现状映射

`src/core/runner/openai-usage-*.ts`（约 6 文件，职责耦合）→ 按职责拆为 `transport-core` / `TransformCoordinator` / `UsageObserver` / `MemoryExtension` / 兼容 facade。Codex 传输 facade 保留 execution-scoped dispatcher、禁 keep-alive 复用、45s header 截止、双超时短路。

`src/server/runtime-server.ts` 新增常驻内网入口：Bearer 鉴权后仅转发 allowlist 中的 `/v1/chat/completions`、`/v1/responses` 与 `/v1/embeddings`，按 model catalog、优先级和 circuit 状态选择 provider，并在尚未开始下游 streaming 时对 provider/transient failure 进行 fallback。现有执行期 `startOpenAiUsageProxy()`、CLI 与 Telegram 调用路径保持不变。

## 10. 验收标准

- 一次执行只创建 1 listener + 1 upstream route；facade 保留原 records/metrics/translation/error 行为。
- 杀 parser/extension worker 不中断当前 provider 流；杀 forwarder 不制造假成功，下条请求被 supervise 回已知态。
- 持久传输证据**不含**原始 authorization/system prompt/reasoning/raw tool 参数。
- memory-disabled 模式下全链路成功、usage 准确；注入 Memory 故障，主链路与 usage 不受影响。
- Memory 注入不超出批准的 prompt-cache / effective-cost / 延迟回归阈值。

## 11. 相关文档

- 权威边界（英文）：[../AI_RUNTIME_ARCHITECTURE.md](../AI_RUNTIME_ARCHITECTURE.md) §4 Unified Runtime Transport Proxy Boundary
- 整体架构：[../00-overview.md](../00-overview.md)｜契约：[../contracts.md](../contracts.md)
- 量化服务等级：[../service-level-objectives.md](../service-level-objectives.md) §3–6

---

# 附：用量事件存储（从 SPEC.md 迁入）

> **Appendix Status: MIGRATION FIXTURE** — legacy `usage.json` 形状只用于 parity/migration；权威事件与 error 以 `contracts.md` 为准。
>
> UsageObserver 的持久化产物。标识符与配置键英文原样。

## A. `usage.json`

默认路径 `~/.ai-gateway/usage.json`。存 token 用量事件，供 CLI status、web 图表与未来桌面统计使用。

```json
{ "events": [{
  "provider": "51talk", "tool": "codex", "model": "gpt-5.5",
  "source": "doctor_deep",
  "inputTokens": 1200, "outputTokens": 800, "totalTokens": 2000,
  "createdAt": "2026-07-04T05:40:00.000Z"
}] }
```

## B. 硬规则

- **只**记录 provider 真实返回的 usage 数据；下游 CLI 不暴露结构化 usage 时**不得**估算 token。这与 ⑤ 的定位一致：Transport Proxy 是唯一权威用量点，成本账基于真实计量而非猜测。
- 日志（`.ai-gateway.log`, JSONL）**不得**存完整 API key；含 key 的命令参数写日志前**必须**掩码。

## C. 双路径采集（回顾）

Claude 路径读 JSON stream 的 `cost_usd/total_cost_usd`；Codex 路径经代理拦截解析 Response headers/body。两者归一为 `TokenUsage` 后经 `recordProviderUsage()` 落库。目标态：两路径统一到单一 Transport Proxy 的 UsageObserver listener，消除双代理与重复解析。

---

# 附：统一接入与 Transport Proxy 执行协议（从 memory-system-spec 迁入）

> **Appendix Status: SUPPORTING SPEC** — 详细协议服从正文“单一数据平面”ownership 与 L0 transport contract。

> 本附录为 Runtime Transport Proxy 最详尽的执行协议，逐字迁自 `memory-system-spec.md`。权威强制实施决策见 [../enforcement-decisions.md](../enforcement-decisions.md)（尤其 R26 `ProtocolExchange`、R34 Transport Proxy）。所有状态机、TypeScript / SQL 代码块与 MUST/禁止/必须 条款按原文保留，不做压缩。

## Telegram 与 ai use 的统一接入

### 统一执行上下文

```typescript
type AiExecutionContext = {
  userId: string;
  source: "telegram" | "cli" | "browser" | "scheduler";
  interaction: "proxy" | "native";
  botId?: string;
  projectId?: string;
  cwd?: string;
  engine: "claude" | "codex";
  provider?: string;
  model?: string;
  sessionId?: string;
  conversationId: string;
  privacyMode: "normal" | "no_read" | "no_write" | "incognito";
  capabilities: {
    preReadInjection: boolean;
    postRunCapture: boolean;
    perTurnHooks: boolean;
  };
};
```

> `interaction` 区分两种接入方式：
> - `proxy`：通过单一 Runtime Transport Proxy spawn CLI；UsageObserver 保留现有统计，MemoryExtension 提供逐 turn Pre-Read 注入和 Post-Run 捕获。所有入口默认使用此模式。
> - `native`：CLI `--native` 模式，绕过 proxy 直连上游；优先使用 session-start 只读注入，无法注入时使用临时只读 MCP 按需检索，不支持 Post-Run。

> `userId` 是**规范化后的 canonical account id**，不是原始来源 id。原始来源 id（telegram chat id / OS user）先经身份绑定映射到 canonical id，否则 `global` 记忆会按来源碎裂，无法跨 Telegram↔CLI 共享。详见「风险与强制实施决策 R1」。

Telegram：

- `sourceUserId = telegram chat/user id` → 映射为 canonical `userId`
- `botId = Telegram bot token 派生 id`
- `projectId` = 按「数据存储 · project_id 派生」规则计算（Telegram）

CLI：

- `sourceUserId = local OS user 或 AI Gateway profile id` → 映射为 canonical `userId`
- `botId = cli profile / 默认 default`
- `projectId` = 按「数据存储 · project_id 派生」规则计算

### Runtime Transport Proxy 与 Memory Extension 执行协议

完整自动记忆要求 Runtime 能看到每轮 prompt、最终回复和结构化工具事件。项目已经存在 `startOpenAiUsageProxy()`、Responses→Chat compatibility translation、usage records 和 metrics；因此禁止再串联或并行启动独立 Memory HTTP Proxy。目标方案是把现有 OpenAI Usage Proxy 增强为 provider-agnostic **Runtime Transport Proxy**，并将“Memory Proxy”定义为其中的逻辑 `MemoryExtension`。

#### 唯一数据平面与职责归属

| 组件 | 唯一职责 | 禁止事项 |
|------|----------|----------|
| `TransportForwarder` | listener、route lease、header policy、上游连接、流式转发、timeout/backpressure | 不解析业务记忆，不写 usage/memory，不调用模型 |
| `TransformCoordinator` | 规范化协议 AST、按固定顺序应用声明式 patch、生成 transformation manifest | 扩展不得直接改 raw body 或自行转发 |
| `CompatibilityTransform` | 保留现有 OpenAI Responses↔Chat 兼容能力和响应映射 | 不承担 usage 计费或记忆抽取 |
| `UsageObserver` | 从 canonical/actual provider event 提取 usage、cost 和现有 metrics | 只读 observer，不修改请求、响应和 Memory 状态 |
| `MemoryExtension` | 请求 Pre-Read patch、旁路接收已关联 turn、生成 sanitized Post-Run enqueue 请求 | 不拥有 listener/upstream，不保存 raw header/body，不签发 capability |
| `RedactionGateway` | 把 ephemeral capture 转成可持久化 envelope，递归 secret/data-class 扫描 | 未脱敏内容不得进入 job/event/log |
| `ExtensionWorker` | 每个故障域承载单一 observer 或非关键 response parser，并执行 bounded capture | 不持有监听端口；Usage 与 Memory 不共享故障队列；崩溃不得中断 forwarder |

每个 execution 只能存在一个 listener、一个 upstream route 和一次 `*_BASE_URL` 覆写。Usage 与 Memory 不允许各自创建 server，也不允许通过“Memory Proxy → Usage Proxy → Provider”链式转发。所有请求变换只能通过 `TransformCoordinator`，每个 patch 声明 owner、允许 JSON path、before/after hash 和 rollback；未声明路径变化立即阻断该 patch 并退回原始请求。

现有 Usage Proxy 不能整体作为 `UsageObserver` 搬迁，因为它还包含关键传输职责。编码时必须按以下 ownership 拆分，且每个状态只能有一个写入者：

| 现有职责 | 目标唯一 owner | 迁移约束 |
|----------|----------------|----------|
| listener、base URL、upstream route、header policy、字节转发 | `TransportForwarder` | 原位迁移到单一 server；禁止 facade 和新 Transport 同时监听 |
| 请求协议识别、Responses↔Chat/Provider compatibility、原生 Responses 单次重试 | `CompatibilityTransform` + `TransformCoordinator` | 属于关键 Transport 路径；不能下放给 Usage/Memory observer，也不能因 Memory 故障关闭 |
| usage 归一化、cost source、records、metrics、`usage.json` | `UsageObserver` | 唯一账本和唯一 counter owner；旧 facade 只返回其视图 |
| Pre-Read、注入 manifest、turn capture、Post-Run enqueue | `MemoryExtension` | 不计算 billable usage、不写 usage ledger、不独立做 provider fallback |
| 旧 `startOpenAiUsageProxy()` API | `asOpenAiUsageProxyFacade` | 聚合 Transport route + UsageObserver view；不保留独立 server/state/persistence |

canonical event 必须携带 `executionId + logicalRequestId + upstreamAttemptId + providerEventId? + sequence`。Usage 的幂等键以实际 upstream attempt 为核，兼容协议重试、CLI 重试、worker 重放和 supervisor 恢复都不能重复计费或重复增加 metrics；每个 attempt 只有一个 terminal outcome，观察到 usage 时最多产生一次 usage/cost contribution，成功但无 usage 时沿用现有 `noUsage` 语义，不能捏造 cost。逻辑请求总览与实际 attempt 账单分开建模，不能为了“每个 turn 一条”吞掉真实重试成本。

Usage 与 Memory 从同一 canonical event source 使用两个独立有界 channel。Memory channel 满、parser/Memory worker 崩溃或 memory circuit 打开不得丢弃 Usage event。Usage channel 必须优先保留最终 usage/provider header 和 attempt 终态，并通过 bounded journal 或 response completion reconciliation 恢复；journal 只允许写 TTL 受控的计量 metadata、状态和 hash，不得写 raw header/body/response。如果仍无法恢复，则 `usageStatus=degraded`、记录 gap 指标并阻止 parity/healthy 声明，不能静默补零或让 Memory 推测 token/cost。

固定请求顺序：

```text
client bytes
  -> protocol detect + canonical AST
  -> resolve compatibility profile and target upstream protocol
  -> MemoryExtension proposes bounded instruction patch
  -> TransformCoordinator applies memory patch to canonical AST
  -> CompatibilityTransform maps canonical AST to actual upstream protocol
  -> TransportForwarder sends one upstream request

provider bytes
  -> TransportForwarder writes downstream immediately
  -> canonical event distributor
     -> bounded Usage channel -> UsageWorker records usage/cost
     -> bounded Memory channel -> MemoryWorker builds sanitized execution evidence
```

Memory 必须在 canonical AST 层注入，再由 compatibility transform 转换到上游协议，避免现有 Responses→Chat fallback 丢失或重复插入记忆。Usage Observer 同时读取 actual provider usage 和 canonical response mapping，但只能产生 usage event，不能参与 Memory confidence 或 activation。

#### 现有 Usage Proxy 的兼容迁移

现有公开接口在迁移期间保持不变：

```typescript
type OpenAiUsageProxy = {
  baseUrl: string;
  close(): Promise<void>;
  getRecords(): OpenAiUsageProxyRecord[];
  getMetrics(): OpenAiUsageProxyMetrics;
};

async function startOpenAiUsageProxy(input: StartOpenAiUsageProxyInput): Promise<OpenAiUsageProxy> {
  return startRuntimeTransportProxy({
    route: resolveOpenAiRoute(input.provider),
    compatibility: "preserve-current-openai-behavior",
    extensions: { usage: { input }, memory: { mode: "disabled" } }
  }).then(asOpenAiUsageProxyFacade);
}
```

迁移不删除 Responses→Chat translation、provider fallback compatibility、usage.json 写入、cost source、records、现有 metrics 或测试。`openai-usage-proxy.ts` 继续作为兼容 facade；旧调用方无需同时理解 MemoryExtension。只有在统一数据平面通过旧测试、透传 fixture 和 metrics parity 后，`openai-usage-server.ts` 内部实现才可以委托或迁移，禁止大爆炸替换。

迁移阶段：

1. **Transport parity**：统一 forwarder 以 `usage-only` 模式复现当前 API、translation、records、metrics 和错误语义，现有测试零修改通过。
2. **Shadow observer**：MemoryExtension 只在 worker 中解析和对比，不注入、不落语义记忆；Usage 行为保持 production。
3. **Read-only injection**：仅批准的 compatibility profile 启用 memory patch，Usage Observer 继续在同一 response event bus 计量。
4. **Full learning**：Post-Run durable enqueue 通过门槛后启用；旧 facade 保留至少一个兼容周期，内部不再拥有第二个 server。

#### 数据平面与扩展进程隔离

`TransportForwarder` 必须保持小而稳定，只执行本地 HTTP 接入、上游路由和流复制。非关键 response parser、UsageObserver、MemoryExtension、NLI/抽取和压缩不进入 forwarder 同步执行栈；它们在独立 child worker 或等价故障隔离单元运行，通过各自有界 IPC 接收复制数据。转发前不可缺少的 request protocol decode、TransformCoordinator 和批准的 CompatibilityTransform 属于受监督的关键 Transport 路径；它们失败时必须使用已验证的原始兼容路径或明确失败，不能猜测式转发。

- 下游 chunk 先写入 CLI，再 best-effort 投递 worker；observer 背压不能反向阻塞 provider stream。
- Memory worker 队列达到上限时停止 capture 并标 `capture_truncated`，Memory 只落 episode-only 或跳过；独立 Usage channel 仍保留 provider header、最终 usage 小事件和 attempt 终态。
- Memory worker 崩溃时 supervisor 立即把 Memory 收窄为 passthrough，forwarder、当前 stream 和 Usage channel 继续。Usage worker 崩溃单独标记 `usageStatus=degraded`，从 bounded journal 重放或按完成响应对账，不能由 Memory worker 代记。
- forwarder 自身进程崩溃时，当前 TCP request 无法保证存活，必须如实返回/表现为网络失败；supervisor 为下一请求重启 listener，CLI 是否重试由其原生策略决定。禁止把“整个数据平面进程死亡”描述为当前请求可透明恢复。
- 数据平面不直接消费 durable learning jobs；Post-Run enqueue 成功后即释放 capture 引用。

“故障注入一个请求内进入 passthrough”仅适用于 parser、extension、policy、Pre-Read 和 compatibility profile 故障；forwarder 进程死亡的门槛是当前请求确定失败、无错误 active memory、下一请求自动恢复或明确要求重启会话。

#### Ephemeral Capture 与持久化 Envelope

原始 header、system/developer instructions、完整消息、reasoning、tool arguments 和 tool output 只能存在于 `EphemeralTransportExchange`，不得直接作为 `SanitizedTurnEnvelope` 或 job payload 持久化：

```typescript
type EphemeralTransportExchange = {
  routeLeaseId: string;
  rawRequestBody: Uint8Array;
  rawResponseWindow: Uint8Array[];
  sensitiveHeaders: Map<string, string>;
  parserState: unknown;
};

type SanitizedTurnEnvelope = {
  executionRunId: string;
  turnId: string;
  protocol: ProtocolKind;
  request: {
    model: string;
    systemHash: string;
    toolSchemaHash?: string;
    sanitizedContentRef?: string; // TTL 加密，仅保留抽取所需 provenance segments
  };
  response: {
    sanitizedTextRef?: string;    // TTL 加密，不保存 reasoning
    toolCalls: Array<{
      idHash: string;
      name: string;
      argumentsHash: string;
      outputHash?: string;
      ok?: boolean;
    }>;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  };
  injectionManifestId?: string;
  requestCount: number;
  captureState: "complete" | "truncated" | "partial" | "unknown";
  startedAt: number;
  finishedAt: number;
};
```

`SanitizedExecutionEnvelope` 只是 execution 级聚合：引用一个或多个 `SanitizedTurnEnvelope`、route/attempt 终态和脱敏指标，不复制 raw transport content。两者共用 RedactionGateway 与 persist-schema allowlist，不允许各自形成内容持久化路径。

RedactionGateway 必须递归扫描 request system/instructions/input/messages、assistant text、reasoning container、tool arguments/output、附件 metadata 和 URL；默认不持久化 reasoning、完整 system prompt、tool schema、raw header 和 raw tool output。需要抽取的 user/assistant 片段先按 provenance 分段、secret/data-class 扫描，再写 TTL 加密 content ref。Buffer 在 forward/enqueue 完成后 best-effort `fill(0)` 并释放引用；实现不得宣称 JavaScript 进程内可证明安全擦除，因此企业高敏模式必须使用短生命周期隔离 worker。

#### Route Lease、回环与本地信任边界

```typescript
type TransportRouteLease = {
  id: string;
  routeNonce: string;
  expectedParentPid: number;
  expectedEngine: "claude" | "codex";
  osUserId: string;
  upstreamOrigin: string;
  expiresAt: number;
  maxConnections: number;
};
```

优先使用 `/r/<128-bit-nonce>/v1/...` 路径并在转发前剥离 route prefix；compatibility fixture 必须证明 CLI 接受带 path prefix 的 base URL。不支持 path prefix 时使用 execution 独占随机端口、父进程存活窗口和短 TTL，但必须记录“同 OS 用户进程可信”的剩余风险。Node.js loopback TCP 不能可靠证明对端 PID；同一 OS 用户下的恶意进程不属于随机端口能够解决的威胁。

企业多租户不得让不互信租户共享同一 OS 用户和 Proxy listener，必须使用独立 OS user、容器/network namespace 或等价隔离。Runtime 启动时维护 active listener registry；规范化 `localhost/127.0.0.1/::1` 后若 upstream 指向自身或另一个未声明 Runtime Proxy，返回 `PROXY_ROUTE_LOOP`。内部 hop/lease metadata 不发送给 Provider，Authorization 和 Provider API key 只在 forwarder 内按 route 注入。

#### Prompt Cache 与行为稳定性

Memory injection 会改变 system/instructions，可能降低 provider prompt-cache 命中、增加首 token 延迟和费用。每个 compatibility profile 必须规定：

- 稳定、版本化的 memory policy prefix，不包含 timestamp、trace id、随机 id 或每 turn 变化字段；
- dynamic memory block 位于稳定 CLI instructions 和工具定义之后的允许位置，顺序使用 canonical sort；
- provider 支持显式 cache boundary 时只缓存稳定 prefix，不缓存 dynamic block；不支持时依靠最长稳定前缀并记录真实 cache usage；
- retry/continuation/compaction 复用同一 injection manifest，避免无意义 cache bust；
- 分别测量 cache read ratio、cached/uncached input tokens、time-to-first-token、effective input cost 和 task quality。

默认发布门槛：相对无 Memory baseline，cache read ratio 不下降超过 5 个百分点、effective input cost 不增加超过 10%、TTFT p95 不增加超过配置阈值；超过任一门槛时先缩小动态块、降低注入频率或退回 read-only/on-demand。只有版本化 Learning Objective 明确接受成本换质量且无安全回归时才能通过例外 ADR。

所有入口（Telegram、CLI、Scheduler）统一通过 spawn CLI + Proxy 执行：

- **Telegram**：spawn CLI（headless `--output-format stream-json` 模式），通过 Proxy 注入记忆，同时解析 stdout 做进度展示。
- **CLI `ai use`**：spawn CLI（原生 TUI 模式），通过 Proxy 注入记忆，用户看到原生终端交互。
- **`--native`**：绕过 Proxy 直连上游，仅支持只读注入，不支持 Post-Run。

#### 架构

```text
所有入口共用：
  → 启动单一 Runtime Transport Proxy (随机端口，仅 127.0.0.1)
  → spawn CLI 子进程
     env: ANTHROPIC_BASE_URL=http://127.0.0.1:{port}  (Claude Code)
     env: OPENAI_BASE_URL=http://127.0.0.1:{port}     (Codex)
     env: 原始 API key 不变
  → CLI 正常运行，完全不知道被代理

数据流：
  CLI → Proxy(收到 request)
    → Pre-Read: 注入记忆到 system message
    → 转发到真实上游 Provider URL
  Provider → Proxy(收到 streaming response)
    → 逐 chunk 透传回 CLI（不等待完整解析；单独计量本地转发开销）
    → bounded IPC 旁路复制给隔离 ExtensionWorker
  流结束 → Post-Run: enqueuePostRun() 入队
```

#### 上游 URL 还原

Orchestrator 在覆写 `*_BASE_URL` 前只解析一次 Provider route，并把规范化 upstream origin 与 opaque key ref 传入数据平面。Transport Proxy 不从已被覆盖的环境变量反推上游，也不把另一个本地 Runtime Proxy 当成合法 upstream：

```typescript
type RuntimeTransportProxyConfig = {
  listenPort: number;
  routeLease: TransportRouteLease;
  upstream: {
    providerId: string;
    origin: string;
    apiKeyRef: string;
    allowedProtocols: ProtocolKind[];
  };
  extensions: {
    usage: "disabled" | "enabled";
    memory: "passthrough" | "shadow_capture" | "read_only" | "full";
  };
};
```

`origin` 必须来自经过现有 Provider schema 校验的配置快照；Proxy 只允许在该 origin 下拼接 adapter 批准的 endpoint。默认 OpenAI/Anthropic URL 由 Provider resolver 决定，不在 transport 层再次猜测。active listener registry 和 route loop detector 在 server listen 前完成校验。

#### 核心接口

```typescript
type EphemeralParsedTurn = {
  engine: "claude" | "codex";
  turnId: string;
  request: {
    model: string;
    instructionHash: string;
    toolSchemaHash?: string;
    segments: ProvenanceSegment[];
  };
  response: {
    segments: ProvenanceSegment[];
    reasoningHash?: string;
    toolCalls: Array<{ id: string; name: string; input: unknown; output?: unknown }>;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  };
  injectedMemoryIds: number[];
  injectedSkillIds: string[];
  requestCount: number;
  startedAt: number;
  finishedAt: number;
};

type ProtocolKind = "openai_responses" | "openai_chat" | "anthropic_messages";

type ProtocolExchange = {
  exchangeId: string;
  executionRunId: string;
  protocol: ProtocolKind | "unknown";
  requestFingerprint: string;
  conversationFingerprint?: string;
  previousResponseId?: string;
  turnId?: string;
  relation: "new_turn" | "continuation" | "retry" | "compaction" | "unknown";
  streamState: "started" | "completed" | "cancelled" | "failed";
  startedAt: number;
  finishedAt?: number;
};

type CorrelationSignals = {
  protocolIds: string[];
  previousResponseId?: string;
  userContentHash?: string;
  toolParentIds: string[];
  completionSignal?: string;
};

type ProtocolItem = {
  id?: string;
  kind: "text_delta" | "reasoning" | "tool_call" | "tool_result" | "usage" | "completion" | "unknown";
  payload: unknown;
  rawHash: string;
};

type CaptureLimits = {
  maxBytesPerItem: number;
  maxBytesPerTurn: number;
  maxItemsPerTurn: number;
};

interface IncrementalTurnParser {
  push(chunk: Uint8Array): ProtocolItem[];
  finish(state: "completed" | "cancelled" | "failed"): Partial<EphemeralParsedTurn>;
}

interface ApiAdapter {
  protocol: ProtocolKind;
  detect(req: IncomingMessage, body: unknown): boolean;
  detectEngine(req: IncomingMessage): "claude" | "codex" | null;
  injectMemory(body: unknown, memoryBlock: string, profile: ProxyCompatibilityProfile): unknown;
  createStreamParser(limits: CaptureLimits): IncrementalTurnParser;
  extractCorrelationSignals(body: unknown): CorrelationSignals;
  getUpstreamPath(req: IncomingMessage, profile: ProxyCompatibilityProfile): string;
}
```

`ApiAdapter` 负责单个协议的语法解析，`TurnCorrelator` 负责跨请求关联，禁止由 adapter 仅凭最后一条 message 独自决定 turn。Proxy 同时维护 API Capture 和 Execution Capture：前者解析请求/流/tool item，后者记录进程、cwd、exit、文件/outcome；协议解析失败时仍保留 execution episode，但不得生成未经验证的完整 turn。

#### Turn 边界判定

Claude Code / Codex 在一次用户输入中可能产生多次 API 请求（模型请求 tool → CLI 执行 → 结果回传 → 模型继续），也可能 retry、resume、compact 或切 provider。Proxy 使用三层信号判定：

1. **Execution marker**：Orchestrator 为本次用户输入创建 `executionRunId/turnSeed`，能注入本地 header 或环境 metadata 时优先使用。
2. **协议关联字段**：OpenAI `previous_response_id`、response/item/call id，Anthropic message/tool_use/tool_result id，以及 provider 会话字段。
3. **内容指纹与状态机**：规范化 user content hash、tool result parent id、请求历史后缀 hash、流完成状态和时间窗口共同判断。

单纯 `messages[-1].role === "user"` 或 Responses `input` 的末尾 role 只能作为弱信号。相同 request fingerprint 在退避窗口内重发判为 retry；历史被压缩或 system 内容变化但 user turn seed 不变判为 compaction；无法确定时 relation=`unknown`，该 exchange 透传并记录 execution episode，不做自动 semantic write。

- **Pre-Read 注入策略**：仅对状态机确认的 `new_turn` 第一次 exchange 注入；continuation/retry/compaction 继承当前 turn 的 injection manifest。
- **Post-Run 收集**：收到协议级完成事件后进入短暂 settle window；若出现关联 continuation 则继续累计，否则由 EphemeralParsedTurn 经 RedactionGateway 生成 SanitizedTurnEnvelope。连接关闭不是成功完成的充分条件。
- **幂等**：`turnId + requestFingerprint + protocol item id` 作为事件幂等键；retry 不能重复落 tool call、episode 或 extract job。

#### API 格式适配

| | Anthropic Messages (Claude Code) | OpenAI Responses (Codex 默认) | OpenAI Chat Completions（兼容） |
|--|--|--|--|
| 拦截端点 | `POST /v1/messages` | `POST /v1/responses` | `POST /v1/chat/completions` |
| 注入位置 | `body.system` 末尾追加 text block | 合并到 `instructions` 或在 `input` 前置受控 system/developer item，按 compatibility profile 固定一种 | `body.messages` 中受控 system/developer message 末尾追加 |
| 流式格式 | SSE `content_block_*` / `message_*` | typed SSE `response.*` / `response.output_*` | SSE `data: {"choices":[...]}` |
| Tool calls | `content[].type = "tool_use"` + `input_json_delta` | `response.output_item.*` 的 `function_call` + `response.function_call_arguments.delta` | `choices[].delta.tool_calls` |
| 完成信号 | `message_stop` | `response.completed` | `[DONE]` 且 choice finish state 完整 |
| 新 turn 强信号 | 新 user content + execution marker；末尾 role 只是弱信号 | 新 user input + execution marker；`previous_response_id` 用于 continuation 关联 | 新 user message + execution marker；末尾 role 只是弱信号 |

非标准 Provider 只允许按 endpoint、Content-Type 和已批准 compatibility profile 识别；无法识别时透传不注入。OpenAI Responses 的 `instructions` 与 `input` 注入方式不能在运行时猜测，必须由 fixture 证明 Provider 保留字段、角色和工具语义后写入 profile。

协议比 CLI 人类可读输出更适合适配，但仍会新增事件类型、字段和 provider 扩展，必须按版本化兼容层治理，不能假定零耦合。

#### 协议 Fixture Corpus 与回放

每个 adapter 必须维护脱敏 fixture corpus，至少覆盖：普通文本、流式文本、单/并行 tool call、arguments 多 delta、tool continuation、reasoning item、retry、429/5xx、连接中断、用户取消、compaction、resume、unknown event 和 provider extra field。fixture 同时包含原始 request、SSE/event stream、期望 `ProtocolExchange`、期望 canonical events、期望 SanitizedTurnEnvelope 和透传字节 hash。

新增协议或升级 adapter 前必须执行 replay：

- 未识别字段仍原样透传；
- 解析器不能改变上游/下游字节语义；
- tool item 不重不漏；
- turn relation、streamState 和 result 符合 fixture；
- 失败 fixture 不产生 active memory；
- 旧 fixture 全部通过后才能更新 adapter version。

#### 非标准 Provider 处理

如果 provider 使用非标准 API 格式（既不是 Anthropic Messages、OpenAI Responses，也不是 OpenAI Chat Completions），`detectEngine()` 返回 `null`，proxy 行为降级为：

- 请求和响应**原样透传**，不注入记忆
- 不捕获 response，本 turn 不产生 Post-Run
- 写 `memory.skip` 日志（reason=`unknown_api_format`）
- CLI 正常使用不受影响

这保证了 proxy 不会因为不认识的格式而破坏 CLI 执行。

#### 实现要点

1. **生命周期**：proxy 监听 `127.0.0.1` 随机端口，仅接受本地连接。Telegram 常驻进程中 proxy 随进程启动持续运行；CLI `ai use` 中 proxy 随命令启动/退出，用 `process.on('exit')` 确保不留孤儿。
2. **Pre-Read 时机**：proxy 收到新 turn 的第一个请求时，同步调用 `memoryService.preRead()`，将返回的记忆块注入 system message 后再转发上游。Pre-Read 默认 deadline 300ms，超时则不注入记忆但继续转发（fail-open）。
3. **流式透传**：proxy 逐 chunk 转发 SSE 给 CLI，不等待完整解析；`TurnCollector` 旁路增量组装，设置内存/单 item/总响应上限，超长内容只保存类型化摘要和 hash。
4. **Post-Run 时机**：协议级 `response.completed/message_stop/[DONE]` 进入 settle window；确认没有 continuation 后完成 ephemeral parse，经递归脱敏后才构造 SanitizedTurnEnvelope。连接关闭分别映射 cancelled/failed/abandoned，不能一律视为完成。
5. **Session 与权限**：CLI 原生处理 session resume、工具权限提示、SIGINT。proxy 不干预这些交互。
6. **Provider fallback**：CLI 内部决定 provider 切换。Proxy 对每个 HTTP 请求独立处理，不感知 CLI 的 fallback 逻辑。
7. **SIGKILL 恢复**：proxy 在收到第一个 API 请求时写 `execution_runs(status=running)`，正常结束或超时后更新状态。进程异常退出时下次启动将遗留 run 标记 `abandoned`。
8. **会话空闲判定**（R2 debounce）：以"距离上次 API 请求流结束"计时。超过 `debounceMs`（默认 5 分钟）无新请求，视为会话空闲，触发 extract job 消费。
9. **Adapter registry**：按 `protocol + adapterVersion + providerCompatibilityProfile` 选择适配器；provider 特例只允许在 registry profile 中声明，禁止散落条件分支。

#### Proxy 安全规则

Proxy 位于 CLI 与 API 之间，能看到完整请求和响应：

- **API key 脱敏**：`Authorization` / `x-api-key` header 不写入任何日志、SanitizedTurnEnvelope 或 job payload。
- **Envelope 脱敏**：RedactionGateway 递归扫描全部 request/response/tool/attachment 字段；只允许 schema allowlist 字段、hash 和 TTL 加密 content ref 进入 SanitizedTurnEnvelope。
- **不缓存请求体**：Pre-Read 注入后的 request body 只存在于转发的网络流中，不落盘。
- **本地限定**：仅绑定 `127.0.0.1`，不接受远程连接；端口随机避免可预测。
- **进程隔离**：proxy 不暴露管理端口或 API，不接受外部指令。

#### Runtime Transport Proxy 与 Memory Extension 风险登记

统一数据平面是 Usage、协议兼容和完整逐 turn 自动记忆的共同接入能力，也是协议、延迟和数据暴露面的集中风险点。Transport 必须是可替换 Runtime adapter；MemoryExtension 必须可独立关闭，不得让 `core/memory` 读取 CLI/Provider 私有字段。风险处理原则是：主任务与现有 Usage 行为优先于记忆增强；协议不确定时收窄当前 turn 的 Memory 注入和自动写入，但不删除能力，也不把未知数据猜成已知协议。

| 风险 | 可观测信号 | 强制应对 | 降级结果 |
|------|------------|----------|----------|
| 与现有 Usage Proxy 重叠/回环 | 同一 execution 出现多个 listener/base URL、upstream 命中 active local proxy、usage 重复 | 单一 Runtime Transport Proxy；现有 `startOpenAiUsageProxy` 仅作 facade；listener registry + normalized route loop detection | 拒绝第二数据平面，Usage 保持可用，MemoryExtension disabled |
| Usage/Memory 所有权漂移或重复计费 | 两套 records/counter、同一 attempt 多条 cost、Memory 与 Usage token 不一致 | Compatibility 归 Transport；UsageObserver 唯一写 usage/cost/metrics；attempt idempotency key；旧 facade 只读同一状态 | 阻断 Memory rollout；保持 usage-only 并运行 ledger reconciliation |
| Memory 背压拖累或丢失 Usage | Memory queue 满时 usage gap、worker crash 后 metrics 少计 | Usage/Memory 独立 bounded channel；最终 usage/attempt 事件优先；bounded journal + completion reconciliation | Memory 停止 capture；Usage degraded 可恢复，禁止静默 healthy |
| CLI/Provider 协议升级 | unknown event/field、fixture mismatch、完成事件缺失 | adapter registry 按 protocol/provider/CLI version 选择；升级前运行完整 fixture、真实脱敏 canary 和字节语义回放 | compatibility profile 标 blocked、circuit 进入 `open`，原样透传且停止自动写 |
| Proxy 改写请求语义 | 声明 patch 之外的 canonical path 变化、工具定义/system 丢失 | 唯一 TransformCoordinator；Compatibility 与 Memory patch 顺序固定；保存 path-level manifest 和 pre/post hash；禁止扩展直接改 raw body | 取消 Memory patch；必要时保留既有 compatibility translation，退回 usage-only |
| 流式 SSE/tool call 解析不完整 | item id 缺失、arguments JSON 未闭合、重复 delta、结束状态不一致 | 增量 parser 有 per-item state、大小上限和幂等键；未知事件同时旁路透传；连接关闭不计成功 | Episode 标 partial/unknown，不生成 active semantic/Skill |
| Turn 关联错误或重复学习 | retry/continuation 被判新 turn、相同 manifest 多次生成 | execution marker + 协议 id + 内容指纹三层关联；injection manifest 继承；operation id 去重 | relation=`unknown`，只记低风险 execution episode |
| 额外延迟或单点故障 | pre-read timeout、proxy overhead、event-loop lag、upstream connect error | L0-L2 deadline、独立 route timeout、circuit breaker、流式旁路、不在同步路径做模型调用 | `passthrough`/no-memory，主请求继续或透传原始上游错误 |
| 大响应导致内存/磁盘压力 | collector bytes、queue depth、RSS、spool quota | 每 item/turn/process 硬上限；只保留 hash 和类型化摘要；队列背压时停止 capture；禁止无界 buffer | 继续流式透传，capture 标 truncated，自动写降为 episode-only |
| API key、prompt 或响应泄漏 | secret scanner hit、raw 字段进入 persist schema、debug/crash dump 出现正文 | Ephemeral/Sanitized 类型隔离；递归 RedactionGateway；日志 allowlist；TTL 加密 content ref；worker 无 auth key；高敏 worker 短生命周期 | drop/redact capture，记录无正文 security event |
| 本机其他进程误连 Proxy | 非预期 path/nonce、无 route lease、父进程失联 | 128-bit route path 或独占端口；lease/uid/engine/TTL 校验；企业租户使用 OS/container 隔离；明确同 uid 剩余风险 | 立即 404/关闭连接，不创建 execution 或 memory event |
| 非标准 Provider | protocol detection 失败或 compatibility profile 不存在 | 原样透传，记录 provider/version fingerprint，允许后续离线创建 adapter fixture | 不注入、不捕获、不 Post-Run，CLI 保持可用 |
| CLI 更新后静默不兼容 | CLI version 超出已验证矩阵、preflight probe 失败 | 启动前读取 CLI/provider fingerprint；未知 major 默认 `shadow_capture` 或 `passthrough`；分阶段 rollout | 提示自动记忆暂时降级，保留显式控制与主任务 |
| MemoryExtension/非关键 response parser 崩溃 | Memory worker heartbeat 丢失、IPC 断开、queue poison | forwarder、Usage、Memory 故障域隔离；supervisor 重启对应 worker；chunk 先下游后 Memory | 当前 stream 与 Usage 继续，Memory passthrough |
| UsageObserver 崩溃 | Usage worker heartbeat 丢失、journal lag、attempt gap | 独立 Usage channel；supervisor 重启；bounded metadata journal 重放或 completion reconciliation | 当前 stream 与 Memory 可继续，Usage 显式 degraded；未对账前禁止 healthy/parity |
| Forwarder 数据平面崩溃 | listener/TCP 断开、parent pid 消失 | 极小 forwarder、supervisor、下次请求重启、execution reconciliation | 当前请求明确失败且不学习；不虚假承诺透明续传 |
| 上游 TLS/重定向/SSRF | target 与启动时保存的 upstream 不一致、redirect 跨 host | 上游 URL 只来自已验证 Provider config；禁用请求参数覆盖；逐跳校验 scheme/host/port；不代理任意 URL | 阻断转发并返回确定性安全错误 |
| Prompt cache/成本回退 | cache-read ratio、TTFT、effective input cost 回归 | 稳定 prefix、canonical dynamic suffix、manifest 复用、profile-specific cache boundary、Shadow 成本对比 | 缩小/降低注入或退到 on-demand，不影响 Usage |
| 回归被自有评测掩盖 | 同一模型生成 fixture 又充当 Judge、synthetic 指标提升但真实错误增加 | 固定人工标注 corpus + 历史脱敏轨迹 + 独立 evaluator；协议正确性不用 LLM Judge | adapter 不晋级 production |

Transport 数据平面与 Memory Extension 分别建模，禁止再用一个 `mode` 同时表达“server 是否存在”和“记忆是否启用”：

```text
transport.mode:
  stopped       用户显式 --native；不启动本地数据平面
  usage_only    现有 Usage/compatibility 能力运行，MemoryExtension disabled
  extensions    Usage 与一个或多个批准扩展共用数据平面

memory.mode:
  disabled       不注册 MemoryExtension
  passthrough    扩展已注册但不注入、不 capture，用于健康检查/故障降级
  shadow_capture 原样转发并旁路解析，只比较结果，不注入、不自动写
  read_only      Pre-Read 注入，Post-Run 只保存 execution/诊断，不自动抽取
  full           Pre-Read + durable Post-Run + 自动学习闭环
```

Memory 状态只能由本地配置、兼容矩阵、健康探测和 circuit breaker 收窄，模型不能扩大。`full -> read_only -> shadow_capture -> passthrough -> disabled` 是自动降级顺序；Memory 降级不得关闭 Usage Observer 或 compatibility transform。自动恢复必须经过连续健康窗口和 canary replay，不允许一次请求成功就立即闭合熔断。

```typescript
type ProxyCompatibilityProfile = {
  protocol: "openai_responses" | "openai_chat" | "anthropic_messages";
  adapterVersion: string;
  cli: { name: "claude" | "codex"; versionRange: string };
  providerFingerprint: string;
  supportedFeatures: string[];
  fixtureCorpusVersion: string;
  status: "shadow" | "approved" | "blocked";
};

type TransportProxyHealth = {
  transportMode: "stopped" | "usage_only" | "extensions";
  memoryMode: "disabled" | "passthrough" | "shadow_capture" | "read_only" | "full";
  usageStatus: "disabled" | "healthy" | "degraded";
  memoryCircuit: "closed" | "half_open" | "open";
  forwarderStatus: "healthy" | "restarting" | "failed";
  reasonCodes: string[];
  overheadP50Ms: number;
  overheadP95Ms: number;
  parseFailureRate: number;
  unknownEventRate: number;
  queueDepth: number;
};
```

生产发布门槛：现有 Usage Proxy records/metrics/translation 测试 parity=100%；compatibility retry、CLI retry、observer restart 和 event replay fixture 中，每个实际 upstream attempt 恰好一个终态，存在 usage 时最多一次 usage/cost contribution，成功但无 usage 时恰好一次 `noUsage` contribution；Memory queue saturation/worker kill 不改变 Usage records、metrics、`usage.json`、response bytes 或 compatibility behavior；纯 passthrough 的 response bytes 一致率 100%；存在声明式 compatibility/memory transform 时，声明路径之外 canonical AST 一致率 100%；持久化 raw header/system/reasoning/tool input/output 数为 0；tool/event 不重不漏；失败、取消和 unknown relation 的危险错误 active 数为 0；Proxy 本地转发开销 p95 不超过 20ms（不含 Pre-Read），L1 Pre-Read p95 不超过 100ms；extension/worker 故障一个请求内收窄 Memory，forwarder 故障不产生错误学习且下一请求恢复；cache/cost 满足本文门槛；关闭 MemoryExtension 后 Usage 与 CLI 行为回到现有基线。

必须提供运维控制：`ai doctor transport-proxy` 展示 listener/route、Usage parity、CLI/provider fingerprint、adapter version、transport/memory mode、worker/circuit、fixture compatibility、cache/cost 和最近降级 reason；`ai doctor memory-proxy` 在兼容期作为 alias。`ai memory proxy mode disabled|passthrough|shadow|read-only|full` 只允许管理员收窄 MemoryExtension，不影响 Usage。Release 流程先完成 usage-only parity，再 shadow capture、小比例 read-only，最后 full；发现协议回归可以独立回滚 MemoryExtension/adapter 或打开 memory kill switch，不回滚 Usage、Transport 或 Memory Store schema。

#### 与 CLI system prompt 的关系

Claude Code/Codex 自身有完整的 system/developer instructions（含项目原生说明和工具定义）。Proxy 按批准的 compatibility profile 在 Anthropic `body.system`、OpenAI Responses `instructions/input` 或 Chat `messages` 的对应位置追加 `<ai_gateway_memory>` 块。三种协议必须分别通过 fixture，不共享猜测式字符串改写。它们共同遵守：

- 记忆块的 `<policy>` 已声明"Current explicit user instructions override conflicting memory"
- 注入位置是 CLI 原有 system/developer instructions 的附加数据块，不能替换、重排或提升到其上方
- 注入内容只包含事实/偏好/技能，不包含执行指令（R3 去指令化清洗保证）
- 如果 system/instructions 总长度超过模型上下文的 20%，记忆块按 token 预算裁剪，不挤占 CLI 的工具定义空间

#### `--native` 直连模式

保留 `ai use ... --native` 绕过 proxy 直接进入 CLI 原生 TUI。此模式下：

- 不设置 `*_BASE_URL`，CLI 直连上游 API
- 启动时执行一次 `memoryService.preRead()`，结果由版本化 `NativeContextAdapter` 通过 CLI 官方支持的 append-system/config/临时 settings 通道注入；禁止修改 `CLAUDE.md`、`AGENTS.md` 或其他项目文件
- 当前 CLI/version 没有已验证的 session-start 注入通道时，退到由 `0600` 临时进程配置注册的本地只读 MCP `memory.search`，继续执行 canonical identity/scope/privacy/authority/token 过滤并显示 `memory capability=read-on-demand, write=disabled`；临时配置随进程删除，不修改用户或项目原生文件
- 只有官方注入和临时 MCP 两种通道都不可用时才显示 `memory capability=disabled, reason=native_context_adapter_unavailable`；保留 adapter 能力和 fixture，版本支持后恢复，不使用项目文件旁路伪装成功
- Post-Run 自动写入不可用（proxy 不在链路上无法捕获响应）
- 启动前按实际 adapter 明确显示 `memory capability=read-at-session-start|read-on-demand|disabled, write=disabled`
- 适用于需要原生体验或调试场景的用户

### 错误分类与入口行为

```typescript
type MemoryErrorCode =
  | "IDENTITY_UNRESOLVED" | "SCOPE_DENIED" | "POLICY_DISABLED"
  | "STORE_UNAVAILABLE" | "PRE_READ_DEADLINE" | "QUEUE_WRITE_FAILED"
  | "MODEL_OUTPUT_INVALID" | "SECRET_DETECTED" | "CONFLICT_RETRY_EXHAUSTED"
  | "PROXY_UPSTREAM_FAILED" | "PROXY_PROTOCOL_INCOMPATIBLE"
  | "PROXY_BACKPRESSURE" | "PROXY_LOCAL_AUTH_FAILED" | "PROXY_CIRCUIT_OPEN"
  | "PROXY_ROUTE_LOOP" | "DUPLICATE_PROXY_LISTENER"
  | "TRANSPORT_FORWARDER_FAILED" | "EXTENSION_WORKER_FAILED"
  | "PERSISTENCE_RAW_DATA_REJECTED" | "PROMPT_CACHE_REGRESSION";
```

- `IDENTITY_UNRESOLVED/SCOPE_DENIED`：记忆读写 fail-closed，主任务继续；UI 不显示任何记忆数量。
- `STORE_UNAVAILABLE/PRE_READ_DEADLINE`：Pre-Read fail-open，运行无记忆；写 `memory.skip/error`。
- `QUEUE_WRITE_FAILED`：模型结果仍返回，但 Telegram/CLI 显示一次非阻塞告警“本轮未能提交自动记忆”，execution_run 标 failed-to-enqueue，后续 doctor 可修复/重放不含正文的状态，不能声称已记住。
- `MODEL_OUTPUT_INVALID/SECRET_DETECTED`：worker retry 或 drop/pending，不影响原任务；日志不包含原始输出。
- `PROXY_UPSTREAM_FAILED`：proxy 无法连接上游 API；透传错误给 CLI 处理，proxy 本身不重试（重试由 CLI 或 provider fallback 逻辑负责）。
- `PROXY_PROTOCOL_INCOMPATIBLE/PROXY_CIRCUIT_OPEN`：当前 compatibility profile 收窄到 shadow/passthrough，不阻塞 CLI，不生成 active memory。
- `PROXY_BACKPRESSURE`：继续透传，停止 collector 或只落 truncated execution episode；不得为记忆完整性阻塞上游流。
- `PROXY_LOCAL_AUTH_FAILED`：拒绝未注册本地连接且不落正文，只写脱敏 security counter。
- `PROXY_ROUTE_LOOP/DUPLICATE_PROXY_LISTENER`：启动阶段拒绝第二数据平面或回环 route；保留现有 Usage-only handle，不尝试链式代理。
- `EXTENSION_WORKER_FAILED`：forwarder 继续当前 stream，Memory 收窄、Usage 标 degraded 并由 supervisor 重启 worker。
- `TRANSPORT_FORWARDER_FAILED`：当前请求确定失败，不生成成功 outcome/active memory；supervisor 为下一请求恢复 listener。
- `PERSISTENCE_RAW_DATA_REJECTED`：RedactionGateway/schema guard 拒绝 envelope 并清除 payload ref，不能通过 retry 降低脱敏要求。
- `PROMPT_CACHE_REGRESSION`：candidate profile 退回 shadow/read-on-demand，Usage 继续记录真实成本。

所有错误对象只包含 code、retryable、traceId 和脱敏 message；原始模型输出或 secret 只允许存在于有 TTL 的加密 job payload。

### 接入点

| 入口 | Pre-Read Hook | Post-Run Hook |
|------|---------------|---------------|
| Telegram（headless spawn CLI） | Proxy 拦截 API 请求时注入 | Proxy 捕获流式 response 结束后入队 |
| CLI `ai use claude ...` | Proxy 拦截 API 请求时注入 | Proxy 捕获流式 response 结束后入队 |
| CLI `ai use codex ...` | Proxy 拦截 API 请求时注入 | Proxy 捕获流式 response 结束后入队 |
| CLI `--native` | 已验证 adapter 走 session-start 一次性只读注入，否则临时 MCP 按需只读检索 | 不可用（无 proxy 无法捕获 response） |
| Scheduler / Browser 自动化 | Proxy 拦截 API 请求时注入 | Proxy 捕获流式 response 结束后入队 |

所有经 Proxy 的入口共用同一套 Pre-Read + Post-Run 逻辑。Proxy 必须用 `try/finally` 保证已开始的 turn 产生终态 envelope。若进程被 `SIGKILL`，proxy 在收到第一个 API 请求时已写 `execution_runs(status=running)`，下次启动将遗留 run 标记 `abandoned` 并入队一个 cancelled episode，确保事件链可闭合。
