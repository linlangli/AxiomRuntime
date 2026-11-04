<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Copy, FileText, Search, Sparkles, X } from 'lucide-vue-next'
import manualSource from '../../docs/USAGE.html?raw'

const emit = defineEmits<{ copy: [value: string] }>()
const manualDocument = new DOMParser().parseFromString(manualSource, 'text/html')
const labels: Record<string, string> = {
  commands: '命令索引', install: '安装配置', use: '模型使用', providers: '服务管理',
  memory: '记忆配置', telegram: '消息接入', status: '状态诊断', sessions: '会话报告', storage: '凭据与历史', files: '配置文件'
}
const groupSections: Record<string, string> = { 基础: 'install', 使用: 'use', Provider: 'providers', Memory: 'memory', Telegram: 'telegram', 诊断: 'status', 会话: 'sessions' }
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
const sourceSections = [...manualDocument.querySelectorAll<HTMLElement>('main section[id]')]
const navigation = [...manualDocument.querySelectorAll<HTMLAnchorElement>('nav a[href^="#"]')]
const sectionOrder = ['commands', ...navigation.map(link => link.hash.slice(1)), ...sourceSections.map(section => section.id)]
const sections = [...new Set(sectionOrder)].flatMap(id => {
  const source = sourceSections.find(section => section.id === id)
  if (!source) return []
  const content = source.cloneNode(true) as HTMLElement
  const title = content.querySelector('h2')?.textContent ?? labels[id] ?? id
  content.querySelector('h2')?.remove()
  const examples: string[] = []
  content.querySelectorAll('pre').forEach(pre => {
    const index = examples.push(pre.textContent ?? '') - 1
    const wrapper = manualDocument.createElement('div')
    wrapper.className = 'manual-code-block'
    const toolbar = manualDocument.createElement('div')
    toolbar.className = 'manual-code-toolbar'
    const caption = manualDocument.createElement('span')
    caption.textContent = id === 'files' ? '文件路径' : '命令示例'
    const button = manualDocument.createElement('button')
    button.type = 'button'
    button.dataset.example = String(index)
    button.setAttribute('aria-label', `复制${title}第 ${index + 1} 段示例`)
    button.textContent = '复制'
    pre.replaceWith(wrapper)
    toolbar.append(caption, button)
    wrapper.append(toolbar, pre)
  })
  return [{
    id, title, label: labels[id] ?? title,
    caption: navigation.find(link => link.hash === `#${id}`)?.querySelector('span:last-child')?.textContent ?? '详细说明',
    text: normalize(source.textContent ?? ''), html: content.innerHTML, examples
  }]
})
const commands = [...manualDocument.querySelectorAll<HTMLTableRowElement>('#commandTable tbody tr')].map((row, index) => {
  const cells = row.querySelectorAll('td')
  const examples = [...(cells[1]?.querySelectorAll('code') ?? [])].map(code => code.textContent ?? '')
  const group = cells[0]?.textContent?.trim() ?? '其它'
  return {
    id: index, group, examples, guide: row.dataset.guide ?? groupSections[group],
    description: cells[2]?.innerHTML ?? '', notes: cells[3]?.innerHTML ?? '',
    text: normalize(`${row.textContent ?? ''} ${row.dataset.search ?? ''}`)
  }
})
const tips = [...manualDocument.querySelectorAll('#commands .chips .chip')].map(tip => tip.innerHTML)
const groups = [...new Set(commands.map(command => command.group))]
const selected = ref('commands')
const query = ref('')
const group = ref('')
const expanded = ref<boolean | null>(null)
const manualTop = ref<HTMLElement | null>(null)
const contentHeading = ref<HTMLElement | null>(null)
const current = computed(() => sections.find(section => section.id === selected.value)!)
const tokens = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean))
const searching = computed(() => tokens.value.length > 0)
const matches = (text: string) => tokens.value.every(token => text.toLowerCase().includes(token))
const visibleCommands = computed(() => commands.filter(command => matches(command.text) && (searching.value || !group.value || command.group === group.value)))
const guideMatches = computed(() => searching.value ? sections.filter(section => section.id !== 'commands' && matches(section.text)) : [])
const currentIndex = computed(() => sections.findIndex(section => section.id === selected.value))
const detailCount = computed(() => current.value.html.match(/<details[\s>]/g)?.length ?? 0)
const guideHtml = computed(() => {
  if (expanded.value === null) return current.value.html
  const container = manualDocument.createElement('div')
  container.innerHTML = current.value.html
  container.querySelectorAll('details').forEach(details => { details.open = expanded.value! })
  return container.innerHTML
})
async function openSection(id: string) {
  selected.value = id
  query.value = ''
  expanded.value = null
  await nextTick()
  manualTop.value?.scrollIntoView({ block: 'start' })
  contentHeading.value?.focus({ preventScroll: true })
}
function preview(text: string) {
  const start = Math.max(0, text.toLowerCase().indexOf(tokens.value[0] ?? '') - 35)
  return `${start ? '…' : ''}${text.slice(start, start + 160)}${text.length > start + 160 ? '…' : ''}`
}
function copyExample(event: MouseEvent) {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-example]') : null
  if (!button || !(event.currentTarget instanceof Element) || !event.currentTarget.contains(button)) return
  const example = current.value.examples[Number(button.dataset.example)]
  if (example !== undefined) emit('copy', example)
}
</script>

