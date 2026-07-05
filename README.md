# AI Gateway

本地 AI Provider 管理工具，用一个 `ai` 命令统一管理 Claude Code、Codex CLI 和 Hermes 机器人的 provider、模型、优先级、健康度和诊断。

## 安装开发依赖

```bash
npm install
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
ai add
ai provider list
ai hermes
ai hermes list
ai hermes edit
ai hermes sync
ai hermes status
ai hermes import-local
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
~/.ai-gateway/sessions.json
~/.ai-gateway/hermes.json
~/.ai-gateway/hermes-state.json
~/.ai-gateway/hermes/<机器人名称>/
~/.ai-gateway/reports/
~/.ai-gateway/exports/
~/.ai-gateway/.ai-gateway.log
```

可通过 `AI_GATEWAY_HOME` 覆盖配置目录。

`providers.json` 含 API Key，不要提交到仓库。

Hermes 集成说明：

- `ai add/edit` 会自动把 AI Gateway provider 列表同步到本机 Hermes 原生配置。
- `ai hermes add/edit/sync` 会同步当前机器人、刷新 provider 模型缓存，并自动重启 Hermes gateway。

更多命令用法见：

- [docs/USAGE.md](./docs/USAGE.md)
- [docs/USAGE.html](./docs/USAGE.html)
