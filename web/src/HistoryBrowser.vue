<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from './console-api'
const props = defineProps<{ initialKind?: string }>()
const kind = ref(props.initialKind ?? 'logs')
const query = ref('')
const items = ref<Record<string, unknown>[]>([])
const total = ref(0)
const offset = ref(0)
const next = ref<number | null>(null)
const busy = ref(false)
const live = ref(false)
const error = ref('')
const selected = ref<Record<string, unknown> | null>(null)
const snapshot = ref(new Date().toISOString())
let timer: ReturnType<typeof setInterval>
function params(start = offset.value) { return new URLSearchParams({ kind: kind.value, limit: '100', offset: String(start), q: query.value, ...(live.value ? {} : { before: snapshot.value }) }) }
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
watch(kind, () => { void load(true) })
watch(live, () => { if (live.value) { offset.value = 0; void load() } })
onMounted(() => { void load(); timer = setInterval(() => { if (live.value && document.visibilityState === 'visible') void load() }, 2000) })
onBeforeUnmount(() => clearInterval(timer))
</script>
<template><section class="card spaced"><div class="card-head"><div><h2>完整历史与导出</h2><p>从本机记录按页查询；实时模式每 2 秒刷新最新记录，下载内容使用安全字段投影。</p></div><label><input v-model="live" type="checkbox" :disabled="busy" /> 实时追踪</label></div><form class="history-tools" @submit.prevent="load(true)"><select v-model="kind" aria-label="历史类型" :disabled="busy"><option value="logs">系统日志</option><option value="calls">调用记录</option><option value="sessions">工具会话</option><option value="usage">用量记录</option></select><input v-model="query" aria-label="搜索完整历史" placeholder="搜索 Provider、模型、ID 或事件" :disabled="busy" /><button class="button" :disabled="busy">查询</button><button type="button" class="button" :disabled="busy" @click="download('csv')">导出 CSV</button><button type="button" class="button" :disabled="busy" @click="download('json')">下载 JSON</button></form><p v-if="error" class="error-banner">{{ error }}</p><div class="table-scroll"><table><thead><tr><th>时间</th><th>事件 / 类型</th><th>Provider</th><th>模型 / ID</th><th>详情</th></tr></thead><tbody><tr v-for="(item, index) in items" :key="index"><td>{{ item.timestamp || item.startedAt || item.createdAt }}</td><td>{{ item.action || item.state || item.tool || '用量' }}</td><td>{{ item.provider || '—' }}</td><td>{{ item.model || item.traceId || item.id || '—' }}</td><td><button class="text-button" @click="selected = item">查看</button></td></tr></tbody></table></div><div v-if="!items.length" class="empty">没有匹配记录。</div><div class="button-row"><button class="button" :disabled="busy || live || offset === 0" @click="offset = Math.max(0, offset - 100); load()">上一页</button><span>共 {{ total }} 条 · 第 {{ Math.floor(offset / 100) + 1 }} 页</span><button class="button" :disabled="busy || live || next === null" @click="offset = next ?? 0; load()">下一页</button></div><div v-if="selected" class="modal-backdrop" @click.self="selected = null"><section class="modal" role="dialog" aria-modal="true" aria-label="历史记录详情"><h2>记录详情</h2><pre>{{ JSON.stringify(selected, null, 2) }}</pre><button class="button" @click="selected = null">关闭</button></section></div></section></template>
<style scoped>.history-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }.history-tools input { flex: 1; min-width: 200px; width: auto; margin: 0; }.history-tools select { width: auto; margin: 0; } pre { max-height: 65vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; } td { overflow-wrap: anywhere; max-width: 280px; } .button-row { font-size: 12px; }</style>
