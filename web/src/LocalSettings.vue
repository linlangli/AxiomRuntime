<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, Check, Copy, Plus, RefreshCw, ShieldCheck, X } from 'lucide-vue-next'
import { api, type Dashboard, type ProviderStatus } from './console-api'
import CodexUsageSettings from './CodexUsageSettings.vue'

const props = defineProps<{ data: Dashboard }>()
const emit = defineEmits<{ reload: []; notice: [message: string] }>()
const sections = ['服务配置', '模型路由', '工具配置', '网络代理', '消息接入', '记忆设置', '配置维护']
const section = ref('服务配置')
const busy = ref(false)
const error = ref('')
const search = ref('')
const editing = ref(false)
const originalProvider = ref<ProviderStatus | null>(null)
const providerForm = ref({ name: '', baseUrl: '', apiKey: '', model: '', mode: 'auto', level: 1 })
const providers = computed(() => props.data.providers.filter(provider => `${provider.name} ${provider.model}`.toLowerCase().includes(search.value.toLowerCase())))
const route = computed(() => [...props.data.providers].filter(provider => provider.level > 0).sort((first, second) => first.level - second.level))
const mode = ref<'provider' | 'chatgpt' | 'proxy'>('provider')
const codexProvider = ref(props.data.providers.find(provider => provider.name === props.data.codex.providerId)?.name ?? props.data.providers[0]?.name ?? '')
const codexModel = ref(props.data.codex.model ?? '')
const codexProxy = ref(props.data.codex.proxy ?? '')
const codexModels = computed(() => props.data.providers.find(provider => provider.name === codexProvider.value)?.models.filter(model => /^(gpt|codex|grok|o\d|openai)/i.test(model)) ?? [])
const proxyTarget = ref('')
const proxyValue = ref(props.data.settings.runtime.proxyUrl ?? '')
const bot = ref({ name: '', token: '', defaultEngine: 'claude', defaultCwd: '', allowedUserIds: '', provider: '', model: '', proxyUrl: '' })
const embedding = ref({ name: '', baseUrl: '', apiKey: '', model: '', providerType: 'openai-compatible', queryTask: '', passageTask: '', ...props.data.settings.embedding })
type Pending = { title: string; url: string; body: Record<string, unknown>; method: string; before: Record<string, unknown> }
const pending = ref<Pending | null>(null)
const fieldNames: Record<string, string> = { name: '名称', baseUrl: '接口地址', apiKey: 'API Key', model: '默认模型', mode: '运行模式', level: '优先级', enabled: '自动切换', value: '代理地址', providerName: 'Provider', token: 'Bot Token', defaultEngine: '默认引擎', defaultCwd: '工作目录', allowedUserIds: '用户白名单', allowAllUsers: '允许所有用户', proxyUrl: '代理地址', provider: 'Provider', id: '备份编号', providerType: '协议类型', queryTask: 'Query task', passageTask: 'Passage task' }
const changes = computed(() => !pending.value ? [] : Object.entries(pending.value.body).filter(([key, value]) => key !== 'action' && (!['apiKey', 'token'].includes(key) || !!value) && JSON.stringify(value) !== JSON.stringify(pending.value?.before[key])).map(([key, value]) => ({
  field: key === 'enabled' && pending.value?.body.action === 'codex-usage' ? '用量采集' : key === 'codexHome' ? 'Codex 目录' : key === 'providerMappings' ? 'Provider 对应关系' : fieldNames[key] ?? key,
  before: ['apiKey', 'token'].includes(key) ? '凭证不回显' : display(pending.value?.before[key]),
  after: ['apiKey', 'token'].includes(key) ? '替换为新凭证' : display(value)
})))
function display(value: unknown) { return value === undefined || value === null || value === '' ? '未设置' : Array.isArray(value) ? value.join(', ') || '空列表' : typeof value === 'object' ? JSON.stringify(value) : String(value) }
function preview(title: string, body: Record<string, unknown>, before: object = {}, url = '/api/settings', method = 'POST') {
  pending.value = { title, body, before: before as Record<string, unknown>, url, method }; error.value = ''
}
async function request(url: string, body: unknown, method = 'POST') {
  if (busy.value) return false
  busy.value = true; error.value = ''
  try {
    const result = await api<{ effect?: string }>(url, { method, body: JSON.stringify(body) })
    emit('notice', result.effect ?? '操作完成，本机配置已更新。'); emit('reload'); return true
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); return false }
  finally { busy.value = false }
}
async function commit() {
  if (!pending.value) return
  if (await request(pending.value.url, pending.value.body, pending.value.method)) { pending.value = null; editing.value = false; providerForm.value.apiKey = ''; bot.value.token = ''; embedding.value.apiKey = '' }
}
function editProvider(provider?: ProviderStatus) {
  originalProvider.value = provider ?? null
  providerForm.value = provider ? { name: provider.name, baseUrl: provider.baseUrl, apiKey: '', model: provider.model, mode: provider.mode, level: provider.level } : { name: '', baseUrl: '', apiKey: '', model: '', mode: 'auto', level: route.value.length + 1 }
  editing.value = true
}
function saveProvider() {
  const body: Record<string, unknown> = { ...providerForm.value }
  if (originalProvider.value && !body.apiKey) delete body.apiKey
  preview(originalProvider.value ? '保存服务商修改' : '添加服务商', body, originalProvider.value ?? {}, originalProvider.value ? `/api/providers/${encodeURIComponent(originalProvider.value.name)}` : '/api/providers', originalProvider.value ? 'PATCH' : 'POST')
}
function selectBot(name: string) {
  const config = props.data.settings.bots.find(item => item.name === name)
  bot.value = { name, token: '', defaultEngine: config?.defaultEngine ?? 'claude', defaultCwd: config?.defaultCwd ?? '', allowedUserIds: config?.allowedUserIds.join(', ') ?? '', provider: config?.provider ?? '', model: config?.model ?? '', proxyUrl: config?.proxyUrl ?? '' }
}
function saveBot() {
  const before = props.data.settings.bots.find(item => item.name === bot.value.name) ?? {}
  const body: Record<string, unknown> = { action: 'telegram', ...bot.value, allowAllUsers: false, allowedUserIds: bot.value.allowedUserIds.split(/[,\s]+/).filter(Boolean).map(Number) }
  if (!body.token) delete body.token
  preview('保存 Telegram 配置', body, before)
}
function saveCodex() {
  preview('应用 Codex 持久配置', mode.value === 'provider' ? { mode: mode.value, providerName: codexProvider.value, ...(codexModel.value ? { model: codexModel.value } : {}) } : mode.value === 'proxy' ? { mode: mode.value, value: codexProxy.value || 'off' } : { mode: mode.value }, { mode: 'provider', providerName: props.data.codex.providerId, model: props.data.codex.model, value: props.data.codex.proxy }, '/api/codex')
}
function copy(text: string) { void navigator.clipboard.writeText(text).then(() => emit('notice', '已复制命令。')).catch(() => { error.value = '复制失败，请手动复制。' }) }
</script>

