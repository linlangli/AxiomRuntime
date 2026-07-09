# AI Gateway

本地 AI Provider 管理工具，用一个 `ai` 命令统一管理 Claude Code、Codex CLI 和 Hermes 机器人的 provider、模型、优先级、健康度和诊断。

## 安装开发依赖

```bash
npm install
```

## 本机 CLI 前置条件

AI Gateway 不内置 Claude Code、Codex 或 Hermes。它们作为彼此独立的外部 CLI 使用，需要先在本机安装并能通过 `PATH` 或常见安装路径找到。

可用下面的命令检查：

```bash
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

## 本机注册 `ai` 命令

```bash
npm link
```

注册后可直接使用：

```bash
ai
ai help
ai provider add
ai provider list
ai provider edit
ai provider delete
ai hermes
ai hermes list
ai hermes edit
ai hermes status
ai hermes import-local
ai telegram
ai telegram start
ai telegram status
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
~/.ai-gateway/hermes.json
~/.ai-gateway/hermes-state.json
~/.ai-gateway/hermes/<机器人名称>/
~/.ai-gateway/telegram.json
~/.ai-gateway/telegram.sqlite
~/.ai-gateway/telegram.log
~/.ai-gateway/reports/
~/.ai-gateway/exports/
~/.ai-gateway/.ai-gateway.log
```

可通过 `AI_GATEWAY_HOME` 覆盖配置目录。

`providers.json` 和 `ai hermes export` 生成的迁移包含 API Key，不要提交到仓库。

Hermes 集成说明：

- `ai provider add/edit/delete` 只更新 AI Gateway 顶层 provider；如果 Hermes 已导入本机配置，下一次执行 Hermes 相关命令时会检测 provider 变化并同步/重启本机 Hermes。
- `ai hermes import-local` 会把本机 Hermes 配置里的 provider 导入 AI Gateway provider 配置后统一管理，并立即同步本机 Hermes 配置。
- `ai hermes export` 默认导出所有机器人完整复刻包；传入机器人名称时只导出单个机器人。
- `ai hermes add/edit/import` 会同步当前机器人、用最小请求验证可调用模型，并自动重启 Hermes gateway。
- 如果本机 Hermes `/model` 只显示默认模型，同步时会自动打兼容补丁让它读取完整模型列表。

Telegram Bot 集成说明：

- `ai telegram config` 配置 Bot token、访问用户、默认引擎、默认目录和权限模式；如需所有用户可访问，执行 `ai telegram config set allowAllUsers true`。
- `ai telegram start|stop|status|logs` 管理后台轮询进程。
- 如果本机不能直连 Telegram API，可设置 `ai telegram config set proxyUrl http://127.0.0.1:7890`。
- Bot 首次 `/start` 或 `/reset` 会先选择工作路径，再选择 Claude Code/Codex，并展示当前会话、provider 和模型卡片。
- Bot 会记录选择过的工作路径；自定义路径会按 `~/输入名称` 创建或复用。
- Telegram 默认命令菜单只保留 `/claude`、`/codex`、`/reset`、`/cwd` 和 `/help`；选择 CLI 后，会在当前 chat 的 `/` 菜单追加该 CLI 的 slash 命令映射。
- Telegram 远程执行复用 AI Gateway 顶层 provider，不维护另一套 provider 配置。
- Telegram Codex 执行会自动走本地 OpenAI 兼容代理记录 provider usage；`/usage` 有 provider cost 时直接展示，否则按 `model-pricing.json` 估算。

更多命令用法见：

- [docs/USAGE.md](./docs/USAGE.md)
- [docs/USAGE.html](./docs/USAGE.html)
