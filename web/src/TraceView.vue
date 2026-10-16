<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowRight, CheckCircle2, ChevronRight, CircleHelp, Clock3, Search, TerminalSquare, TriangleAlert, X } from 'lucide-vue-next'
import type { CallItem, Dashboard, LogItem, SessionItem } from './console-api'

const props = defineProps<{ data: Dashboard; selectedDay: string | null; initialTab?: 'calls' | 'logs' }>()
const emit = defineEmits<{ clearDay: [] }>()
type Tab = 'calls' | 'sessions' | 'logs'
const tabs = [
  { id: 'calls', label: '调用记录', title: '这次执行，结果如何？', text: '查看执行结果、Provider 切换和事件过程。', placeholder: '搜索模型、Provider、工具或调用 ID…' },
  { id: 'sessions', label: '工具会话', title: '工具何时启动，如何结束？', text: '查看 Claude、Codex 等工具的启动与退出记录。这里不保存聊天内容。', placeholder: '搜索工具、初始模型、Provider 或会话 ID…' },
  { id: 'logs', label: '系统日志', title: '发生了什么，哪里需要排查？', text: '按事件查看模型请求、服务检查、配置变更和系统运行。', placeholder: '搜索事件说明、Provider、action 或 traceId…' }
] as const
const tab = ref<Tab>(props.initialTab ?? 'calls')
const queries = ref<Record<Tab, string>>({ calls: '', sessions: '', logs: '' })
const status = ref('all')
const provider = ref('')
const level = ref('')
const category = ref('')
const selected = ref<string | null>(null)
const drawer = ref<HTMLDialogElement | null>(null)
let previousOverflow: string | null = null
const currentTab = computed(() => tabs.find(item => item.id === tab.value)!)
const categories: Record<string, string> = { model: '模型请求', check: '服务检查', config: '配置变更', system: '系统运行' }
const levels: Record<string, string> = { info: '信息', warn: '警告', error: '错误' }
const results: Record<CallItem['state'], string> = { succeeded: '执行成功', failed: '执行失败', unknown: '结果未知' }
const resultClass = (state: CallItem['state']) => state === 'succeeded' ? 'ok' : state === 'failed' ? 'error' : 'unknown'
const providers = computed(() => [...new Set([
  ...props.data.providers.map(item => item.name),
  ...props.data.logs.flatMap(event => [event.provider, event.from, event.to]),
  ...props.data.sessions.map(session => session.provider)
].filter((name): name is string => Boolean(name)))].sort())
const dayCalls = computed(() => props.data.calls.filter(call => (!props.selectedDay || call.events.some(event => event.timestamp.startsWith(props.selectedDay!))) && (!provider.value || call.route.includes(provider.value))))
const totals = computed(() => [
  { label: '执行成功', count: dayCalls.value.filter(call => call.state === 'succeeded').length, icon: CheckCircle2, tone: 'mint' },
  { label: '执行失败', count: dayCalls.value.filter(call => call.state === 'failed').length, icon: TriangleAlert, tone: 'peach' },
  { label: '结果未知', count: dayCalls.value.filter(call => call.state === 'unknown').length, icon: CircleHelp, tone: 'butter' },
  { label: '发生切换', count: dayCalls.value.filter(call => call.switchCount > 0).length, icon: ArrowRight, tone: 'lavender' }
])
function matches(value: string, query: string) { return value.toLowerCase().includes(query.trim().toLowerCase()) }
const calls = computed(() => dayCalls.value.filter(call =>
  (status.value === 'all' || (status.value === 'switched' ? call.switchCount > 0 : status.value === 'retried' ? call.retryCount > 0 : call.state === status.value)) &&
  matches(`${call.id} ${call.model ?? ''} ${call.tool ?? ''} ${call.route.join(' ')} ${results[call.state]}`, queries.value.calls)))
const sessions = computed(() => props.data.sessions.filter(session =>
  (!props.selectedDay || session.startedAt.startsWith(props.selectedDay)) && (!provider.value || session.provider === provider.value) &&
  matches(`${session.id} ${session.tool} ${session.provider} ${session.model}`, queries.value.sessions)))
