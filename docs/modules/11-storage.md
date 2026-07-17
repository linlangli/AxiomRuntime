# ⑪ Storage 存储

> 遵循 doc_2.0 统一模块模板。语言中英混合，标识符英文原样。术语见 [../glossary.md](../glossary.md)。
> 关键立场：Storage 是 **per-contract 可替换后端集合**，不是单块 god-module；账本的 purge/audit **语义**归 Runtime 自持，存储只提供机制。

## 1. 定位（一句话）

按契约提供可替换的持久化后端（关系/全文/向量/图/队列/对象/密钥），部署 profile 换后端而**不改语义**。

## 2. 单一职责边界（高内聚）

**拥有**：后端读写机制、索引、事务、连接管理、迁移。

**禁止拥有**：
- **禁止**持有账本的 purge/audit/derivation **语义**——那归 ⑥/⑦ Runtime 权威。
- **禁止**把存储 schema/供应商类型暴露成公共契约或权威外键。
- **禁止**让托管服务成为本地 profile 的隐式依赖。

## 3. 内部构件与各自单一职责

| 后端契约 | 单一职责 |
|---|---|
| `RetrievalBackend` | 词法/语义/实体/时序检索 |
| `VectorRetrievalBackend` | 向量召回 |
| `TemporalGraphProjection` | 时序图投影（可重建） |
| `DurableJobBackend` | operation-id/lease/retry/dead-letter |
| `ObjectStore` | artifact/大对象 |
| `SecretStore` | 密钥材料（配合 ⑨ codec） |
| `AuditSink` / `AuditQueryPort` | append-only 审计落地、完整性 checkpoint、授权查询/导出 |
| `MeteringExportPort` | 从 UsageObserver ledger revision 生成幂等导出，不复制权威账本 |
| `ObservabilitySinkPort` / `ObservabilityQueryPort` | 非权威 Observation 投影、采样、索引与授权 trace 查询 |

## 4. 对外/消费端口（可插拔点）

各后端实现对应 Port（见 [contracts.md](../contracts.md) §4）。部署 profile = 一张"Port→实现"映射表：

| Port | 本地 profile | 企业 profile |
|---|---|---|
| `RetrievalBackend` | SQLite FTS5 | Postgres / OpenSearch |
| `VectorRetrievalBackend` | sqlite-vec | pgvector / Qdrant |
| `DurableJobBackend` | 本地 SQLite 队列 | 成熟 MQ |
| `SecretStore` | OS SecretStore | KMS / HSM |
| `AuditSink` / `AuditQueryPort` | 本地签名日志 + 索引 | 不可变审计仓 / SIEM adapter |
| `MeteringExportPort` | JSONL / CSV operation | FinOps / billing adapter |
| `ObservabilitySinkPort` / `ObservabilityQueryPort` | JSONL + OTel file/console | OTLP / APM / Observability store |

## 5. 依赖（低耦合）

只 import `L0 Contracts`。存储**禁**反向依赖上层；上层经 Port 使用存储，**禁** import 具体后端。

## 6. 数据所有权

Storage 持有**字节与索引**，不持有**语义**。账本真相的生命周期规则（purge 可达、audit 保留、derivation）由 ⑥/⑦ 定义，Storage 只忠实执行读写与迁移。Observation store 非权威且允许按策略采样/过期；它不能替代 `RuntimeEvent`、AuditSink、Usage Ledger 或 Claim/Evidence。

## 7. 降级 / kill switch

可选后端丢失只降**该能力**（graph→时序 SQL、vector→FTS），**禁**绕过 scope 或关掉显式记忆控制。本地 profile **必须**无托管服务即可运行;每个可选 provider 有独立测试的 fallback 或显式能力级禁用。

## 8. 产品化就绪度

🔄 **采纳而非抽取**——各后端本就是成熟产品（SQLite/Postgres/Qdrant）。本层是接入边界，不产出独立产品。判据见 [../extraction-readiness.md](../extraction-readiness.md)。

## 9. 现状映射

