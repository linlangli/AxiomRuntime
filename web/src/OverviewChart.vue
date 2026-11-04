<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import type { Dashboard } from './console-api'

const props = defineProps<{ kind: 'trend' | 'activity' | 'providers'; usage: Dashboard['usage']; generatedAt: string; windowDays?: number; scopeLabel?: string }>()
const emit = defineEmits<{ selectDay: [date: string] }>()
type Metric = 'totalTokens' | 'inputTokens' | 'outputTokens'
const metric = ref<Metric>('totalTokens')
const metrics: Array<{ key: Metric; label: string }> = [
  { key: 'totalTokens', label: '总 Token' }, { key: 'inputTokens', label: '输入' }, { key: 'outputTokens', label: '输出' }
]
const colors = ['#f18b50', '#7297db', '#cc8fb5', '#a18bce', '#75ada0', '#dbb75a', '#e18782', '#8b9bba', '#93b975', '#78b9c3']
const activityColors = ['#eeede6', '#e0e9cf', '#bacf9c', '#93b36d', '#648b43']
const legendPage = ref(0)
const legendSelected = ref<Record<string, boolean>>({})
const legendPageCount = computed(() => Math.max(1, Math.ceil(providerRows.value.length / 8)))
const legendRows = computed(() => providerRows.value.slice(legendPage.value * 8, legendPage.value * 8 + 8))
const selectedTotal = computed(() => providerRows.value.reduce((sum, row) => legendSelected.value[row.provider] === false ? sum : sum + row.totalTokens, 0))
watch(() => props.usage.providers.map(provider => provider.provider).join('|'), () => { legendPage.value = 0; legendSelected.value = {} })
const fullNumber = (value: number) => new Intl.NumberFormat('zh-CN').format(value)
const compactNumber = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const selectedWindowDays = computed(() => Math.max(1, props.windowDays ?? 70))
const activityWindowDays = computed(() => Math.max(70, selectedWindowDays.value))
const dates = computed(() => {
  const end = new Date(props.generatedAt)
  end.setUTCHours(0, 0, 0, 0)
  return Array.from({ length: activityWindowDays.value }, (_, index) => new Date(end.getTime() - (activityWindowDays.value - index - 1) * 86400000).toISOString().slice(0, 10))
})
const trendDates = computed(() => dates.value.slice(-selectedWindowDays.value))
const providerRows = computed(() => props.usage.providers.filter(provider => provider.totalTokens > 0).map((provider, index) => ({
  ...provider,
  color: colors[index % colors.length]
})))
const providerTotal = computed(() => providerRows.value.reduce((sum, row) => sum + row.totalTokens, 0))
const trendProviders = computed(() => providerRows.value.filter(provider => provider.daily?.some(day => trendDates.value.includes(day.date) && day.totalTokens > 0)))
const tooltip = { renderMode: 'richText' as const, backgroundColor: '#fffdf9', borderColor: '#dfd9ce', borderWidth: 1, padding: [12, 16], textStyle: { color: '#554e46', fontSize: 12 } }
const trendOption = computed(() => ({
  color: trendProviders.value.map(provider => provider.color),
  textStyle: { fontFamily: 'system-ui, sans-serif', color: '#847d73' },
  tooltip: { ...tooltip, trigger: 'axis', confine: true, axisPointer: { type: 'line', lineStyle: { color: '#cbd5e1', type: 'dashed' } }, valueFormatter: (value: number) => `${fullNumber(value)} Token` },
  legend: { type: 'scroll', bottom: 0, left: 8, right: 8, icon: 'roundRect', itemWidth: 12, itemHeight: 4, itemGap: 18, textStyle: { fontSize: 11, color: '#64748b' }, pageIconSize: 10, pageTextStyle: { color: '#94a3b8' } },
  grid: { left: 12, right: 20, top: 20, bottom: 48, containLabel: true },
  xAxis: { type: 'category', data: trendDates.value, boundaryGap: false, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { color: '#94a3b8', fontSize: 10, hideOverlap: true, formatter: (date: string) => date.slice(5).replace('-', '/') } },
  yAxis: { type: 'value', min: 0, splitNumber: 4, axisLabel: { color: '#94a3b8', fontSize: 10, formatter: compactNumber }, splitLine: { lineStyle: { color: '#edf2f7', type: 'dashed' } } },
  series: trendProviders.value.map(provider => {
    const byDate = new Map(provider.daily.map(day => [day.date, day]))
    return { name: provider.provider, type: 'line', smooth: .25, showSymbol: false, symbol: 'circle', symbolSize: 7, lineStyle: { width: 3, cap: 'round', join: 'round' }, areaStyle: { opacity: .035 }, emphasis: { focus: 'series' }, data: trendDates.value.map(date => byDate.get(date)?.[metric.value] ?? 0) }
  })
}))
const providerOption = computed(() => ({
  tooltip: { ...tooltip, trigger: 'item', confine: true, formatter: '{b}\n{c} Token · {d}%' },
  title: {
    text: compactNumber(selectedTotal.value), subtext: 'Token', left: 'center', top: 'center', itemGap: 5,
    textStyle: { color: '#76664e', fontFamily: 'system-ui, sans-serif', fontSize: 30, fontWeight: 550 },
    subtextStyle: { color: '#b0a18a', fontFamily: 'system-ui, sans-serif', fontSize: 10 }
  },
  legend: { show: false, selected: legendSelected.value },
  series: [{
    type: 'pie', radius: ['49%', '80%'], center: ['50%', '50%'], padAngle: 0,
    itemStyle: { borderRadius: 7, borderColor: 'transparent', borderWidth: 0, decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [1, 7], rotation: -.65, color: 'rgba(63,49,37,.12)' } },
    label: { show: false }, labelLine: { show: false },
    emphasis: { scaleSize: 5, label: { show: false } },
    data: providerRows.value.map(provider => ({ name: provider.provider, value: provider.totalTokens, itemStyle: { color: provider.color } }))
  }]
}))
const activityDays = computed(() => {
  const byDate = new Map(props.usage.daily.map(day => [day.date, day.totalTokens]))
  const firstSelectedIndex = dates.value.length - selectedWindowDays.value
  return dates.value.map((date, index) => ({
    date,
    inRange: index >= firstSelectedIndex,
    total: index >= firstSelectedIndex ? byDate.get(date) ?? 0 : 0
  }))
})
const activityTotal = computed(() => activityDays.value.reduce((total, day) => total + day.total, 0))
const activeDays = computed(() => activityDays.value.filter(day => day.total > 0).length)
const maxActivity = computed(() => Math.max(1, ...activityDays.value.map(day => day.total)))
const firstWeekday = computed(() => (new Date(`${dates.value[0]}T00:00:00Z`).getUTCDay() + 6) % 7)
const activityColumns = computed(() => Math.ceil((firstWeekday.value + activityDays.value.length) / 7))
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
    <div class="card-head"><div><h2>Token 使用趋势 <span class="hand-tag">a little progress</span></h2><p>最近 {{ windowDays ?? 30 }} 天 · 每条曲线代表一个 Provider · UTC</p></div><div class="metric-tabs" aria-label="Token 统计指标"><button v-for="item in metrics" :key="item.key" :class="{ active: metric === item.key }" :aria-pressed="metric === item.key" @click="metric = item.key">{{ item.label }}</button></div></div>
    <div v-if="trendProviders.length" class="trend-canvas"><VChart :option="trendOption" autoresize @click="onTrendClick" /></div>
    <div v-else class="chart-empty">所选区间暂无用量记录。</div>
  </section>
  <section v-else-if="kind === 'providers'" class="card overview-chart distribution-card">
    <div class="card-head"><div><h2>Provider 用量占比 <span class="hand-tag">the whole picture</span></h2><p>{{ scopeLabel ?? '累计 Token' }} · 按服务商汇总</p></div><span class="chip">{{ providerRows.length }} 个</span></div>
    <div v-if="providerRows.length" class="distribution-body">
      <div class="donut-canvas"><VChart :option="providerOption" autoresize /></div>
      <div class="sketch-legend" aria-label="Provider 图例"><button v-for="row in legendRows" :key="row.provider" :aria-pressed="legendSelected[row.provider] !== false" :class="{ hidden: legendSelected[row.provider] === false }" @click="legendSelected = { ...legendSelected, [row.provider]: legendSelected[row.provider] === false }"><i :style="{ background: row.color }"></i><span>{{ row.provider }}</span><strong>{{ providerTotal ? (row.totalTokens / providerTotal * 100).toFixed(1) : '0' }}%</strong></button></div>
      <div v-if="legendPageCount > 1" class="legend-pages"><button :disabled="legendPage === 0" aria-label="图例上一页" @click="legendPage--">‹</button><span>{{ legendPage + 1 }} / {{ legendPageCount }}</span><button :disabled="legendPage >= legendPageCount - 1" aria-label="图例下一页" @click="legendPage++">›</button></div>
    </div>
    <div v-else class="chart-empty">暂无用量数据。</div>
  </section>
  <section v-else class="card overview-chart activity-card">
    <div class="card-head"><div><h2>调用活动</h2><p>最近 {{ selectedWindowDays }} 天 · {{ activeDays }} 天有调用 · UTC</p></div><span class="chip">{{ compactNumber(activityTotal) }} Token</span></div>
    <div class="activity-body"><div class="activity-calendar" :style="{ '--weeks': activityColumns }">
      <div class="activity-axis"><span v-for="tick in activityTicks" :key="tick.column" :style="{ gridColumn: tick.column + 1 }">{{ tick.label }}</span></div>
      <div class="activity-weekdays"><span v-for="weekday in ['一', '二', '三', '四', '五', '六', '日']" :key="weekday">{{ weekday }}</span></div>
      <div class="activity-cells"><template v-for="(day, index) in calendarCells" :key="day?.date ?? `padding-${index}`"><button v-if="day?.inRange" :title="`${day.date} · ${fullNumber(day.total)} Token`" :aria-label="`${day.date}，${fullNumber(day.total)} Token，查看当天调用`" :style="{ background: activityColor(day.total) }" @click="emit('selectDay', day.date)"></button><span v-else class="activity-padding" :class="{ 'activity-outside': day }" :title="day ? `${day.date} · 当前区间外` : undefined"></span></template></div>
    </div></div>
    <div v-if="selectedWindowDays < activityWindowDays" class="activity-context">展示最近 {{ activityWindowDays }} 天日历 · 淡灰格为所选区间外</div>
    <div class="activity-footer"><span>点击日期查看调用记录</span><div class="activity-scale"><span>少</span><i v-for="color in activityColors" :key="color" :style="{ background: color }"></i><span>多</span></div></div>
  </section>
