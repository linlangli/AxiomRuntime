# AI Runtime 文档总览

本项目采用分层文档体系：英文正典（`AGENTS.md`、`AI_RUNTIME_ARCHITECTURE.md`、`CONVENTIONS.md`）定义仓库规则与目标架构；中英混合的 `doc_2.0` 文档层（根文档在 `docs/`，模块文档在 `docs/modules/`）承载产品规范、宪法摘要、模块设计与强制条款；面向用户的中文文档负责操作说明。各层描述的是同一个产品，不是多套路线。

## 给用户和中文评审者

| 文档 | 内容 |
|---|---|
| [项目 README](../README.md) | 产品定位、当前能力、安装与常用入口 |
| [doc_2.0 规范层完整索引](#doc_20-规范层完整索引) | 分层架构、模块文档、规范条款、路线图的统一索引（见下方章节）|
| [使用指南](usage.md) | CLI、Provider、Hermes、Telegram、会话和诊断操作 |
| [HTML 命令手册](USAGE.html) | 可浏览的命令索引 |
| [整体架构与当前实现快照](00-overview.md) | 分层俯瞰、现状映射与从旧 ARCHITECTURE 迁入的实现快照 |
| [产品架构全景图](architecture-map.md) | 中文架构图、执行主链、学习闭环与权威所有权说明 |
| [自动记忆系统方案](modules/06-memory.md) | Memory、Knowledge、Skill 与学习治理设计（配套 [contracts](contracts.md)、[07-learning-governance](modules/07-learning-governance.md)）|
| [Telegram Bot 方案](modules/01-surfaces.md) | Telegram 入口的交互和实现设计 |

## 给 AI 和维护者

以下文档使用英文，并作为架构与实现的权威来源：

| 文档 | 内容 |
|---|---|
| [Repository Instructions](../AGENTS.md) | AI 在仓库内工作的规则、文档优先级和交付标准 |
| [Target Architecture](AI_RUNTIME_ARCHITECTURE.md) | Enterprise AI Runtime 目标架构与演进路径 |
| [Development Conventions](CONVENTIONS.md) | 工程、发布、文档同步和模块边界规范 |
| [Portable AI Specification](AI_RUNTIME_PORTABLE_SPEC.md) | 可直接提供给其他 AI 的英文单文件完整上下文；仓库内属于便携快照，不替代分层权威文档 |

产品宪法摘要、产品规范与验收标准构成中英混合的 `doc_2.0` 文档层：宪法摘要见 [00-overview.md](00-overview.md)，跨模块强制条款（R1–R36 / Q1–Q6）见 [enforcement-decisions.md](enforcement-decisions.md)。

除宪法摘要外，正典文档与 `doc_2.0` 规范层都是随开发持续更新的 Living Documents：每个开发任务结束前检查影响，每个里程碑或发布进行完整审计。宪法摘要（见 [00-overview.md](00-overview.md)）只在人类明确调整使命、北极星或三条硬不变量时修改。

## doc_2.0 规范层完整索引

> `doc_2.0` 是按**分层架构**重构的文档集：一份项目整体文档 + 每个独立模块一份文档。语言模式为**中英混合**（叙述中文，标识符英文原样保留，以保 AI 识别准确率）。权威顺序与冲突处理见下方「文档冲突处理」。

### 起点

| 文档 | 内容 |
|---|---|
| [00-overview.md](00-overview.md) | ⭐项目整体文档：三条不变量、分层全景、模块清单、现状映射 |
| [glossary.md](glossary.md) | 中英术语表（一致性锁） |
| [contracts.md](contracts.md) | L0 端口契约清单，含统一 Capability Observability envelope、Sink 与授权查询契约 |
| [extraction-readiness.md](extraction-readiness.md) | 模块产品化就绪度判据 |
| [enforcement-decisions.md](enforcement-decisions.md) | ⭐规范约定 + R1–R36 强制实施决策 + Q1–Q6 质量/运维决策（跨模块权威引用源）|
| [roadmap.md](roadmap.md) | Release R0–R3 纵向产品闭环、Phase 0–13 技术计划与贯穿全程可观测性 |
| [testing.md](testing.md) | 测试计划：核心记忆/Telegram/CLI/Auth/检索质量/长期仿真/Memory、Skill 与 Capability 可观测性 |
| [service-level-objectives.md](service-level-objectives.md) | `local/team/enterprise` 的 SLO、RTO、RPO、容量与恢复演练门槛 |
| [usage.md](usage.md) | 用户使用指南：逐命令用法（交互模式/Claude·Codex/Hermes/Telegram/Provider/会话/日志等）|

### 模块文档（每个独立模块单独维护，位于 `modules/`）

| # | 模块 | 文档 | 状态 |
|---|---|---|---|
| ① | Surfaces | [modules/01-surfaces.md](modules/01-surfaces.md) | ✅ |
| ② | Orchestration | [modules/02-orchestration.md](modules/02-orchestration.md) | ✅ |
| ③ | Capabilities | [modules/03-capabilities.md](modules/03-capabilities.md) | ✅ |
| ④ | Execution Kernel | [modules/04-execution-kernel.md](modules/04-execution-kernel.md) | ✅ |
| ⑤ | Transport Proxy | [modules/05-transport-proxy.md](modules/05-transport-proxy.md) | ✅ |
| ⑥ | Memory | [modules/06-memory.md](modules/06-memory.md) | ✅ |
| ⑦ | Learning & Governance | [modules/07-learning-governance.md](modules/07-learning-governance.md) | ✅ |
| ⑧ | Policy | [modules/08-policy.md](modules/08-policy.md) | ✅ |
| ⑨ | Security | [modules/09-security.md](modules/09-security.md) | ✅ |
| ⑩ | Adapters/Plugins | [modules/10-adapters-plugins.md](modules/10-adapters-plugins.md) | ✅ |
| ⑪ | Storage | [modules/11-storage.md](modules/11-storage.md) | ✅ |

每份模块文档固定 11 节：`定位 → 单一职责边界 → 内部构件 → 对外/消费端口 → 依赖 → 数据所有权 → 降级/kill switch → 产品化就绪度 → 现状映射 → 验收标准 → 相关文档`。以 [modules/05-transport-proxy.md](modules/05-transport-proxy.md) 为样板。

## 文档冲突处理

不同问题只有一个权威归属：

| 问题 | 唯一权威位置 |
|---|---|
| mission / North Star / 三条硬不变量 | [00-overview.md](00-overview.md) 的宪法摘要；仅人类明确决策可修改 |
| 分层、模块 ownership、依赖方向、插件原则 | [AI_RUNTIME_ARCHITECTURE.md](AI_RUNTIME_ARCHITECTURE.md) + [CONVENTIONS.md](CONVENTIONS.md) |
| canonical identifier、Port、跨进程 schema、错误/版本语义 | [contracts.md](contracts.md) |
| 跨模块产品行为和安全/质量硬门槛 | [enforcement-decisions.md](enforcement-decisions.md) 的 R/Q 条款 |
| 单模块职责、数据所有权、降级和模块验收 | 对应 `modules/*.md` 的正文 1–11 节 |
| 交付顺序与测试覆盖 | [roadmap.md](roadmap.md) + [testing.md](testing.md) |
| 历史实现、迁移代码、旧文档保留材料 | 模块附录，仅作 supporting material，不是独立权威源 |

模块附录中的旧字段、代码块、状态说明或实现建议不得覆盖当前 L0 契约、R/Q 条款或模块正文。发现冲突时不能按“更具体”或“更旧”自动取舍：当前任务必须同步修正文档，无法当场修复时显式记录 conflict、owner 和 exit condition。`doc_2.0` 中的 canonical identifier 必须与 `contracts.md` 一致。

所有附录标题下必须声明 `Appendix Status`：

| `Appendix Status` | 含义 | 可否作为新实现依据 |
|---|---|---|
| `CONSTITUTION SUMMARY` | 经人类批准的使命/North Star/硬不变量摘要 | 可以，仅限宪章范围 |
| `SUPPORTING SPEC` | 补充正文的详细行为；不得覆盖正文/L0/RQ | 可以，但先归一化到 canonical contract |
| `CURRENT SNAPSHOT` | 某一时点实现事实 | 不可以直接推导目标设计 |
| `MIGRATION FIXTURE` | legacy schema/样本/兼容输入 | 仅用于 migration 与 compatibility test |
| `DESIGN SOURCE` | 保留的方案、推理或成熟设计来源 | 只能作为 ADR 输入 |
| `DEPRECATED REFERENCE` | 已被新规范取代、等待删除的材料 | 不可以 |

缺少状态标签的附录视为 `DEPRECATED REFERENCE`。引用附录时必须同时引用它所服从的正文、contract 或 R/Q 条款。

宪法摘要只能由人类明确决策后修改。代码、单次模型输出或局部功能文档不能反向改变项目定位。