<template>
  <div ref="manualTop" class="command-manual">
    <section class="manual-welcome">
      <div><span class="eyebrow">THE FIELD GUIDE</span><h2>每个命令，<span class="marker-underline">都有说明。</span></h2><p>与 <code>ai help</code> 完整手册同步，命令、参数、运行规则都在这里。</p><div class="manual-badges"><span><Check :size="12" />{{ sections.length }} 个分类</span><span>{{ commands.length }} 组命令</span><span>完整示例与说明</span></div></div>
      <div class="manual-book"><Sparkles :size="17" /><BookOpen :size="58" :stroke-width="1.2" /><span>keep this handy</span></div>
    </section>
    <div class="manual-toolbar">
      <label class="search manual-search"><Search :size="17" /><input v-model="query" type="search" aria-label="搜索完整命令手册" placeholder="搜索命令、参数或用法，如 --strict、图片、代理…" /><button v-if="query" class="manual-clear" aria-label="清除手册搜索" @click="query = ''"><X :size="15" /></button></label>
      <button class="button" @click="emit('copy', 'ai help')"><Copy :size="14" />复制 ai help</button>
    </div>
    <div class="manual-layout">
      <nav class="manual-menu" aria-label="命令手册分类"><span class="manual-menu-label">查阅目录 <span>CONTENTS</span></span><button v-for="section in sections" :key="section.id" :aria-pressed="!searching && selected === section.id" :class="{ active: !searching && selected === section.id }" @click="openSection(section.id)"><BookOpen v-if="section.id === 'commands'" :size="16" /><FileText v-else :size="16" /><span><strong>{{ section.label }}</strong><small>{{ section.caption }}</small></span><ChevronRight :size="13" /></button><p>先找命令，再看规则。<br />示例支持一键复制。</p></nav>
      <div class="manual-main">
        <template v-if="searching">
          <div class="manual-section-heading"><div><span class="eyebrow">SEARCH THE GUIDE</span><h2 ref="contentHeading" tabindex="-1">搜索结果</h2><p role="status">{{ visibleCommands.length }} 组命令 · {{ guideMatches.length }} 篇详细说明</p></div></div>
          <div v-if="guideMatches.length" class="manual-guide-results"><button v-for="section in guideMatches" :key="section.id" @click="openSection(section.id)"><span class="manual-result-title"><FileText :size="16" /><strong>{{ section.title }}</strong><ArrowRight :size="14" /></span><p>{{ preview(section.text) }}</p><small>阅读完整说明</small></button></div>
        </template>
        <template v-else>
          <div class="manual-section-heading"><div><span class="eyebrow">{{ selected === 'commands' ? 'FIND YOUR COMMAND' : 'READ THE DETAILS' }}</span><h2 ref="contentHeading" tabindex="-1">{{ current.title }}</h2><p v-if="selected === 'commands'">从常用入口到完整参数，找到你需要的命令。</p><p v-else>{{ current.examples.length }} 段{{ selected === 'files' ? '路径' : '命令' }}示例 · 保留完整规则与注意事项</p></div><div v-if="selected !== 'commands' && detailCount" class="manual-expand"><button :aria-pressed="expanded === true" @click="expanded = true">全部展开</button><span>·</span><button :aria-pressed="expanded === false" @click="expanded = false">全部收起</button></div></div>
          <template v-if="selected === 'commands'"><div class="manual-tips"><span v-for="(tip, index) in tips" :key="index" v-html="tip"></span></div><div class="manual-group-filter" aria-label="命令分组筛选"><button :class="{ active: !group }" :aria-pressed="!group" @click="group = ''">全部命令 <span>{{ commands.length }}</span></button><button v-for="name in groups" :key="name" :class="{ active: group === name }" :aria-pressed="group === name" @click="group = name">{{ name }} <span>{{ commands.filter(command => command.group === name).length }}</span></button></div><p class="manual-result-count" role="status">{{ visibleCommands.length }} 组命令 · 点击命令复制，点击说明查看详细用法</p></template>
        </template>
        <div v-if="searching || selected === 'commands'" class="manual-command-list">
          <article v-for="command in visibleCommands" :key="command.id" class="card manual-command"><div class="manual-command-heading"><span class="manual-group-tag">{{ command.group }}</span><button v-if="command.guide" class="link-button" @click="openSection(command.guide)">详细用法 <ArrowRight :size="12" /></button></div><div class="manual-command-layout"><div class="manual-examples"><button v-for="example in command.examples" :key="example" :aria-label="`复制命令：${example}`" @click="emit('copy', example)"><code>{{ example }}</code><Copy :size="13" /></button></div><div class="manual-command-description" v-html="command.description"></div></div><div v-if="command.notes" class="manual-command-notes" v-html="command.notes"></div></article>
        </div>
        <section v-if="searching && !visibleCommands.length && !guideMatches.length" class="card empty manual-empty"><Search :size="29" /><h3>暂时没有找到</h3><p>试试命令名、参数或使用场景，例如 provider、--image、Telegram。</p><button class="button" @click="query = ''">清除搜索</button></section>
        <article v-if="!searching && selected !== 'commands'" class="card manual-document" :data-manual-section="current.id" @click="copyExample" v-html="guideHtml"></article>
        <div v-if="!searching" class="manual-pagination"><button v-if="currentIndex > 0" @click="openSection(sections[currentIndex - 1]!.id)"><ArrowLeft :size="14" /><span><small>上一节</small>{{ sections[currentIndex - 1]!.label }}</span></button><button v-if="currentIndex < sections.length - 1" class="manual-next" @click="openSection(sections[currentIndex + 1]!.id)"><span><small>下一节</small>{{ sections[currentIndex + 1]!.label }}</span><ArrowRight :size="14" /></button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.command-manual { scroll-margin-top: 22px; }
