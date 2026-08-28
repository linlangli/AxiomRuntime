# ① Surfaces 接入面

> 遵循 doc_2.0 统一模块模板。语言中英混合，标识符英文原样。术语见 [../glossary.md](../glossary.md)。

## 1. 定位（一句话）

把用户或系统的意图翻译成稳定的 `RuntimeRequest`——CLI / Telegram / Web / API / Scheduler 都是同层的可替换适配器。

## 2. 单一职责边界（高内聚）

**拥有**：入口协议解析、意图 → `RuntimeRequest` 构造、面向用户的呈现与交互态、面级限流。

**禁止拥有**：
- **禁止**做 provider / model 选择（属 ③）。
- **禁止**持有 memory 策略或 skill 晋升（属 ⑥/⑦）。
- **禁止**做 tool 授权（属 ④ 执行期检查）。
- **禁止**跨 surface 复用私有状态；共享策略**必须**上移 ② Orchestration。

## 3. 内部构件与各自单一职责

| 构件 | 单一职责 |
|---|---|
| `cli` | 命令解析、终端呈现 |
| `telegram` | Bot 更新处理、`ProgressReporter` 中间态、会话并发 `runExclusive()` |
| `server` / API | HTTP/gRPC 入口，鉴权在边缘 |
| `web` | 控制与治理面 |
| `scheduler` | 定时/事件触发的系统意图 |

### Claude Code / Codex 远程控制的分层

Telegram Bot 只属于 **① Surface**：接收远程消息、做边缘鉴权、构造 `RuntimeRequest`、呈现进度/结果，并把绑定到 user/chat/session/action hash 的确认结果交回 ④ Kernel。它不拥有 Agent 选择、provider routing、tool 授权、Memory、Learning、Usage 或执行真相。

Claude Code 与 Codex CLI 在产品目录中分别是 ③ 的 `agent` Capability；一次运行由 ④ `agent-supervisor` 治理；具体子进程启动、stdin/stdout/JSON stream 转换、session resume 与 CLI 版本差异由 ⑩ 的 `ClaudeCodeCliAgentAdapter` / `CodexCliAgentAdapter` 实现。模型流量继续经过 ⑤ 单一 Runtime Transport Proxy 与已选定的 provider/model Adapter。

```text
Telegram Surface
  -> Orchestration
  -> claude-code-agent | codex-cli-agent Capability
  -> Execution Kernel agent-supervisor
  -> ClaudeCodeCliAgentAdapter | CodexCliAgentAdapter
  -> Runtime Transport Proxy -> selected provider/model Adapter
```

现有 `telegram/engine/types.ts::Engine` 是 delivery-local compatibility facade，不是长期公共 Agent contract。目标态它必须委托 Orchestration 与 `AgentAdapterPort`；Telegram callback 只提交 confirmation decision，禁止直接执行 CLI tool。若某 CLI 版本无法可靠拦截 tool request，Capability descriptor 必须声明限制，Policy 通过该 CLI 原生权限模式、进程/容器隔离、filesystem/network boundary 和显式确认收窄风险，禁止声称已实现无法证明的逐工具强制授权。

## 4. 对外/消费端口（可插拔点）

- 消费：Orchestration facade（唯一入口），只传 `RuntimeRequest` / 收 `RuntimeEvent` 投影。
- 新增一个 surface = 新增一个适配器实现，**禁**改动下层契约（对应 §9 验收）。

## 5. 依赖（低耦合）

只 import `L0 Contracts` + Orchestration facade 接口。**禁止** import capabilities / kernel / memory 的具体实现。

## 6. 数据所有权

Surfaces **无持久数据所有权**。会话真相属 ② Orchestration 的 Working Memory；用量/记忆真相属 ⑤/⑥。面级仅可持本地 UI 态与瞬时缓存。

## 7. 降级 / kill switch

单个 surface 故障**必须**隔离，**禁**波及其他 surface 或下层。面级限流触发时返回明确降级信号，**禁**静默丢弃系统意图（scheduler 尤甚）。

## 8. 产品化就绪度

⚠️ 一般**不单独成产品**——surface 是 Runtime 的消费端。可作为"参考客户端/SDK 示例"随核心产品分发。判据见 [../extraction-readiness.md](../extraction-readiness.md)。

## 9. 现状映射

`src/cli/`、`src/telegram/` 已存在并保持为 adapter；`ai set codex` 仅读取 provider/model candidates、呈现 provider→model selector 并调用 `src/core/integrations/codex-provider-config.ts`，不在 Surface 内实现 GPT filtering/ordering、凭据/TOML、desktop environment 写入或重启语义。`telegram/session|memory|interaction` 中的可复用策略**应当**上移 ② Orchestration。`server/`、`web/`、`scheduler/` 待建。

## 10. 验收标准

- 新 surface 可调用 Runtime 能力而**不复制**任何领域策略。
- 关闭某 surface，其余 surface 与下层行为不变。
- surface 层代码中**不存在** provider 选择、memory 策略、tool 授权逻辑。

## 11. 相关文档

- 整体架构：[../00-overview.md](../00-overview.md)｜编排层：[02-orchestration.md](02-orchestration.md)
- 权威边界（英文）：[../AI_RUNTIME_ARCHITECTURE.md](../AI_RUNTIME_ARCHITECTURE.md) §2 Surface Layer

---

# 附：Telegram 接入面详细规范

> **Appendix Status: SUPPORTING SPEC** — 补充 Telegram Surface 行为，不得把业务策略下沉到 Surface。

> 从旧 `telegram-bot-spec.md` 迁入。Telegram 是 ① 的一个具体 surface 适配器。标识符英文原样。

## A. 设计原则

1. **仓库内集成**——Bot 代码在 `src/telegram/`，与 `src/core/`、`src/cli/` 平级。
2. **CLI 管理**——`ai telegram <action> --bot <name>` 对单个命名 Bot 执行 `edit/delete/start/stop/status/config/logs/doctor`；`start/stop/status --all` 显式执行批量生命周期操作。旧位置参数保持兼容。
3. **能力完整**——100% 覆盖 Claude Code 与 Codex CLI 的工具调用、权限模式、会话管理。
4. **交互映射**——所有 CLI 交互（权限确认、模式切换）映射为 Telegram inline button。
5. **美观输出**——格式化模板，支持代码块、diff、进度指示、折叠长输出。

技术栈：`grammy`（TS 原生 Bot 框架）+ `better-sqlite3`（会话持久化）；Claude Code/Codex 作为外部本机 CLI。

## B. 统一引擎接口（`telegram/engine/types.ts`）

两个引擎当前共享统一接口，方便切换。该接口是 Telegram delivery-local compatibility facade；目标态必须映射到 `AgentRunRequest/AgentRunEvent/AgentAdapterPort`，不能成为绕过 Orchestration/Kernel 的第二条执行路径：

```typescript
export interface Engine {
  name: string;
  execute(params: EngineExecuteParams): Promise<ExecutionResult>;
  abort(chatId: number): void;
}

export interface EngineExecuteParams {
  chatId: number; prompt: string; cwd: string;
  resume?: string; permissionMode?: string; allowedTools?: string[];
  imagePaths?: string[];                         // Codex --image / Claude local path context
  onPermission: PermissionHandler;              // 权限请求 → Telegram inline button
  onProgress?: (u: ProgressUpdate) => void;     // 进度事件 → 状态消息
  signal?: AbortSignal;
}

export interface PermissionRequest {
  id: string; tool: string; description: string;
  command?: string; filePath?: string; params: Record<string, unknown>;
}
export type PermissionHandler = (req: PermissionRequest) => Promise<boolean>;

export interface ProgressUpdate {
  phase: 'thinking' | 'tool_calling' | 'writing' | 'done';
  message?: string; tool?: string; responseText?: string;
}

export interface ExecutionResult {
  sessionId?: string; response: string;
  toolCalls?: ToolCallResult[]; filesChanged?: string[];
  diff?: string; cost?: number; duration?: number;
}
```

## C. CLI 生命周期命令

```bash
ai telegram add <name>                              # 创建命名 Bot
ai telegram list                                    # 列出 Bot 与运行状态
ai telegram edit --bot <name>                       # 交互式编辑指定 Bot
ai telegram config show --bot <name>                # 查看指定 Bot 配置
ai telegram config set <key> <value> --bot <name>   # 只更新指定 Bot
ai telegram start|stop|status --bot <name>          # 单 Bot 生命周期
ai telegram logs|doctor --bot <name>                # 单 Bot 诊断
ai telegram delete --bot <name>                     # 停止并删除指定 Bot 文件
ai telegram start|stop|status --all                 # 显式批量操作
```

命名 Bot 的 selector 是配置文件名中的 canonical `name`，格式为小写 `a-z0-9_-`、最长 32 字符。`--bot=<name>` 与 `--bot <name>` 等价；旧 `start <name>`、`config <name>`、`remove <name>` 继续兼容。命名 Bot 的 config/PID/log/SQLite 固定落在 `telegram/bots/<name>.*`，任何带 `--bot` 的 mutation 禁止回退到 legacy `telegram.json`。legacy `telegram.json` 到 `default` 的自动迁移只执行一次；显式删除 `default` 后必须保留迁移完成状态，任何后续 command 或 supervisor 禁止再次重建它。为兼容已有脚本，存在命名 Bot 时，无目标 `start/stop/status` 仍表示全部命名 Bot，但新脚本必须显式使用 `--bot` 或 `--all`。

