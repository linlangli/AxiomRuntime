# ⑨ Security 安全

> 遵循 doc_2.0 统一模块模板。语言中英混合，标识符英文原样。术语见 [../glossary.md](../glossary.md)。
> 边界拆清：本模块含**四个子责任**——凭证 / 脱敏 / 隔离 / 执行期权限——各自单一职责，勿混。

## 1. 定位（一句话）

守护 Runtime 的凭证与会话态、执行递归脱敏、落实租户隔离、在执行期落实权限——凭证与浏览器会话态是**能力**，绝非 prompt memory。

## 2. 单一职责边界（高内聚）

**拥有**：凭证/密钥管理（SecretStore/KMS）、DLP 递归脱敏、tenant/租户隔离落实、执行期权限落实的安全侧。

**禁止拥有**：
- **禁止**把凭证/会话态写入 prompt 或 memory。
- **禁止**在业务代码实现加密原语/nonce/裸主密钥处理——**必须**经 `ProtectedPayloadCodec`。
- **禁止**让原始 header/prompt/reasoning/tool 参数进持久层。

## 3. 内部构件与各自单一职责

| 子责任 | 单一职责 |
|---|---|
| `credentials` | 凭证、浏览器会话态作为能力管理 |
| `redaction` | 递归脱敏 + persist-schema allowlist |
| `isolation` | tenant/OS-user/container/network 隔离 |
| `permission` | 执行期权限落实（与 ⑧ 判定协作） |

## 4. 对外/消费端口（可插拔点）

- 暴露：脱敏后的 `SanitizedTurnEnvelope` / `SanitizedExecutionEnvelope`。
- 消费：`ProtectedPayloadCodec`（本地 OS SecretStore / 企业 KMS/HSM 可换）。
- 密钥后端可换，业务代码零改动。

## 5. 依赖（低耦合）

只 import `L0 Contracts`。作为横切被 ②/④/⑤ 调用。**禁止** import 模块实现，**禁**将供应商密钥 SDK 类型外泄成公共契约。

## 6. 数据所有权

**独占**凭证与密钥材料（经 SecretStore/KMS，绝不入库明文）。脱敏后的 envelope 才可跨入持久层；原始传输态是**瞬时**数据，**禁**持久化。

## 7. 降级 / kill switch

**不可降级**——安全关键，故障 **fail-closed**。`ProtectedPayloadCodec` 不可用 → 拒绝写入需保护的 payload，**禁**降级为明文落盘。租户隔离**禁**用 loopback 随机端口冒充；互不信任租户**必须** OS-user/容器/网络隔离。

## 8. 产品化就绪度

⚠️ 子责任各异：SecretStore/KMS 通常**采纳**成熟产品；DLP 脱敏可作为组件，但与 Runtime persist-schema 强绑，抽取价值有限。判据见 [../extraction-readiness.md](../extraction-readiness.md)。

## 9. 现状映射

**部分存在、待收敛**。当前脱敏与凭证处理散落 Transport/Memory；本层将其收敛为统一 Security，明确四子责任边界。

`ai set codex` 是当前受限的 vendor credential/config compatibility path：ChatGPT token 只能由 `codex login` OAuth 生成；自定义 provider 的 API key 只写入 `CODEX_HOME/auth.json`，权限固定为 `0600`，`config.toml` 只保存 provider metadata 与已验证的 cached GPT model id。Provider/model validation failure 必须发生在 credential/config mutation 前。两文件更新使用 snapshot、atomic rename 与 failure rollback，日志和终端不输出 secret；这是迁移到统一 `SecretStore` 前的本地兼容实现，不改变目标态的 Security ownership。Proxy 子命令只接受无 credential 的 HTTP(S) origin，command usage log 对 endpoint 整体脱敏，并管理 `shell_environment_policy.set` 中固定 allowlist 的 proxy env keys；macOS user launchd environment 的部分更新失败时必须 best-effort 还原已改变量，并恢复原 `config.toml`，禁止重启到半配置状态。

常驻 Runtime 服务使用独立 Bearer Token，在 constant-time comparison 后才允许访问 `/v1/*`。生产 Token 与 provider credentials 通过只读/持久化挂载注入，不进入镜像。Agent Run 禁止任意 cwd，只接受规范化 `workspace_id`；默认 `read_only`，服务 API 不暴露 `bypassPermissions`，并设置请求体、并发与执行超时上限。包安装可使用管理员权限，但 Agent 与常驻 Runtime 应使用专用非 root OS identity；Claude Adapter 检测到 UID 0 时必须在构造 args/settings 前把 `bypassPermissions` 约束为 `default`，清除 execution-scoped settings 中的 inherited bypass，并写入 configured/effective mode 与 reason。

## 10. 验收标准

