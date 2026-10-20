<script setup lang="ts">
import { ArrowRight, Check, Copy, GitBranch, Layers3, Menu, Orbit, ShieldCheck, Terminal, Wallet, X } from 'lucide-vue-next'
import { ref } from 'vue'
import { version } from '../../package.json'

const source = 'https://github.com/linlangli/AxiomRuntime'
const manual = `${source}/-/blob/develop/docs/usage.md`
const install = 'npm install --global @offerpilot/axiomruntime'
const menuOpen = ref(false)
const copyMessage = ref('')
const navigation = [['功能', 'features'], ['工作原理', 'how-it-works'], ['安装', 'install'], ['使用', 'usage'], ['Telegram', 'telegram'], ['路线图', 'status']]
const providers = [['main', 'claude-opus-4-6', 'L1', 'healthy'], ['backup', 'claude-sonnet-4-6', 'L2', 'healthy'], ['fenno', 'gpt-5.5', 'L3', 'healthy'], ['archive', 'gpt-4.1', 'L0', 'manual']]
const features = [
  { icon: ShieldCheck, color: 'green', title: '独立于原生配置', text: 'Claude Code 使用临时 settings；Codex 通过 -c 与环境变量注入。不覆盖原生 auth.json，直接运行原生命令仍使用自己的配置。', code: 'ai use codex fenno' },
  { icon: GitBranch, color: 'amber', title: '请求级自动 fallback', text: '按健康度、模型兼容与 level 构建候选链。请求未产生输出时安全降级；已经产生输出，不静默重放。', code: 'main → backup → fenno' },
  { icon: Wallet, color: 'blue', title: '看见真实成本', text: '优先记录上游真实 cost_usd，其次按模型价格估算。缺少价格明确标为 unknown，不伪装成零成本，也不回填历史账单。', code: 'ai report' }
]
const flow = [['你发起一条命令', 'ai use claude backup'], ['Runtime 建立候选链', '健康度 · 模型兼容 · level'], ['组装进程级注入', '临时 settings + 环境变量'], ['启动原生 CLI', 'claude / codex 正常运行'], ['记录真实用量', 'token · 成本 · 会话']]
const installation = [
  { title: '准备 Node.js 22.19+', text: 'Node.js 20 不受支持。先确认本机运行环境。', commands: ['node --version'] },
  { title: '全局安装 AxiomRuntime', text: '安装 CLI；门户网站不会包含在 npm 包中。', commands: [install, 'ai --version'] },
  { title: '完成交互式初始化', text: '添加 Provider，发现模型并完成最小真实验证。', commands: ['ai setup'] },
  { title: '验证运行状态', text: '检查配置、Provider 健康与本机依赖，然后开始使用。', commands: ['ai status', 'ai doctor'] }
]
const commandGroups = [
  { title: 'Provider 与诊断', icon: Layers3, commands: ['ai add', 'ai provider add <name> <url> <key>', 'ai provider list', 'ai provider edit <name>', 'ai provider delete <name>', 'ai models', 'ai check', 'ai status', 'ai doctor'], note: '集中维护 Provider、模型与健康状态。level 0 仅供显式选择，不参与自动候选链。' },
  { title: '启动与会话', icon: Terminal, commands: ['ai use claude backup', 'ai use codex fenno', 'ai last', 'ai session list', 'ai session resume <id>', 'ai report', 'ai log --print 100', 'ai web'], note: 'ai web 打开本机控制面板。session resume 复用启动参数，不恢复原生 CLI 的聊天上下文。' },
  { title: '图片生成', icon: Orbit, commands: ['ai image', 'ai image <provider> <prompt>', 'ai image <provider> <model> <prompt>'], note: '通过 Images API 生成图片。Base64 结果保存为权限 0600 的文件；URL 结果直接显示，不自动下载。请求超时为 120 秒。' },
  { title: '出站代理', icon: GitBranch, commands: ['ai proxy', 'ai proxy openrouter 127.0.0.1 7890', 'ai proxy openrouter --disable', 'ai proxy 127.0.0.1 8081'], note: 'Provider 代理优先，Runtime 代理作为默认值。连接检查不消耗 Token，支持 NO_PROXY。' }
]
const statuses = [
  ['Provider 管理与模型发现', 'shipped', '添加、探测、编辑、删除与 level 优先级'],
  ['原生 CLI 与请求级 fallback', 'shipped', 'Claude Code / Codex CLI；已输出不静默重放'],
  ['多窗口独立注入', 'shipped', 'ai use 不持久覆盖原生配置'],
  ['用量、成本与会话报告', 'shipped', '真实成本优先；估算与 unknown 明确区分'],
  ['Telegram 与图片生成', 'shipped', '远程调用、权限审批、Images API'],
  ['Codex App 持久配置', 'shipped', 'ai set codex；历史聊天不迁移'],
  ['HTTP API', 'shipped', '共享 Runtime 核心执行契约'],
  ['本机 Web 控制面板', 'partial', 'ai web 已可用；企业治理与完整实时 trace 尚未完成'],
  ['Telegram 显式记忆', 'partial', '显式记忆能力；自动学习仍受治理边界约束'],
  ['自动记忆、向量检索与终端能力', 'planned', '尚未作为完整能力交付'],
  ['凭证加密与 Skills / 插件体系', 'planned', '不将规划能力标记为现有功能']
]
const statusLabels: Record<string, string> = { shipped: '已实现', partial: '部分实现', planned: '规划中' }
async function copyInstall() {
  try { await navigator.clipboard.writeText(install); copyMessage.value = '安装命令已复制' }
  catch { copyMessage.value = '无法自动复制，请选择下方安装命令手动复制' }
}
</script>