交互式 `ai telegram` 必须在选定 action 后展示第二层 Bot selector；`edit/delete/logs/doctor/config` 选择单 Bot，`start/stop/status` 额外提供 `all bots`。`ai telegram --bot <name>` 预绑定目标并跳过第二层 selector；legacy global config 仍由直接 `ai telegram config` 管理。交互删除必须二次确认；若停止在 5 秒内未完成，必须保留 config/PID/log/SQLite 并报错，不得留下仍运行但已失去管理文件的 Bot。删除迁移生成的 `default` Bot 时必须同时清理 legacy `telegram.json` 与数据库，防止后续迁移恢复已解绑 Bot。

交互式新增 Bot 或编辑命名/legacy Telegram 配置时，`proxyUrl` 输入提示必须明确要求包含协议，并展示完整示例 `http://127.0.0.1:7890`；新增 Bot 的提示还必须说明该字段可以留空。

Setup 引导：`/start → model(Provider/Model) → workdir(+/init) → agent_profile(画像) → ready`。`workdir` 步骤直接把最近记录的绝对路径渲染为 inline button，末尾提供“自定义”，不再经过“已存在”二级入口。同一 chat 任务经 `SessionManager.runExclusive()` 串行执行，避免并发写同一 session。

### C.1 当前高优先级 UX 契约

- **动态上下文**：`conversation` 最多保留 12 turn；注入按 1400 token budget 从最新 turn 反向选择，而不是固定轮数。`/pin` 最多持久化 3 个 `pinnedTurns` 并优先纳入预算；`/unpin` 可撤销。native `resume` 可用时不重复注入普通 recent conversation。
- **编辑重跑**：仅最新一条、由当前 Bot 进程观察到的普通用户 prompt 响应 `edited_message:text`。重跑前终止同 chat 活跃 Agent、拒绝待审批、移除被替代的 conversation turn，并清空 `engineSessionId`，禁止旧 native session 继续携带原问题。
- **回复引用**：回复文字或 caption 以 `<referenced_message>` 注入，最多 800 token；内容必须 XML 转义并作为上下文而非新指令。
- **多附件/图片**：下一条请求最多消费 8 个附件。UTF-8 文本单文件 ≤2MB、注入总预算 3000 token；图片单文件 ≤10MB。Codex 使用 `--image` 接收本地路径，Claude 通过结构化附件路径读取。成功后清理临时文件；执行失败保留附件以便重试。
- **流式预览**：JSONL parser 必须跨任意 stdout chunk 保留未完成行。`ProgressReporter` 在同一状态消息内按至少 1500ms 节流显示 timeline 与最长 1200 字符的 HTML-escaped `responseText`；这是 event-level preview，不是逐 token 编辑。最终结果替换状态消息。
- **错误呈现**：Claude/Codex 非零退出必须优先显示 terminal result/error；`system/init`、`api_retry` 等协议 envelope 不能作为主错误发送给用户。

### C.2 Provider 管理

`/provider` 是 Provider control plane 的 Telegram 适配器：以 inline button 列出 Provider，详情页允许编辑 `name/baseUrl/apiKey/model/mode/level`，删除必须二次确认，列表底部提供添加入口。Telegram 层只持有尚未提交的短期表单状态，所有读取和变更必须委托 `core/providers/provider-service.ts` 的 `listProviders/addProvider/updateProvider/deleteProvider/getCachedModels`；不得直接读写 `providers.json`、复制排序/健康检查/缓存更新或变更记录逻辑。

Provider callback 使用 `index + provider name fingerprint` 定位目标，并在每次操作前重新读取列表；索引或指纹失效时只刷新列表，禁止对当前位置上的另一个 Provider 执行操作。API Key 不得出现在详情、callback、错误文本或应用日志中；输入消息应 best-effort 从 Telegram 删除。多 Bot 进程内草稿按 `botId + chatId` 隔离，进程重启可以中断未提交表单，但不得改变已持久化 Provider。

## D. 安全设计（surface 边缘鉴权）

**鉴权**：白名单制——只有 `allowedUserIds` 列表内的 Telegram user ID 可用；legacy token 存 `~/.ai-gateway/telegram.json`，命名 Bot token 存 `~/.ai-gateway/telegram/bots/<name>.json`（权限 600）；无远程配置，只能经本机 `ai telegram config` 改。CLI 的 command log 与终端配置输出必须脱敏 token。

命名 Bot 的配置更新必须写回自身 `telegram/bots/<name>.json`。Provider、model、engine 或 permission mode 的交互更新不得读取全局 `telegram.json` 后整体覆盖运行时配置，尤其不得改变当前 Bot 的 `allowedUserIds` / `allowAllUsers` 鉴权边界。

**危险操作强制确认**：即使 `bypassPermissions`/`full-auto` 模式，以下仍发 inline button 确认（surface 层兜底，与 ⑧ Policy 的 `require confirmation` 呼应）：

```typescript
const ALWAYS_CONFIRM_PATTERNS = [
  /rm\s+(-rf?|--recursive)/, /git\s+push\s+.*--force/,
  /git\s+reset\s+--hard/, /DROP\s+(TABLE|DATABASE)/i,
  /sudo\s+/, /chmod\s+777/, />\s*\/dev\//,
];
```

---

# 附：CLI 接入面命令（从 SPEC.md 迁入）

> **Appendix Status: SUPPORTING SPEC** — 命令材料服从正文 Surface 边界与 `usage.md` 当前用户契约。

> CLI 是 ① 的另一个 surface 适配器。命令名英文原样。

## E. 命令清单

`ai`（无参进交互模式）｜`ai help`（打开 `docs/USAGE.html`）。直接命令：

npm 分发包固定为 `@offerpilot/axiomruntime`，其 `bin` 契约固定注册 `ai`。`npm install --global @offerpilot/axiomruntime` 的安装验收必须在隔离 prefix 中直接执行已安装的 `ai`。Homebrew Formula 必须复用 npm Registry 中已发布版本的 tarball、固定实际下载内容的 SHA256、依赖 `node@22` 并以 `ai --version` 验收；不得维护第二套 Runtime 构建物。维护者通过根目录 `发布.command` 交互选择 npm、Homebrew 或 status check：npm action 在临时 main 中完成 version/test/tag/push 并等待 GitLab pipeline，Homebrew action 只接受 Registry 已存在版本、保留 Formula 安装逻辑、展示 diff 并经确认后推送 Tap。两个 action 禁止隐式连带触发；工作区不干净、合并冲突、缺少 GitLab auth/`NPM_TOKEN`、npm 版本重复或 Homebrew 来源版本不存在时必须 fail-closed，并提供不暴露 secret 的中文引导。`ai doctor` 诊断 Runtime 配置、Provider 连通性和外部 CLI readiness，不承担包管理器完整性校验。

全局安装身份与 Runtime 执行身份分离：管理员可安装 npm 包，但 `ai` 与 Telegram 常驻服务应以专用非 root 用户执行。Surface 只展示 configured/effective permission mode 与约束原因；UID 0 下 Claude `bypassPermissions -> default` 的裁决由共享 core policy 完成，CLI 与 Telegram 禁止各自绕过或重复实现。

```bash
ai version | ai --version | ai -v
ai setup [--yes] [--install-tools] [--skip-provider] [--skip-tools]
ai use claude | ai use codex
ai use claude 51talk claude-opus-4-6      # tool + provider + model
ai set codex chatgpt
ai set codex provider [provider-name] [model-id]
ai set codex proxy <host:port|url|off>
ai add 51talk https://example.com sk-xxx  # 添加 provider
ai provider edit | list
ai status | log | context | doctor [--local|--no-fix|--strict|--deep --tool claude|codex] | last | web
ai session [list|clear]
ai report
```

## F. surface 职责边界（呼应本文 §2）

CLI 只负责：解析命令 → 构造意图 → 获取安装外部 CLI 或持久切换 Codex client provider/proxy 等显式授权 → 呈现结果。provider/model 候选读取 ③ 的 provider cache，GPT-only 校验与 newest ordering 由 core integration policy 完成；Surface 只呈现 provider→model 两级 selector。执行委托 ④，用量呈现读 ⑤ 的 `usage.json`。`ai set codex` 的 ChatGPT OAuth、`CODEX_HOME/config.toml`/`auth.json` 事务写入、macOS user launchd proxy environment 同步和 app restart 委托 ⑩ 的 core integration service。`ai status` 是健康态投影；`ai doctor` 的诊断和安全修复由 core status/config API 实现，修复范围仅限 Runtime home，禁止读取或修改项目源码，禁止自动覆盖 `providers.json`。CLI 不实现路由、凭据写入或配置修复语义。

---

# 附：用户体验与权限确认策略（从 memory-system-spec 迁入）