当前以 SQLite/JSON 文件为主（`usage.json`、`memories` 单表）。本层将其规整为 per-contract 后端，企业 profile 可平滑替换为 Postgres+pgvector，**不改**语义。

## 10. 验收标准

- 换 profile（本地↔企业）**不改**任何 Runtime 语义、权威 id、scope 决策。
- 成熟后端可替换而不改公共契约。
- 本地 profile 无托管服务可完整运行。
- 账本 purge/audit 语义在换后端后保持不变。
- audit/export/backup operation 都有 idempotency key、进度、校验和、失败恢复、过期清理；导出权限与查询本身进入审计。
- 每个 deployment profile 声明并演练 backup/restore、SLO/RTO/RPO；恢复后验证 event chain、ledger revision、purge tombstone、legal hold 与 tenant isolation。
- `MeteringExportPort` 故障不丢失或改写 UsageObserver ledger，恢复时从稳定 cursor 重放且不重复出账。
- `team/enterprise` profile 满足 [../service-level-objectives.md](../service-level-objectives.md) 的 durable accept、RTO/RPO、backup cadence 与恢复演练门槛；projection 可重建不能替代 source ledger 备份。

## 11. 相关文档

- 契约清单：[../contracts.md](../contracts.md)｜适配器：[10-adapters-plugins.md](10-adapters-plugins.md)
- 权威边界（英文）：[../AI_RUNTIME_ARCHITECTURE.md](../AI_RUNTIME_ARCHITECTURE.md) §4 Deployment profiles
- 量化服务等级：[../service-level-objectives.md](../service-level-objectives.md)

---

## 附：存储与完整性详细规范（从 memory-system-spec 迁入）

> **Appendix Status: MIGRATION FIXTURE** — DDL 与 storage alias 只用于 migration/reference fixture，不是 L0 schema。
>
> 本附录保留 legacy `memory-system-spec.md` 的 DDL 与完整性材料作为 migration/reference fixture，不承诺旧代码块继续逐字节有效。Port 以 [../contracts.md](../contracts.md) 为准，purge/audit/replication 行为以 [../enforcement-decisions.md](../enforcement-decisions.md) 为准。

### execution_runs 与隐私策略表

```sql
CREATE TABLE execution_runs (
  id              TEXT PRIMARY KEY,
  trace_id        TEXT NOT NULL UNIQUE,
  user_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  engine          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running','success','failed','cancelled','abandoned')),
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  post_run_job_id TEXT REFERENCES memory_jobs(id)
);

CREATE TABLE memory_policies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source          TEXT NOT NULL DEFAULT '*',
  bot_id          TEXT NOT NULL DEFAULT '*',
  project_id      TEXT NOT NULL DEFAULT '*',
  read_enabled    INTEGER NOT NULL DEFAULT 1,
  write_enabled   INTEGER NOT NULL DEFAULT 1,
  audience        TEXT NOT NULL DEFAULT 'default',
  injection_token_budget INTEGER,
  updated_at      INTEGER NOT NULL,
  UNIQUE (user_id, source, bot_id, project_id)
);
```

policy 表使用 `*` 作为显式 wildcard，禁止用 NULL 表示 wildcard，因为 SQLite UNIQUE 允许多个 NULL。写入前 validator 要求一条规则只能指定合法 source 或 `*`，id 不得为空字符串。

策略按 `project > bot > source > account default` 合并，最具体规则优先；任何一级显式禁用都不能被更宽规则重新开启。`privacyMode=incognito` 等价于本轮 `no_read + no_write + 不落 episode 正文`，只保留不含内容的运行计数与错误码。必须提供 `ai memory policy show/set` 和 Telegram 设置页。

Execution 恢复吸收 LangGraph 的 Checkpointer/Store 分离：`WorkflowCheckpointBackend` 保存 thread-scoped graph state、interrupt、resume 和 time-travel checkpoint；`MemoryStore` 保存跨 execution 的 Claim/Evidence/Skill。checkpoint 可以引用 memory id 和 SanitizedTurnEnvelope，但不能复制 raw reasoning、secret 或完整 transport body，也不能因 checkpoint 回滚逆转已经提交的权威 memory event。未使用 LangGraph 的入口仍遵守相同契约；LangGraph adapter 是可选 backend，不是 Runtime 的必需编排框架。

