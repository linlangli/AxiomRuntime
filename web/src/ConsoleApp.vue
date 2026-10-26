<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Activity, ArrowRight, ArrowUpRight, BarChart3, BookOpen, CheckCircle2, Copy, Globe2, Layers3, LayoutDashboard, RefreshCw, Settings2, ShieldCheck, Sparkles, TerminalSquare, TriangleAlert, X } from 'lucide-vue-next'
import OverviewChart from './OverviewChart.vue'
import LocalSettings from './LocalSettings.vue'
import ExposureSettings from './ExposureSettings.vue'
import TraceView from './TraceView.vue'
import HistoryBrowser from './HistoryBrowser.vue'
import CommandManual from './CommandManual.vue'
import { api, type Dashboard, type ModelPrice } from './console-api'

type Page = 'overview' | 'stats' | 'config' | 'trace' | 'exposure' | 'help'
const navigation = [
  { id: 'overview', label: '运行总览', icon: LayoutDashboard, caption: 'A little overview of everything.' },
  { id: 'stats', label: '用量统计', icon: BarChart3, caption: '看清每一份用量，了解每一次投入。' },
  { id: 'config', label: '本地配置', icon: Settings2, caption: '连接、调整，让 Runtime 按你的方式运行。' },
  { id: 'trace', label: '运行记录', icon: Activity, caption: '看执行结果，查工具会话，排系统问题。' },
  { id: 'exposure', label: '对外服务', icon: Globe2, caption: '把需要的能力，连接到你自己的服务。' },
  { id: 'help', label: '帮助中心', icon: BookOpen, caption: '上手、探索，以及遇到问题的时候。' }
] as const
const page = ref<Page>('overview')
const data = ref<Dashboard | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const selectedDay = ref<string | null>(null)
const traceTab = ref<'calls' | 'logs'>('calls')
const days = ref(30)
const providerFilter = ref('')
const helpTab = ref('快速开始')
const showPricing = ref(false)
const pricingProvider = ref('')
const pricingModel = ref('')
const pricingManualModel = ref(false)
const pricingInput = ref<number | null>(null)
const pricingOutput = ref<number | null>(null)
const pricingCacheRead = ref<number | null>(null)
const pricingSaving = ref(false)
const pricingError = ref('')
let refreshTimer: ReturnType<typeof setInterval> | undefined
const currentPage = computed(() => navigation.find(item => item.id === page.value)!)
const healthy = computed(() => data.value?.providers.filter(provider => provider.health === 'ok').length ?? 0)
const recentErrors = computed(() => data.value?.logs.filter(event => event.level === 'error').slice(0, 4) ?? [])
const rangeDates = computed(() => {
  const end = new Date(data.value?.generatedAt ?? Date.now()); end.setUTCHours(0, 0, 0, 0)
  return Array.from({ length: days.value }, (_, index) => new Date(end.getTime() - (days.value - index - 1) * 86400000).toISOString().slice(0, 10))
})
const scopedUsage = computed(() => {
  const usage = data.value!.usage
  const providers = usage.providers.filter(provider => !providerFilter.value || provider.provider === providerFilter.value).map(provider => {
    const daily = provider.daily.filter(day => rangeDates.value.includes(day.date))
    return {
      ...provider,
      daily,
      totalTokens: daily.reduce((sum, day) => sum + day.totalTokens, 0),
      estimatedCostUsd: daily.reduce((sum, day) => sum + day.estimatedCostUsd, 0),
      unpricedEvents: daily.reduce((sum, day) => sum + day.unpricedEvents, 0)
    }
  })
  const daily = rangeDates.value.map(date => {
    const rows = providers.flatMap(provider => provider.daily.filter(day => day.date === date))
    return { date, inputTokens: rows.reduce((sum, day) => sum + day.inputTokens, 0), outputTokens: rows.reduce((sum, day) => sum + day.outputTokens, 0), totalTokens: rows.reduce((sum, day) => sum + day.totalTokens, 0), estimatedCostUsd: rows.reduce((sum, day) => sum + day.estimatedCostUsd, 0), unpricedEvents: rows.reduce((sum, day) => sum + day.unpricedEvents, 0) }
  })
  return { ...usage, providers, daily, totalTokens: providers.reduce((sum, provider) => sum + provider.totalTokens, 0), estimatedCostUsd: daily.reduce((sum, day) => sum + day.estimatedCostUsd, 0), unpricedEvents: daily.reduce((sum, day) => sum + day.unpricedEvents, 0) }
})
const pricingProviders = computed(() => {
  const names = [
    ...(data.value?.providers ?? []).map(provider => provider.name),
    ...(data.value?.usage.providers ?? []).map(provider => provider.provider)
  ]
  for (const key of Object.keys(data.value?.pricing ?? {})) {
    const slash = key.indexOf('/')
    if (slash > 0) names.push(key.slice(0, slash))
  }
  return [...new Set(names.filter(Boolean))].sort((left, right) => left.localeCompare(right))
})
const pricingModels = computed(() => {
  const provider = data.value?.providers.find(item => item.name === pricingProvider.value)
  const usageProvider = data.value?.usage.providers.find(item => item.provider === pricingProvider.value)
  const models = [...(provider?.models ?? [])]
  if (provider?.model) models.push(provider.model)
  models.push(...(usageProvider?.models ?? []).map(item => item.model))
  for (const key of Object.keys(data.value?.pricing ?? {})) {
    if (key.startsWith(`${pricingProvider.value}/`)) models.push(key.slice(pricingProvider.value.length + 1))
  }
  return [...new Set(models.filter(Boolean))].sort((left, right) => left.localeCompare(right))
})
const pricingModelChoice = computed({
  get: () => pricingManualModel.value ? '' : pricingModel.value,
  set: (model: string) => { pricingManualModel.value = !model; pricingModel.value = model }
})
function pricingKey() { return `${pricingProvider.value.trim()}/${pricingModel.value.trim()}` }
function syncPricingForm() {
  const price = data.value?.pricing[pricingKey()]
  pricingInput.value = price?.inputPerMillionUsd ?? null
  pricingOutput.value = price?.outputPerMillionUsd ?? null
  pricingCacheRead.value = price?.cacheReadPerMillionUsd ?? null
}
watch(pricingProvider, () => {
  if (!pricingModels.value.includes(pricingModel.value)) pricingModel.value = pricingModels.value[0] ?? ''
  pricingManualModel.value = !pricingModels.value.length
  syncPricingForm()
})
watch(pricingModel, syncPricingForm)
function openPricing() {
  const firstProvider = providerFilter.value || data.value?.providers.find(provider => provider.level === 1)?.name || pricingProviders.value[0] || ''
  pricingProvider.value = firstProvider
  pricingModel.value = pricingModels.value[0] ?? ''
  pricingManualModel.value = !pricingModels.value.length
  pricingError.value = ''
  showPricing.value = true
  syncPricingForm()
}
async function savePricing() {
  pricingError.value = ''
  if (!pricingProvider.value.trim() || !pricingModel.value.trim()) { pricingError.value = '请选择 Provider 并选择或填写模型。'; return }
  if (pricingInput.value === null || pricingOutput.value === null || !Number.isFinite(pricingInput.value) || !Number.isFinite(pricingOutput.value) || pricingInput.value < 0 || pricingOutput.value < 0 || (pricingCacheRead.value !== null && (!Number.isFinite(pricingCacheRead.value) || pricingCacheRead.value < 0))) {
    pricingError.value = '输入、输出价格必须是大于等于 0 的数字。'; return
  }
  pricingSaving.value = true
  try {
    await api<Record<string, ModelPrice>>('/api/pricing', { method: 'PUT', body: JSON.stringify({ providerName: pricingProvider.value, model: pricingModel.value, inputPerMillionUsd: pricingInput.value, outputPerMillionUsd: pricingOutput.value, cacheReadPerMillionUsd: pricingCacheRead.value }) })
    showPricing.value = false
    notice.value = '模型价格已保存，统计已重新计算。'
    await load(true)
  } catch (reason) { pricingError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pricingSaving.value = false }
}
async function removePricing() {
  if (!pricingProvider.value.trim() || !pricingModel.value.trim()) return
  pricingSaving.value = true
  pricingError.value = ''
  try {
    await api<Record<string, ModelPrice>>('/api/pricing', { method: 'DELETE', body: JSON.stringify({ providerName: pricingProvider.value, model: pricingModel.value }) })
    showPricing.value = false
    notice.value = '模型价格已清除。'
    await load(true)
  } catch (reason) { pricingError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pricingSaving.value = false }
}
const helpGroups = [
  { title: '第一次使用', text: '准备 Node.js 22.19.0+，添加 Provider 后即可启动 Claude Code 或 Codex。', commands: ['ai setup', 'ai use claude', 'ai use codex'] },
  { title: '服务商与模型', text: '模型刷新只请求目录；真实健康检查可能产生少量 Token。', commands: ['ai provider list', 'ai models', 'ai check', 'ai status'] },
  { title: '运行与排障', text: '在运行记录中查看执行结果、工具会话与分类日志，使用 traceId 回看关联事件。', commands: ['ai doctor', 'ai log --print 100', 'ai session list', 'ai report'] },
  { title: '更多接入方式', text: 'Telegram 远程执行与 Codex 持久设置复用本机 Runtime 配置。', commands: ['ai telegram', 'ai set codex', 'ai help'] }
]
async function load(silent = false) {
  if (loading.value) return
  loading.value = true
  try {
    const state = await api<Dashboard>('/api/state')
    if (!Array.isArray(state.calls) || !state.codexUsage) throw new Error('控制面板已更新，请在终端停止旧的 ai web，再重新运行 ai web 打开新版页面。')
    data.value = state
    error.value = ''
  }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); if (!silent) notice.value = '' }
  finally { loading.value = false }
}
function navigate(next: Page) { traceTab.value = 'calls'; page.value = next; window.scrollTo({ top: 0 }) }
function openLogs() { navigate('trace'); selectedDay.value = null; traceTab.value = 'logs' }
function selectDay(date: string) { selectedDay.value = date; navigate('trace') }
function number(value: number) { return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) }
function money(value: number) { return value === 0 ? '0.00' : value < 0.01 ? value.toFixed(4) : value.toFixed(2) }
function copy(value: string) { void navigator.clipboard.writeText(value).then(() => { notice.value = '已复制命令。' }).catch(() => { notice.value = '复制失败，请手动复制。' }) }
onMounted(() => { void load(); refreshTimer = setInterval(() => { if (document.visibilityState === 'visible' && page.value !== 'config' && page.value !== 'exposure') void load(true) }, 15000) })
onUnmounted(() => clearInterval(refreshTimer))
</script>