> **Appendix Status: SUPPORTING SPEC** — UX 只能呈现 Policy/Kernel 决策，不能自行授权。

> 记忆自动化的用户体验与确认策略经由 ① surface 呈现；确认判定由 ⑧ Policy 产出、执行期由 ⑨ 落实。auth/purge 相关确认见 [03-capabilities.md](03-capabilities.md) 附 与 [09-security.md](09-security.md) 附。标识符与命令英文原样。

## G. 用户体验

新的默认体验：

- 用户不需要输入任何记忆命令也能获得自动记忆。
- 聊天过程中自然表达偏好、身份、项目约定，系统自动提炼。
- 用户启用自动写入且对应 Phase 门槛通过后，系统静默保存 category policy 允许的低风险明确记忆；未达门槛时保持 candidate/pending。
- 成功流程自动形成 Skill candidate，失败自动形成带适用条件的教训；用户不需要手工要求"沉淀"。
- 系统在后台自动去重、压缩、更新 Profile 和冷热迁移，不让记忆数量持续挤占上下文；压缩不会让原始证据或纠错能力消失。
- 对低置信度且高目标影响的信息，系统优先补查或验证，只在一个答案能显著减少风险时提出一个简短确认问题。
- 统一审计页展示"为什么记住、来自哪里、何时被使用、是否产生帮助、经过哪次压缩或提升"，但普通对话不展示内部评分和冗长学习日志。
- 用户可以查看、显式固定、纠正、撤销、删除、彻底清除、导出记忆，并按 source/bot/project 临时关闭读或写。

记忆管理通过统一设置/审计界面提供；CLI 同时保留可脚本化的 `ai memory list|pin|correct|forget|purge|export|policy`。Telegram 不要求用户记命令，但设置页必须提供等价按钮。旧命令只有在等价能力上线并完成一次兼容版本告警后才能移除。

首次启用自动写入时展示一次简短告知，并允许选择 `全部启用 / 只读不写 / 仅项目记忆 / 关闭`。身份绑定到新来源时再次展示共享范围；默认不把 `audience=personal` 的记忆注入 `audience=work` 项目。

## H. 权限与确认策略

| 行为 | 默认策略 |
|------|----------|
| 保存普通偏好 | 自动保存 |
| 更新用户画像 | 自动更新草稿，周期性合并 |
| 更新 bot 画像 | 当前 bot 内自动更新 |
| 保存项目事实 | 自动保存到 project scope |
| 保存 skill | 任务成功后自动生成 candidate；按风险完成 replay/sandbox/shadow/确认后才可 active |
| 保存敏感信息 | 拒绝进入 memory |
| 创建 auth profile | 必须用户主动登录 |
| 使用已登录 session 读取页面 | 允许 |
| 使用已登录 session 执行敏感写操作 | 必须确认 |
| 删除大量记忆 | 必须确认 |
| `purge` 正文、向量、episode、审计可逆 payload 和备份 | 二次确认，完成后输出不可恢复报告 |
| 临时 `--incognito` | 禁止读写和 episode 正文，不需要确认 |

---

# 附：Telegram 核心模块实现设计（从 telegram-bot-spec 迁入）

> **Appendix Status: SUPPORTING SPEC** — 详细实现建议需经 canonical contract 归一化后编码。

> 从旧 `telegram-bot-spec.md` 的「核心模块设计」迁入。这些是 Telegram surface 适配器的实现级设计，代码原样保留。统一引擎接口本身见本文 **附 B**，此处仅补充各模块实现细节。

## I. 引擎接口补充（`telegram/engine/types.ts`）

`Engine` / `EngineExecuteParams` / `PermissionRequest` / `PermissionHandler` / `ProgressUpdate` / `ExecutionResult` 已见本文 **附 B「统一引擎接口」**，两个引擎共享该统一接口、方便切换，此处不再重复。附 B 未含的 `ToolCallResult`（以及 `PermissionRequest` 的字段注释：`command` 为 Bash 命令、`filePath` 为文件路径）补充如下：

```typescript
export interface ToolCallResult {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  status: 'success' | 'error';
}
```

## J. Claude Code Engine（`telegram/engine/claude-engine.ts`）

通过外部 `claude` CLI 子进程执行。AI Gateway 负责解析本机 CLI、生成临时 settings 注入 provider 环境变量、捕获 `stream-json` 输出，并把 Telegram 侧的权限模式映射为 Claude Code 启动参数。

```typescript
import { spawn } from 'node:child_process';

export class ClaudeEngine implements Engine {
  readonly name = 'claude';
  private processes: Map<number, ChildProcess> = new Map();

  async execute(params: EngineExecuteParams): Promise<ExecutionResult> {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', params.model,
      params.prompt,
    ];
    const child = spawn('claude', args, {
      cwd: params.cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_HEADLESS: '1',
        ANTHROPIC_API_KEY: await secretStore.get(params.provider.apiKeyRef),
        ANTHROPIC_BASE_URL: params.provider.baseUrl,
      },
    });
    this.processes.set(params.chatId, child);
    return captureAndParseClaudeOutput(child);
  }

  abort(chatId: number): void {
    this.processes.get(chatId)?.kill('SIGTERM');
    this.processes.delete(chatId);
  }
}
```

**Claude Code 完整能力覆盖清单**:
- ✅ 多轮对话 (sessionId resume)
- ✅ 所有内置工具 (Read, Write, Edit, Bash, Agent, WebFetch, WebSearch, NotebookEdit)
- ✅ MCP 服务器工具调用
- ✅ 权限拦截与远程审批
- ✅ 子 Agent 调度
- ✅ permission mode 切换 (default / acceptEdits / bypassPermissions)
- ✅ 工作目录切换
- ✅ 会话历史恢复 (resume)
- ✅ 执行中断 (AbortController)
- ✅ CLAUDE.md 配置自动加载
- ✅ 自定义 allowedTools
- ✅ maxTurns 控制

## K. Codex Engine（`telegram/engine/codex-engine.ts`）

Codex 通过子进程调用，完整支持三种审批模式。

```typescript
import { spawn, type ChildProcess } from 'node:child_process';

type CodexApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';

export class CodexEngine implements Engine {
  readonly name = 'codex';
  private processes: Map<number, ChildProcess> = new Map();

  async execute(params: EngineExecuteParams): Promise<ExecutionResult> {
    const approvalMode = this.mapPermissionMode(params.permissionMode);
    const startTime = Date.now();

    const args = [
      '--approval-mode', approvalMode,
      '--quiet',
      '--output-format', 'json',
    ];
    args.push(params.prompt);

    return new Promise((resolve, reject) => {
      const proc = spawn('codex', args, {
        cwd: params.cwd,
        env: { ...process.env },
        signal: params.signal,
      });

      this.processes.set(params.chatId, proc);

      let stdout = '';
      let stderr = '';

      proc.stdout!.on('data', (chunk) => {
        stdout += chunk.toString();
        // 解析流式 JSON 事件，发送进度
        this.parseStreamEvents(chunk.toString(), params.onProgress);
      });

      proc.stderr!.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        this.processes.delete(params.chatId);
        if (code === 0) {
          resolve(this.parseOutput(stdout, Date.now() - startTime));
        } else {
          reject(new Error(stderr || `Codex exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        this.processes.delete(params.chatId);
        reject(err);
      });
    });
  }

  abort(chatId: number): void {
    const proc = this.processes.get(chatId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(chatId);
    }
  }

  private mapPermissionMode(mode?: string): CodexApprovalMode {
    switch (mode) {
      case 'bypassPermissions': return 'full-auto';
      case 'acceptEdits': return 'auto-edit';
      default: return 'suggest';
    }
  }

  private parseOutput(raw: string, duration: number): ExecutionResult {
    try {
      const data = JSON.parse(raw);
      return {
        response: data.summary ?? data.message ?? raw,
        toolCalls: data.actions?.map((a: any) => ({
          tool: a.type,
          input: a.input ?? {},
          output: a.output ?? '',
          status: a.status ?? 'success',
        })),
        filesChanged: data.files_changed ?? [],
        duration,
      };
    } catch {
      return { response: raw, duration };
    }
  }

  private parseStreamEvents(chunk: string, onProgress?: (u: ProgressUpdate) => void): void {
    if (!onProgress) return;
    // Codex 输出的每一行可能是一个 JSON 事件
    for (const line of chunk.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'tool_call') {
          onProgress({ phase: 'tool_calling', tool: event.tool });
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
  }
}
```

**Codex 完整能力覆盖清单**:
- ✅ 代码生成与修改
- ✅ 三种审批模式 (suggest / auto-edit / full-auto)
- ✅ 沙箱执行
- ✅ 多模型切换
- ✅ 流式事件解析
- ✅ 执行中断

## L. 权限审批交互（`telegram/interaction/approval.ts`）

CLI 的每一个权限 prompt 映射为 Telegram inline button，阻塞等待用户响应。

```typescript
import { InlineKeyboard, type Bot } from 'grammy';
import type { PermissionRequest } from '../engine/types.js';

interface PendingApproval {
  id: string;
  chatId: number;
  messageId?: number;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

export class ApprovalManager {
  private pending = new Map<string, PendingApproval>();
  private readonly TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟超时自动拒绝

