<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import OverviewChart from './OverviewChart.vue'
import { Activity, ArrowDownRight, BarChart3, BookOpen, CheckCircle2, ChevronRight, CircleHelp, Command, Copy, ExternalLink, Globe2, Layers3, LayoutDashboard, RefreshCw, Search, ServerCog, Settings2, ShieldCheck, TerminalSquare, TriangleAlert, X } from 'lucide-vue-next'
import { api, type Dashboard, type LogItem, type ProviderStatus } from './console-api'

type Page = 'overview' | 'providers' | 'usage' | 'commands' | 'config' | 'help'
const page = ref<Page>('overview')
const data = ref<Dashboard | null>(null)
const loading = ref(true)
const error = ref('')
const busy = ref(false)
const notice = ref('')
const search = ref('')
const selectedProvider = ref<ProviderStatus | null>(null)
const selectedTrace = ref<string | null>(null)
const selectedDay = ref<string | null>(null)
const codexMode = ref<'provider' | 'chatgpt' | 'proxy'>('provider')
const codexProvider = ref('')
const codexModel = ref('')
const codexProxy = ref('')
const editProvider = ref<ProviderStatus | null>(null)
const showProviderForm = ref(false)
const providerForm = ref({ name: '', baseUrl: '', apiKey: '', model: '', mode: 'auto', level: 0 })
let refreshTimer: ReturnType<typeof setInterval> | null = null

const navigation = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'providers', label: '服务商', icon: ServerCog },
  { id: 'usage', label: '使用与日志', icon: BarChart3 },
  { id: 'commands', label: '命令中心', icon: Command },
  { id: 'config', label: 'CLI 配置', icon: Settings2 },
  { id: 'help', label: '帮助中心', icon: BookOpen }
] as const
const pageTitle: Record<Page, string> = { overview: '运行时总览', providers: '服务商管理', usage: '使用与日志', commands: '命令中心', config: 'CLI 与 Codex App', help: '帮助中心' }
const filteredProviders = computed(() => data.value?.providers.filter(provider => `${provider.name} ${provider.baseUrl} ${provider.model}`.toLowerCase().includes(search.value.toLowerCase())) ?? [])
const healthyCount = computed(() => data.value?.providers.filter(provider => provider.health === 'ok').length ?? 0)
const maxProviderLevel = computed(() => (data.value?.providers.filter(provider => provider.level > 0).length ?? 0) + (editProvider.value?.level ? 0 : 1))
const traces = computed(() => {
  const groups = new Map<string, LogItem[]>()
  for (const log of data.value?.logs ?? []) {
    const key = log.traceId ?? `single-${log.timestamp}-${log.action}`
    groups.set(key, [...(groups.get(key) ?? []), log])
  }
  return [...groups.entries()].slice(0, 45).map(([id, events]) => ({ id, events, provider: events.find(event => event.provider)?.provider ?? '—', time: events[0]?.timestamp ?? '', failed: events.some(event => event.level === 'error'), switched: events.some(event => /fallback|retry/.test(event.action)) }))
})
const traceEvents = computed(() => traces.value.find(trace => trace.id === selectedTrace.value)?.events ?? [])
const availableModels = computed(() => data.value?.providers.find(provider => provider.name === codexProvider.value)?.models.filter(model => /^(gpt|codex|grok|o\d|openai)/i.test(model)) ?? [])