</template>

<style scoped>
.overview-chart { min-width: 0; container-type: inline-size; }
.overview-chart .card-head { align-items: flex-start; flex-wrap: wrap; gap: 12px; }
.metric-tabs { display: flex; gap: 2px; padding: 3px; background: #eee8db; border: 1px solid #e2d8c4; border-radius: 8px; }
.metric-tabs button { border: 0; border-radius: 6px; background: transparent; color: #ad9977; font-size: 11px; line-height: 20px; padding: 3px 10px; white-space: nowrap; }
.metric-tabs button.active { background: #fffdf9; color: #8f77a0; box-shadow: 0 1px 3px #ab90642b; }
.trend-canvas { height: 350px; width: 100%; }
.chart-empty { min-height: 350px; display: grid; place-items: center; color: #b4a48b; font-size: 12px; }
.distribution-card, .activity-card { display: flex; flex-direction: column; min-height: 490px; }
.distribution-body { display: grid; grid-template-columns: minmax(170px, 1fr) minmax(150px, 1fr); align-items: center; gap: 16px; flex: 1; min-height: 0; }
.donut-canvas { height: 300px; min-width: 0; position: relative; }
.activity-body { flex: 1; min-height: 380px; display: grid; place-items: center; overflow-x: auto; padding: 8px 0; }
.activity-calendar { --activity-cell: 22px; --activity-gap: 5px; display: grid; grid-template-columns: 20px max-content; grid-template-rows: 20px auto; column-gap: 11px; row-gap: 9px; width: max-content; margin: auto; }
.activity-axis { grid-column: 2; display: grid; grid-template-columns: repeat(var(--weeks), var(--activity-cell)); gap: var(--activity-gap); color: #b0a087; font-size: 10px; }
.activity-axis span { white-space: nowrap; }
.activity-weekdays { display: grid; grid-template-rows: repeat(7, var(--activity-cell)); gap: var(--activity-gap); color: #b0a087; font-size: 10px; align-items: center; text-align: center; }
.activity-cells { display: grid; grid-auto-flow: column; grid-template-columns: repeat(var(--weeks), var(--activity-cell)); grid-template-rows: repeat(7, var(--activity-cell)); gap: var(--activity-gap); }
.activity-cells button, .activity-padding { width: var(--activity-cell); height: var(--activity-cell); padding: 0; border: 1px solid #82745214; border-radius: 3px 4px 2px 4px; }
.activity-padding { visibility: hidden; }
.activity-outside { visibility: visible; background: #eeede6; opacity: .45; }
.activity-context { color: #b0a087; font-size: 10px; text-align: center; }
.activity-cells button { transition: box-shadow .15s, transform .15s; }
.activity-cells button:hover, .activity-cells button:focus-visible { box-shadow: inset 0 0 0 2px #7f9e5e; transform: rotate(-4deg); outline: 0; }
.activity-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 20px; color: #b0a087; font-size: 10px; }
.activity-scale { display: flex; align-items: center; gap: 4px; }
.activity-scale i { display: block; width: 10px; height: 10px; border-radius: 3px 2px 3px 1px; }
.activity-scale span:first-child { margin-right: 3px; }.activity-scale span:last-child { margin-left: 3px; }
@container (max-width: 520px) {
  .distribution-body { grid-template-columns: minmax(145px, .9fr) minmax(130px, 1.1fr); gap: 10px; }
  .donut-canvas { height: 260px; }
}
@container (max-width: 360px) {
  .distribution-body { grid-template-columns: 1fr; gap: 0; }
  .donut-canvas { height: 230px; }
  .sketch-legend { margin-top: 0; }
}
@media (max-width: 750px) {
  .trend-canvas { height: 300px; }
  .chart-empty { min-height: 300px; }
  .distribution-card, .activity-card { min-height: 440px; }
  .activity-body { min-height: 330px; }
  .activity-calendar { --activity-cell: 17px; --activity-gap: 3px; }
}
</style>