<template>
  <div class="subnav" aria-label="本地配置分类"><button v-for="item in sections" :key="item" :class="{ active: section === item }" :aria-pressed="section === item" @click="section = item">{{ item }}</button></div>
  <div v-if="error && !pending" class="error-banner" role="alert">{{ error }}</div>
  <template v-if="section === '服务配置'">
    <div class="section-heading"><div><h2>连接你的 AI 服务 <span class="hand-tag">connect!</span></h2><p>本地 Provider 是模型连接与自动切换的共同配置源。</p></div><button class="button primary" :disabled="busy" @click="editProvider()"><Plus :size="15" />添加服务商</button></div>
    <input v-model="search" class="search-field" placeholder="搜索服务商或模型…" aria-label="搜索服务商" />
    <div class="provider-grid"><section v-for="provider in providers" :key="provider.name" class="card provider-card"><div class="card-head"><div class="provider-avatar">{{ provider.name.slice(0, 1).toUpperCase() }}</div><span class="pill" :class="provider.health">{{ provider.health === 'ok' ? '健康' : provider.health === 'error' ? '异常' : '待验证' }}</span></div><h2>{{ provider.name }}</h2><p class="break-word">{{ provider.baseUrl }}</p><div class="provider-facts"><span>默认模型<strong>{{ provider.model || '未设置' }}</strong></span><span>切换顺序<strong>{{ provider.level ? `第 ${provider.level} 位` : '仅显式选择' }}</strong></span><span>凭证状态<strong>{{ provider.credentialConfigured ? '已配置' : '缺失' }}</strong></span><span>出站代理<strong>{{ provider.proxyUrl || '继承默认' }}</strong></span></div><div class="button-row"><button class="button" :disabled="busy" @click="request('/api/providers/refresh', { name: provider.name })"><RefreshCw :size="13" />检查</button><button class="button" :disabled="busy" @click="editProvider(provider)">编辑</button><button class="link-button danger-text" :disabled="busy" @click="preview('删除服务商', { name: provider.name }, {}, `/api/providers/${encodeURIComponent(provider.name)}`, 'DELETE')">删除</button></div></section></div>
    <div v-if="!providers.length" class="empty card">暂无匹配的服务商，添加第一个 Provider 开始使用。</div>
  </template>
  <template v-else-if="section === '模型路由'">
    <section class="card"><div class="card-head"><div><h2>自动切换路由</h2><p>按优先级尝试；实际候选还受引擎兼容性和健康状态约束。</p></div><span class="pill" :class="data.settings.runtime.failoverDisabled ? 'unknown' : 'ok'">{{ data.settings.runtime.failoverDisabled ? '已关闭' : '已开启' }}</span></div><div class="route-chain"><template v-for="(provider, index) in route" :key="provider.name"><ArrowRight v-if="index" :size="18" /><button class="route-node" @click="section = '服务配置'; editProvider(provider)"><span>LEVEL {{ provider.level }}</span><strong>{{ provider.name }}</strong><small>{{ provider.model }}</small></button></template><p v-if="!route.length">暂无自动候选。level 0 的 Provider 仅可显式选择。</p></div><div class="button-row"><button class="button primary" :disabled="busy" @click="preview('修改自动切换策略', { action: 'failover', enabled: !!data.settings.runtime.failoverDisabled }, { enabled: !data.settings.runtime.failoverDisabled })">{{ data.settings.runtime.failoverDisabled ? '开启自动切换' : '关闭自动切换' }}</button></div><p class="footnote">点击节点修改默认模型和优先级。关闭自动切换后不再跨 Provider 降级，原地重试保留。</p></section>
  </template>
  <template v-else-if="section === '工具配置'">
    <CodexUsageSettings :status="data.codexUsage" :providers="data.providers" :busy="busy" @preview="preview" />
    <div class="info-banner"><ShieldCheck :size="18" /><p><strong>持久设置与单次运行分开。</strong>这里的 Codex 设置修改用户级配置；<code>ai use</code> 的覆盖仅影响新启动的 CLI 进程。旧聊天不会迁移。</p></div>
    <div class="equal-grid"><section class="card"><div class="card-head"><div><h2>Codex App / CLI</h2><p>应用后会尝试重启 Codex App</p></div><span class="pill ok">可编辑</span></div><div class="file-row"><code>{{ data.codex.configPath }}</code><span>{{ data.codex.configPresent ? '已读取' : '未创建' }}</span></div><div class="file-row"><span>凭证文件</span><span>{{ data.codex.authConfigured ? '已配置' : '缺失' }}</span></div><form @submit.prevent="saveCodex"><label>配置方式<select v-model="mode"><option value="provider">自定义 Provider</option><option value="chatgpt">ChatGPT 登录</option><option value="proxy">Codex 出站代理</option></select></label><template v-if="mode === 'provider'"><label>Provider<select v-model="codexProvider" @change="codexModel = ''"><option v-for="provider in data.providers" :key="provider.name">{{ provider.name }}</option></select></label><label>模型<select v-model="codexModel"><option value="">自动选择兼容模型</option><option v-for="model in codexModels" :key="model">{{ model }}</option></select></label></template><label v-else-if="mode === 'proxy'">HTTP 代理<input v-model="codexProxy" placeholder="留空清除，例如 http://127.0.0.1:7890" /></label><p v-else class="footnote">保存后委托 Codex 打开浏览器登录，替换现有自定义 Provider 凭证。</p><button class="button primary" :disabled="busy || (mode === 'provider' && !codexModels.length)">预览并应用</button></form></section><section class="card"><div class="card-head"><div><h2>Claude Code</h2><p>每次运行独立注入临时 settings</p></div><span class="pill unknown">进程级</span></div><p class="body-copy">当前没有 Claude 用户配置的持久写入服务。通过启动命令选择 Provider 与模型，原生配置文件保持原样。</p><button class="command-row" @click="copy('ai use claude')"><code>ai use claude</code><Copy :size="15" /></button><div class="note-paper">提示：Provider 与默认模型可以在「服务配置」直接修改。</div></section></div>
  </template>
  <section v-else-if="section === '网络代理'" class="card form-card"><div class="card-head"><div><h2>出站网络代理</h2><p>这里控制 Runtime 访问上游的网络路径；服务器反代在「对外服务」配置。</p></div></div><form @submit.prevent="preview('保存出站代理', { action: 'proxy', provider: proxyTarget, value: proxyValue }, { value: proxyTarget ? data.providers.find(provider => provider.name === proxyTarget)?.proxyUrl : data.settings.runtime.proxyUrl })"><label>应用范围<select v-model="proxyTarget" @change="proxyValue = (proxyTarget ? data.providers.find(provider => provider.name === proxyTarget)?.proxyUrl : data.settings.runtime.proxyUrl) ?? ''"><option value="">Runtime 默认代理</option><option v-for="provider in data.providers" :key="provider.name" :value="provider.name">{{ provider.name }} · 单独覆盖</option></select></label><label>代理地址<input v-model="proxyValue" placeholder="http://127.0.0.1:7890；留空清除" /></label><div class="note-paper">Provider 单独代理 → Runtime 默认代理 → 直连。保存前执行零 Token 的端点连通检查。清除单独代理后恢复继承。</div><button class="button primary" :disabled="busy">检查并保存</button></form></section>
  <section v-else-if="section === '消息接入'" class="card form-card"><div class="card-head"><div><h2>Telegram Bot</h2><p>编辑具名 Bot 配置，保存后重启对应 Bot 生效。</p></div><span class="pill">{{ data.settings.bots.length }} 个 Bot</span></div><label>选择现有 Bot<select :value="bot.name" @change="selectBot(($event.target as HTMLSelectElement).value)"><option value="">新建配置</option><option v-for="item in data.settings.bots" :key="item.name" :value="item.name">{{ item.name }}</option></select></label><form @submit.prevent="saveBot"><div class="form-grid"><label>Bot 名称<input v-model="bot.name" required pattern="[a-z0-9][a-z0-9_-]{0,31}" placeholder="例如 personal" /></label><label>Bot Token<input v-model="bot.token" type="password" autocomplete="new-password" placeholder="留空保留现有凭证" /></label><label>默认引擎<select v-model="bot.defaultEngine"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>用户白名单<input v-model="bot.allowedUserIds" placeholder="用户 ID，逗号分隔" /></label><label class="span-two">本机工作目录<input v-model="bot.defaultCwd" required placeholder="本机已存在的绝对路径" /></label><label>Provider<select v-model="bot.provider"><option value="">自动选择</option><option v-for="provider in data.providers" :key="provider.name">{{ provider.name }}</option></select></label><label>模型<input v-model="bot.model" placeholder="留空使用默认模型" /></label><label class="span-two">Bot 独立代理<input v-model="bot.proxyUrl" placeholder="留空不设置 Bot 代理" /></label></div><p class="footnote">Web 保存的 Bot 配置使用用户白名单鉴权；创建配置后仍需在终端启动 Bot。</p><button class="button primary" :disabled="busy">预览并保存</button></form></section>
  <section v-else-if="section === '记忆设置'" class="card form-card"><div class="card-head"><div><h2>Embedding 连接</h2><p>配置向量服务连接。向量检索与自动记忆尚未接入。</p></div><span class="pill unknown">仅连接配置</span></div><form @submit.prevent="preview('测试并保存 Embedding', { action: 'embedding', ...embedding }, data.settings.embedding ?? {})"><div class="form-grid"><label>服务名称<input v-model="embedding.name" required /></label><label>协议类型<select v-model="embedding.providerType"><option value="openai-compatible">OpenAI compatible</option><option value="jina">Jina</option></select></label><label class="span-two">Base URL<input v-model="embedding.baseUrl" required type="url" placeholder="https://example.com/v1" /></label><label>模型<input v-model="embedding.model" required /></label><label>API Key<input v-model="embedding.apiKey" :required="!data.settings.embedding" type="password" autocomplete="new-password" placeholder="留空保留现有凭证" /></label><template v-if="embedding.providerType === 'jina'"><label>Query task<input v-model="embedding.queryTask" placeholder="retrieval.query" /></label><label>Passage task<input v-model="embedding.passageTask" placeholder="retrieval.passage" /></label></template></div><p class="footnote">保存前发送一次最小 embedding 请求，可能产生少量用量；失败时保留原配置。</p><div class="button-row"><button class="button primary" :disabled="busy">测试并保存</button><button v-if="data.settings.embedding" type="button" class="button" :disabled="busy" @click="request('/api/settings', { action: 'embedding-check' })">测试现有配置</button><button v-if="data.settings.embedding" type="button" class="link-button danger-text" @click="preview('清除 Embedding 连接', { action: 'embedding-clear' })">清除</button></div></form></section>
  <template v-else><section class="card"><div class="card-head"><div><h2>配置文件与恢复</h2><p>只管理 Runtime 自有配置。备份在本机保存，保留最近 20 份。</p></div><button class="button primary" :disabled="busy" @click="request('/api/settings', { action: 'backup' })"><Plus :size="14" />创建备份</button></div><div class="file-row"><span>本机配置目录</span><code>{{ data.configRoot }}</code></div><div v-for="file in data.settings.managedFiles" :key="file" class="file-row"><code>{{ file }}</code><span>受管配置</span></div><p class="footnote">备份包含 API Key 与 Bot Token，保存在受限权限的 web-backups 目录；不含用量、数据库或 Codex 用户配置。恢复会覆盖快照中的文件，并在操作前创建新备份。</p></section><section class="card spaced"><h2>最近备份</h2><div v-for="backup in data.settings.backups" :key="backup.id" class="file-row"><div><strong>{{ new Date(backup.createdAt).toLocaleString('zh-CN') }}</strong><small class="table-sub">{{ backup.id }}</small></div><button class="button" :disabled="busy" @click="preview('恢复本机配置快照', { action: 'restore', id: backup.id })">恢复此版本</button></div><div v-if="!data.settings.backups.length" class="empty">还没有备份。</div></section></template>

  <div v-if="editing" class="modal-backdrop" @click.self="!busy && (editing = false)"><form class="modal" @submit.prevent="saveProvider"><div class="card-head"><div><h2>{{ originalProvider ? '编辑服务商' : '添加服务商' }}</h2><p>修改地址和凭证会真实探测，可能消耗少量 Token。</p></div><button type="button" class="icon-button" aria-label="关闭服务商表单" @click="editing = false"><X :size="17" /></button></div><label>名称<input v-model="providerForm.name" required /></label><label>Base URL<input v-model="providerForm.baseUrl" type="url" required /></label><label>API Key<input v-model="providerForm.apiKey" type="password" :required="!originalProvider" autocomplete="new-password" placeholder="编辑时留空保留原凭证" /></label><label>默认模型<select v-if="originalProvider?.models.length" v-model="providerForm.model"><option v-for="model in originalProvider.models" :key="model">{{ model }}</option></select><input v-else v-model="providerForm.model" placeholder="可选；目录不可用时需要显式模型" /></label><div class="form-grid"><label>优先级<input v-model.number="providerForm.level" type="number" min="0" :max="route.length + (!originalProvider?.level ? 1 : 0)" required /></label><label>运行模式<select v-model="providerForm.mode"><option value="auto">auto</option><option value="ask">ask</option></select></label></div><p class="footnote">level 0 仅显式使用；修改已有优先级会与占位 Provider 交换。</p><button class="button primary" :disabled="busy">预览修改</button></form></div>
  <div v-if="pending" class="modal-backdrop preview-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="确认配置修改"><div class="card-head"><div><h2>{{ pending.title }}</h2><p>操作发生在运行 ai web 的这台机器。</p></div><button class="icon-button" :disabled="busy" aria-label="关闭预览" @click="pending = null"><X :size="17" /></button></div><div v-for="change in changes" :key="change.field" class="change-row"><strong>{{ change.field }}</strong><span>{{ change.before }}</span><ArrowRight :size="14" /><b>{{ change.after }}</b></div><div v-if="error" class="error-banner" role="alert">{{ error }}</div><p class="footnote">{{ pending.body.action === 'codex-usage' ? '仅更新本机采集设置，无需重启 App。采集设置和游标不进入配置快照，关闭后已有用量保留。' : pending.url === '/api/codex' ? '修改 Codex 共享用户配置；旧聊天不迁移，写入失败由 core 自动回滚。' : 'Runtime 配置修改前保留本机备份。已启动的进程可能需要重启。' }}</p><div class="button-row"><button class="button" :disabled="busy" @click="pending = null">取消</button><button class="button primary" :disabled="busy" @click="commit"><Check :size="14" />{{ busy ? '校验并保存中…' : '确认应用' }}</button></div></section></div>
</template>