- 凭证/会话态**不出现**在任何 prompt 或 memory 中。
- Codex provider 切换 fixture 必须证明 ChatGPT OAuth 不由 Runtime 伪造、自定义 provider key 不进入 TOML/日志、`auth.json` 为 `0600`、仅 cached `gpt-*` model 可被选择、无 GPT/invalid model 在 mutation 前失败，且任一步失败恢复原 `config.toml` 与 `auth.json`。
- Codex proxy fixture 必须证明 URL validation、managed-key-only TOML 更新、无关 shell env/table 保留、清除语义、environment failure config rollback 与 no-restart；测试禁止修改真实 user launchd environment。
- 普通配置、普通 export、日志和 cache **不含**明文 secret；跨设备 secret 迁移只能使用接收方绑定、显式确认、可审计且有有效期的 `ProtectedPayloadCodec` envelope，导入目标只能是 `SecretStore`。
- 持久执行证据**不含**原始 authorization/system prompt/reasoning/raw tool 参数。
- 递归脱敏 + persist allowlist **强制**生效（只扫响应文本不合规）。
- 互不信任租户拥有真实 OS/容器/网络隔离，非仅端口区隔。
- UID 0 启动 Claude 的 fixture 必须证明 args 不含 `--dangerously-skip-permissions`、临时 settings 不含 inherited bypass，且 configured/effective mode 与 constraint reason 可观测。
- OIDC/SAML 登录、SCIM provisioning、delegated admin 与 break-glass 流程必须通过签名/issuer/audience/nonce/session 校验；role 或 group 变化不能直接生成 capability，仍需 Policy 与执行期权限检查。
- break-glass 必须 time-bound、reason-bound、单独审批/告警/审计；禁止绕过 tenant isolation、legal hold、secret handling 或审计写入。
- residency、retention 与 legal hold 的执行状态必须可证明；边界不确定时阻止数据移动或物理删除，禁止以“稍后补审计”继续。

## 11. 相关文档

- 策略：[08-policy.md](08-policy.md)｜传输脱敏：[05-transport-proxy.md](05-transport-proxy.md)
- 权威边界（英文）：[../AI_RUNTIME_ARCHITECTURE.md](../AI_RUNTIME_ARCHITECTURE.md) §6 Governance and Security Invariants

---

# 附：Capability Security Kernel（从 memory-system-spec 迁入）

> **Appendix Status: SUPPORTING SPEC** — capability 细节服从正文 Security ownership、Policy decision 与 closed error catalog。
>
> Capability Kernel 是 ⑨ 凭证/执行期权限子责任的核心机制（R23 Capability Kernel、R8 凭证）；Auth Broker 能力入口见 [03-capabilities.md](03-capabilities.md) 附 Auth Session Broker。相关 enforcement 决策见 [../enforcement-decisions.md](../enforcement-decisions.md)。标识符英文原样。

## A. Capability Security Kernel

Auth Broker 和工具权限统一签发不可伪造的 execution-bound capability handle。Prompt 中只出现 opaque handle 和允许操作摘要；工具执行时服务层验证签名、user、execution、domain、operation、expiry、redirect、confirmation 和 data egress policy。

Capability 不得持久化为普通 memory，不得由 Skill、网页、文件或模型输出创建；跨 execution 自动失效。高危动作必须换取新的 elevated capability，不能复用 read-only capability。

## B. Capability Caveat 与浏览器数据出口

Capability handle 采用可收窄 caveat：`profileId/userId/executionRunId/allowedOrigins/allowedActions/readOnly/expiresAt/maxNavigations/maxDataBytes/requiresConfirmationFor`。子流程只能增加限制，不能移除限制或扩权。

Browser Tool 在返回模型前执行字段分类、secret scan、可见文本裁剪、下载 quarantine、跨域数据发送检测和 target origin 记录。Credential、Session、Capability 分库存储和分进程权限；Memory Worker 无权解密 storage state。

---

# 附：多终端隔离决策（从 SPEC §14 迁入）

> **Appendix Status: DESIGN SOURCE** — 保留历史优先级判断；企业 tenant isolation 以正文与英文正典为准。
>
> 本附为 SPEC §14 Multi-Terminal Isolation Decision 原文迁入（英文规范原样保留），描述多终端隔离的当前优先级与演进决策。isolation 子责任的租户隔离要求见本模块正文第 7、10 节。

## A. Decision Summary

Full per-terminal isolation is not a near-term priority.

## B. Current Behavior

Current `ai use` launches Claude Code or Codex CLI with provider-specific environment variables in the child process. For Codex, the child also receives process-scoped `model_provider` overrides whose `env_key` is `OPENAI_API_KEY`; this pins authentication to the Runtime-selected provider even when the user's global Codex `auth.json` contains a different credential. The Runtime does not modify global Codex authentication or configuration. Different terminals can use different providers at the same time without sharing the active chat process configuration.

Shared management files still exist: `.ai-cache.json`, `.ai-gateway.log`, `usage.json`, global `lastSelection`.

## C. Current Decision

- Keep global `ai last` for now.
- Prefer project-level state next: `.ai-gateway/project.json` and `ai last --cwd`.
- Add session management before considering full per-terminal isolation.
- Treat full per-terminal isolation as low priority unless real conflicts appear.