function number(value: number): string { return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value) }
function dateTime(value: string | null): string { return value ? new Date(value).toLocaleString('zh-CN') : '—' }
function switchPage(next: Page) { page.value = next; selectedTrace.value = null; window.scrollTo(0, 0) }
async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    data.value = await api<Dashboard>('/api/state')
    error.value = ''
    if (!codexProvider.value) codexProvider.value = data.value.providers.find(provider => provider.name === data.value?.codex.providerId)?.name ?? data.value.providers[0]?.name ?? ''
    if (!codexModel.value) codexModel.value = data.value.codex.model ?? ''
    if (!codexProxy.value) codexProxy.value = data.value.codex.proxy ?? ''
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { loading.value = false }
}
async function mutate(path: string, body: unknown, method = 'POST') {
  busy.value = true; notice.value = ''
  try { await api(path, { method, body: JSON.stringify(body) }); notice.value = '操作完成，数据已刷新。'; await load(true); return true }
  catch (reason) { notice.value = reason instanceof Error ? reason.message : String(reason); return false }
  finally { busy.value = false }
}
async function refreshProvider(name: string) { await mutate('/api/providers/refresh', { name }) }
function openProviderForm(provider?: ProviderStatus) {
  editProvider.value = provider ?? null
  providerForm.value = provider ? { name: provider.name, baseUrl: provider.baseUrl, apiKey: '', model: provider.model, mode: provider.mode, level: provider.level } : { name: '', baseUrl: '', apiKey: '', model: '', mode: 'auto', level: (data.value?.providers.filter(item => item.level > 0).length ?? 0) + 1 }
  showProviderForm.value = true
}
async function saveProvider() {
  const input = { ...providerForm.value } as Record<string, string | number>
  if (editProvider.value && !input.apiKey) delete input.apiKey
  const saved = editProvider.value ? await mutate(`/api/providers/${encodeURIComponent(editProvider.value.name)}`, input, 'PATCH')
    : await mutate('/api/providers', input)
  if (saved) showProviderForm.value = false
}
async function removeProvider(provider: ProviderStatus) {
  if (!confirm(`删除服务商「${provider.name}」？此操作会影响后续路由。`)) return
  await mutate(`/api/providers/${encodeURIComponent(provider.name)}`, {}, 'DELETE')
  selectedProvider.value = null
}
async function saveCodex() {
  const action = codexMode.value === 'provider' ? { mode: 'provider', providerName: codexProvider.value, model: codexModel.value || undefined }
    : codexMode.value === 'proxy' ? { mode: 'proxy', value: codexProxy.value || 'off' } : { mode: 'chatgpt' }
  if (!confirm('确认修改本机 Codex 持久配置？现有历史聊天不会自动迁移，新配置可能需要重启 App。')) return
  await mutate('/api/codex', action)
}
function selectUsageDay(date: string) { selectedDay.value = date; switchPage('usage') }
function copy(value: string) { void navigator.clipboard.writeText(value).then(() => { notice.value = '已复制命令。' }) }
onMounted(() => { void load(); refreshTimer = setInterval(() => { if (!busy.value) void load(true) }, 15000) })
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark"><Layers3 :size="18" /></div><div><strong>Axiom Runtime</strong><small>本地控制面板</small></div></div>
      <nav class="primary-nav"><button v-for="item in navigation" :key="item.id" :class="{ active: page === item.id }" @click="switchPage(item.id)"><component :is="item.icon" :size="17" />{{ item.label }}<ChevronRight v-if="page === item.id" :size="14" class="nav-chevron" /></button></nav>
      <div class="sidebar-bottom"><div class="side-card"><span class="muted-label">当前 Provider</span><strong>{{ data?.providers.find(provider => provider.level === 1)?.name ?? '未配置' }}</strong><small>{{ data?.providers.find(provider => provider.level === 1)?.model ?? '运行 ai setup 开始配置' }}</small></div><div class="side-status"><span class="status-dot"></span>本地服务 · 已连接</div></div>
    </aside>
    <main class="main">
      <header class="topbar"><div><h1>{{ pageTitle[page] }}</h1><p>{{ page === 'overview' ? '实时了解 Runtime 的运行状态' : page === 'usage' ? '按调用链路查看请求、用量与降级' : page === 'config' ? '查看并管理本机 CLI 与 Codex App 配置' : 'AxiomRuntime 本地管理' }}</p></div><div class="top-actions"><span class="live-badge"><span class="status-dot"></span>本地运行</span><button class="icon-button" title="刷新" @click="load()"><RefreshCw :size="16" /></button></div></header>
      <div class="content"><div v-if="notice" class="notice" role="status">{{ notice }}<button @click="notice = ''"><X :size="14" /></button></div><div v-if="error" class="error-banner"><TriangleAlert :size="18" />{{ error }}<button @click="load()">重试</button></div><div v-if="loading && !data" class="loading-state">正在读取本地 Runtime 数据…</div>
      <template v-else-if="data">
        <template v-if="page === 'overview'"><div class="stat-grid"><div class="stat-card"><span>可用 Provider</span><strong>{{ healthyCount }} <small>/ {{ data.providers.length }}</small></strong><em>来自最近一次健康状态</em></div><div class="stat-card"><span>累计 Token</span><strong>{{ number(data.usage.totalTokens) }}</strong><em>真实记录，不补录历史</em></div><div class="stat-card"><span>可估算成本</span><strong>${{ data.usage.estimatedCostUsd.toFixed(2) }}</strong><em v-if="data.usage.unpricedEvents">{{ data.usage.unpricedEvents }} 条无价格，未计入</em><em v-else>按已配置价格估算</em></div><div class="stat-card"><span>降级链路</span><strong>{{ traces.filter(trace => trace.switched).length }}</strong><em>最近 {{ data.logs.length }} 条日志内</em></div></div>
          <OverviewChart class="overview-trend" kind="trend" :usage="data.usage" :generated-at="data.generatedAt" @select-day="selectUsageDay" />
          <div class="overview-pair"><OverviewChart kind="activity" :usage="data.usage" :generated-at="data.generatedAt" @select-day="selectUsageDay" /><OverviewChart kind="providers" :usage="data.usage" :generated-at="data.generatedAt" /></div>
        </template>
        <template v-else-if="page === 'providers'"><div class="page-actions"><label class="search"><Search :size="16" /><input v-model="search" placeholder="搜索服务商或接口地址" /></label><button class="button primary" @click="openProviderForm()">+ 添加服务商</button></div><section class="card table-card"><div class="table-scroll"><table><thead><tr><th>服务商</th><th>健康状态</th><th>健康分</th><th>默认模型</th><th>出站代理</th><th>周 Token</th><th>操作</th></tr></thead><tbody><tr v-for="provider in filteredProviders" :key="provider.name"><td><strong>{{ provider.name }}</strong><small class="table-sub">level {{ provider.level }} · {{ provider.baseUrl }}</small></td><td><span class="pill" :class="provider.health">{{ provider.health === 'ok' ? '健康' : provider.health === 'error' ? '异常' : '待验证' }}</span></td><td>{{ provider.healthScore ?? '—' }}</td><td><code>{{ provider.model }}</code></td><td>{{ provider.proxyUrl || '默认 / 直连' }}</td><td>{{ number(provider.weeklyTokens) }}</td><td><button class="link-button" @click="selectedProvider = provider">详情</button></td></tr></tbody></table></div><div v-if="!filteredProviders.length" class="empty">没有匹配的 Provider。</div></section><section v-if="selectedProvider" class="card detail-card"><div class="card-head"><div><h2>{{ selectedProvider.name }}</h2><p>{{ selectedProvider.baseUrl }}</p></div><button class="icon-button" @click="selectedProvider = null"><X :size="17" /></button></div><div class="detail-grid"><div><span>Codex</span><strong>{{ selectedProvider.codex.state }} · {{ selectedProvider.codex.model ?? '无模型' }}</strong></div><div><span>Claude</span><strong>{{ selectedProvider.claude.state }} · {{ selectedProvider.claude.model ?? '无模型' }}</strong></div><div><span>凭证</span><strong>{{ selectedProvider.credentialConfigured ? '已配置' : '缺失' }}</strong></div><div><span>最近检查</span><strong>{{ dateTime(selectedProvider.lastCheckedAt) }}</strong></div></div><p v-if="selectedProvider.lastError" class="inline-error">{{ selectedProvider.lastError }}</p><div class="button-row"><button class="button" :disabled="busy" @click="refreshProvider(selectedProvider.name)"><RefreshCw :size="14" />检查连接</button><button class="button" @click="openProviderForm(selectedProvider)">编辑</button><button class="button danger" @click="removeProvider(selectedProvider)">删除</button></div></section></template>
        <template v-else-if="page === 'usage'"><div class="stat-grid"><div class="stat-card"><span>日志事件</span><strong>{{ data.logs.length }}</strong></div><div class="stat-card"><span>调用链路</span><strong>{{ traces.length }}</strong></div><div class="stat-card"><span>累计 Token</span><strong>{{ number(data.usage.totalTokens) }}</strong></div><div class="stat-card"><span>估算成本</span><strong>${{ data.usage.estimatedCostUsd.toFixed(2) }}</strong></div></div><div class="grid-two usage-grid"><section class="card"><div class="card-head"><div><h2>调用链路</h2><p>按 traceId 聚合；历史无 traceId 的事件单独显示</p></div><button v-if="selectedDay" class="chip clickable" @click="selectedDay = null">{{ selectedDay }} ×</button></div><div class="trace-list"><button v-for="trace in traces.filter(item => !selectedDay || item.time.startsWith(selectedDay))" :key="trace.id" :class="{ selected: selectedTrace === trace.id }" @click="selectedTrace = trace.id"><span class="trace-dot" :class="trace.failed ? 'error' : trace.switched ? 'warning' : 'ok'"></span><span><strong>{{ trace.provider }}</strong><small>{{ trace.id.startsWith('single-') ? '独立事件' : trace.id }} · {{ dateTime(trace.time) }}</small></span><span class="pill" :class="trace.failed ? 'error' : trace.switched ? 'unknown' : 'ok'">{{ trace.failed ? '失败' : trace.switched ? '已切换' : '完成' }}</span></button><div v-if="!traces.length" class="empty">暂无调用日志。</div></div></section><section class="card"><div class="card-head"><div><h2>链路详情</h2><p>{{ selectedTrace ?? '选择左侧链路查看每一跳' }}</p></div></div><div v-if="traceEvents.length" class="timeline"><div v-for="(event, index) in traceEvents" :key="index" class="timeline-row"><div class="timeline-dot" :class="event.level"></div><div><strong>{{ event.action }}</strong><p>{{ event.provider ?? 'Runtime' }} {{ event.model ? `· ${event.model}` : '' }} {{ event.attempt ? `· 第 ${event.attempt} 次` : '' }}</p><small>{{ dateTime(event.timestamp) }} · {{ event.status ?? event.level }}</small></div></div></div><div v-else class="empty">选择一条调用链路。</div></section></div><section class="card"><div class="card-head"><div><h2>最近会话</h2><p>展示启动时 Provider；请求级切换以链路日志为准</p></div></div><div class="session-list"><div v-for="session in data.sessions.slice(0, 12)" :key="session.id"><code>{{ session.id }}</code><span>{{ session.tool }} · {{ session.provider }} / {{ session.model }}</span><span class="pill" :class="session.status === 'failed' ? 'error' : 'ok'">{{ session.status }}</span><small>{{ dateTime(session.startedAt) }}</small></div><div v-if="!data.sessions.length" class="empty">暂无会话。</div></div></section></template>
        <template v-else-if="page === 'commands'"><section class="card intro-card"><TerminalSquare :size="22" /><div><h2>命令中心</h2><p>复制命令在本机终端执行。涉及密钥的命令请在终端交互输入。</p></div></section><div class="command-grid"><section v-for="group in [{ title: '开始使用', commands: ['ai setup', 'ai status', 'ai web'] }, { title: 'Provider', commands: ['ai provider list', 'ai models', 'ai check'] }, { title: '运行与诊断', commands: ['ai use codex', 'ai use claude', 'ai log --print 100'] }, { title: 'Codex App', commands: ['ai set codex', 'ai set codex chatgpt', 'ai set codex proxy off'] }]" :key="group.title" class="card"><h2>{{ group.title }}</h2><button v-for="command in group.commands" :key="command" class="command-row" @click="copy(command)"><code>{{ command }}</code><Copy :size="15" /></button></section></div></template>
        <template v-else-if="page === 'config'"><div class="config-banner"><ShieldCheck :size="18" /><div><strong>进程临时配置与 Codex 持久配置</strong><p><code>ai use</code> 只影响启动的 CLI 子进程；<code>ai set codex</code> 修改本机共享的 Codex 用户配置。旧聊天不会自动迁移。</p></div></div><div class="grid-two config-grid"><section class="card"><div class="card-head"><div><h2>Claude Code</h2><p>本机 <code>ai use claude</code> 通过临时 settings 启动</p></div><span class="pill unknown">进程级</span></div><div class="file-row"><code>~/.claude/settings.json</code><span>本页只读</span></div><div class="config-space"><p>当前版本没有 Claude Code 持久配置写入服务。使用 <code>ai use claude [provider] [model]</code> 为单次运行选择服务商。</p></div><div class="button-row aligned"><button class="button primary" @click="copy('ai use claude')"><Copy :size="14" />复制启动命令</button></div></section><section class="card"><div class="card-head"><div><h2>Codex App / CLI</h2><p>共享用户级 <code>config.toml</code>；CLI <code>-c</code> 可临时覆盖</p></div><span class="pill ok">已读取</span></div><div class="file-row"><code>{{ data.codex.configPath }}</code><span>{{ data.codex.configPresent ? '已配置' : '未创建' }}</span></div><div class="file-row"><code>{{ data.codex.authPath }}</code><span>{{ data.codex.authConfigured ? '凭证已配置' : '无文件凭证' }}</span></div><div class="segmented"><button v-for="mode in [{ id: 'chatgpt', text: 'ChatGPT 账号' }, { id: 'provider', text: '自定义 Provider' }, { id: 'proxy', text: 'HTTP 代理' }]" :key="mode.id" :class="{ active: codexMode === mode.id }" @click="codexMode = mode.id as typeof codexMode">{{ mode.text }}</button></div><div class="config-fields"><template v-if="codexMode === 'provider'"><label>服务商<select v-model="codexProvider" @change="codexModel = ''"><option v-for="provider in data.providers" :key="provider.name" :value="provider.name">{{ provider.name }}</option></select></label><label>模型<select v-model="codexModel"><option value="">自动选择最新 GPT</option><option v-for="model in availableModels" :key="model" :value="model">{{ model }}</option></select></label></template><template v-else-if="codexMode === 'proxy'"><label>HTTP 代理地址<input v-model="codexProxy" placeholder="http://127.0.0.1:7890；留空清除" /></label></template><p v-else>会打开浏览器完成 ChatGPT 登录，并替换现有的自定义 Provider 凭证。</p></div><div class="config-preview"><span>等价命令</span><code>{{ codexMode === 'provider' ? `ai set codex provider ${codexProvider} ${codexModel}` : codexMode === 'proxy' ? `ai set codex proxy ${codexProxy || 'off'}` : 'ai set codex chatgpt' }}</code></div><div class="button-row aligned"><button class="button primary" :disabled="busy || (codexMode === 'provider' && !availableModels.length)" @click="saveCodex()">应用本机配置</button></div></section></div><div class="config-warning"><TriangleAlert :size="17" /><p>配置成功后 Codex App 可能需要手动重启；已有原生历史聊天可能仍访问旧 Provider。新的聊天会读取新配置。</p></div></template>
        <template v-else-if="page === 'help'"><section class="card intro-card"><CircleHelp :size="22" /><div><h2>帮助中心</h2><p>从安装、Provider 配置到运行与排障。完整命令手册随 npm 包提供。</p></div></section><div class="help-grid"><section v-for="item in [{ title: '安装与初始化', text: 'Node.js 22.19.0+，安装 npm 包后运行 ai setup。', command: 'npm install -g @offerpilot/axiomruntime' }, { title: '选择 Provider', text: '添加服务商、发现模型，并进行真实健康探测。', command: 'ai status' }, { title: '并行运行', text: '每次 ai use 都独立注入，不覆盖全局原生 CLI 配置。', command: 'ai use codex' }, { title: '排查调用', text: '按 traceId 查看 Provider 切换和失败原因。', command: 'ai log --print 100' }]" :key="item.title" class="card"><h2>{{ item.title }}</h2><p>{{ item.text }}</p><button class="command-row" @click="copy(item.command)"><code>{{ item.command }}</code><Copy :size="14" /></button></section></div><p class="help-note">配置目录：<code>{{ data.configRoot }}</code>。Web 控制面板仅在本机 <code>127.0.0.1</code> 提供服务。</p></template>
      </template></div>
    </main>
    <div v-if="showProviderForm" class="modal-backdrop" @click.self="showProviderForm = false"><form class="modal" @submit.prevent="saveProvider"><div class="card-head"><div><h2>{{ editProvider ? '编辑服务商' : '添加服务商' }}</h2><p>保存前会由 core 服务验证配置</p></div><button type="button" class="icon-button" @click="showProviderForm = false"><X :size="17" /></button></div><label>名称<input v-model="providerForm.name" required /></label><label>Base URL<input v-model="providerForm.baseUrl" required type="url" /></label><label>API Key<input v-model="providerForm.apiKey" :required="!editProvider" type="password" :placeholder="editProvider ? '留空则保持不变' : ''" autocomplete="off" /></label><label>默认模型<input v-model="providerForm.model" placeholder="可选；目录不可用时需填写" /></label><label>运行模式<select v-model="providerForm.mode"><option value="auto">auto</option><option value="ask">ask</option></select></label><label>优先级（0 表示仅显式选择）<input v-model.number="providerForm.level" type="number" min="0" :max="maxProviderLevel" required /></label><div class="button-row"><button type="button" class="button" @click="showProviderForm = false">取消</button><button type="submit" class="button primary" :disabled="busy">{{ busy ? '正在验证…' : '保存服务商' }}</button></div></form></div>
  </div>
</template>

<style scoped>
.overview-trend{margin-bottom:18px}
.overview-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-bottom:18px}
@media(max-width:750px){.overview-pair{grid-template-columns:1fr}}
</style>
