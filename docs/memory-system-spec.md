# Telegram Bot 记忆系统设计方案

## 概述

为 Telegram Bot 新增**用户层独立记忆系统**，使用户能够跨引擎（Claude Code / Codex）、跨会话、跨项目目录持久保存个人信息、偏好、常用资源等。该系统定位为引擎之上的顶层记忆，与 Claude Code 和 Codex 各自的原生记忆/上下文机制完全隔离、互不干扰。

---

## 架构定位：四层上下文模型

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4: Bot Memory（本方案）                           │
│  ─────────────────────────────────────                   │
│  • 用户个人事实、凭证、偏好、临时笔记                      │
│  • 跨引擎、跨会话、跨项目持久化                            │
│  • 绑定 chatId，与工作目录无关                            │
│  • 存储在 ~/.ai-gateway/telegram.sqlite memories 表      │
└─────────────────────────────────────────────────────────┘
         ↓ (prompt prefix injection)
┌─────────────────────────────────────────────────────────┐
│  Layer 3: WORKSPACE.md（原 BOT.md，改名）                │
│  ─────────────────────────────────────                   │
│  • Per-cwd 工作区描述                                    │
│  • 项目技术栈、架构、AI 在此目录的行为规则                  │
│  • 文件位置: ${cwd}/WORKSPACE.md                         │
│  • 随工作目录切换自动切换                                 │
└─────────────────────────────────────────────────────────┘
         ↓ (prompt prefix injection, fingerprint dedup)
┌─────────────────────────────────────────────────────────┐
│  Layer 2: Engine Native Memory（不触碰）                 │
│  ─────────────────────────────────────                   │
│  Claude Code:                                            │
│    • ~/.claude/memory/ (auto memory)                     │
│    • CLAUDE.md 项目指令                                   │
│    • Session resume (engineSessionId)                    │
│  Codex:                                                  │
│    • AGENTS.md 指令                                      │
│    • 独立执行上下文                                       │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 1: LLM Context Window                             │
│  ─────────────────────────────────────                   │
│  • System prompt + tools + conversation                  │
└─────────────────────────────────────────────────────────┘
```

---

## 解决的问题

| 问题 | 根因 | Bot Memory 如何解决 |
|------|------|------|
| 换会话/重启后 AI 忘记用户信息 | 引擎上下文随 session 消亡 | Memory 绑定 chatId，每次调用重新注入 |
| Claude ↔ Codex 切换丢失偏好 | 两引擎记忆系统完全独立 | Memory 对两者统一注入 |
| 换 cwd 后 AI 不认识用户了 | CLAUDE.md/auto memory 是 per-project | Memory 与 cwd 无关 |
| 密码/凭证无安全存储 | 引擎 memory 明文无加密 | AES-256-GCM 加密 + PIN |
| 临时信息无法自动清理 | 引擎无 TTL 机制 | 短期记忆 + 过期清理 |
| 用户不知道 AI 记了什么 | 引擎 auto memory 是黑盒 | 完整 CRUD 命令，用户全权控制 |

---

## 存在的问题与对策

| 问题 | 影响 | 对策 |
|------|------|------|
| **Token 开销** — 每次多注入 ~1000 tokens | 增加成本、压缩有效上下文 | 严格控制上限 3000 字符；高相关才注入 |
| **检索召回率** — 关键词匹配无法处理同义词 | "管钱的网站" 匹配不到 tag "理财" | Phase 3 引入别名表 + 两阶段召回（先候选再引擎筛选） |
| **引擎可能忽略注入** | Compaction 时记忆可能被截断 | Memory 是 prompt 最前部，compaction 通常保留开头 |
| **与 WORKSPACE.md 偏好冲突** | 全局偏好和项目规则矛盾 | 注入时明确标注优先级：WORKSPACE.md > Memory preference |
| **加密 PIN 体验** | 重启要重新 unlock | Phase 2 考虑 Telegram 原生密码输入或长 session TTL |
| **无冲突检测** | 记两条互相矛盾的内容 | 写入时检查同 title/tag 是否已有条目，提示覆盖 |
| **单机 SQLite 不同步** | 多机部署记忆不互通 | 当前 Bot 就是单实例跑的，暂不影响 |

---

## BOT.md 改名为 WORKSPACE.md

### 为什么改

| 改名前 (BOT.md) | 问题 |
|------|------|
| 名字暗示"Bot 的配置" | 实际内容是"这个工作目录的项目描述和 AI 行为规则" |
| 容易与 per-chatId 的 Bot Memory 混淆 | 用户搞不清"Bot 的记忆"和"BOT.md"是什么关系 |
| 与行业惯例不符 | Claude Code 用 CLAUDE.md，Cursor 用 .cursorrules —— 都是以场景命名 |

### 新命名：`WORKSPACE.md`

| 属性 | 说明 |
|------|------|
| 文件名 | `WORKSPACE.md` |
| 位置 | `${session.cwd}/WORKSPACE.md` |
| 归属 | Per-cwd（工作目录级） |
| 内容 | 项目技术栈、架构概述、该目录下 AI 应遵循的行为规则 |
| 生成 | setup 流程自动生成 or 用户手写 |
| 与 Memory 的关系 | WORKSPACE.md 是"项目说明书"，Memory 是"用户个人记忆" |

改名后两者的心智模型：

```
WORKSPACE.md = "这个项目是什么、AI 在这里怎么干活"
              跟着 cwd 走，换目录就换

