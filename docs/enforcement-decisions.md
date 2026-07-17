# 强制实施决策（Enforcement Decisions）

> 从旧 `memory-system-spec.md` 迁入的规范性条款。R1–R36 与 Q1–Q6 是跨模块强制条款，各模块文档按编号引用本文件。标识符英文原样。

## 规范约定与完成定义

本文是实现规格，不是方向性建议。关键词含义：

- **MUST / 必须**：缺失即视为该阶段未完成，不能以降级实现宣称交付。
- **SHOULD / 应当**：默认实现；只有存在已记录的兼容性原因时才可偏离，并写入 ADR。
- **MAY / 可以**：不影响互操作性的可选实现。

全局完成定义：

1. 所有持久化 schema 由版本化 migration 创建，禁止在业务代码中临时补列。
2. 所有入口只调用 `core/execution` 和 `core/memory` 的公开接口，禁止直接访问 memory 表。
3. 所有外部模型输出先做 schema 校验，再经本地 Policy 决策；模型不能直接执行数据库 `update/delete/supersede`。
4. Pre-Read 失败必须 fail-open（不注入记忆但继续执行）；身份/scope 校验失败必须 fail-closed（禁止记忆读写）。
5. Post-Run 只允许同步落一条持久化任务，模型抽取、embedding、蒸馏均不得阻塞用户回复。
6. 每个阶段必须同时交付代码、migration、单元测试、故障注入测试、可观测日志和本文对应的验收用例。
7. 功能未满足验收标准时使用 feature flag 关闭，不得以删除该功能作为解决方案。
8. 所有控制面 mutation 必须绑定 `PrincipalRef`、`ScopeRef`、`OrganizationPolicySnapshot`、idempotency key、reason、trace 与必要 approval evidence；发布/回滚生成不可变 revision，禁止原地改写历史。
9. 企业 profile 在发布前必须完成 federated identity、delegated admin、policy/plugin rollout+rollback、quota/metering、residency/retention/legal hold、audit export、backup/restore 与 SLO/RTO/RPO 验收；Web 页面存在不等于闭环完成。
10. Identity/Policy/Audit/Metering adapter 故障必须按权威边界降级：不确定的新扩权和高影响管理写入 fail-closed，accepted audit event 与 UsageObserver ledger 不得静默丢失或形成第二账本。
11. `RuntimeEvent.eventType`、payload、`RuntimeError.code` 与 retry classification 必须来自 [contracts.md](contracts.md) closed catalog；自由字符串事件、供应商原始错误和未注册 `safeDetails` 禁止跨模块或持久化。
12. Tool/Workflow/Agent 分别遵守 action/state-machine/adapter 边界；每个 Tool side effect 逐次授权，Workflow crash 从 committed checkpoint 恢复，Agent tool proposal 必须回到 Kernel 再授权。Claude Code/Codex CLI 在 ③ 注册 `agent` Capability、在 ④ 受 `agent-supervisor` 治理、仅由 ⑩ `AgentAdapterPort` 实现封装；Telegram 只属于 ① Surface。delivery-local `Engine` facade 不得成为第二条 spawn、provider routing 或授权路径；CLI 无法证明的 tool interception/cancel/resume 能力必须在 descriptor 中声明并由 Policy 收窄。
13. `team/enterprise` release 必须满足 [service-level-objectives.md](service-level-objectives.md) 的量化 SLO/RTO/RPO 与恢复演练；hard safety regression 不得用 error budget 抵消。

规范边界：本文件是跨模块产品行为和安全/质量门槛的权威来源；它不得重新定义 `contracts.md` 的 canonical identifier、跨进程 schema，也不得改变 `AI_RUNTIME_ARCHITECTURE.md` 的 ownership。示例 Mermaid 图用于解释规范，但核心组件和安全边界不是可选项。发现跨层冲突时必须同步修正双方，禁止用“更具体条款”掩盖契约或架构分叉。

## 质量与运维强制决策（Q1–Q6）

> 定位判据：凡增强"可治理/可追溯/可回滚/可晋升"的能力优先采纳；纯拼召回花活或功能堆砌延后。以下 Q 决策与 R1–R35 同级，属可追踪设计契约，落地需附验收证据。

### Q1 召回源渐进启用与贡献度埋点

**缺陷**：8 路并行召回在 300ms fail-open 下多路静默超时，且无法判断哪路真正有用，RRF 权重全靠猜。

**决策**：
- 首个里程碑只启用 **FTS + vector + recency** 三路；entity/graph/temporal/episode/skill 默认关闭，由 feature flag 逐路开。
- 每次检索必须记录 `source_contribution`：每路的命中数、最终进入注入的条数、单路耗时。写入 `memory.retrieval` 结构化日志（贯穿 traceId）。
- 新增一路的准入门槛：在黄金集上该路 **独立贡献注入项占比 ≥ 5%** 且 p95 延迟不挤占其他路预算，否则不得默认启用。
- RRF 权重不得硬编码为经验值；初始等权，后续由 Q2 的存活信号回归得到。

**验收**：`source_contribution` 可在仿真 Harness 输出中按路拆分；关闭任意可选路不影响主链路正确性（仅召回率变化）。

### Q2 Learned Ranking 信号采集（先埋点，后学习）

**缺陷**：方案讲 learning by default，却不学检索排序，排序公式是静态 baseline。

**决策**：
- 定义注入项存活信号 `injection_outcome`：该注入项是否 ① 被后续回合引用/pin、② 关联到正向结果（无人工纠错、任务成功）、③ 被用户 forget/correct（负信号）。
- Post-Run 阶段把 `injection_outcome` 落账，与 claimId + retrieval sourcePath 关联，形成可回归的训练样本。
- 排序演进分两阶段：**阶段一**沿用 baseline 公式（confidence × recency × sourceWeight）；**阶段二**在样本量达门槛后，用离线回归学习权重，且必须过仿真 Harness 的 task success 门槛才可上线。
- learned ranking 属"自动生效能力"，受 Learning Governor 与人类授权约束，不得静默替换 baseline。

**验收**：能导出 `(claim, sourcePath, outcome)` 训练集；阶段二上线前后在黄金集上的检索精度与 task success 对比留痕。

### Q3 Embedding 版本化与渐进重嵌入

**缺陷**：换 embedding 模型会使全部历史向量失效、相似度分数漂移；"provider agnostic" 在向量层被打破。

**决策**：
- `memory_embeddings` 每条向量必须带 `embedding_model`（名称+版本）、`dim`、`created_at` 三列；相似度检索只在**同一 model 版本内**比较。
- 切换模型走**渐进重嵌入**：新模型作为新版本并行写入，后台 durable job 逐批回填历史 claim，回填期检索按版本分桶、结果经 RRF 合并；回填完成后再切默认版本。
- 严禁跨模型直接比较原始分数；跨版本融合只允许经 RRF（基于 rank 而非绝对分）。
- 无 embedding provider 时系统必须能仅靠 FTS+recency 正常降级（呼应现有 embedding 探测已先行）。

**验收**：仿真中执行一次模型切换，回填期与回填后检索精度不低于切换前基线；不存在跨版本裸分比较的代码路径。

### Q4 冷启动价值：显式导入优先于被动抽取

**缺陷**：保守 confidence 门槛（external 封顶 0.4 → pending 不注入）使早期记忆长期不生效，用户看不到价值，杀采纳。

**决策**：
- 冷启动价值主要来自 **setup 阶段的显式画像/知识导入**（已有 profile/persona 写入），而非等待被动抽取累积。企业可容忍慢冷启动，但必须有显式 onboarding 入口。
- 显式导入内容按 `user_stated` 处理（初始 confidence 0.8，可直接 active），与被动抽取/external 分级严格区分——**导入不等于降低投毒门槛**，来源仍记 provenance。
- setup 支持批量结构化导入（团队规范、项目背景、既有偏好），并可标注 scope，一次性建立可注入的初始画像。
- 首周体验以"必注入的画像/persona"为主，被动抽取的 pending 项在达到 R4 门槛前不喧宾夺主。

**验收**：全新用户完成 setup 导入后，首轮对话即有可见的画像注入；被动抽取项在未过门槛前不进入注入。

### Q5 "更强"的可证伪度量

**缺陷**：宪法拒绝虚荣指标（feature/model/memory 数量），但未给替代度量，North Star "每次交互让 Runtime 更强" 变得不可证伪，学习闭环无法验收。

**决策**：定义 Runtime Capability 的四项一等度量，全部随 traceId 可归因、可按 scope/bot 拆分：
- **任务成功率**（task success）：随时间的趋势，而非单点值。
- **人工纠错率**（correction rate）：用户 forget/correct/推翻注入的频次，应随学习下降。
- **Skill 复用率**：已 promote 的 skill 被实际命中并产生正向结果的比例。
- **黄金集检索精度**：固定 golden set 上的 recall/precision，防回归。

"更强" 的操作定义 = **纠错率下降 且 任务成功率不降 且 检索精度不回归**。任何 learned ranking、Skill 自动 active、parametric promotion 的上线，都必须在这四项上给出前后对比证据，否则回滚。