const actionLabels: Record<string, string> = {
  provider_resolved: '选定候选 Provider', provider_resolved_exact: '选定指定 Provider', fallback_skip_provider: '跳过不可用 Provider',
  failover_disabled: '已禁用自动切换', fallback_applied: '应用 Provider 切换', runtime_fallback_retry: '执行失败，转向下一 Provider',
  runtime_provider_fallback_retry: '任务失败，转向下一 Provider', runtime_server_provider_fallback: '请求失败，尝试下一 Provider',
  provider_failover_automatic: '自动切换 Provider', provider_failover_manual: '手动切换 Provider', provider_failover_confirmation_required: '切换等待确认',
  provider_retry: '在同一 Provider 上重试', tool_start: '开始工具执行', tool_spawn: '启动工具进程',
  tool_run_settled: '工具执行成功', runtime_provider_settled: '模型任务执行成功', runtime_server_request_settled: '收到上游响应',
  tool_candidates_exhausted: '所有工具候选执行失败', runtime_provider_candidates_exhausted: '所有任务候选执行失败',
  runtime_server_candidates_exhausted: '所有请求候选执行失败', runtime_server_request_failed: '请求执行失败', provider_candidates_unavailable: '没有可用 Provider',
  task_completed: '任务已完成', task_failed: '任务执行失败',
  openai_usage_proxy_request: '发送模型请求', openai_usage_proxy_recorded: '记录模型用量', openai_usage_proxy_no_usage: '响应未包含用量',
  openai_usage_proxy_error: '模型代理异常', openai_usage_proxy_upstream_error: '上游连接异常',
  openai_usage_proxy_responses_chat_fallback: '切换兼容协议后重试', usage_proxy_close_failed: '用量代理关闭异常',
  provider_health_check: '检查服务连接', provider_model_discovery: '获取模型目录', provider_model_probe: '探测模型可用性',
  deep_fallback: '深度检查切换候选', token_usage_recorded: '记录检查用量',
  web_settings_updated: '更新本地配置', web_settings_restored: '恢复本地配置', codex_provider_set: '更新 Codex 模型配置', codex_proxy_set: '更新 Codex 代理配置',
  web_model_pricing_updated: '更新模型价格', web_model_pricing_removed: '移除模型价格', command_start: '执行 CLI 命令', command_error: 'CLI 命令执行异常',
  claude_start: '启动 Claude 任务', codex_start: '启动 Codex 任务', codex_session_detected: '识别 Codex 会话',
  claude_permission_constrained: '应用 Claude 权限限制', image_generated: '图像生成完成', image_generated_url: '图像链接生成完成', image_generation_provider_failed: '图像 Provider 执行失败',
  bot_start: '启动 Telegram Bot', bot_stop: '停止 Telegram Bot', bot_error: 'Telegram Bot 异常', bot_fatal: 'Telegram Bot 致命异常',
  bot_restart_spawned: '重新启动 Telegram Bot', bot_restart_failed: 'Telegram Bot 重启失败', polling_started: '开始接收 Telegram 消息',
  update_received: '收到 Telegram 更新', slash_command_received: '收到快捷命令', access_denied: '拒绝未授权访问',
  runtime_service_access_denied: '拒绝未授权能力调用', proxy_enabled: '启用网络代理', orphan_reset: '重置中断的任务',
  report_generated: '生成运行报告', command_register_start: '注册快捷命令', lifecycle_hook_failed: '生命周期回调失败',
  set_commands_failed: '快捷命令设置失败', set_chat_commands_failed: '聊天命令设置失败', reset_chat_commands_failed: '聊天命令重置失败'
}
const reasons: Record<string, string> = { circuit_open: '熔断保护中', health_error: '连接检查失败', no_compatible_model: '没有兼容模型', candidates_exhausted: '候选已用尽', non_fallback_error: '此类错误不再切换', upstream_error: '上游服务异常', headers_timeout: '等待上游响应超时' }
function eventTitle(event: LogItem) { return actionLabels[event.action] ?? `${categories[event.kind]}事件` }
const logs = computed(() => props.data.logs.filter(event =>
  (!props.selectedDay || event.timestamp.startsWith(props.selectedDay)) && (!provider.value || [event.provider, event.from, event.to].includes(provider.value)) &&
  (!level.value || event.level === level.value) && (!category.value || event.kind === category.value) &&
  matches(`${eventTitle(event)} ${event.action} ${event.traceId ?? ''} ${event.provider ?? ''} ${event.model ?? ''} ${categories[event.kind]}`, queries.value.logs)))