<template>
  <div class="shell"><aside class="sidebar"><a class="brand" href="#" @click.prevent="navigate('overview')"><div class="brand-mark"><Layers3 :size="22" /></div><div><strong>Axiom<span>Runtime</span></strong><small>YOUR LOCAL AI WORKSPACE</small></div></a><div class="nav-caption">工作空间 <span>WORKSPACE</span></div><nav class="primary-nav" aria-label="主要导航"><button v-for="item in navigation" :key="item.id" :class="{ active: page === item.id }" :aria-current="page === item.id ? 'page' : undefined" @click="navigate(item.id)"><component :is="item.icon" :size="18" /><span>{{ item.label }}</span><span v-if="page === item.id" class="nav-active-dot"></span></button></nav><div class="sidebar-note"><svg viewBox="0 0 110 46" aria-hidden="true"><path d="M8 28C29 2 42 42 63 15S86 13 101 8M91 6l11 2-5 10" /></svg><p>让每一次交互，<br />成为下一次的积累。</p><small>MAKE EVERY INTERACTION COUNT.</small></div><div class="sidebar-bottom"><div class="side-card"><span class="muted-label">默认 Provider</span><strong>{{ data?.providers.find(provider => provider.level === 1)?.name ?? '等待连接' }}</strong><small>{{ data?.providers.find(provider => provider.level === 1)?.model ?? '添加第一个服务商开始使用' }}</small></div><div class="side-status"><span class="status-dot" :class="{ disconnected: error || !data }"></span>{{ error ? '连接异常' : data ? '本机服务已连接' : '正在连接本机' }}<span class="local-label">LOCAL</span></div></div></aside>
    <main class="main"><header class="topbar"><div class="breadcrumb">工作空间 <span>/</span> <strong>{{ currentPage.label }}</strong></div><div class="top-actions"><span class="live-badge"><span class="status-dot" :class="{ disconnected: error || !data }"></span>本地运行</span><button class="icon-button" aria-label="刷新数据" :disabled="loading" @click="load()"><RefreshCw :size="16" :class="{ spinning: loading }" /></button><button class="avatar-button" aria-label="打开帮助中心" @click="navigate('help')">A</button></div></header><div class="content"><div class="page-heading"><div><span class="eyebrow">AXIOM / {{ page.toUpperCase() }}</span><h1>{{ currentPage.label }}<span class="heading-dot">.</span></h1><p>{{ currentPage.caption }}</p></div><div v-if="data" class="updated-at">最近更新<br /><strong>{{ new Date(data.generatedAt).toLocaleTimeString('zh-CN') }}</strong></div></div>
      <div v-if="notice" class="notice" role="status"><CheckCircle2 :size="16" />{{ notice }}<button aria-label="关闭提示" @click="notice = ''"><X :size="15" /></button></div><div v-if="error" class="error-banner" role="alert"><TriangleAlert :size="17" />{{ error }}<button @click="load()">重试连接</button></div><div v-if="!data && loading" class="loading-state">正在读取本机 Runtime…</div>
      <template v-if="data">
        <div v-if="page === 'stats'" class="info-banner"><BarChart3 :size="18" /><p>Codex App 用量采集：{{ data.codexUsage.lastError ? '同步异常，请检查工具配置' : data.codexUsage.enabled ? '已开启，按实际 Provider 归属' : '未开启' }}<span v-if="data.codexUsage.unmappedProviderIds.length"> · {{ data.codexUsage.unmappedProviderIds.length }} 个 Provider 待匹配</span><button class="text-button" @click="navigate('config')">打开本地配置</button></p></div>
        <template v-if="page === 'overview'"><section class="welcome-card"><div><span class="eyebrow">A GOOD PLACE TO START</span><h2>你的 AI 工作空间，<span class="marker-underline">井然有序。</span></h2><p>连接模型，观察运行，把可复用的能力留在这里。</p><button class="text-button" @click="navigate('config')">管理本地配置 <ArrowUpRight :size="16" /></button></div><svg class="welcome-doodle" viewBox="0 0 240 140" aria-hidden="true"><path class="doodle-orbit" d="M40 90C-10 25 129-6 191 35s9 103-75 81S27 64 55 31" /><path d="m116 19-13 47 31-6-21 54 51-72-33 8 16-37z" /><path class="doodle-star" d="m45 92 3-14 5 13 13 3-13 5-3 14-5-14-13-3zM191 14l3 9 10 2-9 4-2 9-4-9-9-2 9-4z" /><path class="doodle-orbit" d="m190 99 9-4-2 11M28 40l-8-8M33 26l-2-10" /></svg></section><div class="stat-grid"><section class="stat-card"><span class="stat-icon lavender"><ShieldCheck :size="18" /></span><span>可用 Provider</span><strong>{{ healthy }}<small> / {{ data.providers.length }}</small></strong><em>最近一次健康检查结果</em></section><section class="stat-card"><span class="stat-icon peach"><BarChart3 :size="18" /></span><span>累计 Token</span><strong>{{ number(data.usage.totalTokens) }}</strong><em>Runtime 真实用量记录</em></section><section class="stat-card"><span class="stat-icon mint"><Sparkles :size="18" /></span><span>可估算成本</span><strong>${{ money(data.usage.estimatedCostUsd) }}</strong><em>{{ data.usage.unpricedEvents ? `${data.usage.unpricedEvents} 条无价格，未计入` : '按已配置价格估算' }}</em></section><section class="stat-card"><span class="stat-icon butter"><Globe2 :size="18" /></span><span>对外开放能力</span><strong>{{ data.settings.exposure.capabilities.length }}<small> 项</small></strong><em>已保存配置，连通性需测试</em></section></div><div class="equal-grid"><section class="card"><div class="card-head"><div><h2>服务商状态</h2><p>配置与连接，一眼掌握</p></div><button class="text-button" @click="navigate('config')">管理 <ArrowRight :size="14" /></button></div><div class="health-list"><button v-for="provider in data.providers.slice(0, 5)" :key="provider.name" @click="navigate('config')"><span class="provider-avatar mini">{{ provider.name.slice(0, 1).toUpperCase() }}</span><span><strong>{{ provider.name }}</strong><small>{{ provider.model || '未设置默认模型' }}</small></span><span class="pill" :class="provider.health">{{ provider.health === 'ok' ? '健康' : provider.health === 'error' ? '异常' : '待检查' }}</span></button><div v-if="!data.providers.length" class="empty">还没有 Provider，去「本地配置」连接第一个。</div></div></section><section class="card"><div class="card-head"><div><h2>最近动态 <span class="hand-tag">what's happening?</span></h2><p>近期事件，点开查看系统日志</p></div><button class="text-button" @click="openLogs()">查看 <ArrowRight :size="14" /></button></div><div class="event-list"><button v-for="(event, index) in data.logs.slice(0, 5)" :key="index" @click="openLogs()"><span class="trace-dot" :class="event.level === 'error' ? 'error' : 'ok'"></span><div><strong>{{ event.action }}</strong><small>{{ event.provider ?? 'Runtime' }} · {{ new Date(event.timestamp).toLocaleTimeString('zh-CN') }}</small></div><ArrowUpRight :size="15" /></button><div v-if="!data.logs.length" class="empty">第一次运行之后，动态会出现在这里。</div></div></section></div><div v-if="recentErrors.length" class="error-banner spaced"><TriangleAlert :size="18" /><span>近期 {{ recentErrors.length }} 条错误记录，可能包含已恢复的调用。</span><button @click="openLogs()">查看记录</button></div><div class="overview-foot"><span>数据包含 Runtime 调用，以及已启用采集的 Codex App 本机用量。</span><button class="text-button" @click="navigate('stats')">探索用量图表 <ArrowRight :size="14" /></button></div></template>
        <template v-else-if="page === 'stats'"><div class="page-actions"><div class="metric-tabs" aria-label="统计时间范围"><button v-for="range in [7, 30, 70]" :key="range" :class="{ active: days === range }" :aria-pressed="days === range" @click="days = range">最近 {{ range }} 天</button></div><select v-model="providerFilter" aria-label="筛选 Provider"><option value="">全部 Provider</option><option v-for="provider in data.usage.providers" :key="provider.provider" :value="provider.provider">{{ provider.provider }}</option></select></div><div class="stat-grid"><section class="stat-card"><span>区间总 Token</span><strong>{{ number(scopedUsage.totalTokens) }}</strong><em>{{ days }} 个 UTC 自然日</em></section><section class="stat-card"><span>输入 Token</span><strong>{{ number(scopedUsage.daily.reduce((sum, day) => sum + day.inputTokens, 0)) }}</strong><em>当前筛选范围</em></section><section class="stat-card"><span>输出 Token</span><strong>{{ number(scopedUsage.daily.reduce((sum, day) => sum + day.outputTokens, 0)) }}</strong><em>当前筛选范围</em></section><section class="stat-card cost-stat-card"><button class="stat-settings-button" aria-label="配置模型价格" title="配置模型价格" @click="openPricing"><Settings2 :size="15" /></button><span>区间可估算成本</span><strong>${{ money(scopedUsage.estimatedCostUsd) }}</strong><em>{{ scopedUsage.daily.reduce((sum, day) => sum + day.unpricedEvents, 0) ? `${scopedUsage.daily.reduce((sum, day) => sum + day.unpricedEvents, 0)} 条无价格，未计入` : '按已配置价格估算' }}</em></section></div><OverviewChart kind="trend" :usage="scopedUsage" :window-days="days" :generated-at="data.generatedAt" @select-day="selectDay" /><div class="equal-grid spaced"><OverviewChart kind="providers" :usage="scopedUsage" :generated-at="data.generatedAt" scope-label="当前筛选区间" /><OverviewChart kind="activity" :usage="scopedUsage" :window-days="days" :generated-at="data.generatedAt" @select-day="selectDay" /></div><section class="card table-card spaced"><div class="card-head padded"><div><h2>用量明细</h2><p>当前筛选区间按 Provider 汇总</p></div></div><div class="table-scroll"><table><thead><tr><th>Provider</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th><th>区间占比</th></tr></thead><tbody><tr v-for="provider in scopedUsage.providers.filter(item => item.totalTokens > 0)" :key="provider.provider"><td><strong>{{ provider.provider }}</strong></td><td>{{ number(provider.daily.reduce((sum, day) => sum + day.inputTokens, 0)) }}</td><td>{{ number(provider.daily.reduce((sum, day) => sum + day.outputTokens, 0)) }}</td><td>{{ number(provider.totalTokens) }}</td><td>{{ scopedUsage.totalTokens ? (provider.totalTokens / scopedUsage.totalTokens * 100).toFixed(1) : '0' }}%</td></tr></tbody></table></div><div v-if="!scopedUsage.totalTokens" class="empty">所选范围暂无用量。可以切换日期或 Provider。</div><div v-if="showPricing" class="modal-backdrop" @click.self="showPricing = false"><section class="modal pricing-modal" role="dialog" aria-modal="true" aria-labelledby="pricing-title"><div class="card-head"><div><h2 id="pricing-title">配置模型价格</h2><p>按美元 / 1M tokens 估算输入、输出成本。</p></div><button class="icon-button" aria-label="关闭价格设置" @click="showPricing = false"><X :size="16" /></button></div><div class="info-banner pricing-note"><Sparkles :size="16" /><p>价格键为 <strong>Provider / 模型</strong>，保存后会立即重算当前时间区间。</p></div><label>Provider<select v-model="pricingProvider" aria-label="价格 Provider" :disabled="pricingSaving"><option value="" disabled>请选择 Provider</option><option v-for="provider in pricingProviders" :key="provider" :value="provider">{{ provider }}</option></select></label><label>模型<select v-model="pricingModelChoice" aria-label="价格模型" :disabled="pricingSaving"><option v-for="model in pricingModels" :key="model" :value="model">{{ model }}</option><option value="">手动输入模型…</option></select></label><label v-if="pricingManualModel">模型名称<input v-model.trim="pricingModel" aria-label="模型名称" placeholder="填写模型 ID，例如 claude-3-5-sonnet" :disabled="pricingSaving" /></label><div class="form-grid"><label>输入价格（USD / 1M）<input v-model.number="pricingInput" type="number" min="0" step="0.000001" placeholder="0" /></label><label>输出价格（USD / 1M）<input v-model.number="pricingOutput" type="number" min="0" step="0.000001" placeholder="0" /></label><label>Cache Read（可选）<input v-model.number="pricingCacheRead" type="number" min="0" step="0.000001" placeholder="跟随输入价格" /></label></div><div v-if="pricingError" class="error-banner pricing-error"><TriangleAlert :size="16" />{{ pricingError }}</div><div class="button-row"><button class="button primary" :disabled="pricingSaving" @click="savePricing">{{ pricingSaving ? '保存中…' : '保存价格' }}</button><button class="button danger" :disabled="pricingSaving || !data.pricing[pricingKey()]" @click="removePricing">清除当前价格</button><button class="button" :disabled="pricingSaving" @click="showPricing = false">取消</button></div></section></div></section></template>
        <LocalSettings v-else-if="page === 'config'" :data="data" @reload="load(true)" @notice="notice = $event" />
        <template v-else-if="page === 'trace'"><TraceView :data="data" :selected-day="selectedDay" :initial-tab="traceTab" @clear-day="selectedDay = null" /><HistoryBrowser /></template>
        <ExposureSettings v-else-if="page === 'exposure'" :exposure="data.settings.exposure" @reload="load(true)" @notice="notice = $event" />
        <template v-else><div class="subnav" aria-label="帮助分类"><button v-for="item in ['快速开始', '命令手册', '常见问题']" :key="item" :class="{ active: helpTab === item }" @click="helpTab = item">{{ item }}</button></div><template v-if="helpTab === '快速开始'"><section class="welcome-card help-welcome"><div><span class="eyebrow">LET'S GET YOU STARTED</span><h2>从第一个 Provider 开始。</h2><p>配置连接 → 启动工具 → 查看用量 → 查看运行记录。</p><button class="text-button" @click="navigate('config')">开始配置 <ArrowUpRight :size="15" /></button></div><TerminalSquare :size="72" :stroke-width="1.2" /></section><div class="help-grid"><section v-for="(group, index) in helpGroups" :key="group.title" class="card"><span class="step-number">0{{ index + 1 }}</span><h2>{{ group.title }}</h2><p>{{ group.text }}</p><button v-for="command in group.commands.slice(0, 2)" :key="command" class="command-row" @click="copy(command)"><code>{{ command }}</code><Copy :size="14" /></button></section></div></template><CommandManual v-else-if="helpTab === '命令手册'" @copy="copy" /><section v-else class="card faq-list"><details open><summary>Web 修改的是哪台机器？</summary><p>修改运行 ai web 的机器上的配置。浏览器只是操作界面；本地配置路径为 {{ data.configRoot }}。</p></details><details><summary>修改模型后，为什么旧 Codex 聊天仍报错？</summary><p>持久配置不会迁移旧聊天。重新启动 App 并新建聊天使用新配置。</p></details><details><summary>Provider 健康和真实承接者有什么区别？</summary><p>健康状态来自最近一次检查；默认 Provider 是候选起点。运行时可能发生切换。在“运行记录 → 调用记录”查看终止事件记录的结果 Provider；缺少终止事件时结果未知。工具会话的 Provider 仅代表启动配置。</p></details><details><summary>图表为什么没有其他工具的调用？</summary><p>在「本地配置 → 工具配置」开启 Codex App 用量采集后，会按实际 Provider 和模型统计启用后的本机用量。无法匹配的 Provider 可手动指定归属；CLI 代理请求自动去重。不会补录首次启用前或关闭期间的用量，云端任务不在范围内。日期按 UTC 自然日展示。</p></details><details><summary>保存对外服务配置之后，还需要做什么？</summary><p>按「开放能力 → 调用凭证 → 启动与连接 → 验证与调用」继续。内部调用无需域名；公网调用在最后一步保存 HTTPS 入口，SSH 模式可展开部署 Nginx 与证书。配置面板始终保留在本机。</p></details><details><summary>Memory、额度和组织权限可用了吗？</summary><p>Embedding 连接配置已可编辑，向量检索与自动记忆保留现状；调用凭证支持请求限流、请求总额度及 Provider/模型限制，组织权限仍属后续规划。</p></details></section></template>
        <HistoryBrowser v-if="page === 'stats'" initial-kind="usage" />
      </template><footer class="workspace-footer"><span>AxiomRuntime <span class="footer-star">✳</span> 本地优先 · 能力可复用</span><span>你的配置与数据，留在你的机器。</span></footer></div></main></div>
</template>