  constructor(private bot: Bot) {}

  async request(chatId: number, req: PermissionRequest): Promise<boolean> {
    const id = req.id;
    const text = this.formatMessage(req);
    const keyboard = this.buildKeyboard(id);

    const msg = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.expire(id, msg.message_id, chatId);
        resolve(false);
      }, this.TIMEOUT_MS);

      this.pending.set(id, {
        id,
        chatId,
        messageId: msg.message_id,
        resolve,
        timeout,
      });
    });
  }

  resolve(id: string, approved: boolean): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    entry.resolve(approved);
    this.pending.delete(id);
    // 更新消息状态
    this.updateMessage(entry, approved);
  }

  resolveAll(chatId: number, approved: boolean): void {
    for (const [id, entry] of this.pending) {
      if (entry.chatId === chatId) {
        clearTimeout(entry.timeout);
        entry.resolve(approved);
        this.pending.delete(id);
        this.updateMessage(entry, approved);
      }
    }
  }

  private buildKeyboard(id: string): InlineKeyboard {
    return new InlineKeyboard()
      .text('✅ 允许', `perm:approve:${id}`)
      .text('❌ 拒绝', `perm:deny:${id}`)
      .row()
      .text('✅ 后续全部允许', `perm:approve_all:${id}`)
      .text('⏭️ 跳过此工具', `perm:skip:${id}`);
  }

  private formatMessage(req: PermissionRequest): string {
    const lines = [
      `🔐 <b>权限请求</b>`,
      ``,
      `🔧 <b>工具:</b> <code>${esc(req.tool)}</code>`,
    ];

    if (req.command) {
      lines.push(`💻 <b>命令:</b>`);
      lines.push(`<pre>${esc(truncate(req.command, 300))}</pre>`);
    } else if (req.filePath) {
      lines.push(`📄 <b>文件:</b> <code>${esc(req.filePath)}</code>`);
    }

    if (req.description) {
      lines.push(`📋 ${esc(truncate(req.description, 200))}`);
    }

    lines.push(``, `⏰ <i>5分钟内未响应将自动拒绝</i>`);
    return lines.join('\n');
  }

  private async updateMessage(entry: PendingApproval, approved: boolean): Promise<void> {
    if (!entry.messageId) return;
    const status = approved ? '✅ 已允许' : '❌ 已拒绝';
    try {
      await this.bot.api.editMessageReplyMarkup(entry.chatId, entry.messageId, {
        reply_markup: new InlineKeyboard().text(status, 'noop'),
      });
    } catch { /* 消息可能已过期 */ }
  }

  private expire(id: string, messageId: number, chatId: number): void {
    this.pending.delete(id);
    this.bot.api.editMessageReplyMarkup(chatId, messageId, {
      reply_markup: new InlineKeyboard().text('⏰ 已超时', 'noop'),
    }).catch(() => {});
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
```

## M. 消息模板（`telegram/templates/messages.ts`）

美观、信息密度高、适配 Telegram HTML。

```typescript
import type { ExecutionResult, ProgressUpdate } from '../engine/types.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

export const Msg = {
  // ━━━━━━ 任务生命周期 ━━━━━━

  taskStarted(engine: string, prompt: string): string {
    const icon = engine === 'claude' ? '🤖' : '⚡';
    return [
      `${icon} <b>${engine === 'claude' ? 'Claude Code' : 'Codex'}</b>`,
      ``,
      `┌ 📝 <i>${esc(truncate(prompt, 120))}</i>`,
      `└ ⏳ 处理中...`,
    ].join('\n');
  },

  taskProgress(update: ProgressUpdate): string {
    const icons: Record<string, string> = {
      thinking: '⏱️ 思考中',
      tool_calling: '🔧 调用工具',
      writing: '✍️ 编写中',
      done: '✅ 完成',
    };
    const base = icons[update.phase] ?? '⏳ 处理中';
    return update.tool ? `${base}: <code>${esc(update.tool)}</code>` : base;
  },

  taskCompleted(result: ExecutionResult): string {
    const parts: string[] = [];

    parts.push(`✅ <b>完成</b>`);

    // 主要响应
    if (result.response) {
      parts.push(``);
      parts.push(esc(truncate(result.response, 2500)));
    }

    // 变更文件列表
    if (result.filesChanged?.length) {
      parts.push(``);
      parts.push(`📁 <b>变更文件:</b>`);
      for (const f of result.filesChanged.slice(0, 10)) {
        parts.push(`  ├ <code>${esc(f)}</code>`);
      }
      if (result.filesChanged.length > 10) {
        parts.push(`  └ <i>...还有 ${result.filesChanged.length - 10} 个文件</i>`);
      }
    }

    // 工具调用摘要
    if (result.toolCalls?.length) {
      parts.push(``);
      parts.push(`🔧 <b>工具调用:</b> ${result.toolCalls.length} 次`);
      const summary = new Map<string, number>();
      for (const tc of result.toolCalls) {
        summary.set(tc.tool, (summary.get(tc.tool) ?? 0) + 1);
      }
      const items = [...summary.entries()].map(([t, n]) => `<code>${t}</code>×${n}`);
      parts.push(`  ${items.join(' · ')}`);
    }

    // 底部元信息
    const meta: string[] = [];
    if (result.duration) meta.push(`⏱ ${(result.duration / 1000).toFixed(1)}s`);
    if (result.cost) meta.push(`💰 $${result.cost.toFixed(4)}`);
    if (meta.length) {
      parts.push(``);
      parts.push(`<i>${meta.join(' · ')}</i>`);
    }

    return parts.join('\n');
  },

  taskFailed(error: string): string {
    return [
      `❌ <b>执行失败</b>`,
      ``,
      `<pre>${esc(truncate(error, 1500))}</pre>`,
    ].join('\n');
  },

  taskAborted(): string {
    return `⏹️ <b>已终止</b>`;
  },

  // ━━━━━━ 代码与 Diff ━━━━━━

  codeBlock(code: string, lang?: string): string {
    const content = truncate(code, 3500);
    return `<pre><code class="language-${lang ?? ''}">${esc(content)}</code></pre>`;
  },

  diffBlock(diff: string): string {
    const lines = diff.split('\n').slice(0, 40);
    const formatted = lines.map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) return line;
      if (line.startsWith('+')) return `+ ${line.slice(1)}`;
      if (line.startsWith('-')) return `- ${line.slice(1)}`;
      return `  ${line}`;
    }).join('\n');
    return `<pre>${esc(formatted)}</pre>`;
  },

  // ━━━━━━ 会话 ━━━━━━

  sessionInfo(session: {
    id: string;
    engine: string;
    cwd: string;
    permissionMode: string;
    messageCount: number;
    createdAt: string;
  }): string {
    return [
      `📋 <b>当前会话</b>`,
      ``,
      `┌ 🆔 <code>${session.id.slice(0, 8)}</code>`,
      `├ 🤖 引擎: <code>${session.engine}</code>`,
      `├ 📂 目录: <code>${esc(session.cwd)}</code>`,
      `├ 🔒 模式: <code>${session.permissionMode}</code>`,
      `├ 💬 消息: ${session.messageCount}`,
      `└ ⏱️ 创建: ${session.createdAt}`,
    ].join('\n');
  },

  // ━━━━━━ 帮助 ━━━━━━

  help(): string {
    return [
      `🤖 <b>AI CLI Telegram Bot</b>`,
      ``,
      `<b>━━ 基本使用 ━━</b>`,
      `直接发消息即与默认引擎对话`,
      ``,
      `<b>━━ 命令 ━━</b>`,
      `/claude <code>指令</code> — Claude Code 执行`,
      `/codex <code>指令</code> — Codex 执行`,
      `/mode <code>模式</code> — 权限模式`,
      `/cwd <code>路径</code> — 工作目录`,
      `/new — 新建会话`,
      `/resume — 恢复上次会话`,
      `/stop — 终止执行`,
      `/session — 会话详情`,
      `/history — 历史会话`,
      `/config — 设置面板`,
      ``,
      `<b>━━ 权限模式 ━━</b>`,
      `<code>default</code> — 逐一审批`,
      `<code>auto-edit</code> — 自动允许文件编辑`,
      `<code>full-auto</code> — 全自动（危险操作仍确认）`,
      ``,
      `<b>━━ 快捷操作 ━━</b>`,
      `• 回复消息 → 追加上下文`,
      `• 发送文件 → 附加为上下文`,
      `• /stop → 立即终止`,
    ].join('\n');
  },

  // ━━━━━━ 设置面板 ━━━━━━

  configPanel(config: {
    engine: string;
    permissionMode: string;
    cwd: string;
  }): string {
    return [
      `⚙️ <b>设置</b>`,
      ``,
      `🤖 引擎: <code>${config.engine}</code>`,
      `🔒 模式: <code>${config.permissionMode}</code>`,
      `📂 目录: <code>${esc(config.cwd)}</code>`,
    ].join('\n');
  },

  welcome(name: string): string {
    return [
      `👋 你好 <b>${esc(name)}</b>`,
      ``,
      `我是 AI CLI Bot，可以远程控制 Claude Code 和 Codex。`,
      `直接发消息开始，或输入 /help 查看命令。`,
    ].join('\n');
  },
};
```

## N. 会话管理（`telegram/session/manager.ts`）

每个 Telegram user/chat 对应独立的 AI 会话。

```typescript
import type { SessionStore } from './store.js';