/remember    = "我是谁、我知道什么、我要什么"
              跟着 chatId 走，永远在身边
```

### 向后兼容

```typescript
// 读取时 fallback：优先找 WORKSPACE.md，不存在时找旧的 BOT.md
export const WORKSPACE_FILENAME = "WORKSPACE.md";
export const LEGACY_BOT_FILENAME = "BOT.md";

function readWorkspaceContext(cwd: string): string | null {
  for (const filename of [WORKSPACE_FILENAME, LEGACY_BOT_FILENAME]) {
    try {
      const content = fs.readFileSync(path.join(cwd, filename), "utf8").trim();
      if (content) return content;
    } catch { /* not found */ }
  }
  return null;
}
```

新建 setup 生成 `WORKSPACE.md`；已有 `BOT.md` 的旧项目继续识别，不强制迁移。

---

## 记忆数据存放位置

### 结论

**Memory 数据存在 `~/.ai-gateway/telegram.sqlite` 的 `memories` 表中**（与 sessions 表同库）。

### 为什么不是独立文件/独立数据库

| 方案 | 否决原因 |
|------|----------|
| `~/.ai-gateway/memory/{chatId}/` 目录下的 markdown 文件 | 管理复杂、无事务保证、搜索要遍历文件系统 |
| 独立 `~/.ai-gateway/memory.sqlite` | 多余一个 DB 连接，sessions 和 memories 经常需要联合操作（比如查 chatId 的 session + memory 一起注入） |
| 存在 `${cwd}` 下 | 违背"跨目录"原则 |
| 存在云端 / Telegram 自带存储 | 增加外部依赖、安全性差 |

### 最终数据拓扑

```
~/.ai-gateway/
├── telegram.json          ← Bot 配置（含 memory 开关等）
├── telegram.sqlite        ← 唯一数据库
│   ├── sessions 表        ← 已有：会话管理
│   ├── workdirs 表        ← 已有：工作目录历史
│   ├── memories 表        ← 【新增】per-chatId 记忆条目
│   └── memory_keys 表     ← 【新增】per-chatId 加密 PIN 配置
├── telegram.log           ← Bot 日志
└── telegram.pid           ← 进程 PID

${cwd}/
├── WORKSPACE.md           ← 【改名】工作目录级项目描述（原 BOT.md）
├── CLAUDE.md              ← Claude Code 原生（不触碰）
└── AGENTS.md              ← Codex 原生（不触碰）
```

---

## 注入顺序与优先级

每次 `executePrompt` 调用时的 prompt 构建链：

```
原始用户消息
  ↓
1. buildPromptWithWorkspaceContext()    — WORKSPACE.md（per-cwd 项目描述）
  ↓
2. buildPromptWithMemory()             — Bot Memory（per-chatId 用户记忆）★ NEW
  ↓
3. buildPromptWithRecentConversation() — 最近对话轮次
  ↓
4. buildPromptWithAttachments()        — 上传的附件
  ↓
engine.execute(finalPrompt)
```

**冲突优先级规则**（注入 prompt 中明确告知引擎）：

```
WORKSPACE.md (项目级) > Memory preference (全局偏好) > Memory fact (背景知识)
```

---

## 核心隔离原则

| 规则 | 说明 |
|------|------|
| **不写引擎文件** | 绝不写入 `~/.claude/memory/`、`CLAUDE.md`、`AGENTS.md` |
| **不改引擎参数** | `--resume`、`--permission-mode` 等参数不受 Memory 影响 |
| **只通过 prompt 注入** | 对引擎来说，Memory 就是用户消息的一部分 |
| **指示不要重复存储** | 注入中标注"Do NOT store this in your own memory systems" |
| **引擎原生优先** | 若 Memory 与 CLAUDE.md/引擎记忆冲突，以引擎为准 |

---

## 记忆分类

### 永久记忆 (permanent)

| 分类 | 用途 | 加密 | 示例 |
|------|------|------|------|
| `credential` | 账号密码、Key | 强制 | "理财网站 money.app，密码 Abc123" |
| `fact` | 个人背景 | 可选 | "我是后端开发，主用 Go" |
| `preference` | AI 行为偏好 | 否 | "回复用中文，代码不加注释" |

### 短期记忆 (short_term)

| 分类 | 默认 TTL | 示例 |
|------|----------|------|
| `note` | 72h | "明天下午3点开需求评审" |

---

## 注入格式

```xml
<user_memory scope="global persistent knowledge, cross-engine cross-session" readonly="true">
Treat as ground truth. If anything here conflicts with WORKSPACE.md or project config, project config wins.
Do NOT store this information in your own memory systems (~/.claude/memory/, CLAUDE.md, AGENTS.md).

