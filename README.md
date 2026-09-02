# AxiomRuntime（当前阶段：Provider Gateway）

本项目的长期目标是构建一套 AI Runtime：让模型、Agent、记忆、知识、技能、工作流和工具在统一的运行、治理与学习体系中协作，并持续把个人经验沉淀为可复用能力。

Runtime 才是产品。Memory、Agent 和 LLM 都是可以替换和组合的能力模块。

当前可用版本是 Runtime 的 Gateway 基础层：通过统一的 `ai` 命令管理 Claude Code 和 Codex CLI 的 provider、模型、优先级、健康度、故障转移、用量、会话、诊断与 Telegram 入口。后续能力会在保持现有命令稳定的基础上，逐步演进到统一执行、受治理学习、Skill/Capability 沉淀和组织级共享。

北极星目标：**每一次交互，都让 Runtime 更有能力。**

## 文档导航

文档共三份，均标注实现状态（🟢 已实现 / 🟡 部分实现 / 🔴 规划中）：

| 文档 | 读者 | 内容 |
|---|---|---|
| [使用指南](./docs/usage.md) | 使用者 | 安装、上手、每个命令怎么用 |
| [技术架构](./docs/architecture.md) | 开发者 | 分层设计、执行主链、所有权边界、Mermaid 图 |
| [产品需求文档](./docs/prd.md) | 开发者 + 产品 | 定位、能力清单、发布计划、交付风险、验收标准 |

另有 [HTML 命令手册](./docs/USAGE.html)，`ai help` 会直接打开。

维护者与 AI 协作规则见 `AGENTS.md` 和 `CLAUDE.md`（英文）。

## 当前边界

- 已交付：本地 Provider Gateway、Claude/Codex 启动与 fallback、Telegram、会话、用量、诊断和早期 Memory。
- 演进中：统一 Runtime 执行上下文、自动学习与记忆治理、Skill/Capability 生命周期、插件体系。
- 长期方向：组织与租户隔离、能力注册与共享、外部系统集成、Web/Desktop/API 治理界面。

完整的已实现与规划对照见 [产品需求文档 §3](./docs/prd.md)。

## 通过 npm 安装

运行环境需要 Node.js `22.19.0` 或更高版本。先确认版本，再执行全局安装；npm 会把本包注册为 `ai` 命令：

```bash
node --version
npm install --global @offerpilot/axiomruntime
ai --version
ai setup
```

如果 npm 显示 `EBADENGINE`，说明当前 Node.js 版本不受支持。请先升级到 `22.19.0+`，不要继续使用警告状态下安装的 CLI。

`ai --version` 用于验证 npm 包和命令安装成功；`ai setup` 初始化 Runtime 配置，并可在确认后安装缺失的 Claude Code/Codex。之后可直接运行 `ai`。

可用 root 完成全局安装，但日常执行 `ai` 和常驻服务应使用专用非 root 用户。若仍以 root 启动 Claude，Runtime 会把 `auto`/`bypassPermissions` 安全约束为默认权限、输出告警，并且绝不会传递 Claude Code 禁止 root 使用的 `--dangerously-skip-permissions`。

## 通过 Homebrew 安装

维护者发布新版本时可直接双击仓库根目录的 `发布.command`，交互选择 npm、Homebrew 或发布条件检查，无需记发布命令。npm 发布成功后，再选择 Homebrew；助手会读取 npm Registry 的真实 tarball 与 SHA256，并把 `Formula/axiomruntime.rb` 同步到 GitLab 项目 `linlangli/axiom`。

用户首次安装需要显式提供 GitLab 地址：

```bash
brew tap linlangli/axiom https://gitlab.com/linlangli/axiom.git
brew install linlangli/axiom/axiomruntime
ai --version
ai setup
```

## 安装开发依赖

运行和开发需要 Node.js `22.19.0` 或更高版本。该下限与锁定依赖的运行时要求一致；Node.js 20 不受支持。

```bash
npm install
```

## 本机 CLI 前置条件

AI Gateway 不内置 Claude Code 或 Codex。它们作为彼此独立的外部 CLI 使用，需要先在本机安装并能通过 `PATH` 或常见安装路径找到。

可用下面的命令初始化和检查：