SQLite 可以先使用 FTS5 + 关键词检索；当记忆数量和语义需求上来后，再接入 sqlite-vec/sqlite-vss 或外部向量库。

> **CJK 分词**：FTS5 默认 `unicode61` 分词器不切中文词，会导致中文记忆几乎无法命中，反而比当前的 `LIKE %...%` 子串匹配更差。中文场景必须使用 `trigram` 分词器（`tokenize = 'trigram'`，SQLite ≥ 3.34）或外挂 `simple`/ICU/jieba 分词器。启用 FTS5 前先在 CJK 语料上做召回验证，详见「风险与强制实施决策 R6」。

Phase 5 schema：

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title, content, summary, tags_json,
  content='memories', content_rowid='id', tokenize='trigram'
);

CREATE TABLE memory_aliases (
  user_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  term       TEXT NOT NULL,
  alias      TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('user','system','model')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, term, alias)
);
```

migration 同时创建同步 trigger：

```sql
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid,title,content,summary,tags_json)
  VALUES (new.id,new.title,new.content,coalesce(new.summary,''),new.tags_json);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts,rowid,title,content,summary,tags_json)
  VALUES ('delete',old.id,old.title,old.content,coalesce(old.summary,''),old.tags_json);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts,rowid,title,content,summary,tags_json)
  VALUES ('delete',old.id,old.title,old.content,coalesce(old.summary,''),old.tags_json);
  INSERT INTO memories_fts(rowid,title,content,summary,tags_json)
  VALUES (new.id,new.title,new.content,coalesce(new.summary,''),new.tags_json);
END;
INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
```

FTS 查询必须 join 回 memories，再执行 account/scope/status/time 硬过滤。

启动时在临时表探测 `fts5 + trigram`。缺少能力时 Phase 5 feature flag 保持关闭并使用参数化 `LIKE` fallback，同时 `ai doctor` 给出重新安装 bundled better-sqlite3/扩展的确定指令；不能静默声称 FTS 已启用。短于 3 字符的查询始终走 LIKE/tag fallback。

### Artifact Store

多模态和大文件使用 content-addressed encrypted store，例如 `artifacts/<hash-prefix>/<sha256>.enc`。SQLite 保存 artifact id、hash、media type、size、key ref、origin/privacy 和派生 observation ids。

派生链固定为 `Artifact → Region/Span → Observation → Evidence → Claim`。删除 artifact 时撤回相关 Evidence、重算 Claim、删除 embedding 和 blob；不允许只删文件而保留无法验证的派生事实。

### 分区完整性链

`memory_events` 不使用全库单热点链，而按 `account_id + logical_stream` 建链，例如 semantic、episodic、skill、purge、auth-audit。事件 hash 包含 stream、sequence、previous_hash 和 canonical payload hash；checkpoint 签名所有 stream head。

Hash Chain 用于检测本地篡改和恢复缺失，不宣称抵御持有全部本机密钥的攻击者。发现断链时自动治理写入 fail-closed，主任务进入 no-memory 模式，并保留只读诊断和恢复工具。

### 多设备事件复制（R31 事件复制）

Team/多设备共享不复制 SQLite 文件，只复制签名 append-only event envelope，再由各设备 deterministic materializer 重建状态：

```typescript
type ReplicatedMemoryEvent = {
  eventId: string;
  accountId: string;
  deviceId: string;
  lamportTime: number;
  causalParents: string[];
  operationId: string;
  eventType: string;
  encryptedPayload: string;
  keyVersion: number;
  signature: string;
};
```

Evidence 采用追加合并；Claim current state 由 materializer 重算；purge 使用 tombstone + 内容密钥销毁；成员移除后停止获得新 team key。离线并发不按本机 wall clock 决胜，使用 causal parents、Lamport time、authority 和 category conflict policy。
