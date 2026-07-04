# AI Gateway

本地 AI Provider 管理工具，用一个 `ai` 命令统一管理 Claude Code 和 Codex CLI 的 provider、模型、优先级、健康度和诊断。

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
~/.ai-gateway/reports/
~/.ai-gateway/.ai-gateway.log
```

可通过 `AI_GATEWAY_HOME` 覆盖配置目录。

`providers.json` 含 API Key，不要提交到仓库。

更多命令用法见：

- [docs/USAGE.md](./docs/USAGE.md)
- [docs/USAGE.html](./docs/USAGE.html)
