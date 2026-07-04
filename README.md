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
ai list
ai status
ai log
ai log --print
ai doctor
```

## 配置文件

默认从当前执行目录读取：

```text
providers.json
.ai-cache.json
usage.json
```

`providers.json` 含 API Key，已加入 `.gitignore`，不要提交到仓库。

更多命令用法见：

- [docs/USAGE.md](./docs/USAGE.md)
- [docs/USAGE.html](./docs/USAGE.html)