.manual-welcome { display: flex; justify-content: space-between; align-items: center; gap: 20px; border: 1px solid #ded4e8; background: #f0eaf5; border-radius: 14px 11px 17px 10px; padding: 25px 29px; }
.manual-welcome .eyebrow { color: #a08ab0; }
.manual-welcome h2 { font-size: 23px; font-weight: 600; color: #665077; margin: 12px 0 17px; }
.manual-welcome p { color: #9882a5; font-size: 11px; line-height: 1.9; margin: 0; }
.manual-welcome code { color: #7b618e; }
.manual-badges { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 17px; font-size: 10px; color: #a08aae; }
.manual-badges > span { display: inline-flex; align-items: center; gap: 5px; }
.manual-book { display: grid; justify-items: center; gap: 8px; width: 135px; flex: none; color: #a48ab5; transform: rotate(-7deg); }
.manual-book > svg:first-child { justify-self: end; margin-right: 12px; color: #c3a26b; }
.manual-book span { font-family: 'Comic Sans MS', 'Segoe Print', cursive; font-size: 11px; color: #b69d71; }
.manual-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 22px 0; }
.manual-search { flex: 1; width: auto; min-width: 230px; }
.manual-search input { font-size: 12px; }
.manual-clear { flex: none; display: grid; place-items: center; border: 0; padding: 4px; background: none; color: #a18aaf; }
.manual-search input::-webkit-search-cancel-button { display: none; }
.manual-layout { display: grid; grid-template-columns: 177px minmax(0, 1fr); gap: 27px; align-items: start; }
.manual-menu { position: sticky; top: 22px; padding: 17px 10px 12px; border: 1px dashed #dfd5c3; border-radius: 10px 13px 9px 12px; background: #f9f6ee; }
.manual-menu-label { display: block; margin: 0 9px 15px; font-size: 10px; color: #aa9b83; }
.manual-menu-label > span { display: block; font-size: 7px; letter-spacing: 1.3px; color: #c2b59e; margin-top: 6px; }
.manual-menu > button { display: flex; align-items: center; gap: 9px; text-align: left; padding: 12px 9px; width: 100%; background: none; border: 1px solid transparent; border-radius: 8px; color: #a08c72; }
.manual-menu > button:hover { background: #f1eadc; }
.manual-menu > button.active { background: #eee5f4; border-color: #ded0e7; color: #8d729f; box-shadow: 2px 2px 0 #e4d9eb66; }
.manual-menu > button > svg { flex: none; }.manual-menu > button > svg:last-child { margin-left: auto; opacity: .7; }
.manual-menu strong { display: block; font-size: 11px; font-weight: 550; }
.manual-menu small { display: block; font-size: 8px; margin-top: 5px; opacity: .65; line-height: 1.6; }
.manual-menu > p { border-top: 1px dashed #e3d9c6; padding: 14px 9px 0; margin: 13px 0 0; font-size: 10px; line-height: 1.9; color: #b8a585; }
.manual-main { min-width: 0; }
.manual-section-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 3px 0 18px; }
.manual-section-heading h2 { font-size: 18px; font-weight: 600; margin: 8px 0; }.manual-section-heading h2:focus { outline: none; }
.manual-section-heading p { font-size: 10px; color: #a29279; line-height: 1.8; margin: 0; }
.manual-expand { display: flex; gap: 7px; color: #c5b6cf; font-size: 10px; }
.manual-expand button { border: 0; background: none; padding: 6px 0; font-size: 10px; color: #9a7ead; }.manual-expand button[aria-pressed=true] { color: #715080; text-decoration: underline; }
.manual-tips { display: flex; flex-wrap: wrap; gap: 8px 15px; padding: 13px 16px; background: #f8f2e5; border: 1px dashed #e3d6ba; border-radius: 7px 10px 7px 9px; color: #ad9772; font-size: 9px; line-height: 1.9; margin-bottom: 18px; }
.manual-group-filter { display: flex; flex-wrap: wrap; gap: 7px; }
.manual-group-filter button { border: 1px solid #e6decf; border-radius: 6px; background: var(--paper); color: #a6957b; font-size: 10px; padding: 7px 10px; }
.manual-group-filter button.active { background: #ede5f4; border-color: #d9cbe3; color: #8b709f; }
.manual-group-filter span { margin-left: 5px; opacity: .6; font-size: 9px; }
.manual-result-count { font-size: 10px; color: #ac9b80; margin: 18px 0 13px; line-height: 1.8; }
.manual-command-list { display: grid; gap: 13px; }
.manual-command { padding: 18px 20px; border-radius: 10px 12px 9px 11px; }
.manual-command-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 13px; }
.manual-group-tag { display: inline-block; background: #f2ecdf; color: #ab9574; font-size: 9px; padding: 4px 8px; border-radius: 5px 3px 5px 3px; }
.manual-command-heading .link-button { font-size: 10px; }
.manual-command-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.manual-examples { display: grid; gap: 6px; min-width: 0; }
.manual-examples button { display: flex; align-items: start; justify-content: space-between; gap: 9px; text-align: left; border: 1px solid #e8decb; border-radius: 6px 8px 5px 7px; padding: 9px 10px; color: #937b5c; background: #faf6ed; min-width: 0; }
.manual-examples button:hover { background: #f0e7f6; border-color: #dccccd; color: #8f6b9f; }
.manual-examples code { font-size: 10px; line-height: 1.8; overflow-wrap: anywhere; }.manual-examples svg { flex: none; margin-top: 3px; opacity: .6; }
.manual-command-description { color: #95846c; font-size: 11px; line-height: 1.95; overflow-wrap: anywhere; }
.manual-command-description :deep(code), .manual-command-notes :deep(code) { color: #92789e; font-size: 10px; }
.manual-command-notes { padding-top: 12px; margin-top: 13px; border-top: 1px dashed #ece3d2; font-size: 10px; line-height: 1.9; color: #b09a77; overflow-wrap: anywhere; }
.manual-command-notes:empty { display: none; }
.manual-command-notes :deep(.tag) { color: #957a9d; }.manual-command-notes :deep(.warn) { color: #be9364; }
.manual-guide-results { display: grid; gap: 12px; margin-bottom: 18px; }
.manual-guide-results > button { width: 100%; border: 1px solid #e0d4e7; border-radius: 10px 7px 11px 8px; background: #f6f0fa; padding: 17px 20px; color: #92789f; text-align: left; }
.manual-result-title { display: flex; align-items: center; gap: 8px; }.manual-result-title strong { font-size: 12px; font-weight: 550; }.manual-result-title svg:last-child { margin-left: auto; }
.manual-guide-results p { font-size: 11px; line-height: 1.9; color: #a08bab; overflow-wrap: anywhere; margin: 10px 0; }.manual-guide-results small { font-size: 9px; }
.manual-empty { padding-block: 40px; }.manual-empty h3 { font-size: 14px; font-weight: 550; }.manual-empty .button { margin-top: 12px; }
.manual-document { padding: 23px; }
.manual-document :deep(p), .manual-document :deep(li) { font-size: 12px; line-height: 2; color: #94836a; overflow-wrap: anywhere; }
.manual-document :deep(p) { margin: 13px 0; }.manual-document :deep(p:first-child) { margin-top: 0; }
.manual-document :deep(h3) { font-size: 14px; color: #8c775c; font-weight: 550; margin: 0 0 16px; }
.manual-document :deep(ul), .manual-document :deep(ol) { padding-left: 20px; margin: 15px 0; }.manual-document :deep(li) { padding-left: 3px; margin: 9px 0; }.manual-document :deep(li::marker) { color: #b7a1bf; }
.manual-document :deep(code) { color: #977ba5; font-size: 11px; }
.manual-document :deep(.section-grid) { display: grid; gap: 23px; }
.manual-document :deep(.note + .note) { border-top: 1px dashed #e7dcca; padding-top: 23px; }
.manual-document :deep(details) { border-bottom: 1px solid #ece3d2; padding: 0 0 18px; margin-bottom: 18px; }.manual-document :deep(details:last-child) { border-bottom: 0; margin-bottom: 0; padding-bottom: 0; }
.manual-document :deep(.section-grid + details) { margin-top: 25px; border-top: 1px dashed #e7dcca; padding-top: 23px; }
.manual-document :deep(summary) { cursor: pointer; color: #93789f; font-size: 13px; font-weight: 550; line-height: 1.8; padding: 4px 0; }.manual-document :deep(summary::marker) { color: #bba5c7; }
.manual-document :deep(.detail-body) { margin-top: 17px; }
.manual-document :deep(.manual-code-block) { border: 1px solid #e5d9c5; background: #f8f3e8; border-radius: 8px 11px 7px 10px; margin: 16px 0; overflow: hidden; }
.manual-document :deep(.manual-code-toolbar) { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 14px; border-bottom: 1px dashed #e7dac1; font-size: 9px; color: #b39a75; }
.manual-document :deep(.manual-code-toolbar button) { padding: 4px 9px; border: 1px solid #dfcfb2; border-radius: 5px; background: var(--paper); font-size: 10px; color: #a08963; }.manual-document :deep(.manual-code-toolbar button:hover) { color: #886296; border-color: #cfbad7; }
.manual-document :deep(pre) { border: 0; background: none; padding: 15px; margin: 0; border-radius: 0; color: #8f7654; line-height: 2; font-size: 11px; }
.manual-pagination { display: flex; gap: 12px; margin-top: 22px; }
.manual-pagination button { display: flex; align-items: center; gap: 12px; border: 0; background: none; color: #a38aad; padding: 8px 0; font-size: 11px; text-align: left; }.manual-pagination small { display: block; font-size: 9px; margin-bottom: 6px; color: #b9a78b; }.manual-pagination .manual-next { margin-left: auto; text-align: right; }
@media (max-width: 1200px) { .manual-layout { grid-template-columns: 155px minmax(0, 1fr); gap: 18px; }.manual-menu { padding-inline: 6px; }.manual-menu > button { gap: 7px; }.manual-menu small { font-size: 7px; }.manual-command-layout { grid-template-columns: 1fr; gap: 13px; } }
@media (max-width: 900px) {
  .manual-layout { grid-template-columns: 1fr; gap: 22px; }.manual-menu { position: static; display: flex; gap: 6px; overflow-x: auto; padding: 8px; border-style: solid; }.manual-menu-label, .manual-menu > p, .manual-menu small, .manual-menu > button > svg:last-child { display: none; }.manual-menu > button { width: auto; flex: none; padding: 9px; gap: 7px; }.manual-menu strong { white-space: nowrap; font-size: 10px; }
}
@media (max-width: 600px) {
  .manual-welcome { padding: 21px; }.manual-welcome h2 { font-size: 20px; }.manual-book { display: none; }.manual-toolbar { gap: 10px; }.manual-search { flex-basis: 100%; }.manual-toolbar > .button { margin-left: auto; padding: 8px 11px; font-size: 10px; }.manual-search input { font-size: 12px; }.manual-command, .manual-document { padding: 17px; }.manual-document :deep(p), .manual-document :deep(li) { font-size: 11px; }.manual-document :deep(pre), .manual-document :deep(code) { font-size: 10px; }.manual-group-filter { gap: 6px; }.manual-group-filter button { padding: 6px 8px; }.manual-pagination { margin-bottom: 12px; }
}
</style>