const detail = computed(() => props.data.calls.find(call => call.id === selected.value))
function date(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—' }
function duration(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return '未记录'
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60000) return `${(value / 1000).toFixed(1)} 秒`
  if (value < 3600000) return `${Math.floor(value / 60000)} 分 ${Math.floor(value % 60000 / 1000)} 秒`
  return `${Math.floor(value / 3600000)} 小时 ${Math.floor(value % 3600000 / 60000)} 分`
}
function callDuration(call: CallItem) { return call.durationMs !== null ? duration(call.durationMs) : call.observedDurationMs !== null ? `记录跨度 ${duration(call.observedDurationMs)}` : '耗时未记录' }
function sessionDuration(session: SessionItem) { return session.endedAt ? duration(Date.parse(session.endedAt) - Date.parse(session.startedAt)) : '—' }
function sessionResult(session: SessionItem) { return !session.endedAt ? '尚无退出记录' : session.status === 'failed' || (session.exitCode !== null && session.exitCode !== 0) ? '异常退出' : '正常结束' }
function sessionCalls(sessionId: string) { return props.data.calls.filter(call => call.sessionIds.includes(sessionId)) }
function relatedCall(event: LogItem) { return event.traceId ? props.data.calls.find(call => call.id === event.traceId) : undefined }
function openCall(id: string) { selected.value = id }
function closeDrawer() { drawer.value?.close() }
function backdropClick(event: MouseEvent) { if (event.target === event.currentTarget) closeDrawer() }
function restoreScroll() { if (previousOverflow !== null) { document.body.style.overflow = previousOverflow; previousOverflow = null } }
watch(detail, async value => {
  await nextTick()
  if (value && drawer.value && !drawer.value.open) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    drawer.value.showModal()
  } else if (!value) {
    drawer.value?.close()
    restoreScroll()
  }
})
watch(() => props.selectedDay, () => { tab.value = 'calls'; selected.value = null })
onBeforeUnmount(() => { drawer.value?.close(); restoreScroll() })
</script>

