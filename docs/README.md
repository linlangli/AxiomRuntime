# AI Runtime 文档总览

本项目采用双层文档体系：AI 与维护者使用英文权威文档，用户与中文评审者使用中文文档。两层描述的是同一个产品，不是两套路线。

## 给用户和中文评审者

| 文档 | 内容 |
|---|---|
| [项目 README](../README.md) | 产品定位、当前能力、安装与常用入口 |
| [使用指南](USAGE.md) | CLI、Provider、Hermes、Telegram、会话和诊断操作 |
| [HTML 命令手册](USAGE.html) | 可浏览的命令索引 |
| [技术架构说明](ARCHITECTURE.md) | 当前实现、模块结构和中文架构评审 |
| [自动记忆系统方案](memory-system-spec.md) | Memory、Knowledge、Skill 与学习治理的完整中文设计 |
| [Telegram Bot 方案](telegram-bot-spec.md) | Telegram 入口的交互和实现设计 |

## 给 AI 和维护者

以下文档使用英文，并作为架构与实现的权威来源：

| 文档 | 内容 |
|---|---|
| [Repository Instructions](../AGENTS.md) | AI 在仓库内工作的规则、文档优先级和交付标准 |
| [Project Constitution](PROJECT_CONSTITUTION.md) | 不可轻易改变的产品使命、北极星和核心原则 |
| [Target Architecture](AI_RUNTIME_ARCHITECTURE.md) | Enterprise AI Runtime 目标架构与演进路径 |
| [Product Specification](SPEC.md) | 产品行为、接口方向、命令和验收标准 |
| [Development Conventions](CONVENTIONS.md) | 工程、发布、文档同步和模块边界规范 |

除项目宪法外，英文权威文档都是随开发持续更新的 Living Documents：每个开发任务结束前检查影响，每个里程碑或发布进行完整审计。项目宪法只在人类明确调整使命、北极星或核心原则时修改。

## 文档冲突处理

英文权威文档定义产品与工程约束，中文文档负责用户说明和架构评审。当两者出现行为冲突时，不应静默选择其中一份：同一个变更必须同步修正对应的英文规范和中文说明。

项目宪法只能由人类明确决策后修改。代码、单次模型输出或局部功能文档不能反向改变项目定位。