```bash
ai setup
ai doctor
```

## 构建

```bash
npm run build
```

## 本地测试

```bash
npm test
```

## 本机 Runtime 服务

从源码进行本地开发或集成时，可以启动受鉴权的 Runtime HTTP 服务，同时保留现有 `ai` CLI 和 Telegram 行为：

- `POST /v1/chat/completions`、`/v1/responses`、`/v1/embeddings`：OpenAI 兼容模型调用，按 provider 优先级、模型目录、健康度和熔断状态自动切换。
- `POST /v1/agent/runs`：复用 Telegram 背后的 Claude/Codex Engine。只接受受控 `workspace_id`，默认 `read_only`，服务端限制并发和超时。
- `GET /health/live`、`/health/ready`：不含 Secret 的存活与就绪检查；其他接口必须使用 Bearer Token。

```bash
npm run build
AI_GATEWAY_SERVER_TOKEN='replace-me' npm run server
```

项目不通过 GitLab CI 构建镜像或部署服务器。正式分发统一使用 npm：普通分支和合并请求运行测试，版本 tag 通过校验后发布 `@offerpilot/axiomruntime`，用户通过 `npm install --global @offerpilot/axiomruntime` 安装或升级。

## 本机注册 `ai` 命令

```bash
npm link
```

注册后可直接使用：

```bash
ai
ai --version
ai setup
ai help
ai provider add
ai provider list
ai provider edit
ai provider delete
ai set codex chatgpt
ai set codex provider 51talk-cq gpt-5.6-sol
ai set codex provider 51talk-cq
ai set codex proxy 127.0.0.1:7890
ai telegram
ai telegram list
ai telegram start --bot ops
ai telegram status --bot ops
ai status
ai log
ai log --print
ai context
ai context --print
ai session
ai session list
ai session clear
ai report
ai doctor
```

## 配置文件

默认从全局配置目录读取：

```text
~/.ai-gateway/providers.json
~/.ai-gateway/.ai-cache.json
~/.ai-gateway/usage.json
~/.ai-gateway/model-pricing.json
~/.ai-gateway/sessions.json
~/.ai-gateway/telegram.json
~/.ai-gateway/telegram.sqlite
~/.ai-gateway/telegram.log
~/.ai-gateway/reports/
~/.ai-gateway/exports/
~/.ai-gateway/.ai-gateway.log
```

可通过 `AI_GATEWAY_HOME` 覆盖配置目录。

`providers.json` 包含 provider 配置和 SecretStore 引用，不要提交到仓库。

Telegram Bot 集成说明：

- 多 Bot 使用 `ai telegram add <name>` 创建，并以统一的 `--bot <name>` 选择目标；例如 `ai telegram edit --bot ops`、`start|stop|status --bot ops`、`delete --bot ops`。裸 `ai telegram` 会先选操作再选 Bot，删除有二次确认；批量生命周期操作使用 `--all`。
- `ai telegram config set <key> <value> --bot <name>` 只修改指定 Bot；旧位置参数写法继续兼容。
- 如果本机不能直连 Telegram API，可设置 `ai telegram config set proxyUrl http://127.0.0.1:7890 --bot <name>`；代理地址需包含协议，交互式新增或编辑 Bot 时也会显示该完整示例。
- Bot 首次 `/start` 或 `/reset` 会先选择工作路径，再选择 Claude Code/Codex，并展示当前会话、provider 和模型卡片。
- Bot 会记录选择过的工作路径；自定义路径会按 `~/输入名称` 创建或复用。
- Telegram 默认命令菜单只保留 `/claude`、`/codex`、`/reset`、`/cwd` 和 `/help`；选择 CLI 后，会在当前 chat 的 `/` 菜单追加该 CLI 的 slash 命令映射。
- Telegram 远程执行复用 AI Gateway 顶层 provider，不维护另一套 provider 配置。
- Telegram Codex 执行会自动走本地 OpenAI 兼容代理记录 provider usage；`/usage` 有 provider cost 时直接展示，否则按 `model-pricing.json` 估算。

更多命令用法见：

- [docs/usage.md](./docs/usage.md)
- [docs/USAGE.html](./docs/USAGE.html)
- [docs/prd.md](./docs/prd.md) 的「已知限制」一节