<template>
  <div class="subnav" aria-label="运行记录分类">
    <button v-for="item in tabs" :key="item.id" :class="{ active: tab === item.id }" :aria-pressed="tab === item.id" @click="tab = item.id">{{ item.label }}</button>
  </div>
  <div class="history-intro"><h2>{{ currentTab.title }}</h2><p>{{ currentTab.text }}</p></div>
  <div class="page-actions history-filters">
    <label class="search"><Search :size="16" /><input v-model="queries[tab]" :aria-label="currentTab.placeholder" :placeholder="currentTab.placeholder" /></label>
    <div class="button-row compact">
      <button v-if="selectedDay" class="chip clickable" aria-label="清除日期筛选" @click="emit('clearDay')">{{ selectedDay }} UTC <X :size="12" /></button>
      <select v-model="provider" aria-label="Provider 筛选"><option value="">全部 Provider</option><option v-for="name in providers" :key="name" :value="name">{{ name }}</option></select>
      <select v-if="tab === 'calls'" v-model="status" aria-label="调用结果筛选"><option value="all">全部结果</option><option value="succeeded">执行成功</option><option value="failed">执行失败</option><option value="unknown">结果未知</option><option value="switched">发生切换</option><option value="retried">发生重试</option></select>
      <template v-if="tab === 'logs'">
        <select v-model="category" aria-label="日志分类筛选"><option value="">全部分类</option><option v-for="(label, key) in categories" :key="key" :value="key">{{ label }}</option></select>
        <select v-model="level" aria-label="日志级别筛选"><option value="">全部级别</option><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option></select>
      </template>
    </div>
  </div>

  <template v-if="tab === 'calls'">
    <div class="history-totals"><div v-for="item in totals" :key="item.label" class="history-total"><span class="history-total-icon" :class="item.tone"><component :is="item.icon" :size="18" /></span><div><span>{{ item.label }}</span><strong>{{ item.count }}</strong></div></div></div>
    <div class="info-banner"><Clock3 :size="17" /><p>基于最近 {{ data.logs.length }} 条日志，按执行归组；一次工具执行可能包含多次模型请求。未记录终止事件的调用显示“结果未知”。{{ selectedDay ? '日期按 UTC 事件日期筛选。' : '' }}</p></div>
    <section class="card call-card">
      <div class="card-head"><div><h2>调用记录 <span class="hand-tag">every run has a story</span></h2><p>{{ calls.length }} 条匹配记录 · 点击查看执行过程</p></div></div>
      <div class="call-list">
        <button v-for="call in calls" :key="call.id" class="call-row" :aria-label="`查看调用：${call.model ?? '模型未记录'}，${results[call.state]}，${date(call.startedAt)}`" @click="openCall(call.id)">
          <span class="call-icon" :class="resultClass(call.state)"><CheckCircle2 v-if="call.state === 'succeeded'" :size="19" /><TriangleAlert v-else-if="call.state === 'failed'" :size="19" /><CircleHelp v-else :size="19" /></span>
          <span class="call-main"><strong>{{ call.model ?? '模型未记录' }}</strong><small>{{ call.tool ?? '工具未记录' }} · {{ call.provider ? `结果 Provider：${call.provider}` : `起始 Provider：${call.initialProvider ?? '未记录'}` }}</small><span class="call-tags"><span v-if="call.switchCount" class="chip">切换 {{ call.switchCount }} 次</span><span v-if="call.retryCount" class="chip">重试 {{ call.retryCount }} 次</span><span v-if="!call.provider" class="call-muted">结果 Provider 未记录</span></span></span>
          <span class="call-time"><span>{{ date(call.startedAt) }}</span><small>{{ callDuration(call) }}</small></span>
          <span class="pill" :class="resultClass(call.state)">{{ results[call.state] }}</span><ChevronRight :size="16" class="call-chevron" />
        </button>
      </div>
      <div v-if="!calls.length" class="empty"><CircleHelp :size="30" /><p>{{ data.calls.length ? '没有匹配的调用记录，请调整日期、结果或搜索条件。' : '暂无可关联的调用记录。通过 Runtime 执行任务后，有 traceId 的调用会显示在这里。' }}</p><small>未带调用 ID 的事件仍可在“系统日志”查看。</small></div>
    </section>
  </template>

  <template v-else-if="tab === 'sessions'">
    <div class="info-banner"><TerminalSquare :size="17" /><p>显示最近 {{ data.sessions.length }} 次工具启动记录。模型和 Provider 为启动时配置；没有退出记录时无法确认进程是否仍在运行。日期按启动日筛选。</p></div>
    <section class="card table-card"><div class="table-scroll"><table><thead><tr><th>工具 / 初始模型</th><th>初始 Provider</th><th>开始时间</th><th>运行时长</th><th>退出结果</th><th>关联记录</th></tr></thead><tbody>
      <tr v-for="session in sessions" :key="session.id">
        <td><strong>{{ session.tool }}</strong><small class="table-sub">{{ session.model }}</small></td><td>{{ session.provider }}</td><td>{{ date(session.startedAt) }}</td><td>{{ sessionDuration(session) }}</td>
        <td><span class="pill" :class="!session.endedAt ? 'unknown' : session.status === 'failed' || (session.exitCode !== null && session.exitCode !== 0) ? 'error' : 'ok'">{{ sessionResult(session) }}</span><small v-if="session.exitCode !== null" class="table-sub">退出码 {{ session.exitCode }}</small></td>
        <td><details class="session-details"><summary>{{ sessionCalls(session.id).length ? `${sessionCalls(session.id).length} 条调用` : '会话详情' }}</summary><div><code>{{ session.id }}</code><p>结束：{{ date(session.endedAt) }}</p><p v-if="session.fallbackFrom">启动前从 {{ session.fallbackFrom }} 切换</p><button v-for="call in sessionCalls(session.id)" :key="call.id" class="link-button" @click="openCall(call.id)">查看关联调用 <ArrowRight :size="12" /></button><p v-if="!sessionCalls(session.id).length">日志窗口内暂无明确关联的调用。</p></div></details></td>
      </tr>
    </tbody></table></div><div v-if="!sessions.length" class="empty">{{ data.sessions.length ? '没有匹配的工具会话，请调整启动日期、Provider 或搜索条件。' : '还没有工具会话。通过 ai use 启动 Claude 或 Codex 后，可在这里查看启动与退出记录。' }}</div></section>
  </template>

  <template v-else>
    <p class="history-count">最近 {{ data.logs.length }} 条事件中，{{ logs.length }} 条匹配 · 展开事件查看原始字段</p>
    <section class="card log-card"><article v-for="(event, index) in logs" :key="`${event.timestamp}-${index}`" class="log-row">
      <details><summary><span class="pill" :class="event.level === 'error' ? 'error' : event.level === 'warn' ? 'unknown' : ''">{{ levels[event.level] ?? event.level }}</span><span class="log-main"><strong>{{ eventTitle(event) }}</strong><small>{{ categories[event.kind] }}<template v-if="event.provider"> · {{ event.provider }}</template><template v-if="event.from || event.to"> · {{ event.from ?? '—' }} → {{ event.to ?? '—' }}</template></small></span><time>{{ date(event.timestamp) }}</time><ChevronRight :size="15" /></summary><div class="log-detail"><p v-if="event.model">模型：{{ event.model }}</p><p v-if="event.reason">原因：{{ reasons[event.reason] ?? event.reason }}</p><pre>{{ JSON.stringify(event, null, 2) }}</pre></div></details>
      <button v-if="relatedCall(event)" class="link-button log-link" @click="openCall(event.traceId!)">查看调用 <ArrowRight :size="12" /></button>
    </article><div v-if="!logs.length" class="empty">{{ data.logs.length ? '没有匹配的系统日志，请调整分类、级别、日期或搜索条件。' : '暂无系统日志。服务检查、配置保存和模型执行事件会显示在这里。' }}</div></section>
  </template>

  <Teleport to="body"><dialog ref="drawer" class="history-drawer" aria-labelledby="call-detail-title" @click="backdropClick" @close="selected = null; restoreScroll()">
    <div v-if="detail" class="drawer-body">
      <header class="drawer-heading"><div><span class="eyebrow">EXECUTION DETAILS</span><h2 id="call-detail-title">调用详情</h2></div><button class="icon-button" aria-label="关闭调用详情" autofocus @click="closeDrawer"><X :size="18" /></button></header>
      <section class="result-paper"><span class="pill" :class="resultClass(detail.state)">{{ results[detail.state] }}</span><h3>{{ detail.model ?? '模型未记录' }}</h3><p v-if="detail.state === 'unknown'">日志窗口内缺少终止事件，无法确认最终结果。</p><dl><div><dt>结果 Provider</dt><dd>{{ detail.provider ?? '未记录' }}</dd></div><div><dt>执行工具</dt><dd>{{ detail.tool ?? '未记录' }}</dd></div><div><dt>首条事件</dt><dd>{{ date(detail.startedAt) }}</dd></div><div><dt>{{ detail.durationMs !== null ? '记录耗时' : '事件记录跨度' }}</dt><dd>{{ duration(detail.durationMs ?? detail.observedDurationMs) }}</dd></div></dl></section>
      <p class="drawer-note">结果 Provider 取自终止事件。工具执行可能包含多次请求，此处不能代表每次请求的实际承接者；未记录耗时时仅显示事件跨度。</p>
      <section class="drawer-section"><div class="drawer-section-heading"><h3>Provider 过程</h3><span>{{ detail.switchCount }} 次切换 · {{ detail.retryCount }} 次同 Provider 重试</span></div><div class="route-summary"><template v-for="(name, index) in detail.route" :key="`${index}-${name}`"><ArrowRight v-if="index" :size="14" /><span>{{ name }}</span></template><span v-if="!detail.route.length">暂无 Provider 过程</span></div><p class="drawer-note">按已记录事件展示，跳过候选不作为实际承接记录；重试和切换分别计数。</p></section>
      <section class="drawer-section"><h3>事件时间线</h3><div class="timeline history-timeline"><div v-for="(event, index) in detail.events" :key="index" class="timeline-row"><div class="timeline-dot" :class="event.level"></div><strong>{{ eventTitle(event) }}</strong><p v-if="event.provider || event.model">{{ event.provider ?? '' }}{{ event.model ? ` · ${event.model}` : '' }}</p><p v-if="event.from || event.to">{{ event.from ?? '—' }} → {{ event.to ?? '—' }}</p><p v-if="event.reason">{{ reasons[event.reason] ?? event.reason }}</p><small>{{ date(event.timestamp) }}<template v-if="event.status !== null"> · 状态 {{ event.status }}</template><template v-if="event.attempt !== null"> · 第 {{ event.attempt }} 次尝试</template></small><details class="event-raw"><summary>原始字段</summary><pre>{{ JSON.stringify(event, null, 2) }}</pre></details></div></div></section>
      <details class="technical-details"><summary>调用 ID 与技术信息</summary><pre>{{ JSON.stringify({ traceId: detail.id, startedAt: detail.startedAt, endedAt: detail.endedAt, lastEventAt: detail.lastEventAt, sessionIds: detail.sessionIds }, null, 2) }}</pre><p>Token 和成本请在“用量统计”查看。现有记录未提供可靠的逐调用用量关联。</p></details>
    </div>
  </dialog></Teleport>
