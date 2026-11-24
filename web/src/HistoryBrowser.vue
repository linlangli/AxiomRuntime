<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Search, RefreshCw, Download, X } from 'lucide-vue-next'
import { api } from './console-api'
import { formatTokens } from './token-format'
const props = defineProps<{ initialKind?: string; providers?: string[] }>()
const kind = ref(props.initialKind ?? 'logs')
const usageOnly = props.initialKind === 'usage'
function formatTime(value: unknown) { if (typeof value !== 'string') return '—'; const time = new Date(value); return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN', { hour12: false }) }
const query = ref('')
const items = ref<Record<string, unknown>[]>([])
const total = ref(0)
const offset = ref(0)
const next = ref<number | null>(null)
const busy = ref(false)
const provider = ref('')
const period = ref('all')
const since = ref('')
const searchOpen = ref(false)
const exportOpen = ref(false)
const error = ref('')
const selected = ref<Record<string, unknown> | null>(null)
const snapshot = ref(new Date().toISOString())
function toggleSearch() { searchOpen.value = !searchOpen.value; if (!searchOpen.value && query.value) { query.value = ''; void load(true) } }
function params(start = offset.value) { return new URLSearchParams({ kind: kind.value, limit: '100', offset: String(start), q: query.value, ...(offset.value > 0 ? { before: snapshot.value } : {}), ...(provider.value ? { provider: provider.value } : {}), ...(since.value ? { since: since.value } : {}) }) }
async function load(reset = false) {
  if (busy.value) return
  if (reset) { offset.value = 0; snapshot.value = new Date().toISOString() }
  busy.value = true; error.value = ''
  try { const result = await api<{ items: Record<string, unknown>[]; total: number; nextOffset: number | null }>(`/api/history?${params()}`); items.value = result.items; total.value = result.total; next.value = result.nextOffset }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
async function download(format: string) {
  busy.value = true; error.value = ''
  try {
    const all: object[] = []; let position: number | null = 0
    const frozen = new Date().toISOString()
    do { const search = params(position); search.set('limit', '1000'); search.set('before', frozen); const result: { items: object[]; nextOffset: number | null } = await api(`/api/history?${search}`); all.push(...result.items); position = result.nextOffset } while (position !== null)
    const fields = [...new Set(all.flatMap(item => Object.keys(item)))];
    const cell = (value: unknown) => { let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"` }
    const content = format === 'csv' ? '\ufeff' + [fields.map(cell).join(','), ...all.map(item => fields.map(field => cell((item as Record<string, unknown>)[field])).join(','))].join('\r\n') : JSON.stringify(all, null, 2)
    const url = URL.createObjectURL(new Blob([content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `axiom-${kind.value}.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (reason) { error.value = String(reason) } finally { busy.value = false }
}
watch([kind, provider, period], () => { since.value = period.value === 'all' ? '' : new Date(Date.now() - Number(period.value) * 86400000).toISOString(); void load(true) })
onMounted(() => { void load() })
</script>
<template>
<section class="card spaced">
  <div class="card-head history-head"><div><h2>日志流水</h2></div><div class="button-row compact"><button class="icon-button" type="button" aria-label="刷新日志流水" title="刷新" :disabled="busy" @click="load(true)"><RefreshCw :size="17" /></button><button class="icon-button" type="button" aria-label="搜索日志" :aria-expanded="searchOpen" @click="toggleSearch"><Search :size="17" /></button><div class="export-menu"><button class="button" type="button" :disabled="busy" :aria-expanded="exportOpen" @click="exportOpen = !exportOpen"><Download :size="14" />导出</button><div v-if="exportOpen" class="export-options"><button type="button" @click="exportOpen = false; download('csv')">CSV</button><button type="button" @click="exportOpen = false; download('json')">JSON</button></div></div></div></div>
  <form class="history-tools" @submit.prevent="load(true)">
    <label v-if="!usageOnly">类型<select v-model="kind" aria-label="历史类型" :disabled="busy"><option value="logs">系统日志</option><option value="calls">调用记录</option><option value="sessions">工具会话</option><option value="usage">用量记录</option></select></label>
    <label>时间<select v-model="period" aria-label="时间范围" :disabled="busy"><option value="all">全部时间</option><option value="1">最近 24 小时</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></label>
    <label>Provider<select v-model="provider" aria-label="Provider 筛选" :disabled="busy"><option value="">全部 Provider</option><option v-for="name in providers ?? []" :key="name" :value="name">{{ name }}</option></select></label>
    <div class="inline-search" :class="{ hidden: !searchOpen }" :aria-hidden="!searchOpen"><input v-model="query" aria-label="搜索日志流水" placeholder="搜索 Provider、模型或 ID" :disabled="busy || !searchOpen" /><button class="button" :disabled="busy || !searchOpen">搜索</button><button type="button" class="icon-button" aria-label="清除搜索" :disabled="!searchOpen" @click="query = ''; load(true)"><X :size="15" /></button></div>

  </form>
  <p v-if="error" class="error-banner">{{ error }}</p>
  <div class="table-scroll"><table><thead><tr><th>时间</th><th v-if="!usageOnly">事件 / 类型</th><th>Provider</th><th>模型 / ID</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th><th>详情</th></tr></thead><tbody><tr v-for="(item, index) in items" :key="index"><td>{{ formatTime(item.timestamp || item.startedAt || item.createdAt) }}</td><td v-if="!usageOnly">{{ item.action || item.state || item.tool || '用量' }}</td><td>{{ item.provider || '—' }}<small v-if="item.source === 'codex_cli_chatgpt'" class="table-sub">Codex CLI · ChatGPT</small><small v-if="item.source === 'codex_telegram_chatgpt'" class="table-sub">Telegram · Codex ChatGPT</small></td><td>{{ item.model || item.traceId || item.id || '—' }}</td><td>{{ formatTokens(item.inputTokens) }}</td><td>{{ formatTokens(item.outputTokens) }}</td><td>{{ formatTokens(item.totalTokens) }}</td><td><button class="text-button" @click="selected = item">查看</button></td></tr></tbody></table></div>
  <div v-if="!items.length" class="empty">没有匹配记录。</div><div class="button-row"><button class="button" :disabled="busy || offset === 0" @click="offset = Math.max(0, offset - 100); load()">上一页</button><span>共 {{ total }} 条 · 第 {{ Math.floor(offset / 100) + 1 }} 页</span><button class="button" :disabled="busy || next === null" @click="if (offset === 0) snapshot = new Date().toISOString(); offset = next ?? 0; load()">下一页</button></div>
  <div v-if="selected" class="modal-backdrop" @click.self="selected = null"><section class="modal" role="dialog" aria-modal="true" aria-label="历史记录详情"><h2>记录详情</h2><pre>{{ JSON.stringify(selected, null, 2) }}</pre><button class="button" @click="selected = null">关闭</button></section></div>
</section>
</template>
<style scoped>.history-head { align-items:center; margin-bottom:10px; }.history-tools { display:flex; align-items:center; flex-wrap:nowrap; gap:10px; margin-bottom:16px; overflow-x:auto; }.inline-search { display:flex; align-items:center; gap:8px; margin-left:auto; min-width:280px; flex:1; }.inline-search.hidden { visibility:hidden; }.inline-search input { min-width:120px; }.history-tools label { margin:0; font-size:11px; display:flex; align-items:center; gap:8px; }.history-tools input { flex:1; min-width:180px; width:auto; margin:0; }.history-tools select { width:auto; margin:0; }.export-menu { position:relative; }.export-options { position:absolute; right:0; top:100%; z-index:2; background:white; border:1px solid #ddd; border-radius:8px; padding:6px; display:grid; min-width:90px; }.export-options button { padding:8px; text-align:left; } pre { max-height:65vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; } td { overflow-wrap:anywhere; max-width:280px; } .button-row { font-size:12px; }</style>