export interface Session {
  id: string;
  chatId: number;
  engine: 'claude' | 'codex';
  engineSessionId?: string;    // Claude Code 的 sessionId（用于 resume）
  cwd: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions';
  approveAll: boolean;         // 用户点了"后续全部允许"
  status: 'idle' | 'running' | 'waiting_approval';
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
}

export class SessionManager {
  constructor(private store: SessionStore) {}

  getOrCreate(chatId: number, defaults: Partial<Session>): Session {
    const existing = this.store.getByChatId(chatId);
    if (existing && existing.status !== 'idle') return existing;
    if (existing) {
      this.store.touch(existing.id);
      return existing;
    }
    return this.store.create({
      chatId,
      engine: (defaults.engine ?? 'claude') as Session['engine'],
      cwd: defaults.cwd ?? process.env.DEFAULT_CWD ?? process.cwd(),
      permissionMode: (defaults.permissionMode ?? 'default') as Session['permissionMode'],
      approveAll: false,
      status: 'idle',
      messageCount: 0,
    });
  }

  update(id: string, patch: Partial<Session>): void {
    this.store.update(id, patch);
  }

  newSession(chatId: number): Session {
    // 关闭旧会话，开启新的
    this.store.closeByChatId(chatId);
    return this.getOrCreate(chatId, {});
  }

  getHistory(chatId: number, limit = 10): Session[] {
    return this.store.listByChatId(chatId, limit);
  }
}
```

## O. Bot 主体（`telegram/bot.ts`）

```typescript
import { Bot, session } from 'grammy';
import { loadTelegramConfig } from './config.js';
import { ClaudeEngine } from './engine/claude-engine.js';
import { CodexEngine } from './engine/codex-engine.js';
import { ApprovalManager } from './interaction/approval.js';
import { SessionManager } from './session/manager.js';
import { SessionStore } from './session/store.js';
import { registerCommands } from './handlers/command.js';
import { registerMessageHandler } from './handlers/message.js';
import { registerCallbackHandler } from './handlers/callback.js';
import { registerDocumentHandler } from './handlers/document.js';

export async function createBot() {
  const config = loadTelegramConfig();
  const bot = new Bot(config.token);

  // 基础设施
  const store = new SessionStore(config.dbPath);
  const sessionManager = new SessionManager(store);
  const claudeEngine = new ClaudeEngine();
  const codexEngine = new CodexEngine();
  const approvalManager = new ApprovalManager(bot);

  // 鉴权 middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !config.allowedUserIds.includes(userId)) {
      await ctx.reply('⛔ 无权限使用此 Bot');
      return;
    }
    return next();
  });

  // 注册各 handler
  registerCommands(bot, { sessionManager, config });
  registerCallbackHandler(bot, { approvalManager, sessionManager });
  registerDocumentHandler(bot, { sessionManager });
  registerMessageHandler(bot, {
    sessionManager,
    claudeEngine,
    codexEngine,
    approvalManager,
    config,
  });

  return bot;
}
```

## P. 消息处理流程（`telegram/handlers/message.ts`）

```typescript
import type { Context, Bot } from 'grammy';
import { Msg } from '../templates/messages.js';
import type { ApprovalManager } from '../interaction/approval.js';
import type { SessionManager, Session } from '../session/manager.js';
import type { Engine, ProgressUpdate } from '../engine/types.js';

export function registerMessageHandler(bot: Bot, deps: {
  sessionManager: SessionManager;
  claudeEngine: Engine;
  codexEngine: Engine;
  approvalManager: ApprovalManager;
  config: any;
}) {
  bot.on('message:text', async (ctx) => {
    // 跳过命令（以 / 开头的已被 command handler 处理）
    if (ctx.message.text.startsWith('/')) return;

    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const session = deps.sessionManager.getOrCreate(chatId, deps.config);

    // 防止重入
    if (session.status === 'running') {
      await ctx.reply('⏳ 任务执行中，请等待完成或发送 /stop 终止');
      return;
    }

    // 发送状态消息
    const statusMsg = await ctx.reply(Msg.taskStarted(session.engine, text), {
      parse_mode: 'HTML',
    });

    // 标记运行中
    deps.sessionManager.update(session.id, {
      status: 'running',
      messageCount: session.messageCount + 1,
    });

    try {
      const engine = session.engine === 'claude' ? deps.claudeEngine : deps.codexEngine;

      // 进度更新（编辑状态消息）
      let lastUpdate = 0;
      const onProgress = async (update: ProgressUpdate) => {
        const now = Date.now();
        if (now - lastUpdate < 2000) return; // 节流：2秒最多更新一次
        lastUpdate = now;
        try {
          await ctx.api.editMessageText(
            chatId, statusMsg.message_id,
            Msg.taskStarted(session.engine, text) + '\n\n' + Msg.taskProgress(update),
            { parse_mode: 'HTML' }
          );
        } catch { /* 编辑失败忽略 */ }
      };

      const result = await engine.execute({
        chatId,
        prompt: text,
        cwd: session.cwd,
        resume: session.engineSessionId,
        permissionMode: session.permissionMode,
        onPermission: async (req) => {
          if (session.approveAll) return true;
          deps.sessionManager.update(session.id, { status: 'waiting_approval' });
          const approved = await deps.approvalManager.request(chatId, req);
          deps.sessionManager.update(session.id, { status: 'running' });
          return approved;
        },
        onProgress,
      });

      // 保存引擎会话 ID
      deps.sessionManager.update(session.id, {
        engineSessionId: result.sessionId,
        status: 'idle',
      });

      // 删除状态消息，发送结果
      await ctx.api.deleteMessage(chatId, statusMsg.message_id);
      await sendResult(ctx, result);

    } catch (error: any) {
      deps.sessionManager.update(session.id, { status: 'idle' });
      await ctx.api.deleteMessage(chatId, statusMsg.message_id);

      if (error.name === 'AbortError') {
        await ctx.reply(Msg.taskAborted(), { parse_mode: 'HTML' });
      } else {
        await ctx.reply(Msg.taskFailed(error.message), { parse_mode: 'HTML' });
      }
    }
  });
}

async function sendResult(ctx: Context, result: ExecutionResult): Promise<void> {
  const text = Msg.taskCompleted(result);

  // 短消息直接发
  if (text.length <= 4000) {
    await ctx.reply(text, { parse_mode: 'HTML' });
    return;
  }

  // 长消息：摘要 + 文件
  const summary = [
    `✅ <b>完成</b>`,
    ``,
    result.filesChanged?.length
      ? `📁 变更 ${result.filesChanged.length} 个文件`
      : `💬 输出过长，详见附件`,
  ].join('\n');

  await ctx.reply(summary, { parse_mode: 'HTML' });

  // 完整输出作为文件
  const { InputFile } = await import('grammy');
  const buffer = Buffer.from(result.response, 'utf-8');
  await ctx.replyWithDocument(
    new InputFile(buffer, 'output.md'),
    { caption: '📄 完整输出' }
  );

  // Diff 单独发送
  if (result.diff) {
    const diffBuf = Buffer.from(result.diff, 'utf-8');
    await ctx.replyWithDocument(
      new InputFile(diffBuf, 'changes.diff'),
      { caption: '📝 变更详情' }
    );
  }
}
```

## Q. Callback 处理（`telegram/handlers/callback.ts`）

处理所有 inline button 点击。

```typescript
import type { Bot } from 'grammy';
import type { ApprovalManager } from '../interaction/approval.js';
import type { SessionManager } from '../session/manager.js';