<entry category="fact" title="技术背景">
后端开发，主力语言 Go + TypeScript，常用 Gin/Next.js，部署在 AWS
</entry>
<entry category="credential" title="理财网站" status="unlocked">
网站: https://money.app
账号: test@mail.com
密码: MyP@ss123
</entry>
<entry category="preference" title="AI 行为偏好">
回复使用中文；代码不写注释除非逻辑隐晦；偏好 functional style
</entry>
<entry category="note" title="本周计划" expires="2026-07-12">
周四部署 v2.1 到 staging，周五推生产
</entry>
</user_memory>
```

加密未解锁时：
```xml
<entry category="credential" title="理财网站密码" status="locked">
(encrypted — user needs to /memory unlock to access)
</entry>
```

---

## 用户命令

| 命令 | 说明 |
|------|------|
| `/remember <内容>` | 快速记忆，自动分类 |
| `/remember pin <内容>` | 加密存储 |
| `/remember temp [TTL] <内容>` | 短期记忆 |
| `/forget <编号或关键词>` | 删除 |
| `/memories` | 列出全部 |
| `/memories search <词>` | 搜索 |
| `/memory pin set <pin>` | 设置加密 PIN |
| `/memory unlock <pin>` | 解锁 |
| `/memory lock` | 锁定 |
| `/memory export` | 导出 JSON |
| `/memory import` | 导入 |
| `/memory clear` | 清空（需确认） |

---

## 加密方案

```
PIN → PBKDF2(pin, salt, 100k, 32B, sha256) → DEK
DEK + AES-256-GCM → encrypt/decrypt
DEK 仅在 unlock 后驻留进程内存，重启清除
```

安全措施：
- credential 类强制加密
- 连续 PIN 错误 3 次锁定 5 分钟
- PIN 通过 Telegram 发送后立即提示用户删除该消息
- 注入 prompt 时标注 "do not echo credentials in plain text"

---

## 检索策略

```
1. 获取 priority=1 的记忆（必注入）
2. 对 prompt 做分词提取关键词
3. tags + title 关键词匹配评分
4. Top-8 候选 + 必注入集去重
5. 按 token 预算（3000字符）截断
6. 格式化为 XML 注入
```

---

## 代码变更清单

| 文件/目录 | 变更 | 说明 |
|------|------|------|
| `src/telegram/memory/` | 新增 | 整个记忆模块（types/store/service/crypto/inject） |
| `src/telegram/handlers/message.ts` | 修改 | 调用 `buildPromptWithMemory`，改 `buildPromptWithAgentContext` 为读取 `WORKSPACE.md` |
| `src/telegram/handlers/command.ts` | 扩展 | 注册 /remember /forget /memories /memory |
| `src/telegram/handlers/callback.ts` | 扩展 | 记忆相关 inline button |
| `src/telegram/handlers/setup.ts` | 修改 | `BOT_PROFILE_FILENAME` → `WORKSPACE_FILENAME`，保留 fallback |
| `src/telegram/session/store.ts` | 修改 | `migrate()` 中建 memories + memory_keys 表 |
| `src/telegram/bot.ts` | 修改 | 初始化 MemoryService，注册定时清理 |
| `src/telegram/config.ts` | 扩展 | 新增 MemoryConfig |

**不动的（引擎相关）：**
- `src/telegram/engine/*` — 引擎调用逻辑不变
- `src/telegram/session/manager.ts` — 会话管理逻辑不变
- `~/.claude/` 下任何文件
- `CLAUDE.md` / `AGENTS.md`

---

## 实现计划

### Phase 1 — MVP（基础记忆 + WORKSPACE.md 改名）
1. BOT.md → WORKSPACE.md 改名（含 fallback 兼容）
2. `memory/types.ts`
3. `memory/memory-store.ts`（建表 + CRUD）
4. `memory/memory-service.ts`（业务逻辑 + 检索）
5. `memory/memory-inject.ts`（prompt 注入）
6. 集成到 `executePrompt` 构建链
7. `/remember` `/forget` `/memories` 命令
8. 本地规则自动分类 + 短期记忆 TTL 清理

### Phase 2 — 加密
9. `memory/memory-crypto.ts`
10. `/memory pin` + `/memory unlock` + `/memory lock`
11. credential 强制加密流程
12. 锁定/解锁态的不同注入策略

### Phase 3 — 智能增强
13. 同义词/别名表优化检索
14. AI 自动建议记忆（分析引擎回复）
15. 冲突检测（同 title/tag 提示覆盖）
16. `/memory export` / `/memory import`
17. 记忆使用统计