<template>
  <div class="portal">
    <header class="site-header"><div class="container header-inner">
      <a class="logo" href="#top" aria-label="AxiomRuntime 首页"><Orbit :size="25" /><span>AxiomRuntime</span></a>
      <nav id="main-navigation" :class="{ open: menuOpen }" aria-label="主导航"><a v-for="[label, id] in navigation" :key="id" :href="`#${id}`" @click="menuOpen = false">{{ label }}</a></nav>
      <div class="header-actions"><a class="button secondary source-link" :href="source" target="_blank" rel="noopener noreferrer">GitLab <ArrowRight :size="14" /></a><a class="button primary" href="#install">快速开始</a></div>
      <button class="mobile-menu" :aria-expanded="menuOpen" aria-controls="main-navigation" aria-label="切换导航" @click="menuOpen = !menuOpen"><X v-if="menuOpen" /><Menu v-else /></button>
    </div></header>
    <main id="top">
      <section class="hero container">
        <span class="badge"><i></i> v{{ version }} · 需要 Node.js 22.19+</span>
        <h1>一条命令，接管你的<br /><span>全部 AI Provider</span></h1>
        <p>AxiomRuntime 是以 CLI 为核心的本地 AI Runtime 基础层。把官方 API、中转站和兼容服务集中管理，再以每次进程独立注入的方式启动原生 Claude Code 与 Codex CLI —— 多窗口并行、互不覆盖，日常使用不接管你的原生配置。</p>
        <div class="actions"><a class="button primary" href="#install">立即安装 <ArrowRight :size="17" /></a><a class="button secondary" :href="manual" target="_blank" rel="noopener noreferrer">阅读文档</a></div>
        <div class="copy-command"><span class="prompt">$</span><code>{{ install }}</code><button aria-label="复制安装命令" @click="copyInstall"><Copy :size="17" /></button></div><span class="copy-feedback" role="status">{{ copyMessage }}</span>
      </section>
      <section class="showcase container" aria-label="Runtime 运行示例">
        <div class="terminal-shell"><div class="terminal-top"><div class="dots"><i></i><i></i><i></i></div><div class="tabs"><span class="active">claude · main</span><span>claude · backup</span><span>codex · fenno</span></div><span class="terminal-path">~/.ai-gateway · 示例</span></div>
          <div class="terminal-panes">
            <article><h3>多窗口并行</h3><code><span class="prompt">$</span> ai use claude backup</code><p class="muted">→ 路由与凭证只注入本次进程</p><div class="window-row"><span>窗口 A</span><b>claude · main</b><small>opus-4-6</small></div><div class="window-row"><span>窗口 B</span><b>claude · backup</b><small>sonnet-4-6</small></div><div class="window-row"><span>窗口 C</span><b>codex · fenno</b><small>gpt-5.5</small></div><p class="green">✓ 三个窗口并行，互不覆盖</p></article>
            <article><h3>请求级自动降级</h3><code><span class="prompt">$</span> ai use claude main</code><p class="red">! main 502 · 请求未产生输出</p><p>→ 同一会话内切换到 backup</p><p>→ 模型改写 opus-4-6 → sonnet-4-6</p><p class="muted">已产生输出则不静默重放</p><p class="green">✓ 请求继续，无需重启 CLI</p></article>
            <article><h3>真实用量与成本</h3><code><span class="prompt">$</span> ai report</code><dl class="usage-values"><div><dt>输入 Token</dt><dd>1,284,900</dd></div><div><dt>输出 Token</dt><dd>318,420</dd></div><div><dt>真实成本</dt><dd class="green">$18.64</dd></div><div><dt>估算成本</dt><dd>$2.07</dd></div><div><dt>会话数</dt><dd>47</dd></div></dl></article>
          </div><div class="terminal-foot"><span><ShieldCheck :size="14" /> ai use 原生配置零改动</span><span>● 3 个窗口并行</span><span>● runtime fallback 已启用</span><span>v{{ version }}</span></div>
        </div>
      </section>
      <section class="stats container" aria-label="运行特性"><article><strong>∞</strong><h3>并行窗口数</h3><p>只受本机资源与上游额度限制</p></article><article><strong>0</strong><h3>原生配置改动</h3><p>ai use 仅注入本次进程</p></article><article><strong>5</strong><h3>已接入接入面</h3><p>CLI · Telegram · HTTP · Images · Proxy</p></article><article><strong>22.19+</strong><h3>Node.js 要求</h3><p>Node.js 20 不受支持</p></article></section>
      <section id="features" class="section container"><div class="section-heading"><span class="kicker">核心能力</span><h2>Runtime 是产品，<br />Provider 只是可替换的能力。</h2><p>CLI、Telegram、HTTP 都是调用同一套核心契约的接入面。连接、执行与观测留在 Runtime，工具保持原生体验。</p></div>
        <div class="bento-top"><article class="card provider-card"><span class="icon blue"><Layers3 /></span><h3>Provider 管理，从手改配置变成一条命令。</h3><p>添加、探测、发现模型，按 level 组织候选链。level 0 保留为显式选择，不参与自动降级。</p><div class="table-scroll"><table class="provider-table"><thead><tr><th>PROVIDER</th><th>MODEL</th><th>LEVEL</th><th>STATE</th></tr></thead><tbody><tr v-for="row in providers" :key="row[0]"><td>{{ row[0] }}</td><td>{{ row[1] }}</td><td><span class="level">{{ row[2] }}</span></td><td :class="row[3] === 'healthy' ? 'green' : 'amber'">● {{ row[3] }}</td></tr></tbody></table></div></article>
        <article class="card windows-card"><span class="icon purple"><Layers3 /></span><h3>多开窗口，互不覆盖。</h3><p>每个子进程拥有自己的路由与凭证。同一台机器，不同窗口各用各的 Provider。</p><div v-for="(command, i) in ['ai use claude main', 'ai use claude backup', 'ai use codex fenno']" :key="command" class="mini-window"><span><i></i> WINDOW {{ i + 1 }}</span><code><b>$</b> {{ command }}</code></div></article></div>
        <div class="bento-bottom"><article v-for="feature in features" :key="feature.title" class="card"><span class="icon" :class="feature.color"><component :is="feature.icon" /></span><h3>{{ feature.title }}</h3><p>{{ feature.text }}</p><code class="card-code">{{ feature.code }}</code></article></div>
      </section>
      <section id="how-it-works" class="section alternate"><div class="container"><div class="section-heading centered"><span class="kicker">工作原理</span><h2>每次执行，都是一次独立注入。</h2><p>不做代理工具的替身，只做原生工具背后可靠的 Runtime。</p></div><div class="flow"><article v-for="([title, detail], i) in flow" :key="title"><span class="step-number">0{{ i + 1 }}</span><h3>{{ title }}</h3><p>{{ detail }}</p><ArrowRight v-if="i < flow.length - 1" class="flow-arrow" :size="18" /></article></div><div class="notice green"><ShieldCheck :size="19" /><p>临时注入文件在进程结束后清理。<strong>唯一例外：</strong><code>ai set codex</code> 是用户显式触发的持久配置操作。</p></div></div></section>
      <section id="install" class="section container"><div class="section-heading"><span class="kicker">安装与初始化</span><h2>四步完成安装。</h2><p>原生 Claude Code / Codex CLI 是外部依赖；可以按需安装，不随 Runtime 捆绑。</p></div><div class="install-layout"><div class="install-steps"><article v-for="(step, i) in installation" :key="step.title" class="card install-step"><span class="step-number">0{{ i + 1 }}</span><div><h3>{{ step.title }}</h3><p>{{ step.text }}</p><div class="code-block"><code v-for="command in step.commands" :key="command"><span class="prompt">$</span> {{ command }}</code></div></div></article></div><aside class="install-aside"><article class="card"><h3>无人值守安装</h3><p>自动化环境中，显式选择依赖安装行为。</p><div class="code-block"><code>ai setup --yes --skip-tools</code><code>ai setup --yes --install-tools</code><code>ai setup --skip-provider</code></div></article><article class="card"><h3>配置目录</h3><code class="directory">~/.ai-gateway/</code><p>可用 AI_GATEWAY_HOME 覆盖默认位置。</p><dl class="file-list"><div v-for="[name, label] in [['providers.json', 'Provider 配置'], ['runtime.json', 'Runtime 运行配置'], ['.ai-cache.json', '模型缓存与健康'], ['usage.json', '用量账本'], ['sessions.json', 'CLI 会话'], ['memory.sqlite', 'Telegram 记忆'], ['telegram/bots/', '多 Bot 配置与日志']]" :key="name"><dt>{{ name }}</dt><dd>{{ label }}</dd></div></dl></article><div class="notice amber"><ShieldCheck :size="19" /><p>API Key 当前以明文保存在配置文件中。限制文件权限，不要提交到版本库；凭证加密仍在规划中。</p></div></aside></div></section>
      <section id="usage" class="section alternate"><div class="container"><div class="section-heading"><span class="kicker">使用参考</span><h2>命令手册。</h2><p>从 Provider 管理到原生工具启动，把常用操作放在一起。</p></div><div class="command-grid"><article v-for="group in commandGroups" :key="group.title" class="card"><h3><component :is="group.icon" :size="20" />{{ group.title }}</h3><div class="code-block"><code v-for="command in group.commands" :key="command"><span class="prompt">$</span> {{ command }}</code></div><p>{{ group.note }}</p></article></div><article class="card codex-card"><div><span class="kicker">CODEX APP</span><h3>一键切换 Codex App 的 Provider。</h3><div class="code-block"><code>ai set codex provider &lt;provider&gt; &lt;model&gt;</code><code>ai set codex provider &lt;provider&gt;</code><code>ai set codex chatgpt</code><code>ai set codex proxy 127.0.0.1:7890</code><code>ai set codex proxy off</code></div></div><div class="codex-notes"><h3>显式持久配置，与 ai use 不同。</h3><p>Codex App 与 CLI 在同一 CODEX_HOME 下共享 config.toml。切换操作备份并原子更新配置与凭证，失败自动回滚。</p><p>切换 Provider 会替换 ChatGPT 登录凭证。macOS 上会重启 App，清理继承的旧环境变量。</p><div class="notice amber"><p>旧聊天的历史 session 不会迁移，可能仍使用旧 Provider 并报 403。切换后请新建聊天。</p></div></div></article></div></section>
      <section id="telegram" class="section container telegram-layout"><div><div class="section-heading"><span class="kicker">TELEGRAM</span><h2>在手机上，<br />驱动本机的 Claude Code。</h2><p>不在电脑前，也能把任务交给 Runtime。同一套 Provider、同一份用量账本，执行仍发生在你的机器上。</p></div><ul class="check-list"><li v-for="text in ['授权用户才能调用，高风险操作需要审批', '多 Bot 配置、日志与工作目录隔离', '编辑同一条进度消息，减少通知噪声', '支持附件与上下文传递', '/provider 切换服务商，沿用 Runtime 路由']" :key="text"><Check :size="17" />{{ text }}</li></ul><div class="onboarding"><div v-for="(command, i) in ['ai telegram add ops', 'ai telegram config set token <bot-token> --bot ops', 'ai telegram config set allowedUserIds <telegram-user-id> --bot ops', 'ai telegram config set proxyUrl http://127.0.0.1:7890 --bot ops', 'ai telegram start --bot ops']" :key="command"><span>0{{ i + 1 }}</span><code>{{ command }}</code></div></div><p class="small muted">无法直连 Telegram 时先配置代理。Token 会经 getMe 验证，验证失败不覆盖原配置。</p></div><div class="phone"><div class="phone-notch"></div><div class="phone-header"><span class="bot-avatar"><Orbit /></span><div><strong>AxiomRuntime Bot</strong><small>● 在线 · 对话示例</small></div></div><div class="chat-body"><span class="chat-date">今天</span><div class="chat-bubble user">帮我检查 Runtime 的核心测试，修复失败用例。</div><div class="chat-bubble bot"><strong>正在执行 · 3 / 5</strong><p>检查测试与依赖关系</p><div class="progress"><i></i></div><code>test/core.test.ts</code><small>进度在同一条消息中更新</small></div><div class="chat-bubble bot"><span class="green">✓ 任务完成</span><p>测试已通过，修改可供审阅。</p><div class="chat-result"><span>47s 耗时</span><span>12 passed</span></div></div></div><div class="phone-input">发送消息… <ArrowRight :size="17" /></div></div></section>
      <section id="status" class="section alternate"><div class="container"><div class="section-heading"><span class="kicker">实现状态与路线图</span><h2>诚实区分「已经能用」<br />和「只是规划」。</h2><p>不把架构目标当成现有功能。当前交付的是本地 Runtime 基础能力，不代表企业控制面已经完成。</p></div><div class="status-legend"><span v-for="(label, key) in statusLabels" :key="key" :class="key">● {{ label }}</span></div><div class="table-scroll status-table-wrap"><table class="status-table"><thead><tr><th>能力</th><th>状态</th><th>当前边界</th></tr></thead><tbody><tr v-for="[name, status, detail] in statuses" :key="name"><td>{{ name }}</td><td><span class="status-pill" :class="status">● {{ statusLabels[status] }}</span></td><td>{{ detail }}</td></tr></tbody></table></div></div></section>
      <section class="closing container"><span class="kicker">开始使用</span><h2>现在就把 Provider<br />交给 Runtime。</h2><p>继续使用熟悉的工具，让 Runtime 负责可靠的连接、执行与观测。</p><div class="actions"><a class="button primary" href="#install">安装 AxiomRuntime <ArrowRight :size="17" /></a><a class="button secondary" :href="source" target="_blank" rel="noopener noreferrer">查看源码</a></div><small>需要 Node.js 22.19+ · 本机运行 · 原生 CLI 体验</small></section>
    </main>
    <footer><div class="container"><div class="footer-grid"><div><a class="logo" href="#top"><Orbit :size="25" />AxiomRuntime</a><p>以 CLI 为核心的本地 AI Runtime 基础层。<br />每一次交互，都让 Runtime 更可靠、更可复用。</p></div><div><h3>文档</h3><a :href="manual">使用手册</a><a :href="`${source}/-/blob/develop/docs/architecture.md`">架构说明</a><a :href="`${source}/-/blob/develop/docs/prd.md`">产品路线图</a></div><div><h3>能力</h3><a href="#features">Provider 管理</a><a href="#telegram">Telegram</a><a href="#usage">本机控制面板</a></div><div><h3>项目</h3><a :href="source">GitLab 源代码</a><a href="https://www.npmjs.com/package/@offerpilot/axiomruntime">npm 包</a><a href="#status">实现状态</a></div></div><div class="footer-bottom"><span>© {{ new Date().getFullYear() }} AxiomRuntime</span><code>@offerpilot/axiomruntime · v{{ version }}</code><a href="#top">返回顶部 ↑</a></div></div></footer>
  </div>
</template>
