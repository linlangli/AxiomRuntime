<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, Clock3, Search, X } from 'lucide-vue-next'
import type { Dashboard, LogItem } from './console-api'

const props = defineProps<{ data: Dashboard; selectedDay: string | null }>()
const emit = defineEmits<{ clearDay: [] }>()
const tab = ref('调用链路')
const query = ref('')
const status = ref('all')
const selected = ref<string | null>(null)
const traces = computed(() => {
  const groups = new Map<string, LogItem[]>()
  for (const event of props.data.logs) {
    const key = event.traceId ?? `event-${event.timestamp}-${event.action}`
    groups.set(key, [...(groups.get(key) ?? []), event])
  }
  return [...groups.entries()].map(([id, group]) => {
    const events = [...group].sort((first, second) => first.timestamp.localeCompare(second.timestamp))
    const terminal = [...events].reverse().find(event => /settled|candidates_exhausted|tool_exit|run_completed|task_completed|task_failed/.test(event.action))
    const switched = events.some(event => /fallback|retry/.test(event.action) && !/skip/.test(event.action))
    const state = !events[0]?.traceId ? 'event' : terminal ? /exhausted/.test(terminal.action) || terminal.level === 'error' || terminal.status === 'failed' ? 'failed' : 'succeeded' : 'incomplete'
    const providers = [...new Set(events.flatMap(event => [event.from, event.provider, event.to]).filter((provider): provider is string => !!provider))]
    return { id, events, providers, provider: [...events].reverse().find(event => /settled/.test(event.action) && event.provider)?.provider ?? providers.at(-1) ?? 'Runtime', switched, state, time: events.at(-1)?.timestamp ?? '' }
  }).sort((first, second) => second.time.localeCompare(first.time))
})
const filtered = computed(() => traces.value.filter(trace => (!props.selectedDay || trace.events.some(event => event.timestamp.startsWith(props.selectedDay!))) && (status.value === 'all' || (status.value === 'switched' ? trace.switched : trace.state === status.value)) && `${trace.id} ${trace.providers.join(' ')} ${trace.events.map(event => `${event.action} ${event.model}`).join(' ')}`.toLowerCase().includes(query.value.toLowerCase())))
const detail = computed(() => traces.value.find(trace => trace.id === selected.value))
const logs = computed(() => props.data.logs.filter(event => (!props.selectedDay || event.timestamp.startsWith(props.selectedDay)) && `${event.action} ${event.traceId} ${event.provider} ${event.category}`.toLowerCase().includes(query.value.toLowerCase())))
const labels: Record<string, string> = { event: '独立事件', incomplete: '记录不完整', failed: '失败', succeeded: '已结束' }
function date(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN') : '—' }
</script>

<template>
  <div class="subnav" aria-label="调用追踪分类"><button v-for="item in ['调用链路', '会话记录', '运行日志']" :key="item" :class="{ active: tab === item }" :aria-pressed="tab === item" @click="tab = item">{{ item }}</button></div>
  <div class="page-actions"><label class="search"><Search :size="16" /><input v-model="query" placeholder="搜索 traceId、Provider 或日志事件…" /></label><div class="button-row compact"><button v-if="selectedDay" class="chip clickable" @click="emit('clearDay')">{{ selectedDay }} UTC <X :size="12" /></button><select v-if="tab === '调用链路'" v-model="status" aria-label="链路状态"><option value="all">全部链路</option><option value="switched">发生切换</option><option value="failed">终止失败</option><option value="succeeded">已有终止记录</option><option value="incomplete">记录不完整</option></select></div></div>
  <template v-if="tab === '调用链路'"><div class="info-banner"><Clock3 :size="17" /><p>展示最近 {{ data.logs.length }} 条事件中的链路。缺少终止事件时标记为“记录不完整”，不能据此判断正在运行；最终结果以终止事件为准。</p></div><div class="equal-grid trace-layout"><section class="card"><div class="card-head"><div><h2>调用链路 <span class="hand-tag">follow the trail</span></h2><p>{{ filtered.length }} 条匹配记录</p></div></div><div class="trace-list"><button v-for="trace in filtered" :key="trace.id" :class="{ selected: selected === trace.id }" @click="selected = trace.id"><span class="trace-dot" :class="trace.state === 'failed' ? 'error' : trace.state === 'succeeded' ? 'ok' : 'warning'"></span><span><strong>{{ trace.provider }} <small v-if="trace.switched" class="switch-label">发生切换</small></strong><small>{{ trace.id.startsWith('event-') ? '无 traceId' : trace.id }}</small><small>{{ date(trace.time) }}</small></span><span class="pill" :class="trace.state === 'failed' ? 'error' : trace.state === 'succeeded' ? 'ok' : 'unknown'">{{ labels[trace.state] }}</span></button><div v-if="!filtered.length" class="empty">没有匹配的链路。可清除日期或搜索条件。</div></div></section><section class="card"><div class="card-head"><div><h2>链路详情</h2><p class="break-word">{{ detail?.id ?? '选择一条链路，查看每个事件' }}</p></div></div><template v-if="detail"><div class="route-summary"><template v-for="(provider, index) in detail.providers" :key="provider"><ArrowRight v-if="index" :size="14" /><span>{{ provider }}</span></template></div><div class="timeline"><div v-for="(event, index) in detail.events" :key="index" class="timeline-row"><div class="timeline-dot" :class="event.level"></div><div><strong class="break-word">{{ event.action }}</strong><p>{{ event.provider ?? 'Runtime' }} {{ event.model ? `· ${event.model}` : '' }}</p><div v-if="event.from || event.to" class="footnote">{{ event.from ?? '—' }} → {{ event.to ?? '—' }}</div><p v-if="event.reason">原因：{{ event.reason }}</p><small>{{ date(event.timestamp) }} · {{ event.status ?? event.level }}{{ event.attempt !== null ? ` · 第 ${event.attempt} 次` : '' }}{{ event.durationMs !== null ? ` · ${event.durationMs} ms` : '' }}</small></div></div></div></template><div v-else class="empty trace-placeholder"><Clock3 :size="35" /><p>每一次切换，都有迹可循。</p></div></section></div></template>
  <section v-else-if="tab === '会话记录'" class="card table-card"><div class="table-scroll"><table><thead><tr><th>会话 ID</th><th>工具 / 模型</th><th>启动 Provider</th><th>状态</th><th>开始时间</th></tr></thead><tbody><tr v-for="session in data.sessions.filter(item => (!selectedDay || item.startedAt.startsWith(selectedDay)) && `${item.id} ${item.tool} ${item.provider} ${item.model}`.toLowerCase().includes(query.toLowerCase()))" :key="session.id"><td><code>{{ session.id }}</code></td><td>{{ session.tool }}<small class="table-sub">{{ session.model }}</small></td><td>{{ session.provider }}</td><td><span class="pill" :class="session.status === 'failed' ? 'error' : 'unknown'">{{ session.status }}</span></td><td>{{ date(session.startedAt) }}</td></tr></tbody></table></div><p class="footnote padded">会话记录展示启动时选择的 Provider；运行期间的实际承接者请查看调用链路。</p><div v-if="!data.sessions.length" class="empty">还没有会话记录。</div></section>
  <section v-else class="card table-card"><div class="table-scroll"><table><thead><tr><th>时间</th><th>级别</th><th>分类 / 事件</th><th>Provider</th><th>Trace ID</th></tr></thead><tbody><tr v-for="(event, index) in logs" :key="index"><td>{{ date(event.timestamp) }}</td><td><span class="pill" :class="event.level === 'error' ? 'error' : 'unknown'">{{ event.level }}</span></td><td>{{ event.action }}<small class="table-sub">{{ event.category }}</small></td><td>{{ event.provider ?? '—' }}</td><td><button v-if="event.traceId" class="link-button" @click="selected = event.traceId; tab = '调用链路'; status = 'all'">{{ event.traceId }}</button><span v-else>无 traceId</span></td></tr></tbody></table></div><div v-if="!logs.length" class="empty">没有匹配的日志。</div></section>
</template>
