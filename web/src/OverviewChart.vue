<script setup lang="ts">
import { computed, ref } from 'vue'
import VChart from 'vue-echarts'
import type { Dashboard } from './console-api'

const props = defineProps<{ kind: 'trend' | 'activity' | 'providers'; usage: Dashboard['usage']; generatedAt: string }>()
const emit = defineEmits<{ selectDay: [date: string] }>()
type Metric = 'totalTokens' | 'inputTokens' | 'outputTokens'
const metric = ref<Metric>('totalTokens')
const metrics: Array<{ key: Metric; label: string }> = [
  { key: 'totalTokens', label: '总 Token' }, { key: 'inputTokens', label: '输入' }, { key: 'outputTokens', label: '输出' }
]
const colors = ['#3b82f6', '#f97316', '#8b5cf6', '#14b8a6', '#ec4899', '#22c55e', '#f59e0b', '#ef4444', '#64748b', '#06b6d4']
const activityColors = ['#edf2f7', '#bbf7d0', '#86efac', '#4ade80', '#16a34a']
const fullNumber = (value: number) => new Intl.NumberFormat('zh-CN').format(value)
const compactNumber = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const dates = computed(() => {
  const end = new Date(props.generatedAt)
  end.setUTCHours(0, 0, 0, 0)
  return Array.from({ length: 70 }, (_, index) => new Date(end.getTime() - (69 - index) * 86400000).toISOString().slice(0, 10))
})
const trendDates = computed(() => dates.value.slice(-30))
const providerRows = computed(() => props.usage.providers.filter(provider => provider.totalTokens > 0).map((provider, index) => ({
  ...provider,
  color: colors[index % colors.length]
})))
const trendProviders = computed(() => providerRows.value.filter(provider => provider.daily?.some(day => trendDates.value.includes(day.date) && day.totalTokens > 0)))
const tooltip = { renderMode: 'richText' as const, backgroundColor: '#fff', borderColor: '#e2e8f0', borderWidth: 1, padding: [12, 16], textStyle: { color: '#334155', fontSize: 12 }, extraCssText: 'box-shadow: 0 8px 28px rgba(15,23,42,.12);border-radius:10px;' }
const trendOption = computed(() => ({
  color: trendProviders.value.map(provider => provider.color),
  textStyle: { fontFamily: 'Inter, sans-serif', color: '#64748b' },
  tooltip: { ...tooltip, trigger: 'axis', confine: true, axisPointer: { type: 'line', lineStyle: { color: '#cbd5e1', type: 'dashed' } }, valueFormatter: (value: number) => `${fullNumber(value)} Token` },
  legend: { type: 'scroll', bottom: 0, left: 8, right: 8, icon: 'roundRect', itemWidth: 12, itemHeight: 4, itemGap: 18, textStyle: { fontSize: 11, color: '#64748b' }, pageIconSize: 10, pageTextStyle: { color: '#94a3b8' } },
  grid: { left: 12, right: 20, top: 20, bottom: 48, containLabel: true },
  xAxis: { type: 'category', data: trendDates.value, boundaryGap: false, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { color: '#94a3b8', fontSize: 10, hideOverlap: true, formatter: (date: string) => date.slice(5).replace('-', '/') } },
  yAxis: { type: 'value', min: 0, splitNumber: 4, axisLabel: { color: '#94a3b8', fontSize: 10, formatter: compactNumber }, splitLine: { lineStyle: { color: '#edf2f7', type: 'dashed' } } },
  series: trendProviders.value.map(provider => {
    const byDate = new Map(provider.daily.map(day => [day.date, day]))
    return { name: provider.provider, type: 'line', smooth: .25, showSymbol: false, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2.5 }, emphasis: { focus: 'series' }, data: trendDates.value.map(date => byDate.get(date)?.[metric.value] ?? 0) }
  })
}))
const providerOption = computed(() => ({
  tooltip: { ...tooltip, trigger: 'item', confine: true, formatter: '{b}\n{c} Token · {d}%' },
  legend: { type: 'scroll', bottom: 0, left: 8, right: 8, icon: 'roundRect', itemWidth: 12, itemHeight: 4, itemGap: 18, textStyle: { fontSize: 11, color: '#64748b' }, pageIconSize: 10, pageTextStyle: { color: '#94a3b8' } },
  series: [{
    type: 'pie', radius: ['48%', '78%'], center: ['50%', '46%'],
    itemStyle: { borderRadius: 5, borderColor: '#fff', borderWidth: 3 },
    label: { show: false }, labelLine: { show: false },
    emphasis: { scaleSize: 5, label: { show: false } },
    data: providerRows.value.map(provider => ({ name: provider.provider, value: provider.totalTokens, itemStyle: { color: provider.color } }))
  }]
}))
const activityDays = computed(() => {
  const byDate = new Map(props.usage.daily.map(day => [day.date, day.totalTokens]))
  return dates.value.map(date => ({ date, total: byDate.get(date) ?? 0 }))
})
const activityTotal = computed(() => activityDays.value.reduce((total, day) => total + day.total, 0))
const activeDays = computed(() => activityDays.value.filter(day => day.total > 0).length)
const maxActivity = computed(() => Math.max(1, ...activityDays.value.map(day => day.total)))
const firstWeekday = computed(() => (new Date(`${dates.value[0]}T00:00:00Z`).getUTCDay() + 6) % 7)
const activityColumns = computed(() => Math.ceil((firstWeekday.value + 70) / 7))
const calendarCells = computed(() => Array.from({ length: activityColumns.value * 7 }, (_, index) => activityDays.value[index - firstWeekday.value] ?? null))
const activityTicks = computed(() => Array.from({ length: activityColumns.value }, (_, column) => {
  const day = calendarCells.value.slice(column * 7, column * 7 + 7).find(Boolean)
  return { column, label: day ? day.date.slice(5).replace('-', '/') : '' }
}).filter(tick => tick.column % 3 === 0))
function activityColor(total: number) {
  return activityColors[total <= 0 ? 0 : total <= maxActivity.value * .25 ? 1 : total <= maxActivity.value * .5 ? 2 : total <= maxActivity.value * .75 ? 3 : 4]
}
function onTrendClick(event: { dataIndex?: number }) {
  const date = trendDates.value[event.dataIndex ?? -1]
  if (date) emit('selectDay', date)
}
</script>

