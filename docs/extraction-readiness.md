# 模块产品化就绪度判据（Extraction Readiness）

> 用途：判定"某模块能否从 Runtime 抽取为独立产品"。这是 [AI_RUNTIME_ARCHITECTURE.md](AI_RUNTIME_ARCHITECTURE.md) §4 Mature Capability Reuse 的姊妹判据。
> 前提区分：**可插拔（swappable inside）** 是局部属性，端口-适配器已免费提供；**独立成产品（standalone product）** 是边界属性，需刻意跨过下面 5 条线，且只对天然有边界的模块跨。

## 1. 跨线 5 判据（全满足才算就绪）

| # | 判据 | 说明 |
|---|---|---|
| C1 | **进程/网络边界** | in-process Port **必须**同时有网络版契约（HTTP/gRPC），非仅内存接口 |
| C2 | **自持数据 + 迁移** | **必须**独占自己的 schema 与 migrations，不共用 Runtime 存储约定 |
| C3 | **独立发版 SDK** | 对外契约与 Runtime 内部契约**分开发版**，内部 churn 不破外部 |
| C4 | **依赖闭包隔离** | 自成 package、自带依赖树，import 时**不**拖入整个 monolith |
| C5 | **自身边缘安全** | 在自己边缘做 authN/authZ，**不**假设宿主已解析 tenant/scope |

## 2. dogfooding 约束（保持与宪法自洽）

抽取后，**Runtime 自身必须通过同一个 Port 消费该产品**，与外部客户一模一样。例：Memory 抽出后，Runtime 经 `RetrievalBackend`/`CandidateExtractor` 消费它。
- 这样抽取**不破坏**"Runtime 才是产品"命题，反而**强化**"Memory 是可替换 provider"原则。
- **禁**出现"抽取版"与"内嵌版"两套分叉实现——只有一套，经 Port 消费。

## 3. 逐模块判定

| 模块 | 判定 | 理由 |
|---|---|---|
| ⑤ Transport Proxy | ✅ **最强候选** | 天然网络边界，对标 LiteLLM/OpenRouter，差异化=用量成本账+治理注入 |
| ⑥ Memory | ✅ 强候选（打包大） | 对标 Mem0/Zep/Letta，但**必须**连 Policy+Learning+Security 一起带走 |
| ⑥ Skill（子） | ✅ 可 | 程序性记忆/技能挖掘可成品，耦合故事同 Memory |
| ③ Provider Routing | ⚠️ 并入网关 | 单独价值小，通常并进 Transport 产品 |
| ⑥ Recall 流水线 | ❌ 子组件 | 脱离账本无意义 |
| ⑦ Learning Governor | ❌ 结构上最不能 | 核心 IP，由 Runtime 契约定义，只在闭环有意义 |
| ⑧ Policy Engine | 🔄 采纳 | 本就是 OPA/Cedar 薄适配，直接用成熟品 |
| ⑪ Storage 各后端 | 🔄 采纳 | SQLite/Postgres/Qdrant 本身已是产品 |
| ①②④⑨ | ❌ / ⚠️ | Runtime 闭环组件或横切，不独立 |

## 4. 两个必须警惕的坑

1. **分布式单体**：抽出去却在网络上做细粒度往返 → 延迟+耦合比单体更糟。**Memory 读/注入路径受 300ms fail-open 预算约束**，独立成远程产品时优先拆**写/抽取路径**（异步 durable job），读路径要么内嵌要么极致低延迟缓存。
2. **别硬抽闭环模块**：Recall/Learning Governor/Policy 被"独立产品"目标绑架去加网络边界，只会把简单的东西搞复杂。它们就该留在 Runtime 内。

## 5. 一句话结论

有天然边界者（Transport、Memory/Skill）**能**按需、逐个、经 dogfooding 抽取为产品且与宪法自洽；子组件/闭环 IP/可采纳成熟品者**不该也不必**独立。"可插拔"现在就有;"独立成产品"是第二步。

## 6. 相关文档

- 整体架构：[00-overview.md](00-overview.md)｜契约清单：[contracts.md](contracts.md)
- 各模块"产品化就绪度"节：见 [modules/](modules/) 各文档 §8
