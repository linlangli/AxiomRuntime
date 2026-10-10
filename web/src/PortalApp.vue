<script setup lang="ts">
import { ArrowRight, Blocks, Check, ChevronRight, CircleHelp, Command, GitBranch, Layers3, LockKeyhole, Menu, Radio, ShieldCheck, Terminal, X } from 'lucide-vue-next'
import { ref } from 'vue'

const menuOpen = ref(false)
const copied = ref(false)
const install = 'npm install -g @offerpilot/axiomruntime'
const features = [
  { icon: GitBranch, title: '一个入口，多种模型', text: '集中管理 Provider 与模型，让 Claude Code、Codex 各自使用合适的服务。' },
  { icon: ShieldCheck, title: '故障自动降级', text: '请求失败时按优先级安全切换，已输出内容不会被自动重放。' },
  { icon: Radio, title: '真实用量可观测', text: '按 Provider 和模型记录实际 Token；没有价格的数据不会伪装成零成本。' },
  { icon: Blocks, title: '可演进的 Runtime', text: '从 Provider Gateway 出发，逐步承载执行、治理与可复用能力。' }
]
const steps = [
  { number: '01', title: '安装与初始化', code: 'ai setup', text: '添加 Provider，完成模型发现和最小真实验证。' },
  { number: '02', title: '启动原生工具', code: 'ai use codex', text: '为单次执行注入配置，保留熟悉的原生交互。' },
  { number: '03', title: '查看运行状态', code: 'ai web', text: '在本机打开控制面板，查看健康、用量与调用链路。' }
]
const commands = [
  { command: 'ai setup', description: '初始化 Runtime' },
  { command: 'ai provider list', description: '查看服务商' },
  { command: 'ai use claude', description: '启动 Claude Code' },
  { command: 'ai use codex', description: '启动 Codex' },
  { command: 'ai web', description: '打开本地控制面板' }
]
async function copyInstall() {
  await navigator.clipboard.writeText(install)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <div class="portal">
    <header class="site-header"><div class="container header-inner"><a class="logo" href="#top"><span class="logo-mark"><Layers3 :size="21" /></span><span>Axiom<span>Runtime</span></span></a><nav :class="{ open: menuOpen }"><a href="#capabilities" @click="menuOpen = false">能力</a><a href="#how-it-works" @click="menuOpen = false">工作方式</a><a href="#commands" @click="menuOpen = false">命令</a><a href="#status" @click="menuOpen = false">路线图</a></nav><a class="header-cta" href="#get-started">开始使用 <ArrowRight :size="15" /></a><button class="mobile-menu" aria-label="切换导航" @click="menuOpen = !menuOpen"><X v-if="menuOpen" :size="22" /><Menu v-else :size="22" /></button></div></header>
    <main id="top">
      <section class="hero container"><div class="hero-copy"><span class="eyebrow"><span class="pulse-dot"></span> CLI-FIRST AI RUNTIME</span><h1>让每一次 AI 交互，<br /><span>成为持续进化的能力。</span></h1><p>在 Claude Code、Codex 与多个模型服务之间建立可靠的运行层。统一配置、故障切换、真实用量——从一个命令开始。</p><div class="hero-actions"><a class="primary-cta" href="#get-started">快速开始 <ArrowRight :size="17" /></a><a class="secondary-cta" href="#how-it-works">了解工作方式 <ChevronRight :size="17" /></a></div><div class="hero-proof"><span><Check :size="15" /> 保留原生 CLI 体验</span><span><Check :size="15" /> 本机控制面板</span><span><Check :size="15" /> 可验证的调用记录</span></div></div><div class="hero-terminal"><div class="terminal-top"><div class="dots"><i></i><i></i><i></i></div><span>axiom-runtime — terminal</span><Terminal :size="15" /></div><div class="terminal-body"><p><span class="prompt">❯</span> ai use codex</p><p class="terminal-muted">◆ AxiomRuntime · Provider Gateway</p><p class="terminal-row"><span>Provider</span><strong>primary-gpt</strong><span class="terminal-ok">● healthy</span></p><p class="terminal-row"><span>Model</span><strong>gpt-5.5</strong></p><p class="terminal-row"><span>Fallback</span><strong>standby → backup</strong></p><div class="terminal-divider"></div><p class="terminal-muted">正在启动原生 Codex CLI…</p><p><span class="prompt">›</span> <span class="cursor"></span></p></div><div class="terminal-foot"><span class="pulse-dot"></span> 运行时就绪 <span>LOCAL EXECUTION</span></div></div></section>
      <section id="capabilities" class="section capabilities"><div class="container"><div class="section-heading"><span class="kicker">CAPABILITIES</span><h2>工具照旧使用，能力自然累积。</h2><p>Runtime 负责可靠的连接、执行与观测，让你专注于真正要完成的工作。</p></div><div class="feature-grid"><article v-for="feature in features" :key="feature.title" class="feature-card"><div class="feature-icon"><component :is="feature.icon" :size="22" /></div><h3>{{ feature.title }}</h3><p>{{ feature.text }}</p></article></div></div></section>
      <section id="how-it-works" class="section workflow"><div class="container"><div class="section-heading"><span class="kicker">HOW IT WORKS</span><h2>三步，让 Runtime 跑起来。</h2><p>配置一次，按需启动；控制面板只在本机开放。</p></div><div class="step-grid"><article v-for="step in steps" :key="step.number"><span class="step-number">{{ step.number }}</span><div class="step-line"></div><h3>{{ step.title }}</h3><code>{{ step.code }}</code><p>{{ step.text }}</p></article></div></div></section>
      <section id="get-started" class="section install-section"><div class="container install-layout"><div><span class="kicker">GET STARTED</span><h2>从终端开始，<br />几分钟完成接入。</h2><p>需要 Node.js 22.19.0 或更高版本。安装 npm 包后运行 <code>ai setup</code>，按引导添加你的第一个 Provider。</p><a href="https://gitlab.com/linlangli/agent-router" target="_blank" rel="noopener noreferrer">查看源代码 <ArrowRight :size="16" /></a></div><div class="install-card"><div class="install-label"><Command :size="17" /> 安装命令 <span>npm</span></div><button class="install-command" @click="copyInstall"><code>{{ install }}</code><span>{{ copied ? '已复制' : '复制' }}</span></button><div class="install-next"><span>接下来</span><code>ai setup</code><ArrowRight :size="16" /><code>ai web</code></div></div></div></section>
      <section id="commands" class="section commands-section"><div class="container"><div class="section-heading"><span class="kicker">CLI REFERENCE</span><h2>熟悉的命令，清晰的控制。</h2><p>从 Provider 配置到本机面板，常用操作都在一处。</p></div><div class="command-list"><div v-for="item in commands" :key="item.command"><code><span>❯</span> {{ item.command }}</code><span>{{ item.description }}</span></div></div></div></section>
      <section class="section telegram-section"><div class="container telegram-card"><div class="telegram-icon"><Radio :size="28" /></div><div><span class="kicker">BEYOND THE DESKTOP</span><h2>不在电脑前，也能继续工作。</h2><p>通过 Telegram Bot 远程启动 Claude Code 或 Codex，并查看进度、审批与结果。Bot 需由你自行配置和运行。</p></div><a href="https://gitlab.com/linlangli/agent-router" target="_blank" rel="noopener noreferrer">了解 Telegram 集成 <ArrowRight :size="16" /></a></div></section>
      <section id="status" class="section status-section"><div class="container"><div class="section-heading"><span class="kicker">BUILDING THE RUNTIME</span><h2>明确区分已交付与下一步。</h2><p>我们公开能力边界，不把路线图写成现有功能。</p></div><div class="status-grid"><article><span class="status-indicator shipped">● 已实现</span><h3>Provider Gateway</h3><p>Provider 管理、原生 CLI 接入、请求级降级与真实用量记录。</p></article><article><span class="status-indicator shipped">● 已实现</span><h3>本地控制面板</h3><p>通过 <code>ai web</code> 查看状态、用量、日志，并管理本机配置。</p></article><article><span class="status-indicator planned">◌ 规划中</span><h3>治理与学习</h3><p>组织级身份、策略控制、可验证学习与插件能力仍在规划中。</p></article></div></div></section>
      <section class="closing"><div class="container"><span class="kicker">YOUR RUNTIME STARTS HERE</span><h2>让运行时成为你的可靠底座。</h2><p>安装 AxiomRuntime，连接第一个 Provider，继续使用你喜欢的 AI 工具。</p><a class="primary-cta" href="#get-started">开始使用 <ArrowRight :size="17" /></a></div></section>
    </main>
    <footer><div class="container footer-inner"><a class="logo" href="#top"><span class="logo-mark"><Layers3 :size="18" /></span><span>Axiom<span>Runtime</span></span></a><p>Every interaction makes the Runtime more capable.</p><div><a href="https://gitlab.com/linlangli/agent-router" target="_blank" rel="noopener noreferrer">GitLab</a><a href="#commands">命令</a><a href="#top">返回顶部 ↑</a></div></div></footer>
  </div>
</template>