<template>
  <section v-if="kind === 'trend'" class="card large-card overview-chart">
    <div class="card-head"><div><h2>Token 使用趋势</h2><p>最近 30 天 · 每条曲线代表一个 Provider · UTC</p></div><div class="metric-tabs" aria-label="Token 统计指标"><button v-for="item in metrics" :key="item.key" :class="{ active: metric === item.key }" :aria-pressed="metric === item.key" @click="metric = item.key">{{ item.label }}</button></div></div>
    <div v-if="trendProviders.length" class="trend-canvas"><VChart :option="trendOption" autoresize @click="onTrendClick" /></div>
    <div v-else class="chart-empty">最近 30 天暂无用量记录。</div>
  </section>
  <section v-else-if="kind === 'providers'" class="card overview-chart distribution-card">
    <div class="card-head"><div><h2>Provider 用量占比</h2><p>累计 Token · 按服务商汇总</p></div><span class="chip">{{ providerRows.length }} 个 Provider</span></div>
    <div v-if="providerRows.length" class="distribution-body">
      <div class="donut-canvas"><VChart :option="providerOption" autoresize /><div class="donut-total"><strong :title="fullNumber(usage.totalTokens)">{{ compactNumber(usage.totalTokens) }}</strong><span>累计 Token</span></div></div>
    </div>
    <div v-else class="chart-empty">暂无用量数据。</div>
  </section>
  <section v-else class="card overview-chart activity-card">
    <div class="card-head"><div><h2>调用活动</h2><p>最近 70 天 · {{ activeDays }} 天有调用 · UTC</p></div><span class="chip">{{ compactNumber(activityTotal) }} Token</span></div>
    <div class="activity-body"><div class="activity-calendar" :style="{ '--weeks': activityColumns }">
      <div class="activity-axis" :style="{ gridTemplateColumns: `repeat(${activityColumns}, minmax(0, 1fr))` }"><span v-for="tick in activityTicks" :key="tick.column" :style="{ gridColumn: tick.column + 1 }">{{ tick.label }}</span></div>
      <div class="activity-weekdays"><span v-for="weekday in ['一', '二', '三', '四', '五', '六', '日']" :key="weekday">{{ weekday }}</span></div>
      <div class="activity-cells" :style="{ gridTemplateColumns: `repeat(${activityColumns}, minmax(0, 1fr))` }"><template v-for="(day, index) in calendarCells" :key="day?.date ?? `padding-${index}`"><button v-if="day" :title="`${day.date} · ${fullNumber(day.total)} Token`" :aria-label="`${day.date}，${fullNumber(day.total)} Token，查看当天日志`" :style="{ background: activityColor(day.total) }" @click="emit('selectDay', day.date)"></button><span v-else class="activity-padding"></span></template></div>
    </div></div>
    <div class="activity-footer"><span>点击日期查看日志</span><div class="activity-scale"><span>少</span><i v-for="color in activityColors" :key="color" :style="{ background: color }"></i><span>多</span></div></div>
  </section>