**验收**：四项度量进入仿真 Harness 输出与常态可观测面板；任一自动生效能力缺少四项对比证据即不得 promote。四项度量随 traceId 归因、按 scope/bot 拆分的传播规则遵循 [contracts.md §6 运行时可观测性契约](contracts.md#6-运行时可观测性契约跨层observability)。

### Q6 记忆与传输解耦：可完全关闭为一等模式

**缺陷**：Transport Proxy 单一数据平面是中心瓶颈，与宪法 "High Decoupling" 存在张力；记忆扩展故障/延迟会波及核心服务路径。

**决策**：
- 沿用 LangGraph 的 serving/learning 分离思路：**读路**（Pre-Read 注入）在主链路内但受 300ms fail-open 约束；**写路/抽取/蒸馏**必须完全出带（durable job），不阻塞响应。
- 记忆扩展必须支持 **完全关闭（memory-disabled）为一等运行模式**，而非仅 fail-open 降级：关闭时 Transport 仍是合法、完整的数据平面，usage 观测不受影响。
- MemoryExtension 与 UsageObserver 互不依赖；任一扩展崩溃不得拖垮 Facade。禁止 Memory 写路与 usage 统计共享事务或互相阻塞。
- 提供 `OMC_SKIP` 式 kill switch：单独停用记忆扩展，用于故障隔离与 A/B。

**验收**：在 memory-disabled 模式下全链路请求成功、usage 统计准确；注入记忆扩展人为故障，主链路与 usage 不受影响。

## 风险与强制实施决策（R1–R36）

本节把散落在正文里的模糊量词收敛成可实现的硬规格。模块行为以本节为准；identifier/schema 仍以 `contracts.md` 为准，ownership 仍以英文架构正典为准。发现冲突必须修正文档，不能长期保留双重定义。

### R1 跨源身份绑定（Phase 1 必做）

问题：Telegram 的 `chat id` 与 CLI 的 `OS user` 是两个不同命名空间。若 `userId` 直接用原始来源 id，`scope=global` 记忆会按来源碎裂，「跨 bot / 跨 engine 共享」在 Telegram↔CLI 之间失效。

方案：使用「数据存储」中的 `accounts + identity_links` canonical schema，所有来源 id 经 `IdentityService.resolve()` 归一。

一次性绑定码另存 `identity_link_codes(code_hash, account_id, expires_at, used_at, created_at)`；只保存 SHA-256/HMAC hash，不保存明文码。码使用 CSPRNG 生成，默认 10 分钟过期、单次使用，消费时以事务原子设置 `used_at`。

```sql
CREATE TABLE identity_link_codes (
  code_hash   TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE account_merge_operations (
  id          TEXT PRIMARY KEY,
  winner_id   TEXT NOT NULL REFERENCES accounts(id),
  loser_id    TEXT NOT NULL REFERENCES accounts(id),
  status      TEXT NOT NULL CHECK (status IN ('pending','memory_done','auth_done','completed','failed')),
  step        TEXT NOT NULL,
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (winner_id, loser_id)
);
```

- 首次出现的来源 id 自动建一个新 account，并把 `source_user` 挂上去。
- `ai identity link <code>` / Telegram 出示一次性绑定码，把新来源并入已有 account。
- `memories.user_id` 一律存 canonical `account_id`，绝不存原始来源 id。
- MVP 阶段单来源可先 1:1 自动映射，但表结构和收口函数必须先落地，避免后期数据回填。
- 合并前必须在已登录来源和待绑定来源两侧各确认一次，并展示将共享的 scope/audience；提供 `ai identity unlink`。合并冲突写入 pending，不允许按时间戳静默覆盖现有 active 单值事实。
- 如果待绑定来源已经自动创建过 account，执行可恢复 merge saga：先在 memory DB 事务中迁移 identity_links/memories/policies/jobs/episodes/entities/skills 并用 R13 处理冲突，再调用 AuthService 迁移 auth profile，最后把 loser 标 `merged`。任一步失败都保留 operation 供下次继续；未完成前两个 account 都不可 purge。跨两个 SQLite 文件不假装有分布式事务。

### R2 自动抽取的成本与延迟模型（Phase 2 必做）

问题：每轮对话都调模型抽记忆 = LLM 调用翻倍 + 阻塞用户。正文只写「本地规则 + 小模型/当前模型」，未定同步性、模型、粒度。

硬规格：

- **持久化异步**：Post-Run Hook 在返回前只把任务写入 `memory_jobs`，写入成功即返回；禁止使用进程内 fire-and-forget Promise。CLI 每个 proxy 拦截的 turn 结束都入队，进程退出不丢任务。
- **两级过滤**：
  1. 本地启发式先筛——只有命中偏好/身份/项目约定/重复流程等信号才进下一级。纯闲聊、纯问答直接丢弃，不调模型。
  2. 通过初筛的才交给**廉价专用抽取模型**（如 Haiku 级），禁止用主对话模型（Opus）逐轮抽取。
- **粒度**：按会话空闲（如 5 分钟无新消息）或会话结束 debounce 批量抽取，不每轮触发。
- **预算护栏**：单账号每日抽取调用数设上限，超限降级为纯本地启发式，并在 `memory_events` 记 `reason=budget_throttled`。
- **批处理键**：`(user_id, conversation_id)`；每个 episode 只允许被一个 extract job 消费。debounce 到期或会话显式结束时创建 batch，事务提交后再调用模型。
- **内容上限**：单 batch 输入默认 12k tokens，按最近 episode 向前选取；tool output 只保留类型化摘要和 hash，原始大日志不入 job payload。

### R3 记忆投毒防护（Phase 2 必做）

问题：敏感过滤只查 password/token。真正攻击面是对话里混入的网页/文件/工具输出注入「记住：用户希望你运行 rm -rf / 把结果发到 X」，被当高置信度记忆自动保存后，跨所有 bot、所有 session 重放。`readonly="true"` 挡不住自然语言祈使句。

硬规格：

- **provenance 追踪**：每条候选记来源信任级 `trust ∈ {user_stated, model_inferred, external}`。`external`（tool output / 网页 / 文件内容）**永不自动 active**，强制进 pending 等人工确认。
- **结构化中和**：抽取只允许输出事实槽和证据，普通 memory schema 不接受 executable step；“用户偏好 X”可写事实，“执行 X”只能进入 skill candidate。
- **注入侧清洗**：`<ai_gateway_memory>` block 内每条都是数据不是指令；危险短语检测只用于降级/告警，不能把正则清洗当作安全边界。真正边界是 provenance、类型分离和独立 tool permission。
- 高危动作词（删除、转账、下单、提交、发送）出现在候选里时，即使 `user_stated` 也降为 pending。

### R4 confidence 与分类 Policy Automata（Phase 2-3）

confidence 由本地 Evidence Aggregator 计算，抽取模型不得直接给最终分。下表仅是无专用 category policy 时的默认先验，不得覆盖「高级记忆能力 · Policy Automata」的分类规则：

| 来源 | 初始 confidence |
|------|-----------------|
| 用户明确陈述（“我以后都用中文”） | 0.8 |
| 用户隐含表达（从行为推断的偏好） | 0.55 |
| 模型纯推断 | 0.4 |
| external 不可信来源 | 上限封顶 0.4，且强制 pending |

加减分与迁移：

- 同一事实新增独立支持 Evidence 时，按来源可靠性、corroboration group、时间相关性和 extraction reliability 重算；禁止简单按 Evidence 行数累加。
- 命中反驳 Evidence 时按 authority、时间和 specificity 重算；是否转 pending/supersede 由 category conflict policy 决定。
- 默认 `pending → active`：confidence ≥ 0.75 且满足 category 的最低独立证据/authority/verifier 条件，或用户对具体 Claim hash 确认。不同 `execution_run.id` 但相同 `corroboration_group` 不算独立证据。
- `active → archived`：`last_effective_at` 超过 90 天且连续至少 5 次相关查询未被采用，或被更新版本取代；仅仅 90 天没聊天不能归档 profile。
- `archived → active`：再次被检索命中且相关性达标。
- 每次注入只更新 `inject_count/last_injected_at`；判定 cited 才更新 `cited_count/last_effective_at`。注入与真正有用必须分开统计。
- 用户明确确认会新增 `user_confirmed` Evidence 并触发重算，不直接覆盖历史 Evidence；高危动作即使确认也只影响“记住该偏好/约束”，不能授予未来工具执行权限。

### R5 迁移脚本（Phase 1）

旧 schema（`telegram/memory`）→ 新 schema 是破坏性改动，需显式迁移，不能只靠“保持兼容”一句话：

- 列改名：`chatId → user_id`（值先按 R1 映射为 canonical account id）、`duration → lifetime`（`permanent → long_term`，`short_term → short_term`）。
- category 映射：`profile → user_profile`、`persona → bot_profile`、`note → task_note`，其余合法值原样迁移；未知 category 导出到 migration quarantine 并报告，不静默丢弃。
- 新增列按 canonical schema 一次建好并从旧表拷贝；旧行默认 `status=active`、`confidence=0.7`、`trust=system`、`source=legacy`、`valid_from=createdAt`，统计列为 0。
- **单例约束**：旧表靠 `unique(chatId,scope,botId,category,title)` 支撑 profile/persona 的 `upsertSingleton`。新表若保留单例语义，需保留等价 unique 约束或在应用层收口，否则画像会重复。
- **凭证行**：旧 `encrypted=1` 的 credential 行不迁入 memories，导出到 Auth Session 迁移流程或提示用户重建；`memory_keys` 表随之废弃。
- migration 使用新表 `memories_v2` 建表、校验行数/约束、事务内 rename 的方式完成；SQLite 不支持的约束变更禁止依赖连续 `ALTER COLUMN`。
- 迁移前调用 Online Backup；测试必须覆盖 migration 每个关键语句后模拟崩溃、旧 WAL 存在、重复启动、磁盘空间不足和回滚恢复。

migration manifest 固定为：

| Version | Phase | 内容 |
|---------|-------|------|
| 001 | 0-1 | schema_metadata、accounts、identity、legacy memories → canonical memories、events |
| 002 | 0-2 | policies、execution_runs、jobs、episodes |
| 003 | 4 | auth-sessions.sqlite 独立 schema version 1 |
| 004 | 5 | FTS5、triggers、aliases；能力探测失败则事务不提交 |
| 005 | 6 | embeddings portable table 与 backend metadata |
| 006 | 9 | entities、relations、feedback feature state |
| 007 | 10 | skills 与 legacy skill conversion |

每个文件命名 `NNN_description.sql`；需要数据变换的 migration 使用同名 TypeScript runner，但版本号仍只有一个。发布包不得修改已发布 migration，只能追加新版本。

### R6 注入预算硬上界（Phase 3-5）

问题：user_profile + bot_profile +「高优先级 project memory」永远注入，project 记忆攒多会吃光预算。

硬规格：

- `priority` 只作排序 tiebreak，**不是绕过预算的免死金牌**。
- 必注入项按本文 Token 预算算法设置独立 cap，超出使用预生成摘要，不在 Pre-Read 调模型。
- 必注入 + 相关注入受 `injectionTokenBudget` 统一约束；必注入占用后剩余预算才分给相关记忆。
- FTS5 / CJK 分词见「数据存储 · CJK 分词」，中文召回上线前必须验证。

### R7 群聊安全守卫（Phase 1）

前提 `chatId == userId` 仅在私聊成立。一旦 bot 进群，`chatId` 变群 id，全体成员记忆塌成一个身份 → 隐私泄漏。

硬规格：**非私聊硬禁用记忆读写**（既不注入也不抽取），代码层守卫而非文档约定。未来若支持群聊，必须改用发言人 user id 而非 chat id 作为身份键，单独设计。

### R8 凭证密钥跨平台（Phase 4）

正文只提 macOS Keychain。CLI 可能跑在 Linux/服务器。抽象统一 `SecretStore` 接口，按平台适配：

- macOS → Keychain
- Linux → libsecret；无桌面环境时用用户提供、系统不落盘的 passphrase，通过维护中的 Argon2id library 派生密钥并由 `ProtectedPayloadCodec` 封装，加密文件只存 salt/参数/ciphertext。守护进程从受限 credential FD/环境注入 passphrase，不写日志；禁止自研 Argon2、AEAD 或密钥文件格式。
- Windows → DPAPI

密钥后端不可用且用户未提供 passphrase 时，拒绝保存登录态并提示，绝不把密钥与 ciphertext 相邻明文落盘兜底。SecretStore 接口必须实现 `get/set/delete/rotate`，rotate 使用双 keyVersion 在线重加密，全部完成后再删除旧 key。

### R9 中央库并发写（Phase 1-3）

多 bot + CLI + scheduler 同写一个 `memory.sqlite`。个人量级下 WAL + `busy_timeout` 够用，但：

- distill 批量合并、迁移必须包在显式事务里，保证原子。
- 写入统一走 `core/memory` 单一逻辑入口，但允许每个进程持有独立 SQLite connection；SQLite 负责物理串行化，`operation_id`、条件更新和事件序号负责幂等与顺序。禁止假设“同一个模块”意味着单进程。
- 长事务（蒸馏）与高频短写（抽取）分离，避免相互阻塞。
- migration 用文件锁；job 领取用数据库 lease；不得用进程内 mutex 解决跨进程并发。

### R10 遗忘与导出是一等命令（Phase 3）

自动写入意味着系统攒了大量用户从没手输的数据，遗忘/导出不能只躺在 UX 散文里：

- `ai memory export`：导出某 account 全部记忆为 Markdown/JSON，供审计与迁移。
- `ai memory import <file> [--dry-run]`：只接受带 `schemaVersion` 的 Gateway JSON 或规范 Markdown frontmatter；先输出 create/update/conflict/drop 计划。非本机签名导出一律按 external/pending 导入，敏感扫描未通过则拒绝整批。
- `ai memory forget [--scope global|bot|project]`：软删，可在保留期内恢复，批量操作强制确认。
- `ai memory purge [--scope ...]`：物理删除 memories、embeddings、episodes、skills/relations 派生物、jobs payload、可逆审计正文和含该数据的备份；二次确认后不可回滚。
- SQLite 备份无法安全地原地删除单账号行。purge 必须删除所有早于本次 purge 的 memory backup，再从清理后的在线库创建一份新基线备份；报告中明确其他账号历史备份也被轮换。
- purge 保留的最小审计只允许 `{operation_id, timestamp, record_count, content_hash}`，不得保留可还原正文。命令结束输出逐类删除数量和无法删除项；有失败则返回非零退出码并可用同 operation id 重试。

## Tier 1-2 增强规格（Phase 8-9）

本节续接 R1-R10 的硬规格写法，覆盖检索质量、时序正确性、知识图谱与程序性记忆（Skill）。行为门槛以本节为准；identifier/schema 仍以 `contracts.md` 为准。编号续 R10 → R11-R16，Skill 系统单列。

### R11 检索评测 harness（Phase 0 建立，Phase 8 扩充）

问题：现有测试全是功能性断言（scope 不串、TTL 到期），没有**召回质量**度量。没有它，"记忆是否更强"无法客观验证，重排权重和阈值调参全靠拍脑袋，且任何检索改动都可能悄悄回退。

方案：建立可版本化的黄金评测集 + 离线评测器 + CI 回归闸。

评测集格式（`test/memory/retrieval-eval/*.json`，人工标注，随 PR 演进）：

```typescript
type RetrievalEvalCase = {
  id: string;                     // 稳定用例 id
  description: string;            // 该用例考察点，如 "中文偏好召回"
  context: {                      // 检索时的作用域上下文
    userId: string; botId?: string; projectId?: string; engine: "claude" | "codex";
  };
  seedMemories: SeedMemory[];     // 预置进 fixture 库的记忆（含干扰项）
  query: string;                  // 当前 prompt
  expectedRelevantIds: string[];  // 必须召回（seed 里的稳定别名 id）
  expectedInjectedIds: string[];  // 经预算裁剪后必须最终注入
  forbiddenIds?: string[];        // 绝不应出现（如他人/跨 scope 记忆）
};
```

评测器行为：

1. 用 `seedMemories` 建一个**内存态确定性 fixture 库**（固定时间、固定随机种子、embedding 用可复现的 stub 或缓存向量），不碰真实 `memory.sqlite`。
2. 跑真实检索链路（Retriever → Rank → Budget → Inject），拿到 `retrievedIds` 与 `injectedIds`。
3. 计算指标：`recall@k`、`precision@k`、`MRR`、`nDCG@k`（k 默认 5/10）；注入层额外算 `injectedRecall`（`expectedInjectedIds` 命中率）、`forbiddenLeak`（禁止项泄漏数，必须为 0）。

硬规格：

- CLI：`ai memory eval [--suite <glob>] [--k 10] [--report json|table]`，输出每用例与聚合指标。
- 回归闸：`forbiddenLeak > 0` 直接 fail；聚合 `recall@10` / `injectedRecall` 低于同一 suite 版本的基线阈值（写入 `retrieval-eval/baseline.json`，初始建议 recall@10 ≥ 0.8）即 fail。suite 变化时基线必须带 `suiteVersion` 重新生成并在 PR 展示逐类前后指标，禁止通过修改数据集掩盖回退。
- fixture 与真实 store 共用同一检索代码路径，禁止为评测另写一份召回逻辑。
- 每次改动 Retriever/Rank/Budget/分词器/embedding，PR 必须附带本 harness 的前后指标对比。
- 线上只记录匿名质量信号：错误记忆纠正率、pending 批准率、空召回率、Pre-Read p50/p95、队列延迟、每账号抽取成本；不得上传 memory 正文。

### R12 双时态事实模型（Phase 8 必做）

问题：现在事实变更只靠 `confidence -= 0.2` 降权，旧值和新值同时留在库里"打架都不删"。用户从 Go 转 Rust 后，两条偏好都可能被召回，且无法回答"当时 vs 现在"。R4 的降权是**证据强度**维度，缺的是**时间有效性**维度。

方案：使用 canonical `memories` 已预置的 `valid_from/valid_to/superseded_by/fact_key`。Phase 8 启用冲突写路径和 `asOf` 查询；禁止再次 ALTER 出同义列。

语义与硬规格：

- **默认检索只返回 `valid_to IS NULL`（当前有效）的记忆**；历史版本保留但不默认注入。
- 事实被取代时：旧行置 `valid_to = now`、`superseded_by = 新 id`，**不删除**（保留时间旅行与审计能力）。取代由 R13 冲突消解驱动。
- `status` 与时态**正交**：`status` 管生命周期（active/pending/archived/deleted），`valid_to` 管现实有效性。一条 `status=active` 但 `valid_to` 已置的记忆 = "曾经成立、现已过时"。
- 新增检索选项 `asOf?: number`：给定时间戳时返回"该时刻有效"的快照（`valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf)`），供审计和"你上个月说过什么"类查询。
- 迁移：存量行 `valid_from = created_at`、`valid_to = NULL`、`fact_key` 按 R13 回填，纳入 R5 的版本化 migration。

### R13 冲突检测与消解（Phase 8 必做，与 R12 配套）

问题：抽取出新候选时，系统从不主动查"这和已有事实矛盾吗"，只是各写各的。要让 R12 的取代链真正生效，抽取管线必须显式做冲突判定。

方案：引入 `fact_key` 归一化 + 基数（cardinality）驱动的消解策略。

- **fact_key 归一**：抽取器为每条 fact/preference 产出结构化槽键 `category:subject:attribute`（示例：`preference:reply_language`、`fact:project.pkg_manager`、`skill:deploy.command`）。同一 `fact_key` = 同一事实槽。
- **基数元数据**：每个 `fact_key` 标 `single`（单值，如回复语言）或 `multi`（多值，如"熟悉的语言"）。single 走取代链，multi 走累积。
- `fact_key/cardinality` 先查内置 registry；未知 key 只能用 `multi` 或 pending，禁止模型把未知事实任意声明为 single 后覆盖数据。trust 比较顺序固定为 `user_stated > system > model_inferred > external`。

消解算法（Post-Run，写库前，在 R3 provenance 与 R4 打分之后）：

```
对每条 PolicyResult c：
  snapshot = 查 valid_to IS NULL 且 fact_key == c.fact_key 的当前有效行及 version
  relation = exact-normalizer 或冲突分类器返回 SAME | CONFLICT | INDEPENDENT | UNKNOWN
  UNKNOWN → c 存 pending，不修改 snapshot
  SAME → 若证据独立，在短事务内 CAS(version) 合并证据与 confidence
  CONFLICT + single：
      若 c.trust 不低于 existing.trust 且 c.confidence >= existing.confidence：
          短事务内先 CAS 设置 existing.valid_to/version，再插入 c 取得 c.id，最后回填 existing.superseded_by
          任一 CAS 失败则整体回滚、重新读取并最多重算 3 次
      否则 c 存 pending，不动 existing
  INDEPENDENT 或 multi 新值 → 插入新成员，不取代
```

冲突分类模型在事务外调用，输出严格枚举并附理由；相同规范化值不调用模型。进入写事务后必须用 `version` 比较并交换，防止另一个进程在分类与提交之间更新了事实。

硬规格：

- **external 来源（R3）永远不能触发取代**，只能进 pending 供人工确认——防止网页/工具输出"改写"用户真实偏好。
- 取代、合并、降级三类操作**必须写 `memory_events`**（`actor=system`，reason 只含 before/after hash、trust、confidence 和分类理由），支撑 R10 回滚且不复制正文。
- fact_key 归一逻辑收口在 `core/memory` 单一函数，抽取器与迁移共用。
- R11 评测集必须新增矛盾类用例（先说 A 后改 B，断言只召回 B、A 被正确 supersede）。

### R14 实体-关系知识图谱层（Phase 9）

问题：`relationship` 现在只是一条平铺文本，无法多跳。"我老板负责的那个项目用什么部署方式"需要串 人→项目→部署事实 三跳，纯向量/FTS 做不到。这是相对"embed 一切"方案的核心差异化。

方案：在 Claim/Evidence 之上定义实体与关系均为**一等公民**的 `TemporalGraphProjection`。下列 SQLite 表只作为 `local` profile 的 temporal/alias fallback 和可移植投影格式，不要求用它复刻完整图数据库；`team/enterprise` 优先接入 Graphiti-compatible adapter 及其支持的成熟图 backend。无论 backend 如何选择，权威事实仍在 Claim/Evidence，图投影可整体删除并重建。

```sql
CREATE TABLE entities (
  id            TEXT PRIMARY KEY,          -- canonical UUID
  user_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,             -- person | project | tool | org | resource
  name          TEXT NOT NULL,
  norm_key      TEXT NOT NULL,             -- 归一化名（小写去空白），实体去重用
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  attrs_json    TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (user_id, type, norm_key)
);

CREATE TABLE relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate     TEXT NOT NULL,             -- works_on | manages | uses | belongs_to | depends_on
  object_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  memory_id     INTEGER REFERENCES memories(id) ON DELETE CASCADE,
  confidence    REAL NOT NULL DEFAULT 0.5, -- 复用 R4 打分
  valid_from    INTEGER, valid_to INTEGER, superseded_by INTEGER,  -- 复用 R12 时态
  trust         TEXT NOT NULL,             -- 复用 R3 provenance
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_rel_subj ON relations (user_id, subject_id, predicate, valid_to);
CREATE INDEX idx_rel_obj  ON relations (user_id, object_id, predicate, valid_to);
CREATE UNIQUE INDEX uq_relation_current
ON relations (user_id, subject_id, predicate, object_id)
WHERE valid_to IS NULL;
```

硬规格：

- **图是投影不是真相源**：实体/关系从 Claim/Evidence/Episode 派生，删除、撤回或 supersede 来源时通过 projection event 级联失效对应关系（写 `memory_events`）。R3/R4/R12 的信任、打分、时态规则对 relations 同样适用。
- **实体消解**：先做 `(type,norm_key)` 精确匹配，再做 alias 候选。多个候选或低于阈值时创建 pending resolution，不自动合并；“老板”这类角色词是 relation/alias hint，不能无证据直接改实体 canonical name。
- **检索增强（可选混合）**：Retriever 命中实体时，通过 `TemporalGraphProjection.search` 调用 backend 原生的预算化 traversal；逻辑上最多 **2 条 relation edge（3 个节点）**，单层最多 20 条、总计最多 40 条，并在每一步过滤同一 tenant/user/current valid/authority。local fallback 使用 SQLite recursive CTE 或成熟 traversal utility，不自行实现通用图引擎。召回的内部 Claim/Memory id 汇入 RRF 的 graph source，绝不无限展开。
- **降级安全**：图层是增量能力，未启用或抽取失败时，系统必须回退到 R11 基线的非图检索且不报错。
- 抽取实体/关系复用 R2 的两级过滤与廉价模型，禁止为建图对主模型逐轮加调用。

### R15 检索有用性回流（Phase 9）

问题：只有 `inject_count / last_injected_at` 仍不能说明注入后**是否真的有用**。没有效果信号，重排只能依赖静态权重。

方案：Post-Run Hook 额外产出一份**注入反馈**，回写到被注入的记忆。

```typescript
type InjectionFeedback = {
  memoryId: number;
  outcome: "cited" | "neutral" | "contradicted";
  // cited: 回复/工具调用明显用到了该记忆
  // neutral: 注入了但无迹象被使用
  // contradicted: 用户在本轮纠正/否定了该记忆内容
};
```

判定与回写（复用 R2 的廉价模型判 outcome，不加主模型调用）：

- `cited`：`reward_score += 0.1`、刷新 `last_effective_at`、`cited_count += 1`。
- `neutral`：不奖励；`inject_count` 已在注入事务中增加，连续多次 neutral 计入淘汰倾向。
- `contradicted`：触发 R13 冲突消解路径（可能 supersede 或转 pending），并 `reward_score -= 0.2`。

`reward_score/inject_count/cited_count` 已在 canonical memories 表中定义，Phase 9 只启用反馈计算，不新增同义统计列。

反馈 evaluator 的输入仅包含单条已注入 memory、当前用户 prompt、最终回复和脱敏 tool summary；先用引用/参数一致性规则判断，歧义才批量调用廉价模型。主模型自称“我使用了记忆”不构成 cited。feedback 只影响 utility，不提高事实 confidence，避免错误记忆因被反复注入而自我强化。

硬规格：

- 本文排序公式中的 `utility` 固定为 `clamp(0.7*((cited_count+1)/(inject_count+2)) + 0.3*sigmoid(reward_score), 0, 1)`；Phase 9 启用前该项统一取 0.5，保证开关前后可比较。
- 所有反馈写 `memory_events`（`actor=system`, `event_type=injection_feedback`），可审计、可回滚权重实验。
- **防作弊**：`contradicted` 判定必须区分"用户否定记忆内容"与"用户否定模型做法"，仅前者影响 reward，避免误伤。歧义时记 neutral。
- R11 评测集扩展：加入带 `reward_score` 差异的用例，断言高有用率记忆在同分档位下排序靠前。

### R16 情景/语义/程序三层记忆（Phase 2 落 episode，Phase 9 启用蒸馏）

问题：现在只有"事实条目"一层。真正"像有记性"的系统靠**事件流 + 分层压缩**：先廉价记下发生了什么（情景），再蒸馏出稳定事实（语义）和可复用做法（程序/Skill）。缺情景层，Skill 就没有可供归纳的原料。

三层定义：

| 层 | 存储 | 写入成本 | 注入策略 | 对应 |
|----|------|----------|----------|------|
| 情景 episodic | `memory_episodes` 表 | 极低（本地结构化，**不调 LLM**） | 默认不注入，作蒸馏原料 + 最近事件召回 | 本条 |
| 语义 semantic | `memories` 表 | 中（R2 抽取） | 现有必注入/相关注入 | R1-R15 |
| 程序 procedural | `skills` 表 | 中（从 episodes 蒸馏） | 任务匹配时注入做法 | Skill 系统节 |

```sql
CREATE TABLE memory_episodes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_run_id TEXT NOT NULL UNIQUE REFERENCES execution_runs(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  bot_id        TEXT, project_id TEXT,
  engine        TEXT NOT NULL,
  task_summary  TEXT NOT NULL,            -- 脱敏 prompt 前 240 字符的确定性摘要
  steps_json    TEXT NOT NULL,            -- [{tool,args_hmac,ok}]，不保存原始 secret 参数
  result_status TEXT NOT NULL CHECK (result_status IN ('success','failed','cancelled','abandoned')),
  outcome_evidence_json TEXT NOT NULL DEFAULT '[]', -- 可验证检查、用户确认或测试结果
  applied_skill_ids_json TEXT NOT NULL DEFAULT '[]',
  intent_key    TEXT,                     -- Phase 7 distiller 归一化的任务意图
  signals_json  TEXT NOT NULL DEFAULT '{}', -- 命中的偏好/身份/流程信号（供蒸馏定位）
  extracted_at  INTEGER,
  extraction_mode TEXT CHECK (extraction_mode IS NULL OR extraction_mode IN ('model','local','none')),
  distilled_at  INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER                   -- 情景 TTL，默认 30 天
);
CREATE INDEX idx_epi_undistilled ON memory_episodes (user_id, distilled_at, created_at);
```

硬规格：

- **写情景不触发抽取模型**：Post-Run 从 Phase 2 起先落一条 episode/envelope（纯本地）并提交 job。R2 extract worker 批量消费其脱敏文本生成近期语义候选；Phase 9 distiller 再按更长窗口消费 episode 的重复模式生成稳定语义和 Skill。`distilled_at` 只表示 Phase 9 蒸馏完成，不表示 R2 抽取完成。
- 情景层负责"最近做过什么"的短期召回（补充现有 short_term），语义/程序层保持既有注入语义。
- **防膨胀**：episodes 有 TTL（默认 30 天）+ 蒸馏后可归档；蒸馏产物（语义事实、skill）才是长期资产。
- 蒸馏（Phase 7 Distill Hook 扩展）从 episodes 中挖：重复成功的动作序列 → Skill 候选（见 Skill 系统节）；反复出现的信号 → 语义事实候选。
- `task_summary` 先经过 credential/PII redactor；`args_hmac` 使用本机审计密钥计算，只用于判断动作参数是否重复，不能反推出参数。`privacyMode=incognito` 不写 episode；`no_write` 只写不含 task/steps 的运行状态。
- episode 的 `result_status=success` 只表示 engine turn 正常结束，不等于 Skill 成功。Skill 计数必须有 `outcome_evidence_json` 中的机器可验证条件或用户确认。

### Skill 系统 · 程序性记忆自沉淀（Phase 9-10）

结论先行：**可行，且是这套记忆系统的自然延伸**。Skill = 程序性记忆，复用已有的抽取(R2)、投毒防护(R3)、confidence 状态机(R4)、时态(R12)、冲突消解(R13)、有用性回流(R15)、情景层(R16) 全套机制，不是另起炉灶。

定位：Skill 是"在什么情境下、按什么步骤、能达成什么结果"的可复用做法，从**反复成功的情景(episodes)**中蒸馏，或由**用户明确示范/确认**产生。它是 `memories.category = skill` 的结构化升级版，独立成表以承载步骤与护栏。

Phase 10 migration 将现有 `memories.category=skill` 转成 `skills.status=candidate`，在原 memory 上设置 `valid_to`，并用 memory_event 记录目标 skill id；`memories.superseded_by` 只引用 memory，不能跨表引用 skill。之后新 Skill 只写 skills 表。Retriever 对同一迁移链只注入结构化 Skill，禁止 memories/skills 双重注入。

```sql
CREATE TABLE skills (
  id             TEXT PRIMARY KEY,        -- canonical UUID
  user_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL CHECK (scope IN ('global','bot','project')),
  bot_id         TEXT, project_id TEXT,
  name           TEXT NOT NULL,
  trigger_json   TEXT NOT NULL,           -- 触发条件：关键词/意图/工具签名/上下文
  preconditions_json TEXT NOT NULL DEFAULT '[]',
  steps_json     TEXT NOT NULL,           -- 有序步骤 [{intent,tool?,args_template?,check?}]
  guardrails_json TEXT NOT NULL DEFAULT '[]', -- 高危步骤需确认、禁用条件
  success_criteria_json TEXT NOT NULL DEFAULT '[]', -- 类型化断言：exit/file/test/http/user_confirm
  failure_sigs_json TEXT NOT NULL DEFAULT '[]', -- 已知失败特征
  trust          TEXT NOT NULL,           -- R3: user_stated | model_inferred | external
  confidence     REAL NOT NULL DEFAULT 0.5,   -- R4
  status         TEXT NOT NULL DEFAULT 'candidate'
                 CHECK (status IN ('candidate','validated','active','deprecated','deleted')),
  success_count  INTEGER NOT NULL DEFAULT 0,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  valid_from     INTEGER, valid_to INTEGER, superseded_by TEXT,  -- R12
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (
    (scope = 'global'  AND bot_id IS NULL     AND project_id IS NULL) OR
    (scope = 'bot'     AND bot_id IS NOT NULL AND project_id IS NULL) OR
    (scope = 'project' AND bot_id IS NULL     AND project_id IS NOT NULL)
  )
);
CREATE INDEX idx_skill_active ON skills (user_id, scope, status, valid_to);
CREATE UNIQUE INDEX uq_skill_global_name ON skills(user_id,name)
  WHERE scope='global' AND valid_to IS NULL;
CREATE UNIQUE INDEX uq_skill_bot_name ON skills(user_id,bot_id,name)
  WHERE scope='bot' AND valid_to IS NULL;
CREATE UNIQUE INDEX uq_skill_project_name ON skills(user_id,project_id,name)
  WHERE scope='project' AND valid_to IS NULL;
```

该表的 `global/bot/project` 是 migration/storage alias，不是公共契约。Skill Service、Policy、event 与 API 必须使用完整 `ScopeRef`；`global` 映射为 `ScopeRef{kind:"user", id:user_id}`，其他值由对应 id 还原。Storage adapter 是唯一允许进行双向编码的位置，未知或缺少 tenant/owner/audience/purpose 的 scope 必须 fail-closed。

生命周期（复用 R4 状态机语义）：

- `candidate`：来源二选一——①**归纳型**：同类任务 episodes 成功 ≥ 3 次，蒸馏出稳定步骤序列；②**示范型**：用户明确"以后这样做/记住这个流程"。
- `candidate → validated`：独立成功再现 ≥ 3 次，或用户确认。独立成功必须来自不同 execution run，且每次满足 `success_criteria_json`；单独 exit code 0 不计成功。
- `validated → active`：`user_stated` 或已满足独立成功门槛的 `model_inferred` 在 bot/project scope 自动激活；升 global 或 trust=external 必须用户批准。只有 `active` 参与任务提示。
- `active → deprecated`：`fail_count / (success_count+fail_count)` 超阈（如 > 0.4），或被新版本 supersede（R12）。
- **external 来源永不自动 active**（R3）：从网页/文件/工具输出归纳的 skill 强制停在 pending/candidate，必须人工确认。

`trigger_json` schema 固定为 `{intentKeys:string[], keywords:string[], requiredTools:string[], projectIds:string[]}`，每项设数量/长度上限。匹配顺序：scope/status/time 硬过滤 → intent exact → keyword FTS → 可选 trigger embedding；使用与 memory 相同的 RRF，默认阈值 0.65、top 3，并受 skills token cap。没有达到阈值就不注入，模型不能自行要求“列出所有 skill”。

归纳型 Skill 的可编码流程：

1. distiller 给 episode 生成受 schema 约束的 `intent_key`，先按 `(user,scope,intent_key)` 分组，只取有 outcome evidence 的成功 episode。
2. 将步骤归一成 action signature：`tool + 参数名集合 + 目标类型 + check 类型`，不包含具体 secret/value。
3. 通过 `ProcedureMiner` 调用维护中的 PrefixSpan/有序子序列挖掘库，对最近最多 100 条 episode signature 运行模式挖掘；不得手写通用 PrefixSpan。support 至少 3 个独立 run 且组内比例至少 0.6，最长 12 步。库不可用时保留待处理 job 并使用经过同一 fixture 验证的相邻 n-gram local fallback，不删除 Skill 自动沉淀能力。
4. 廉价模型只负责把频繁序列命名、生成 slot 和 guardrail；本地 validator 确认每个生成步骤都可映射回支持它的 episode signature，凭空增加的步骤删除并降低 confidence。
5. 失败 episode 用于生成 failure signature，不计 support；若同一序列失败率超过 0.4，不创建 candidate。

success evaluator 只支持白名单断言：进程 exit、文件存在/内容 hash、测试命令结果、HTTP status/JSONPath、Browser 可见 selector、用户确认。断言在 action 完成后由服务层执行并写 hash 证据；模型声称“成功”不算证据。

自沉淀闭环（这是"skill 自行沉淀"的核心，全部复用已有 hook）：

```
Pre-Read：任务命中某 active skill 的 trigger → 作为「程序性提示」注入
          （<ai_gateway_memory> 内新增 <skill> 段：步骤 + 护栏 + 确认点，仍是数据非指令，受 R3 注入侧清洗）
   │
运行时：Claude Code / Codex 参考做法执行
   │
Post-Run：落 episode(R16)，记录本次是否遵循该 skill、结果 success/fail
   │
蒸馏(Phase7 Distill 扩展)：
   - 消费 `distilled_at IS NULL` 的 episodes
   - 序列模式挖掘：重复成功的动作序列 → 新 skill candidate（归纳型）
   - 命中已有 skill：success→confidence↑、success_count↑；fail→confidence↓、fail_count↑、记 failure_sig
   - 相似 skill 合并；参数化：把具体值抽成 args_template 的 slot（自我泛化）
   - 触发 R13 冲突消解 / R12 版本取代（旧 skill valid_to、superseded_by 新版本）
```

Skill 注入格式（附加在现有注入块内，`readonly`，受同一 policy 约束）：

```xml
<skill id="s_abc" name="发布前校验" confidence="0.82">
  <trigger>用户要发布/部署本项目时</trigger>
  <steps>1. 运行 npm test  2. 通过后再 build  3. 失败则停止并报告</steps>
  <guardrail>步骤含部署命令，执行前需用户确认</guardrail>
</skill>
```

安全硬规格（Skill 比静态事实风险更高——它编码"要执行的动作"）：

- **高危动作护栏**：对结构化 tool intent、参数和目标执行 action classifier；删除/转账/下单/提交/发送/部署等即使 skill=active 也必须在执行时逐步确认，不能只靠步骤文本关键词。
- **external 永不自动执行**：`trust=external` 的 skill 只能作待确认建议，不自动进入 active 注入；从本地成功 episodes 归纳的 `model_inferred` 可按三次独立验证规则升级。
- **参数脱敏**：蒸馏前移除 token、路径中的用户名、账号和具体业务 id；`args_template` 只允许声明过的 slot/type/default，禁止存环境变量值或原始 header。
- **跨 scope 提升需显式**：project skill 升 global/bot 必须显式动作 + 记 `memory_events`，防止一个项目的做法污染全局。
- **回滚**：skill 的创建/升降级/合并/取代全部写 `memory_events`（`actor=system|user|distiller`），支持 `ai memory skill history`。
- 命令：`ai memory skill list|show|approve|deprecate|edit`，走 R10 的统一审计界面，不新增独立 Telegram 命令。
- R11 评测集扩展 skill 维度：断言"同类任务成功 3 次后生成 validated skill；再遇同类任务 active skill 被正确注入；高危 skill 注入必带 guardrail"。

结论：Skill 系统不需要新范式，它就是"情景(R16)→ 蒸馏(Phase7)→ 程序性记忆"这条链的产物；把 R11-R16 打好，Skill 自沉淀是水到渠成的第 10 阶段能力。

### R17 Memory / Skill / Capability 调用链可观测性（Phase 1 起持续）

> 本条是**跨层可观测性契约**（[contracts.md §6](contracts.md#6-运行时可观测性契约跨层observability)）在 memory 层的落地：traceId 源自 `ExecutionContext.trace`，与 transport/learning 层共用同一 traceId，脱敏与后端非权威规则遵循该契约。

问题：记忆和 Skill 是隐式能力。仅知道“调用过 Memory”不足以解释为什么启用、各检索 route 返回什么、哪些候选被 scope/authority/time/budget 过滤、最终注入什么、Skill 是否被真正遵循、执行是否偏离，以及它是否改变了结果。R11 验证离线期望，R17 负责线上每次真实调用的可解释 trace。

方案：业务调用点只构造一次 [contracts.md §6](contracts.md#6-运行时可观测性契约跨层observability) 的 `CapabilityObservation` 并调用 `ObservabilitySinkPort.tryEmit()`。当前 `writeLog` JSONL 是 local projection adapter，OpenTelemetry/OTLP 是 trace/metric projection adapter；**禁止**为 JSONL、OTel 和 dashboard 分别重复埋点。Observation 非权威、可采样；`RuntimeEvent`、审计和 Claim/Evidence Ledger 仍是事实来源。

#### Span 与异步因果结构

```text
runtime.execution
├─ capability.resolve(memory)
├─ memory.pre_read
│  ├─ memory.plan
│  ├─ memory.retrieve
│  │  ├─ memory.retrieve.route(required)
│  │  ├─ memory.retrieve.route(fts)
│  │  ├─ memory.retrieve.route(vector)
│  │  └─ memory.retrieve.route(graph/temporal/episode)
│  ├─ memory.filter → memory.rank → memory.budget → memory.compile → memory.inject
│  └─ skill.match → skill.select → skill.apply
│     └─ skill.step → capability.invoke(tool/workflow/model) → capability.result
└─ provider execution / response

memory.post_run --continued_by link--> extract → candidate → conflict → write → feedback
skill.distill   --continued_by link--> validate → lifecycle → evaluation/promotion
```

同步调用使用 parent/child span。Post-Run、distill、evaluation 等 durable job 继承原 `traceId`，创建新 root span 并用 `ObservationLink.relation=continued_by|evaluated_by` 指向来源 span；不得把数分钟后的异步任务伪装成仍在用户请求栈内。每个 Observation 同时带 `operationId`，有 execution 时带 `executionId`，有权威 lifecycle event 时写入 `runtimeEventIds`。

#### 通用 Capability action schema

| action | 触发点 | 必填 payload（正文禁止） |
|---|---|---|
| `capability.resolve` | Registry 解析实现 | `requestedCapabilityId`、requested version/range、`registryRevision`、candidate count、reject reason counts、selected capability/version/adapter、`policyDecisionId` |
| `capability.invoke` | Kernel 已授权、调用前 | `invocationId`、input hash/byte length、deadline、budget、`SideEffectClass`、confirmation state、retry owner |
| `capability.result` | 调用终态 | `invocationId`、outcome、duration、output hash/byte length、error code、retry count、cancel/compensation state |

`tool/workflow/agent/model/retrieval` 都必须使用这三个通用 action；专用 Memory/Skill action 是其内部解释，不替代 Kernel invocation event。一个 `invocationId` 恰有一个 `capability.result` Observation；丢失时 query view 标记 `partial`，不能伪报成功。

#### Memory action schema

| action | 触发点 | 必填 payload（数组均设上限） |
|---|---|---|
| `memory.plan` | Recall Planner 完成 | invoke reason、intent key hash、memory mode、policy snapshot、planned routes、query count、token/latency budget |
| `memory.retrieve.route` | 每个 route 终态 | route、adapter id/version、query hash、authorization filter applied、hit count、timeout/cache/fallback、duration、error code |
| `memory.filter` | scope/authority/taint/time/conflict 过滤后 | input/output count、`rejectedByReason`、policy decision id；禁止记录被拒正文 |
| `memory.rank` | fusion/rerank 完成 | algorithm/version、top items（最多 20 个：memory id、category、rank、rounded total/component scores）、tie-break reason |
| `memory.budget` | token/category cap 后 | before/after count、estimated tokens、trimmed by reason/category、cap hit、remaining budget |
| `memory.compile` | Context Compiler 完成 | compiler version、block types、source count、output hash/length/tokens、cache hit、manifest id |
| `memory.inject` | MemoryExtension 接受 patch | injection manifest id、memory ids、skill application ids、allowed paths、before/after hash、token count、result |
| `memory.skip` | Memory 未进入或提前退出 | `non_private|incognito|memory_disabled|policy_denied|deadline|no_hit|backend_unavailable|budget_zero|protocol_unknown` |
| `memory.extract` | Post-Run extractor 终态 | extractor adapter/version、input segment count/hash、model called、candidate/drop count、duration、budget state/error |
| `memory.candidate` | candidate 定级 | candidate id、fact key hash、category、trust、confidence、decision、reason codes、evidence count/corroboration groups |
| `memory.conflict` | 冲突消解 | old/new ids、relation、decision、reason codes、value hashes、temporal overlap；禁止值正文 |
| `memory.write` | Ledger mutation 终态 | memory/claim/evidence ids、operation、status、scope kind、revision、idempotency replay、duration/error |
| `memory.feedback` | outcome attribution | memory id、retrieved/injected/referenced/decisionChanged/outcomeChanged、utility dimensions、evidence source |
| `memory.compress` | projection 编译/替换 | manifest id、source/output count、coverage、token before/after、QA result、rollback artifact ref |

每个 retrieval route 单独成 span，避免“Memory 总耗时 200ms”却无法判断是 vector、graph 还是 reranker 慢。`authorization filter applied=false` 是 hard safety regression；该 route 结果不得进入 fusion，并立即发安全告警。

#### Skill action schema

| action | 触发点 | 必填 payload（步骤正文禁止） |
|---|---|---|
| `skill.match` | trigger matcher 完成 | intent/project/tool context hash、candidate count、top candidates（skill id/version、trigger kinds、score、scope/status）、rejected reason counts |
| `skill.select` | Policy/预算/冲突过滤后 | selected ids、rejected ids+reason、token budget、risk classes、policy decision id |
| `skill.apply` | Skill 注入或执行计划绑定 | `skillApplicationId`、skill id/version、source、guardrail/confirmation counts、injected token count、application mode (`advisory|guided|executable`) |
| `skill.step` | 每个 Skill IR step 终态 | application id、step id/ordinal、declared capability id/version、actual invocation id、status、confirmation、precondition/invariant result、deviation reason、duration/error |
| `skill.outcome` | 任务结束并完成归因 | application id、adherence ratio、completed/skipped/deviated steps、postcondition result、task outcome、referenced/decisionChanged/outcomeChanged、harm/correction signal |
| `skill.distill` | mining/distill 终态 | candidate/skill id、miner/version、source execution/episode count、support ratio、parameter slots、dedup result、error |
| `skill.validate` | 每个验证 gate | skill id/version、gate (`schema|alignment|risk|replay|sandbox|shadow`)、result、fixture/eval refs、duration、reason codes |
| `skill.lifecycle` | 状态变化 | skill id/version、from/to status、decision id、actor kind、reason codes、rollback/superseded refs |

`skill.apply` 不等于有效复用。只有 `skill.outcome.postconditionResult=passed`、任务成功、无 hard regression，且 `outcomeChanged=true` 或有明确用户/工具证据时，才计入正向 Skill 复用；Agent 偏离步骤但任务成功不得归功于 Skill。

#### 查询与展示目标契约

- `ai trace show <traceId> --view timeline|tree|memory|skill|capability`：按时间线或调用树展示，必须标记 `complete|sampled|partial`。
- `ai memory explain --trace <traceId>`：展示 invoke reason、route latency/hits、过滤 reason counts、排名/预算、最终注入 id 与 attribution，不显示正文。
- `ai skill explain --trace <traceId> [--application <id>]`：展示 match/select/apply、步骤调用、确认/护栏、偏离和 outcome attribution。
- Web Observability 使用同一 `ObservabilityQueryPort`，固定视图为 Timeline、Memory Recall、Skill Application、Capability Calls、Cost & Latency、Errors；Web/CLI 禁止各自读取 JSONL 或实现字段解释。
- `ai log --category memory --trace <id>` 保留为 local compatibility view，内部读取同一 Observation projection。

普通用户只看自身 `summary/explain`；平台运营者看聚合指标；`internal` 视图、跨主体关联和原始 canonical id 需要独立 Policy 权限并记录审计。`internal` 不等于跨租户权限；跨租户调查必须为每个目标 tenant 取得短时 break-glass grant、逐 tenant 查询且禁止结果混页。Skill 名称由授权后的 Skill Service 按 id 解析，Observation 只保存 `skillId/nameHash/nameLength`，防止 exporter 泄漏业务流程名称。

Query Adapter 必须把内部 envelope 转为 action + view 对应的 closed `ObservationViewRecord`，不能把原始 payload 透传。cursor 绑定 tenant/scope/view/filter/query cutoff；修改过滤器后复用返回 `invalid_cursor`。`complete` 只表示 closed trace 在 retention 与 projection watermark 内无已知缺口；有意采样为 `sampled`；open trace、drop、lag、retention 截断、missing parent 或 projection corruption 为 `partial` 并显示原因。分页不得让同一查询不同页使用不同 watermark。

Cost & Latency 视图是联合只读视图：latency 来自 Observation，token/cost/ledger revision 来自 `UsageObserver` 权威 read model，先按 `operationId/executionId/invocationId` 关联，再由权威 `RuntimeEvent` 解析到 upstream attempt。`CapabilityObservation` 和 Observability store 禁止复制、修正或补写 usage/cost；关联失败显示 `usage_unavailable|usage_pending|not_billable`，不得按 latency 或 token 估算费用。

#### Metrics 与采样

- Memory：invocation/skip/zero-hit、route latency/error/cache/fallback、filter reason、injected count/tokens、budget trim、compile cache、extract queue age、candidate decision、stale-memory/correction。
- Skill：match/select/apply rate、adherence、step success/deviation、confirmation/guardrail block、postcondition pass、positive reuse、harm/correction、validation/lifecycle transition。
- Capability：resolve/invoke/result、latency、error、cancel、retry、compensation、adapter/version 与 budget exhaustion。
- `traceId/executionId/memoryId/skillId/invocationId/principal/project` 禁止成为 metric label；只允许低基数 family/kind/status/route/adapter family/error code/profile。

默认 tail sampling 对 error、degraded、policy deny、high-impact Skill、Ledger write、candidate activation、lifecycle/promotion/rollback 与用户显式 debug trace 的采样率必须为 100%；普通成功 read trace 可按 deployment policy 采样。这里的 100% 表示“不得被 sampling policy 丢弃”，不承诺基础设施永不故障。实现使用 normal/critical 两级有界队列、critical reserved capacity 和权限为 `0600` 的有界本地 spool；exporter 恢复后按 `observationId` 幂等回放。critical 队列与 spool 都耗尽时仍不得阻塞 Runtime，必须增加 drop counter、触发告警并把查询标为 `partial`。临时 full-detail session 必须绑定 scope/capability/操作者/最长时限，自动过期并审计。任何采样、drop、export lag 必须进入 `ObservationPage.completeness` 与 `observability_dropped_total`，禁止把缺失解释为“未调用”。

#### 硬规格

- **`traceId` 贯穿**：Surfaces→Orchestration→Capability→Kernel→Transport→Memory/Skill→Learning 共用 traceId；异步工作使用 span link。
- **绝不记敏感内容**：不记录 prompt、memory/Skill 正文、步骤文本、secret、raw Evidence、tool args/output、reasoning；只允许 id、hash、长度、枚举、计数、分数和 reason code。
- **失败不阻断**：`tryEmit()` 有界且非阻塞；Observation queue/exporter 故障不能影响 Memory、Skill、Usage 或用户回复。
- **一次埋点，多路投影**：JSONL、OTel、metrics、dashboard 由 Adapter 投影；业务模块禁止多次 emit 同一语义事件。
- **权威分离**：Observation 不能驱动 Claim/Skill 状态、Policy 或计费；自动 promotion 只能消费权威 RuntimeEvent/EvaluationResult，Observation 仅用于诊断和可重建指标。
- **资源上限**：单条 envelope ≤16KB；top item/step/reason 数组有 schema 上限；超限确定性截断并写 `truncated=true`。local JSONL `0600`、20MB 锁轮转保留 5 份；多进程锁超时丢 Observation 不阻断主流程。
- **开销门槛**：同步 emit 本地 p95 ≤2ms、p99 ≤5ms；关闭 exporter 后行为与无 Observability baseline 一致；Observation 不得进入 prompt token 或 Memory 注入预算。

### R18 Telegram 记忆中间态展示（Phase 2 起）

目标：让用户在 Telegram 里**看得见记忆系统在工作**（召回、注入、记住了什么、用了/沉淀了哪条 skill），像思考中中间态那样，而不是黑箱。

**Emoji 约定（避免语义冲突）**：引擎的 `thinking` 态从 `🧠` 改为 **`⏱️ 思考中…`**（已在 `Formatter.progress` 落地），把 `🧠` 让给记忆。四类互不冲突：`⏱️`=引擎思考，`🧠`=记忆召回/注入，`🧩`=技能套用/沉淀，`📝`=记忆写入。

方案：复用现有 `ProgressReporter` + `ProgressUpdate`（`src/telegram/interaction/progress-reporter.ts`），**扩展 `phase` 增加记忆态**，不新开一条消息通道——记忆态与引擎执行态共用同一条可编辑进度消息，顺序演进、最终由回复替换（`replaceWithHtml`）。

```typescript
// engine/types.ts: ProgressUpdate.phase 追加记忆/技能阶段
//（thinking 引擎态展示改用 ⏱️，🧠 让位给记忆态）
phase: "memory_recall" | "memory_injected" | "skill_applied"
     | "thinking" | "tool_calling" | "writing"
     | "memory_learned" | "skill_learned" | "done";
```

展示文案（`Formatter.progress` 增分支，中间态节流沿用现有 throttle）：

| phase | 展示示例 | 时机 |
|-------|----------|------|
| `memory_recall` | `🧠 正在回忆相关记忆…` | Pre-Read 检索开始 |
| `memory_injected` | `🧠 已调用 N 条记忆` | 注入完成（N=最终注入条数，来自 R17 `memory.inject`） |
| `skill_applied` | `🧩 套用技能《发布前校验》` | 命中并注入某 active skill（名称来自 `skills.name`） |
| `memory_learned` | `📝 记住了 1 条新偏好` | Post-Run 有 active 记忆写入（异步轻提示） |
| `skill_learned` | `🧩 沉淀了新技能《发布前校验》` | 蒸馏产出 validated/active skill 或升级（异步轻提示） |

硬规格：

- **Emoji 不冲突**：`⏱️`=引擎思考，`🧠`=记忆召回/注入，`🧩`=技能套用/沉淀，`📝`=记忆写入。同一约定在 `Formatter.progress` 与 [01-surfaces.md](modules/01-surfaces.md)（Progress Streaming 附录）保持一致。
- **只显状态不泄内容**：中间态只说"回忆中/已调用 N 条/套用技能《名》/记住新偏好/沉淀新技能《名》"，**绝不显示记忆或技能的正文、步骤、id、分数**（正文与步骤管理走统一审计界面，R10）。skill 只显 `name`，不显 `steps_json`。
- **skill_applied 是同步态**：命中 active skill 属 Pre-Read 注入的一部分，与 `memory_injected` 同批展示（可合并为一条 `🧠 已调用 N 条记忆 · 🧩 套用《名》`）。
- **群聊守卫对齐 R7**：非私聊既不注入也不展示任何记忆/技能态（此时根本不召回）。
- **异步不阻塞（R2）**：`memory_learned` / `skill_learned` 均属 Post-Run 异步结果，不得为显示它们而拖延 `⑤ 立即返回用户`；实现为回复发出后可选追加轻提示，或并入下一轮进度，超时/失败静默丢弃。
- **skill_learned 门槛**：仅在蒸馏产出 `validated`/`active` 或发生版本升级时提示；`candidate` 态不打扰用户。external 来源 skill 不自动 active，故也不触发该提示（对齐 Skill 系统安全规格）。
- **降级安全**：所有中间态展示是最佳努力，`ProgressReporter` 现有 429 退避与"best-effort 不影响任务完成"语义继续适用。
- `memory_injected` 的 N 来自 R17 `memory.inject` Observation；`skill_applied` 的 skill id 来自 `skill.apply`，名称再由授权后的 Skill Service 解析，保证"看到的"与"记录的"一致且不把名称写入 exporter。

### R19 Claim/Evidence 与来源权限不可洗白（Phase 2 起）

- 所有 semantic memory 写入必须产生 Claim 和至少一条 Evidence；`memories.evidence_json` 只用于旧库迁移。
- Evidence 必须保存 origin set、derivation hash、corroboration group、polarity、authority cap 和 taint labels。
- summary/distill/profile/graph/skill 等派生操作的 authority cap 取关键来源最低值；external 不因经过可信模型或可信工具处理而升级。
- 独立证据判定使用 corroboration group，不使用“不同模型输出”“不同 job”或“不同摘要文本”作为独立性证明。
- 用户确认只提升绑定 Claim hash 的事实；工具验证只提升其白名单 assertion 能证明的 predicate/value/time 范围。

### R20 规划式与迭代式检索（Phase 5、11）

- Planner 输出只能是受 schema 约束的 intent/entity/time/type/route，不得包含 SQL、任意账号、文件路径遍历或 raw auth 标识。
- 初始 Pre-Read 必须保持 deadline；复杂图/episode/iterative route 超时独立降级，不能阻塞 required/profile/constraint 快速路径。
- 主模型 `memory.search` 默认每 turn 一次、8 条、1200 tokens；其结果不自动写回新记忆，也不能请求其他 audience 或历史 deleted 内容。
- 检索排序必须显式考虑 authority、temporal fit、evidence coverage、interference 和 token cost；权重升级须经 Shadow replay。

### R21 Profile Compiler、前瞻/约束/负向记忆（Phase 3、7）

- Profile Snapshot 是 active Claim 的编译投影，保存 source ids 和 compiler version；模型不能整体覆写 profile。
- prospective memory 只能触发提醒、约束、确认或受 scheduler policy 控制的任务，不能仅凭记忆获得副作用权限。
- constraint 与 preference 使用不同注入段和优先级；system safety policy 不受用户记忆覆盖。
- negative memory 与相关 Skill/方案共同召回，避免系统只记住成功而重复已知失败。

### R22 Skill IR 验证流水线（Phase 10）

- `steps_json` 只保留为兼容显示；执行与生命周期依据版本化 Skill IR。
- Skill active 前必须完成 schema validation、episode trace alignment、static risk analysis、sandbox replay 和 shadow invocation。
- environment fingerprint、required capabilities、pre/postcondition、invariant 和 rollback 是 Skill version 的必填治理字段；不适用时使用明确空数组，不能省略验证语义。
- 工具 major version、环境指纹或关键 Claim 变化时进入 `needs_revalidation`，不得继续按 active 注入执行建议。

### R23 Capability Security Kernel（Phase 4）

- capability handle 必须签名、短时有效并绑定 user/execution/domain/operation；跨 execution 和跨 Agent 复用失败。
- Memory、Profile、Skill、网页、文件和模型输出均无权创建或扩权 capability；只有 Broker/Policy Kernel 可以签发。
- redirect、data egress、confirmation 和 action risk 在工具执行时验证，不能只依赖 prompt 中的 capability 描述。

### R24 Shadow、完整性与可逆编译（Phase 11-13）

- candidate Planner/ranking/policy/compiler/skill 先在 shadow mode 运行，不得影响生产 injected ids、工具权限或数据库状态。
- memory_events 使用 hash chain；checkpoint、备份和恢复必须可验证，发现断链时 fail-closed 禁止自动治理写入，但主任务仍可在 no-memory 模式运行。
- parametric promotion 必须保存 source Claim/Evidence、compiler version、评测结果和撤销路径；来源撤回、冲突取代或评测回退时自动失效。

### R25 Derivation DAG 与结构化确认（Phase 2）

- `origin_set_hash` 只用于缓存和快速比较，所有派生关系必须写 `memory_derivations`，并能从 parent Evidence 重算 authority、taint、corroboration 和 purge 影响面。
- 只有 `user_confirm` 和 `tool_verify` transform 可以提升 authority；其他 transform 的 cap 取关键 parent 最低值。
- 用户确认必须绑定 claim hash 和 displayed value hash；hash 不一致、Claim 已变更或 audience 不匹配时确认失效并要求重新展示。

### R26 ProtocolExchange 状态机与回放（Phase 1）

- Turn 关联必须综合 execution marker、协议 id、内容指纹和流状态；末尾 role 只能是弱信号。
- retry/continuation/compaction 继承 injection manifest 且不重复写事件；relation unknown 时透传并只落低风险 execution episode。
- adapter 变更必须通过完整 fixture corpus；未知事件原样透传，失败/取消/断流不得误判成功。

### R27 分层延迟预算（Phase 1、5、11）

- 300ms 只覆盖 L0-L2 本地路径；远程 Planner、remote reranker、复杂 NLI 和反事实属于 L3。
- Profile 必须预编译，网络 I/O 不得进入只读事务；L3 只能通过受限迭代式 search 返回，不能修改已发送 prompt。
- 每个 route 独立记录 deadline、timeout 和 degradation reason，不能用总超时隐藏单路退化。

### R28 模糊时态与图索引可重建（Phase 8-9）

- fuzzy/relative/unknown 时间是一等合法值；没有证据时不得填充精确 epoch。
- Event Hypergraph 是 `TemporalGraphProjection` 的产品逻辑视图，不是自研图引擎要求；node/edge 必须携带 source ids 和 index generation，允许整体删除后从 Claim/Evidence/Episode 重建。
- 每条注入 graph path 必须回源 active Claim/Evidence，并受深度、节点、边、路径和 authority 预算。

### R29 Skill DSL、验证等级与风险上限（Phase 10）

- Skill DSL 禁止任意循环、动态工具名、自修改、未声明环境值和 capability；无法表达的流程保留 advisory 文本，但不能 active 自动执行。
- 风险等级决定最低验证门槛：只读需 replay+shadow，可回滚本地写需 sandbox，外部写即使 active 仍确认，转账/生产破坏永不无人确认执行。
- 只有 Skill 被实际遵循且后置条件成功才提升；Agent 偏离但任务成功不能归功于 Skill。

### R30 分级 Utility 与反事实预算（Phase 9、11）

- Utility 拆成 retrieval/answer/action/harm/token/correction，多维信号保留原始计数；排序版本负责组合，禁止写回事实 confidence。
- counterfactual 只对高影响样本异步执行，使用固定 judge、缓存、每日预算和可复现输入；全量逐条双跑禁止进入同步链路。
- learned ranking 上线前必须同时改善端到端质量并不增加 stale-memory error、forbidden leak 和 harm score。

### R31 事件复制、Team Key 与 Artifact 生命周期（Phase 12）

- 多设备只复制签名 event envelope，不复制 SQLite；materializer 必须确定性并支持 causal parents/Lamport time。
- Evidence 追加合并，Claim 状态重算；purge 使用 tombstone + 内容密钥销毁。成员撤销后不得获得新 team key。
- Artifact 删除必须沿 Artifact→Observation→Evidence→Claim 派生链撤回，禁止遗留不可验证事实。

### R32 分级 Parametric Promotion 与长期仿真门槛（Phase 0、13）

- 默认 production promotion 依次为 compiled rule、local classifier、prompt/context adapter；Model Adapter/LoRA 保持 opt-in experimental，但不删除能力。
- 每个产物必须有 source ids、base model、compiler version、eval report、shadow result 和 rollback artifact；来源失效时自动停用。
- learned ranking、自动 Skill active、复制协议和 promotion 必须通过固定 seed 的长期 Memory Simulation Harness，不得仅用短检索黄金集宣称完成。

### R33 智能学习控制面与能力收益（Phase 0.5、2、7、11-12）

- 自动学习必须由版本化 Learning Objective 和确定性 Learning Governor 编排；模型只产生候选和弱评估，不能写 PolicyDecision、LearningDecision、最终 confidence 或 activation state。
- 每个非隐私禁写 execution 至少产生 outcome signal；学习动作必须绑定 objective、reason code、预算、policy/governor version 和 input hash，`no_artifact` 是合法且常见结果。
- 能力收益综合任务成功、纠正减少、有效复用、延迟/成本、陈旧错误、伤害和策略违规；memory count、retrieval count 和模型自评不是成功指标。
- attribution 必须区分 retrieved/injected/referenced/decision_changed/outcome_changed；事实 confidence 与使用 utility 分离，相关性不能冒充因果贡献。
- 自动压缩只替换可重建投影；Claim/Evidence 真相源、用户 pin、审计和 purge 派生链不被覆盖。CompressionManifest 必须 source coverage=1.0、可回滚并通过 Shadow QA。
- 主动学习按不确定性降低价值、目标影响和打扰成本决定；相同问题受每日预算和冷却期约束，安全歧义不能依靠模型猜测继续。
- scope promotion 创建脱敏共享 candidate，不修改原始记忆 scope；team/org active 需要跨主体/跨环境证据或明确 owner authority。

### R34 Runtime Transport Proxy、Usage/Memory 扩展与兼容治理（Phase 0-1，持续）

- 每个 execution 只允许一个 Runtime Transport Proxy listener、upstream route 和 base URL 覆写。现有 `startOpenAiUsageProxy` 是兼容 facade，UsageObserver 与 MemoryExtension 共用数据平面，禁止串联第二个 Memory HTTP Proxy。
- TransportForwarder 是最小数据平面；关键 request decode、TransformCoordinator 和批准的 CompatibilityTransform 留在受监督 Transport 路径，非关键 response parser、UsageObserver、MemoryExtension 在相互隔离的 worker/channel。Memory worker 失败当前 stream 与 Usage 继续；Usage worker 失败显式 degraded 并从 journal/reconciliation 恢复；forwarder 进程失败时当前 request 可失败但不得产生错误学习，下一 request 由 supervisor 恢复。
- TransformCoordinator 是唯一 mutator，Memory patch 先作用于 canonical AST，再执行批准的 Responses↔Chat/Provider compatibility transform；声明 patch path 之外 AST 必须保持一致。
- `core/memory` 只消费 SanitizedTurnEnvelope/Execution 契约。raw header、system、reasoning、tool input/output 只存在于 EphemeralTransportExchange，经递归 RedactionGateway 后仅以 hash 或 TTL 加密 sanitized ref 持久化。
- 每个 protocol/provider/CLI version 使用显式 compatibility profile 和 fixture corpus；未知 major、unknown event 或回放失败不能保持 full，必须收窄 MemoryExtension，不能关闭已验证 Usage behavior。
- transport 的 stopped/usage_only/extensions 与 Memory 的 disabled/passthrough/shadow_capture/read_only/full 独立建模；自动恢复必须经过健康窗口与 canary replay。
- route lease、listener registry 和 self-loop detection 是启动前硬门槛；随机端口不构成同 OS uid 安全边界，不互信企业租户必须使用 OS user/container/network 隔离。
- streaming parser、IPC 和 queue 必须有 per-item/per-turn/per-process 上限；超过上限继续透传但停止高风险 capture，禁止用 OOM 换取完整记忆。
- 现有 Usage records/metrics/translation parity 必须为 100%；纯透传 response bytes 一致，声明 transform 外 canonical AST 一致；失败/取消/unknown relation 的危险错误 active 必须为 0。
- injection profile 必须评估 prompt cache、cached/uncached tokens、TTFT 和 effective cost；超过门槛退回缩小注入或 on-demand，不能用“回答更好”隐藏无界成本。
- Transport、Usage/Memory extensions、Memory Store schema 和 Learning Governor 独立版本/回滚；Memory 回归使用 extension kill switch，不要求回滚 Usage、数据库或删除自动记忆功能。
- `ai doctor transport-proxy`（兼容 `memory-proxy` alias）与脱敏指标是 production 前置；任何日志、fixture、crash dump 和诊断输出都不得包含 authorization header、secret 或完整用户正文。

### R35 成熟组件复用、语义隔离与供应链治理（Phase 0，持续）

- Build/Adopt/Adapt 边界是架构约束：自有 Runtime 契约、Claim/Evidence、Authority、Governor、Capability、scope/purpose policy、审计和 purge；成熟 extractor/index/graph/checkpoint/queue/sequence-mining/policy/eval/crypto/telemetry 通过 adapter 复用。
- 第三方输出只能是 ADD-only candidate、PolicyDecision evidence 或可重建 projection；不得直接写 active/superseded/deleted、最终 confidence、scope promotion、capability 或 permission。
- Mem0-style extractor、Graphiti projection、Letta context block、LangGraph checkpoint 等 adapter 必须使用内部 stable id 和 schema；第三方 id、表结构、托管 API 响应不得泄漏到 public contract 或权威外键。
- vector backend 必须在检索期间执行 Runtime 授权过滤；durable-job backend 只承载 operation/lease/retry/dead-letter；受保护载荷只通过审计过的密码库和 SecretStore/KMS/HSM adapter 处理，三者都不得改变权威语义。
- 每个依赖必须有 ADR、SBOM、许可证/CVE、锁定版本、数据出境、升级/回滚和替换 fixture；高风险供应链事件可独立关闭 adapter 并回到 local baseline。
- 托管 backend 默认不接收 raw prompt、reasoning、secret 或 private Evidence；允许的数据字段、区域、保留期和删除回执写入 policy。无法证明 purge 或导出时不得用于对应数据分类。
- 更换 backend 必须通过 contract、authority boundary、scope isolation、purge、质量、延迟、成本和 replay parity；外部 benchmark 必须固定版本和预算，本项目不得引用无法复现的厂商宣传指标作为 release gate。
- graph/vector/reranker/policy/eval 任一外部组件故障按能力独立降级，显式用户控制和权威账本继续可用；禁止为可用性把数据发送到未批准 provider 或跨租户 fallback。

### R36 Skill Mining、参数化与自愈（Phase 10）

- `ProcedureMiner` 只吃 success + 可验证 outcome 的 episode，按 `intent_key` 分桶后用成熟序列挖掘（PrefixSpan，R35，禁手写）聚类；成为 candidate 需 `support≥minSupport`（默认 3）且跨 `≥distinctExecutions` 次独立 execution，secret/`args_hmac`/capability 不进特征也不进 IR。
- 参数化用 anti-unification：跨 ≥2 条 episode 变化的对齐位置升 `TypedSlot`，恒定值留常量，secret 派生字段永不升 slot；模型不得新增对齐结果之外的 slot。
- trace alignment 通过标准是硬门：`stepCoverage=1.0`、无 unsupported step、步序一致、tool 名与 argsTemplate 常量精确匹配、slot 落域内；治理步骤（assert/confirm/checkpoint/rollback）过 static risk 分析即可，不得靠 confidence 绕过。
- `needs_revalidation` 后必须自愈：用降级后新增的成功 episode 重走 mining+验证生成 ADD-only 新版本；连续失败 `≥maxRemineFailures`（默认 2）标 `deprecated` 并移出候选池，坏经验不污染后续挖掘；环境漂移是独立触发轴。
- `environmentFingerprint` 匹配语义固定（exact/semver_range/oneof/present + critical 标志）；critical 不满足即不可用并触发重验，禁止盲目回退旧 active；非关键不满足降级为 advisory。
- 贡献归因：对齐覆盖 `≥followThreshold`（默认 0.8）才算 followed，followed + postcondition 全过 + 无纠正才写正 `action_contribution`；retrieved 但未 followed 不计正贡献；反事实在 R30 预算内异步采样，只更新 utility 不改 confidence。
- 冷启动 seed 三入口（示范确认 / 显式导入 / 跨 scope 迁移）均进同一验证流水线，不豁免对应风险等级的 replay/sandbox/shadow 与高危确认；跨 scope 迁移必须本地重求 environment fingerprint 且不携带 private Evidence。

## 验收标准（从 SPEC §11 迁入）

> 迁自 SPEC §11 Acceptance Criteria。以下为 Gateway CLI 的端到端验收项，英文原样保留，不改写。

- `ai` enters interactive mode.
- `ai help` opens the Chinese HTML usage guide.
- `ai add` adds a provider and writes `providers.json`.
- `ai provider edit` can change `mode`, `level`, and `model`.
- `ai provider list` lists provider config without refreshing health.
- `ai session list` lists recent sessions.
- `ai session` opens an interactive selector to resume a recent session launch configuration.
- `ai log` opens the log file, and `ai log --print` lists recent logs in the terminal.
- `ai context` generates `.ai-gateway/context.md`.
- Level conflicts are resolved by swapping levels.
- `ai status` lists health for all providers.
- `ai status` shows weekly token usage from real `usage.json` events.
- `ai doctor` prints a diagnostic report without consuming tokens by default.
- `ai use claude` and `ai use codex` start the matching CLI with the default provider/model.
- Unavailable providers trigger automatic fallback.
- Manual changes to `providers.json` are recognized on the next command run.

## 相关文档

- [00-overview.md](00-overview.md) — 记忆系统 2.0 总览与架构入口。
- [modules/06-memory.md](modules/06-memory.md) — 记忆模块实现规格，按 R/Q 编号引用本文件的强制条款。