</template>

<style scoped>
.history-intro { margin-bottom: 22px; }
.history-intro h2 { font-size: 17px; font-weight: 600; margin: 0 0 8px; }
.history-intro p, .history-count { font-size: 11px; color: #968875; line-height: 1.8; }
.history-filters { flex-wrap: wrap; gap: 12px; }
.history-filters .search { flex: 1 1 300px; max-width: 420px; }
.history-filters select { max-width: 220px; }
.history-totals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 20px; }
.history-total { display: flex; gap: 13px; align-items: center; border: 1px solid var(--border); border-radius: 12px 9px 13px 9px; padding: 17px; background: var(--paper); }
.history-total-icon { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 11px 8px 12px 8px; transform: rotate(-5deg); flex: none; }
.history-total span:not(.history-total-icon) { font-size: 10px; color: #998c77; }
.history-total strong { display: block; font-size: 23px; margin-top: 4px; font-weight: 550; }
.call-row { display: flex; width: 100%; align-items: center; gap: 16px; background: none; border: 0; border-top: 1px solid #eee8dd; text-align: left; padding: 21px 4px; color: var(--ink); }
.call-row:hover { background: #f7f2fa; border-radius: 8px; }
.call-icon { width: 37px; height: 37px; border: 1px dashed #d4c2a0; border-radius: 12px 9px 13px 8px; display: grid; place-items: center; color: #ad9258; background: #faf3e1; flex: none; }
.call-icon.ok { color: #829b76; border-color: #b9cbb0; background: #eef3e9; }
.call-icon.error { color: #bd8179; border-color: #ddbeb3; background: #faf0e9; }
.call-main { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.call-main strong { font-size: 13px; font-weight: 600; }
.call-main small { display: block; color: #9a8a73; font-size: 10px; margin-top: 8px; }
.call-tags { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 8px; align-items: center; }
.call-tags:empty { display: none; }
.call-muted { font-size: 9px; color: #ae9b7b; }
.call-time { color: #9a8a73; font-size: 10px; text-align: right; }
.call-time small { display: block; margin-top: 8px; font-size: 9px; color: #b0a189; }
.call-chevron { color: #b6a3c1; flex: none; }
.session-details { white-space: normal; min-width: 100px; max-width: 240px; }
.session-details summary, .technical-details summary, .event-raw summary { cursor: pointer; font-size: 10px; color: #8e779e; }
.session-details > div { font-size: 10px; line-height: 1.8; margin-top: 12px; overflow-wrap: anywhere; }
.session-details .link-button { margin: 6px 0; }
.log-card { padding: 0 22px; }
.log-row { position: relative; border-bottom: 1px solid #eee8dd; }
.log-row:last-child { border-bottom: 0; }
.log-row > details > summary { display: flex; align-items: center; gap: 15px; list-style: none; padding: 20px 0; cursor: pointer; }
.log-row > details > summary::-webkit-details-marker { display: none; }
.log-main { flex: 1; min-width: 0; }
.log-main strong { font-size: 12px; font-weight: 550; }
.log-main small { display: block; font-size: 10px; color: #a29279; margin-top: 7px; overflow-wrap: anywhere; }
.log-row time { font-size: 10px; color: #ab9d87; }
.log-row summary > svg { color: #b29cbd; transition: transform .15s; }
.log-row details[open] > summary > svg { transform: rotate(90deg); }
.log-detail { color: #998775; font-size: 11px; }
.log-link { margin: 0 0 16px 56px; }
.history-drawer { position: fixed; inset: 0 0 0 auto; width: min(630px, 100vw); height: 100dvh; max-width: 100vw; max-height: 100dvh; margin: 0; padding: 0; border: 1px solid #d8cce1; border-radius: 17px 0 0 12px; background: var(--paper); color: var(--ink); box-shadow: -10px 0 55px #49315422; }
.history-drawer::backdrop { background: #3c30494f; backdrop-filter: blur(2px); }
.drawer-body { padding: 27px; min-height: 100%; }
.drawer-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 23px; }
.drawer-heading h2 { font-size: 22px; margin: 8px 0 0; font-weight: 600; }
.result-paper { padding: 22px; background: #f3eef7; border: 1px solid #ddd1e8; border-radius: 13px 9px 15px 10px; }
.result-paper h3 { font-size: 19px; font-weight: 550; margin: 17px 0; overflow-wrap: anywhere; }
.result-paper > p { font-size: 11px; line-height: 1.8; color: #94819f; }
.result-paper dl { display: grid; grid-template-columns: 1fr 1fr; gap: 21px 15px; margin: 22px 0 0; }
.result-paper dt { font-size: 10px; color: #a08aaf; margin-bottom: 8px; }
.result-paper dd { font-size: 12px; margin: 0; overflow-wrap: anywhere; color: #7b668a; }
.drawer-note { font-size: 10px; color: #a1937f; line-height: 1.9; }
.drawer-section { margin-top: 28px; padding-top: 24px; border-top: 1px dashed #e2d9c9; }
.drawer-section h3 { font-size: 13px; font-weight: 600; margin: 0 0 20px; }
.drawer-section-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
.drawer-section-heading > span { font-size: 10px; color: #b09b7d; }
.history-timeline { max-height: none; overflow: visible; margin-top: 26px; }
.event-raw { margin-top: 10px; }
.event-raw pre, .technical-details pre { font-size: 10px; }
.technical-details { border-top: 1px dashed #e2d9c9; padding: 22px 0; }
.technical-details > p { font-size: 10px; color: #a19279; line-height: 1.9; }
@media (max-width: 1100px) { .call-row { gap: 10px; }.call-time { max-width: 130px; line-height: 1.7; }.history-total { padding: 14px 10px; gap: 9px; } }
@media (max-width: 600px) {
  .history-totals { grid-template-columns: 1fr 1fr; gap: 10px; }
  .history-filters .button-row { width: 100%; }.history-filters select { flex: 1; min-width: 100px; max-width: 100%; font-size: 12px; }
  .call-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 12px; padding-block: 20px; }
  .call-icon { width: 32px; height: 34px; }.call-time { grid-column: 2; grid-row: 2; max-width: none; text-align: left; }.call-time small { margin-top: 3px; }
  .call-row > .pill { grid-column: 3; grid-row: 1; align-self: start; }.call-chevron { grid-column: 3; grid-row: 2; justify-self: end; }
  .log-card { padding-inline: 15px; }.log-row > details > summary { flex-wrap: wrap; gap: 10px; }.log-main { flex-basis: calc(100% - 70px); }.log-row time { margin-left: 52px; }.log-row summary > svg { margin-left: auto; }
  .drawer-body { padding: 22px 18px; }.history-drawer { border-radius: 0; }.result-paper { padding: 18px; }
}
</style>