</template>

<style scoped>
.overview-chart{min-width:0;container-type:inline-size}.overview-chart .card-head{align-items:flex-start;flex-wrap:wrap;gap:12px}.metric-tabs{display:flex;gap:2px;padding:3px;background:#f1f5f9;border-radius:8px}.metric-tabs button{border:0;border-radius:6px;background:transparent;color:#8492a6;font-size:11px;line-height:20px;padding:3px 10px;white-space:nowrap}.metric-tabs button.active{background:#fff;color:#2563eb;box-shadow:0 1px 4px #0f172a12}.trend-canvas{height:280px;width:100%}.chart-empty{min-height:260px;display:grid;place-items:center;color:#94a3b8;font-size:12px}.distribution-body{min-height:260px;display:grid;grid-template-columns:minmax(135px,.9fr) minmax(150px,1.1fr);align-items:center;gap:14px}.donut-canvas{height:220px;min-width:0;position:relative}.donut-total{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:5px;pointer-events:none}.donut-total strong{font-size:21px;letter-spacing:-.035em;color:#24354f;font-variant-numeric:tabular-nums}.donut-total span{font-size:10px;color:#94a3b8}.provider-legend{list-style:none;margin:0;padding:0;max-height:250px;overflow:auto;scrollbar-width:thin}.provider-legend li{display:flex;align-items:center;gap:9px;padding:10px 1px;border-bottom:1px solid #f1f5f9;min-width:0}.provider-legend li:last-child{border:0}.legend-dot{width:8px;height:8px;border-radius:3px;flex:none}.provider-legend li>div{flex:1;min-width:0}.provider-legend strong{display:block;font-size:11px;font-weight:600;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.provider-legend small{display:block;font-size:10px;color:#94a3b8;margin-top:4px;font-variant-numeric:tabular-nums}.legend-percent{color:#334155;font-weight:600;font-size:11px;font-variant-numeric:tabular-nums;flex:none}.activity-calendar{display:grid;grid-template-columns:18px minmax(0,1fr);grid-template-rows:20px 220px;column-gap:10px;row-gap:8px}.activity-axis{grid-column:2;display:grid;gap:5px;color:#94a3b8;font-size:10px}.activity-axis span{white-space:nowrap}.activity-weekdays{display:grid;grid-template-rows:repeat(7,minmax(0,1fr));gap:5px;color:#94a3b8;font-size:10px;align-items:center;text-align:center}.activity-cells{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,minmax(0,1fr));gap:5px;min-width:0}.activity-cells button{width:100%;height:100%;padding:0;border:0;border-radius:5px;transition:box-shadow .15s}.activity-cells button:hover,.activity-cells button:focus-visible{box-shadow:inset 0 0 0 2px #16a34a;outline:0}.activity-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px;color:#94a3b8;font-size:10px}.activity-scale{display:flex;align-items:center;gap:4px}.activity-scale i{display:block;width:10px;height:10px;border-radius:2px}.activity-scale span:first-child{margin-right:3px}.activity-scale span:last-child{margin-left:3px}@container (max-width: 320px){.distribution-body{grid-template-columns:1fr;gap:0}.donut-canvas{height:190px}.provider-legend{max-height:155px}.activity-calendar{column-gap:7px;grid-template-rows:20px 200px}.activity-cells,.activity-weekdays,.activity-axis{gap:4px}}
.trend-canvas{height:420px}
.chart-empty{min-height:380px}
.distribution-card,.activity-card{display:flex;flex-direction:column;min-height:480px}
.distribution-body{display:block;min-height:0;flex:1}
.donut-canvas{height:380px}
.donut-total{bottom:8%}
.donut-total strong{font-size:28px}
.activity-body{flex:1;min-height:330px;display:grid;place-items:center}
.activity-calendar{width:min(100%,calc(28px + var(--weeks) * 26px - 6px));grid-template-rows:20px auto}
.activity-cells{grid-template-rows:repeat(7,1fr);gap:6px}
.activity-cells button,.activity-padding{aspect-ratio:1;border-radius:3px}
.activity-weekdays,.activity-axis{gap:6px}
.activity-footer{margin-top:24px}
@container (max-width:320px){.donut-canvas{height:350px}.activity-calendar{column-gap:10px;grid-template-rows:20px auto}.activity-cells,.activity-weekdays,.activity-axis{gap:6px}}
@media(max-width:750px){.trend-canvas{height:360px}.distribution-card,.activity-card{min-height:450px}}
</style>