export function registerCallbackHandler(bot: Bot, deps: {
  approvalManager: ApprovalManager;
  sessionManager: SessionManager;
}) {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // 权限审批回调: perm:approve:<id> / perm:deny:<id> / perm:approve_all:<id>
    if (data.startsWith('perm:')) {
      const [, action, id] = data.split(':');

      if (action === 'approve') {
        deps.approvalManager.resolve(id!, true);
        await ctx.answerCallbackQuery({ text: '✅ 已允许' });
      } else if (action === 'deny') {
        deps.approvalManager.resolve(id!, false);
        await ctx.answerCallbackQuery({ text: '❌ 已拒绝' });
      } else if (action === 'approve_all') {
        deps.approvalManager.resolve(id!, true);
        deps.sessionManager.update(
          deps.sessionManager.getOrCreate(chatId, {}).id,
          { approveAll: true }
        );
        await ctx.answerCallbackQuery({ text: '✅ 后续操作将自动允许' });
      } else if (action === 'skip') {
        deps.approvalManager.resolve(id!, false);
        await ctx.answerCallbackQuery({ text: '⏭️ 已跳过' });
      }
      return;
    }

    // 设置面板回调: config:engine:claude / config:mode:full-auto 等
    if (data.startsWith('config:')) {
      const [, category, value] = data.split(':');
      const session = deps.sessionManager.getOrCreate(chatId, {});

      if (category === 'engine') {
        deps.sessionManager.update(session.id, { engine: value as any });
        await ctx.answerCallbackQuery({ text: `已切换到 ${value}` });
      } else if (category === 'mode') {
        deps.sessionManager.update(session.id, { permissionMode: value as any });
        await ctx.answerCallbackQuery({ text: `模式: ${value}` });
      }

      // 更新设置面板消息
      await ctx.editMessageText(Msg.configPanel({
        engine: value === 'engine' ? value : session.engine,
        permissionMode: category === 'mode' ? value! : session.permissionMode,
        cwd: session.cwd,
      }), { parse_mode: 'HTML', reply_markup: buildConfigKeyboard(session) });
      return;
    }

    await ctx.answerCallbackQuery();
  });
}
```

## R. Bot 命令（`telegram/handlers/command.ts`）

Telegram 自定义命令由 `(chat_id, cwd, name)` 唯一标识并持久化到 Bot 独立的 `custom_commands` 表。Bot 重启或恢复 ready 会话时必须按当前 `cwd` 恢复命令菜单。Telegram 菜单最多展示 100 条命令，排序必须优先保留基础命令、当前 CLI 内建命令和工作目录自定义命令，再填充扫描到的插件命令；该展示上限不得限制运行时对已持久化自定义命令的解析与执行。

```typescript
import { InlineKeyboard, type Bot } from 'grammy';
import { Msg } from '../templates/messages.js';
import type { SessionManager } from '../session/manager.js';

