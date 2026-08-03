# AI Runtime（当前阶段：AI Gateway）

本项目的长期目标是构建一套企业级 AI Runtime：让模型、Agent、记忆、知识、技能、工作流和工具在统一的运行、治理与学习体系中协作，并持续把个人经验沉淀为组织能力。

Runtime 才是产品。Memory、Agent 和 LLM 都是可以替换和组合的能力模块。

当前可用版本是 Runtime 的 Gateway 基础层：通过统一的 `ai` 命令管理 Claude Code 和 Codex CLI 的 provider、模型、优先级、健康度、故障转移、用量、会话、诊断与 Telegram 入口。后续能力会在保持现有命令稳定的基础上，逐步演进到统一执行、受治理学习、Skill/Capability 沉淀和组织级共享。

北极星目标：**每一次交互，都让 Runtime 更有能力。**

## 文档导航

- [中文文档总览](./docs/README.md)
- [doc_2.0 文档层总览](./docs/README.md)
- [中文使用指南](./docs/usage.md)
- [HTML 命令手册](./docs/USAGE.html)
- [整体架构与当前实现快照](./docs/00-overview.md)

AI 与维护者使用的英文权威文档位于 `AGENTS.md`、`docs/AI_RUNTIME_ARCHITECTURE.md` 和 `docs/CONVENTIONS.md`；产品规范、宪法摘要、记忆/学习与 Telegram 设计等构成 `doc_2.0` 文档层（现已展开在 `docs/` 与 `docs/modules/` 下，索引见 `docs/README.md`）。

## 当前边界

- 已交付：本地 Provider Gateway、Claude/Codex 启动与 fallback、Telegram、会话、用量、诊断和早期 Memory。
- 演进中：统一 Runtime 执行上下文、自动学习与记忆治理、Skill/Capability 生命周期、插件体系。
- 长期方向：组织与租户隔离、能力注册与共享、企业集成、Web/Desktop/API 治理界面。

## 通过 npm 安装

运行环境需要 Node.js `22.19.0` 或更高版本。全局安装后，npm 会把本包注册为 `ai` 命令：

```bash
npm install --global @offerpilot/axiomruntime
ai --version
ai setup
```

`ai --version` 用于验证 npm 包和命令安装成功；`ai setup` 初始化 Runtime 配置，并可在确认后安装缺失的 Claude Code/Codex。之后可直接运行 `ai`。

## 通过 Homebrew 安装

发布流程会在 npm 发布成功后把 `Formula/axiomruntime.rb` 同步到 `offerpilot/homebrew-tap`。Tap 建立后可使用：

```bash
brew tap offerpilot/tap
brew install axiomruntime
ai --version
ai setup
```

如果 Tap 不托管在 GitHub，需要在首次添加时显式提供公开 Git 地址：

```bash
brew tap offerpilot/tap <homebrew-tap-public-git-url>
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

## 内网 Runtime 服务

常驻服务为其他应用提供两类受鉴权接口，同时保留现有 `ai` CLI 和 Telegram 行为：

- `POST /v1/chat/completions`、`/v1/responses`、`/v1/embeddings`：OpenAI 兼容模型调用，按 provider 优先级、模型目录、健康度和熔断状态自动切换。
- `POST /v1/agent/runs`：复用 Telegram 背后的 Claude/Codex Engine。只接受受控 `workspace_id`，默认 `read_only`，服务端限制并发和超时。
- `GET /health/live`、`/health/ready`：不含 Secret 的存活与就绪检查；其他接口必须使用 Bearer Token。

```bash
npm run build
AI_GATEWAY_SERVER_TOKEN='replace-me' npm run server
```

生产 Compose 位于 `deploy/docker-compose.prod.yml`，默认仅映射宿主机 `127.0.0.1:8020`，并加入外部 Docker 网络 `ai-runtime`。Provider 配置挂载到 `/var/lib/ai-gateway`，服务 Token 通过只读文件挂载，不写入镜像或仓库。

### GitLab 自动部署

默认分支提交通过测试后，GitLab CI 会构建以 commit SHA 标记的镜像，并由锁定当前项目的受保护 Runner（标签 `axiomruntime-prod`）部署到 `154.201.73.41:/opt/AxiomRuntime`。部署只操作 `axiomruntime` Compose 项目；健康检查失败时恢复上一镜像，不清理服务器上的其他容器或镜像。

首次部署前，服务器必须已有 `/opt/AxiomRuntime/config/providers.json` 和 `/opt/AxiomRuntime/secrets/server-token`，且容器用户 `10001:10001` 可以读写配置目录。CI 只校验这些文件，不生成或覆盖凭据。

Telegram 容器默认不启动，以免与现有 long polling 进程争抢消息。完成迁移并停止旧 Bot 后，在服务器 `/opt/AxiomRuntime/.env` 中设置：

```dotenv
COMPOSE_PROFILES=telegram
```

启用前还要把各 Bot 的 `defaultCwd` 改为容器内的 `/workspace/...`，对应宿主机 `/opt/AxiomRuntime/workspaces/...`。之后的自动部署会同时更新 Runtime API 和所有位于 `config/telegram/bots/*.json` 的 Telegram Bot。资源上限和工作目录可参考 `.env.server.example` 调整。

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
- 如果本机不能直连 Telegram API，可设置 `ai telegram config set proxyUrl http://127.0.0.1:7890 --bot <name>`。
- Bot 首次 `/start` 或 `/reset` 会先选择工作路径，再选择 Claude Code/Codex，并展示当前会话、provider 和模型卡片。
- Bot 会记录选择过的工作路径；自定义路径会按 `~/输入名称` 创建或复用。
- Telegram 默认命令菜单只保留 `/claude`、`/codex`、`/reset`、`/cwd` 和 `/help`；选择 CLI 后，会在当前 chat 的 `/` 菜单追加该 CLI 的 slash 命令映射。
- Telegram 远程执行复用 AI Gateway 顶层 provider，不维护另一套 provider 配置。
- Telegram Codex 执行会自动走本地 OpenAI 兼容代理记录 provider usage；`/usage` 有 provider cost 时直接展示，否则按 `model-pricing.json` 估算。

更多命令用法见：

- [docs/usage.md](./docs/usage.md)
- [docs/USAGE.html](./docs/USAGE.html)
