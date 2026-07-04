# AI Gateway 使用指南

## 进入交互模式

```bash
ai
```

进入交互式操作。

## 打开帮助页面

```bash
ai help
```

打开 `docs/USAGE.html` 使用指南。

## 使用 Claude Code 或 Codex

使用默认 provider 和默认模型：

```bash
ai use claude
ai use codex
```

指定 provider：

```bash
ai use claude 51talk
ai use codex 51talk
```

指定 provider 和模型：

```bash
ai use claude 51talk claude-opus-4-6
ai use codex 51talk gpt-5.5
```

规则：

- 不指定 provider 时，使用 `level: 1` 的 provider。
- 不指定模型时，使用该 provider 的默认 `model`。
- 当前 provider 不可用时，按 `level` 自动降级。

## 添加 Provider

交互式添加：

```bash
ai add
```

直接添加：

```bash
ai add 51talk https://example.com sk-xxx
```

添加时会自动完成：

- 写入 `providers.json`。
- 默认设置 `mode` 为 `auto`。
- 默认设置 `level` 为下一个可用等级。
- 测试 provider 连通性。
- 探测可用模型。
- 设置默认模型。

## 编辑 Provider

```bash
ai edit
```

可编辑字段：

```text
name
baseUrl
apiKey
mode
level
model
```

规则：

- `mode` 从 `ask` 和 `auto` 中选择。
- `level` 从当前 provider 数量生成的等级中选择。
- 如果选择的 `level` 已被占用，会和对应 provider 交换等级。
- `model` 从已探测到的模型中选择，不手动输入。

## 查看状态

## 列出 Provider

```bash
ai list
```

列出 `providers.json` 中的 provider 配置：

```text
level
name
baseUrl
apiKey
mode
model
```

`ai list` 只展示配置，不刷新健康度。

终端会以卡片形式展示，每个 provider 单独一块，`level: 1` 会标记为默认 provider。

## 查看状态

```bash
ai status
```

执行时会轻量刷新所有 provider：

- 检查连通性。
- 刷新模型缓存。
- 不发送真实对话请求。
- 默认不消耗 token。

展示内容：

```text
level
name
baseUrl
apiKey
mode
model
健康度
最近检查时间
token 使用量
使用占比
```

token 使用量来自 `usage.json` 中真实记录的 provider usage。当前只有 AI Gateway 自己发起且 provider 返回 usage 的请求会累计，例如 `ai doctor --deep`。

## 查看日志

```bash
ai log
```

打开日志文件。

终端打印最近日志：

```bash
ai log --print
ai log --print 100
```

`--print` 会按日志条目分块展示，适合快速查看最近错误和策略执行记录。

日志包括：

```text
使用痕迹
报错信息
provider 健康检查
fallback 策略执行
doctor 诊断记录
```

日志文件：

```text
.ai-gateway.log
```

## 生成项目上下文

```bash
ai context
```

生成并打开：

```text
.ai-gateway/context.md
```

终端打印：

```bash
ai context --print
```

上下文包括：

```text
项目路径
Git 分支和最近 commit
git status
git diff --stat
package.json scripts
文件树摘要
关键文档摘要
最近 AI Gateway 日志
```

默认排除：

```text
node_modules
dist
build
.git
.ai-gateway
providers.json
.ai-cache.json
usage.json
.ai-gateway.log
.env
*.key
*.pem
```

## 检查本地环境

```bash
ai doctor
```

默认不消耗 token。

检查内容：

```text
providers.json
.ai-cache.json
usage.json
Claude Code CLI
Codex CLI
provider 连通性
模型探测
配置字段是否合法
level 是否冲突
默认模型是否存在
```

如果 `codex` 不在 PATH，AI Gateway 会额外检查常见安装位置：

```text
/Applications/Codex.app/Contents/Resources/codex
```

深度检查：

```bash
ai doctor --deep
```

会使用当前最高优先级可用 provider 验证真实推理链路，可能消耗 token，执行前需要确认。

规则：

- 默认从 `level` 最小的可用 provider 开始。
- 当前 provider 不可用时，自动降级到下一个 provider。
- 如果没有任何 provider 可用，自动回到普通 `ai doctor`，不使用大模型。
- 如果 provider 返回 usage，会写入 `usage.json` 并反映到 `ai status`。
- 如果 provider 没有返回 usage，不会估算 token。

## 继续上次会话

```bash
ai last
```

继续使用上次选择的工具、provider 和模型。

## 打开 Web 控制面板

```bash
ai web
```

规划中的命令。当前基础版会提示暂未实现。

## 配置文件

用户可直接编辑：

```text
providers.json
```

示例：

```json
[
  {
    "name": "51talk",
    "baseUrl": "https://example.com",
    "apiKey": "sk-xxx",
    "mode": "auto",
    "level": 1,
    "model": "claude-opus-4-6"
  }
]
```

内部文件：

```text
.ai-cache.json
usage.json
```

除非调试问题，否则不要手动修改内部文件。