export function registerCommands(bot: Bot, deps: {
  sessionManager: SessionManager;
  config: any;
}) {
  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name ?? 'there';
    await ctx.reply(Msg.welcome(name), { parse_mode: 'HTML' });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(Msg.help(), { parse_mode: 'HTML' });
  });

  // /claude <prompt> — 强制用 Claude Code
  bot.command('claude', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    deps.sessionManager.update(session.id, { engine: 'claude' });
    // 触发消息处理（移除 /claude 前缀）
    ctx.message!.text = ctx.match;
    // 让 message handler 接管
  });

  // /codex <prompt> — 强制用 Codex
  bot.command('codex', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    deps.sessionManager.update(session.id, { engine: 'codex' });
    ctx.message!.text = ctx.match;
  });

  // /mode <mode>
  bot.command('mode', async (ctx) => {
    const mode = ctx.match.trim();
    const validModes = ['default', 'auto-edit', 'acceptEdits', 'full-auto', 'bypassPermissions'];
    if (!validModes.includes(mode)) {
      await ctx.reply(`❌ 无效模式。可选: <code>${validModes.join(' | ')}</code>`, {
        parse_mode: 'HTML',
      });
      return;
    }
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    deps.sessionManager.update(session.id, { permissionMode: mode as any });
    await ctx.reply(`🔒 权限模式已切换为: <code>${mode}</code>`, { parse_mode: 'HTML' });
  });

  // /cwd <path>
  bot.command('cwd', async (ctx) => {
    const cwd = ctx.match.trim();
    if (!cwd) {
      const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
      await ctx.reply(`📂 当前目录: <code>${session.cwd}</code>`, { parse_mode: 'HTML' });
      return;
    }
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    deps.sessionManager.update(session.id, { cwd });
    await ctx.reply(`📂 工作目录已切换: <code>${cwd}</code>`, { parse_mode: 'HTML' });
  });

  // /new — 新建会话
  bot.command('new', async (ctx) => {
    deps.sessionManager.newSession(ctx.chat.id);
    await ctx.reply('🆕 已创建新会话');
  });

  // /stop — 终止当前任务
  bot.command('stop', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    if (session.status === 'idle') {
      await ctx.reply('💤 当前没有运行中的任务');
      return;
    }
    // 通过 engine abort
    // Engine 实例需要从外部注入或通过事件通知
    await ctx.reply(Msg.taskAborted(), { parse_mode: 'HTML' });
  });

  // /session — 查看当前会话
  bot.command('session', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    await ctx.reply(Msg.sessionInfo({
      id: session.id,
      engine: session.engine,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      messageCount: session.messageCount,
      createdAt: session.createdAt,
    }), { parse_mode: 'HTML' });
  });

  // /config — 设置面板
  bot.command('config', async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id, deps.config);
    const keyboard = new InlineKeyboard()
      .text('🤖 Claude', 'config:engine:claude')
      .text('⚡ Codex', 'config:engine:codex')
      .row()
      .text('🔓 default', 'config:mode:default')
      .text('✏️ auto-edit', 'config:mode:acceptEdits')
      .text('🚀 full-auto', 'config:mode:bypassPermissions')
      .row()
      .text('🆕 新会话', 'config:action:new')
      .text('📂 改目录', 'config:action:cwd');

    await ctx.reply(Msg.configPanel({
      engine: session.engine,
      permissionMode: session.permissionMode,
      cwd: session.cwd,
    }), { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // /history — 历史会话
  bot.command('history', async (ctx) => {
    const sessions = deps.sessionManager.getHistory(ctx.chat.id, 10);
    if (!sessions.length) {
      await ctx.reply('📭 暂无历史会话');
      return;
    }
    const lines = sessions.map((s, i) =>
      `${i + 1}. <code>${s.id.slice(0, 8)}</code> · ${s.engine} · ${s.messageCount}条 · ${s.createdAt}`
    );
    await ctx.reply(`📜 <b>历史会话</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  // /resume [id] — 恢复会话
  bot.command('resume', async (ctx) => {
    const targetId = ctx.match.trim();
    if (!targetId) {
      // 恢复最近的会话
      const sessions = deps.sessionManager.getHistory(ctx.chat.id, 1);
      if (!sessions.length) {
        await ctx.reply('📭 没有可恢复的会话');
        return;
      }
      await ctx.reply(`♻️ 已恢复会话 <code>${sessions[0]!.id.slice(0, 8)}</code>`, {
        parse_mode: 'HTML',
      });
      return;
    }
    await ctx.reply(`♻️ 已恢复会话 <code>${targetId}</code>`, { parse_mode: 'HTML' });
  });
}
```

---

# 附：Progress Streaming 进度流式设计（从 ARCHITECTURE §3.5 迁入）

> **Appendix Status: SUPPORTING SPEC** — 进度事件必须映射到 closed `RuntimeEvent`/Surface presentation contract。

> 从 `ARCHITECTURE.md` §3.5 迁入。进度流式是 Telegram surface 展示层的实现设计，属 ① 的交互态。
>
> **状态：已实现。** 引擎已有的进度事件已接到 Telegram：长任务执行期间会编辑同一条状态消息展示阶段/工具；任务完成后，短结果会直接把这条状态消息编辑成最终回复，避免“删除状态消息再新发结果”的割裂感。

## S. 现状：进度流式已接通

底层管道本来就是流式的，本轮已补齐 Telegram 展示层：

- **引擎到 CLI 一层本就是流式**：ClaudeEngine 用 `--output-format stream-json --verbose`；CodexEngine 用 `codex exec --json` + `wire_api=responses`。
- **子进程 stdout 边跑边收**：`spawnCapture({ onStdout })` 实时把 chunk 交给 `handleClaudeProgress()` / `handleCodexProgress()`，已能解析出 `tool_calling` / `writing` 等 `ProgressUpdate`（见 `engine/types.ts` 的 `ProgressUpdate`）。
- **message.ts 已接线**：`executePromptLocked()` 构造 `ProgressReporter`，把 `onProgress` 透传给 `engine.execute()`；成功或失败时优先用最终内容覆盖状态消息，只有无法覆盖时才由 `finally` 清理。
- **最终文本一次性解析**：进程整体结束后 `parseClaudeOutput()` / `parseCodexOutput()` 从完整 stdout 取 `result` / `last_message`，再由 `sendResult()` 优先编辑已有状态消息；没有状态消息、内容过长或编辑失败时回退到 `ctx.reply` / 附件。
- 用户端现在同时保留每 4 秒一次的 `startTypingStatus()` 输入指示，以及 `ProgressReporter` 维护的一条可编辑状态消息。

结论：进度阶段现在会通过一条可编辑状态消息展示；最终答案仍保持非 token 级流式，避免 Telegram edit 限流和中间工具日志刷屏。

## T. 设计目标与取舍

| 方案 | 是否采用 | 理由 |
|------|----------|------|
| 进度流式（编辑一条状态消息展示阶段/工具） | ✅ 采用 | 复用现成 `onProgress` 管道，低风险；长任务里用户能看到「在思考 / 在跑命令 / 在整理回复」 |
| Token 级流式（逐字吐最终答案） | ❌ 不采用 | Telegram `editMessageText` 对同一 chat 有硬限流（约 1 次/秒，超限 429）；且 Codex/Claude 是 agent，用户真正要的是结尾 `last_message`，中间是工具日志，逐字吐意义有限 |

**核心原则**：编辑**同一条**状态消息（不是每次进度都新发消息），节流更新；任务结束时短结果直接覆盖这条消息，长结果继续走文件附件，保留 HTML 降级、diff 附件等行为。

## U. 改动点总览

| 文件 | 改动 | 说明 |
|------|------|------|
| `telegram/engine/types.ts` | 扩展 `ProgressUpdate` | 增加 `toolKind?` / `mcpServer?` 等字段（见 §Y）；`toolCount` 由 reporter 内部统计 |
| `telegram/interaction/tool-name.ts` | **新增** | 共享 helper `parseToolName()`：解析 `mcp__` 前缀、归一 `toolKind`（见 §Y） |
| `telegram/interaction/progress-reporter.ts` | **新增** | 节流状态消息更新器（发送/编辑/清理一条状态消息），核心组件 |
| `telegram/interaction/formatter.ts` | 新增 `Formatter.progress()` | 把 `ProgressUpdate` 渲染为状态文案（emoji + 阶段 + 工具名，不展示耗时） |
| `telegram/handlers/message.ts` | 接线 | `executePromptLocked()` 构造 `ProgressReporter`，透传 `onProgress`，最终结果优先覆盖状态消息 |
| `telegram/engine/claude-engine.ts` | **不改** | MCP 前缀 `mcp__` 在 `tool_use.name` 里，由 `parseToolName()` 解析，引擎无需改动 |
| `telegram/engine/codex-engine.ts` | 小改 `handleCodexProgress` | Codex 无 `mcp__` 前缀，`toolKind` 需按事件 type 判定后写入 `ProgressUpdate` |

## V. ProgressReporter 组件设计

新增 `telegram/interaction/progress-reporter.ts`，职责单一：把高频 `ProgressUpdate` 合并成低频的状态消息编辑。

```typescript
export type ProgressReporterOptions = {
  throttleMs?: number;   // 默认 1500，两次 editMessageText 的最小间隔
  silent?: boolean;      // silentSuccess 场景全程 no-op
};

export class ProgressReporter {
  private messageId?: number;     // 状态消息 id；首个 update 时惰性 sendMessage
  private lastSignature = "";     // 上次状态签名，去重用（忽略单纯秒数变化）
  private pending?: ProgressUpdate;// 节流窗口内最后一次 update，窗口到点后 flush
  private startedAt = Date.now();
  private toolCount = 0;

  constructor(api: Pick<Context["api"], "sendMessage" | "editMessageText" | "deleteMessage">, chatId: number, options?: ProgressReporterOptions);

  // onProgress 回调入口：记录 pending，按 throttle 决定立即 flush 还是等定时器
  update(u: ProgressUpdate): Promise<void>;

  // 任务结束但没有被最终结果覆盖时调用：删除状态消息、清定时器
  async finalize(): Promise<void>;

  // 任务成功/失败时优先调用：把状态消息原地编辑成最终内容
  async replaceWithHtml(html: string, fallbackText: string): Promise<boolean>;
}
```

**节流与去重规则**：
- 窗口内多次 `update()` 只保留最后一个，窗口到点 flush 一次；`done` 阶段不展示，由 `finalize()` 清理。
- flush 前用 `Formatter.progress()` 渲染文本，若阶段/工具/消息签名未变则跳过编辑（避免无谓 API 调用和「message is not modified」错误）。
- 首次有内容时 `sendMessage` 建状态消息并记住 `messageId`；之后一律 `editMessageText`。
- 所有 Telegram API 调用 best-effort：`try/catch` 吞掉错误（含 429），**绝不影响主任务执行**。

## W. message.ts 接线

在 `executePromptLocked()` 中用 `ProgressReporter` 替换/补充现有的 `startTypingStatus()`：

```typescript
const reporter = new ProgressReporter(ctx.api, chatId, {
  silent: options.silentSuccess === true,  // /init 等静默任务全程 no-op
});
const stopTypingStatus = startTypingStatus(ctx, chatId); // 保留：typing 与状态消息可并存

try {
  // ... provider 候选循环内：
  result = await engine.execute({
    chatId,
    prompt: promptWithContext,
    // ... 其余参数不变
    onPermission: async (req) => { /* 不变 */ },
    onProgress: (u) => reporter.update(u),   // ← 新增：唯一的接线点
  });
  // ...
  if (!options.silentSuccess) {
    await sendResult(ctx, session.engine, result, deps.config.maxOutputLength, reporter);
  }
} catch (error) {
  // ... 失败时也优先 reporter.replaceWithHtml()，失败再 ctx.reply()
} finally {
  await reporter.finalize();                 // 幂等：成功路径已替换则 no-op；未替换才删除状态
  stopTypingStatus();
}
```

**要点**：
- `onProgress` 是唯一接线点，引擎无需改动。
- `replaceWithHtml()` / `finalize()` 必须幂等：成功替换后 `finally` 不再删除；未替换时 `finally` 负责清理残留状态。
- provider fallback 时**复用同一个 reporter**，可选地在切换时 `update` 一帧「↻ 正在切换 provider…」。
- 与 `SessionManager.runExclusive()` 天然兼容：同一 chat 串行执行，任意时刻只有一个 reporter 活跃。

## X. 状态文案（Formatter.progress）

| phase | 状态文案示例 |
|-------|-------------|
| `thinking` | `⏱️ 思考中…`（🧠 保留给记忆态，避免冲突） |
| `tool_calling` | `🔧 正在运行 Bash（第 3 个操作）` |
| `writing` | `✍️ 正在整理回复…` |
| `done` | 不再展示（由 `finalize()` 清理） |

- 状态消息不展示耗时，避免出现 `（2s）` 这类跳秒信息；若阶段/工具/消息签名未变则不触发编辑（避免无意义刷新）。
- 工具名与 MCP 识别见 §Y；`toolCount` 由 reporter 侧对 `tool_calling` 事件累加得到。

## Y. 工具名解析（含 MCP 识别）

新增共享 helper `telegram/interaction/tool-name.ts`，把原始工具标识归一为结构化字段，供 `Formatter.progress()` 渲染。`ProgressUpdate` 扩展：

- `toolKind?: "builtin" | "mcp" | "command"`
- `mcpServer?: string`（仅 MCP 调用有值）

**解析规则（两引擎差异）**：

- **Claude**：`tool_use.name` 若以 `mcp__` 开头，按约定 `mcp__<server>__<tool>` 拆分 → `toolKind="mcp"`、`mcpServer=<server>`、展示名取 `<tool>`（如 `mcp__codegraph__codegraph_context` → server=`codegraph`, tool=`codegraph_context`）；否则 `toolKind="builtin"`，名字原样（`Bash`/`Edit`/`Read`…）。**解析全在 `parseToolName()` 内完成，`claude-engine.ts` 不改。**
- **Codex**：事件里没有 `mcp__` 前缀，需在 `handleCodexProgress` 按事件 type 判定：`exec`/`command` → `"command"`；MCP 调用事件 → `"mcp"`（server/tool 从事件字段取）；其余 → `"builtin"`。判定结果写入 `ProgressUpdate.toolKind`。

**Formatter.progress() 按 toolKind 渲染**：

| toolKind | 展示示例 |
|----------|---------|
| `mcp` | `🔌 调用 MCP · codegraph / codegraph_context（第 3 个操作）` |
| `command` | `⌨️ 执行命令 · npm test` |
| `builtin`（编辑类 Write/Edit） | `✏️ 编辑文件 · a.ts` |
| `builtin`（其它） | `🔧 运行 Bash（第 2 个操作）` |

- server 名 / tool 名 / 命令各做长度截断（建议 ≤ 24 字符），避免状态消息过长。
- 未知 kind 或解析失败兜底为 `🔧 运行 <原始名>`，**绝不因出现新工具类型而崩溃**。

## Z. 最终替换策略与边界情况

`ProgressReporter` 的收尾分两类：

- **成功替换**：`replaceWithHtml()` 把已有状态消息直接编辑成最终回复；HTML 解析失败时再用纯文本 fallback 编辑一次。成功后 reporter 标记为 finalized，`finally` 不再删除。
- **清理残留**：如果没有状态消息、编辑失败、静默任务或需要中止清理，`finalize()` 仍可删除状态消息。删除失败（用户已删、超时）吞错即可。

边界情况处理：

| 情况 | 处理 |
|------|------|
| 任务极快（< throttle 窗口，进度消息还没发出） | `replaceWithHtml()` 会取消 pending 进度并返回 false，用户只看到最终结果，不会在结果后补闪状态消息 |
| `editMessageText` 返回 429 | 吞错并适度拉长 `throttleMs`（退避），不阻塞、不重试风暴 |
| `editMessageText` 报 "message is not modified" | 去重逻辑应已避免；万一触发，吞错 |
| 状态消息被用户手动删除 | 后续 edit 报错，吞错；下次 update 可惰性重建或放弃 |
| `silent: true`（如 `/init`） | `update()` / `finalize()` 全程 no-op，不产生任何状态消息 |
| 短最终结果 | 优先编辑原状态消息为最终回复 |
| 长最终结果 / 附件 | 原状态消息优先编辑为附件提示，再发送完整输出文件和 diff 文件 |
| 任务失败 | 优先编辑原状态消息为失败内容；编辑失败再单独发送失败消息 |
| 任务中止 / 静默失败 | `finally` 中 `finalize()` 保证状态消息被清理 |

## AA. 测试与实施要求

**单元测试**（`node:test`，mock `ctx.api`）：
- 高频 `update()` 在节流窗口内被合并为有限次 `editMessageText` 调用。
- 相同渲染文本不重复编辑（去重）。
- `silent: true` 时 `sendMessage` / `editMessageText` / `deleteMessage` 零调用。
- 成功路径下短结果会编辑原状态消息，且 `finalize()` 不再删除。
- 失败或编辑失败路径下 `finalize()` 仍被调用且状态消息被清理。
- `editMessageText` 抛错时不冒泡到主流程（主任务结果不受影响）。
- `parseToolName()`：`mcp__codegraph__codegraph_context` → kind=`mcp`/server=`codegraph`/tool=`codegraph_context`；`Bash` → kind=`builtin`；超长名被截断；未知输入走兜底不抛错。

**手动验证**：长任务（多工具调用）能看到状态滚动更新；结果出现时同一条消息原地变成最终回复；短任务无残留状态消息。

**实施原则**：
- 已新增 `progress-reporter.ts` + `tool-name.ts` + `Formatter.progress()` + message.ts 接线；Claude 引擎解析零改动，Codex 仅补充 progress metadata。
- reporter 不存在或 `silent` 时，行为与当前代码等价（零功能回退）。
- 最终结果发送逻辑保留 `sendResult` 的附件/HTML 降级/diff 能力，并新增“有状态消息时原地替换”的优先路径。

# 附：Telegram 工程落地（结构/依赖/优先级/测试）（从 telegram-bot-spec 迁入）

> **Appendix Status: CURRENT SNAPSHOT** — 记录 legacy 工程拆分；目标依赖方向以模块正文为准。

## A. 项目结构变更

```
ai-gateway/
├── src/
│   ├── cli/
│   │   ├── index.ts              # 新增 "telegram" case
│   │   └── commands/
│   │       └── telegram.ts       # ai telegram 多 Bot target + lifecycle/config
│   ├── core/                     # 现有核心逻辑（不动）
│   └── telegram/                 # 【新增】Telegram Bot 模块
│       ├── index.ts              # Bot 入口（可独立进程运行）
│       ├── bot.ts                # Grammy 实例 + middleware 注册
│       ├── config.ts             # Bot 配置（token、白名单等）
│       ├── engine/
│       │   ├── types.ts          # 引擎公共接口
│       │   ├── claude-engine.ts  # Claude Code CLI 子进程封装
│       │   └── codex-engine.ts   # Codex CLI 子进程封装
│       ├── handlers/
│       │   ├── message.ts        # 文本消息 → 引擎调度
│       │   ├── callback.ts       # Inline button 回调处理
│       │   ├── command.ts        # Bot 命令 (/start /help /mode 等)
│       │   └── document.ts       # 文件上传处理
│       ├── interaction/
│       │   ├── approval.ts       # 权限审批队列 + Telegram button
│       │   ├── formatter.ts      # 输出格式化（代码块、diff、进度）
│       │   └── keyboards.ts      # Inline keyboard 构建器
│       ├── session/
│       │   ├── manager.ts        # 会话生命周期（创建、恢复、销毁）
│       │   └── store.ts          # SQLite 持久化
│       └── templates/
│           └── messages.ts       # 美观消息模板
├── test/
│   └── telegram/                 # Bot 测试
│       ├── claude-engine.test.ts
│       ├── codex-engine.test.ts
│       └── approval.test.ts
└── package.json                  # 新增 grammy 等依赖
```

## B. 依赖变更

在现有 package.json 中新增：

```json
{
  "dependencies": {
    "grammy": "^1.30.0",
    "better-sqlite3": "^13.0.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

## C. CLI 入口变更

在 `src/cli/index.ts` 的 switch 中新增：

```typescript
case "telegram":
  await runTelegramCommand(args);
  break;
```

## D. 实现优先级

### Phase 1 — 核心链路 (MVP)

1. `src/telegram/` 目录初始化 + 类型定义
2. `telegram/config.ts` — 读取 `~/.ai-gateway/telegram.json`
3. `telegram/engine/claude-engine.ts` — Claude Code CLI 子进程封装
4. `telegram/bot.ts` — Grammy 实例 + 鉴权 middleware
5. `telegram/handlers/message.ts` — 消息 → 引擎 → 返回结果
6. `telegram/interaction/approval.ts` — 权限请求 → inline button
7. `telegram/handlers/callback.ts` — 按钮回调处理
8. `telegram/templates/messages.ts` — 格式化输出
9. `src/cli/commands/telegram.ts` — `ai telegram` 交互式多 Bot selector、`--bot` 单目标与 `--all` 批量生命周期
10. 接入 CLI 入口

### Phase 2 — 引擎与会话

11. `telegram/engine/codex-engine.ts` — Codex 子进程封装
12. `telegram/session/store.ts` — SQLite 持久化
13. `telegram/session/manager.ts` — 会话生命周期
14. `telegram/handlers/command.ts` — 全部 Bot 命令
15. 长消息分片 + 文件发送

### Phase 3 — 体验优化

16. 进度更新（编辑同一消息显示当前阶段与有界 event-level 响应预览）
17. `telegram/handlers/document.ts` — 多文件/图片上传作为下一条请求上下文
18. `/config` 设置面板 inline keyboard
19. 错误重试 + 超时处理
20. `ai telegram logs` 日志查看
21. 最新消息编辑重跑、回复引用、动态 token budget 与 `/pin|/unpin`

当前超时与回复投递规则：

- 普通 CLI 任务总时限仍为 15 分钟，复杂工具任务不会因为短暂无输出被直接终止。
- Codex 请求等待 Provider 响应头最多 45 秒；连续两次首包超时后，本轮该 Provider 快速失败并进入下一个可用 Provider。
- Telegram 的状态消息编辑、最终回复和附件发送遇到网络断开、连接超时或 HTTP 5xx 时有限重试。
- Telegram 回复重试只重发消息，不会重新执行已经完成的 Claude Code 或 Codex 请求。
- HTML 格式错误、参数错误等确定性失败不做网络重试。
- Claude 非零退出从 terminal JSON `result` 提取真实失败原因，不把首个 `system/init` envelope 当作错误。

## E. 关键注意事项

### Claude Code CLI

- 设置环境变量 `CLAUDE_CODE_HEADLESS=1`，确保无 TTY 也能运行
- 通过临时 settings 和环境变量注入 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`
- 使用 `--output-format stream-json --verbose` 获取结构化输出
- 每次执行后解析 CLI 输出中的 session id，用于下次 resume 多轮对话
- 通过终止子进程实现 /stop

### Codex CLI

- `--quiet --output-format json` 获取结构化输出
- 通过 `spawn` 的 `signal` 选项传入 AbortSignal
- `cwd` 在 spawn 时指定
- 没有官方的会话恢复机制，每次是独立执行

### Telegram 限制

- 单条消息 ≤ 4096 字符
- 消息编辑频率约 30 次/分钟（进度更新需节流）
- HTML parse_mode 只支持有限标签
- Bot 在群组中需要 @ 提及或设置 privacy mode off

### 进程管理

- Bot 作为 detached 子进程运行
- PID 文件存储在 `~/.ai-gateway/telegram.pid`
- SIGTERM 优雅关闭（finish pending, cleanup）
- 崩溃时通过 `ai telegram status` 检测并重启

## F. 测试策略

```bash
# 构建
npm run build

# 单元测试
npm test -- --filter telegram

# 手动测试 checklist
- [ ] ai telegram config set token <token>
- [ ] ai telegram start → Bot 在线
- [ ] 发消息 → Claude Code 执行 → 返回结果
- [ ] 触发权限请求 → inline button 出现
- [ ] 点击允许 → 继续执行
- [ ] 点击拒绝 → 终止该工具调用
- [ ] /stop → 终止执行中的任务
- [ ] /codex <指令> → Codex 执行
- [ ] /mode full-auto → 切换后不再请求权限
- [ ] /cwd /tmp → 后续任务在 /tmp 执行
- [ ] /new → 清除上下文
- [ ] /resume → 恢复多轮对话
- [ ] 超长输出 → 文件附件发送
- [ ] 连续上传多个 UTF-8 文本/图片 → 下一条请求一次消费，Codex 收到 `--image`
- [ ] 回复历史消息 → `<referenced_message>` 转义后注入
- [ ] 编辑最新 prompt → 旧任务停止、旧 turn/native session 不再进入重跑
- [ ] 长回答 → 同一状态消息按节流显示 event-level 预览，最终被结果替换
- [ ] `/pin`/`/unpin` → 固定上下文持久化且受 3 条/1400 token budget 约束
- [ ] Claude API 失败 → 显示 terminal error，不显示 `system/init` JSON
- [ ] `/terminal` 高风险命令 → inline confirmation；`/restart` → 优雅停止并拉起 replacement process
- [ ] ai telegram stop → Bot 下线
- [ ] ai telegram status → 显示运行状态
```
