<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, Blocks, Check, CircleCheck, Copy, Globe2, Image, LoaderCircle, Monitor, RefreshCw, Server, ShieldCheck, Sparkles, Terminal, X } from 'lucide-vue-next'
import { api, type Dashboard, type ServiceExposure } from './console-api'
import ExposureCredentials from './ExposureCredentials.vue'
import ServicePlayground from './ServicePlayground.vue'
import SshSetup from './SshSetup.vue'
import RemoteDeployment from './RemoteDeployment.vue'

const props = defineProps<{ exposure: ServiceExposure }>()
const emit = defineEmits<{ reload: []; notice: [message: string] }>()
type Step = 'capabilities' | 'credentials' | 'connection' | 'verify'
type ServiceState = { supported: boolean; running: boolean; autostart: boolean; installed: boolean; manager: string; logPath: string; baseUrl: string; detail: string }
type SshConfig = { host: string; user: string; port: number; identityFile: string }
type TunnelState = ServiceState & { connected: boolean; config: SshConfig | null }
type ExposureInput = { publicBaseUrl: string; upstreamUrl?: string; connectionMode?: 'ssh' | 'local'; capabilities: string[] }
type SavePlan = { input: ExposureInput; next: 'credentials' | 'connect' | null; title: string }
const saved = ref(props.exposure)
const step = ref<Step>('capabilities')
const navigated = ref(false)
const busy = ref(false)
const credentialBusy = ref(false)
const sshBusy = ref(false)
const playgroundBusy = ref(false)
const deploymentBusy = ref(false)
const pending = computed(() => loading.value || busy.value || credentialBusy.value || sshBusy.value || playgroundBusy.value || deploymentBusy.value)
const progress = ref('')
const error = ref('')
const message = ref('')
const loading = ref(true)
const currentTime = ref(Date.now())
const expiryTimer = setInterval(() => { currentTime.value = Date.now() }, 15_000)
onBeforeUnmount(() => clearInterval(expiryTimer))
const service = ref<ServiceState | null>(null)
const tunnel = ref<TunnelState | null>(null)
const verification = ref({ verified: false, verifiedAt: null as string | null })
const capabilities = ref([...props.exposure.capabilities])
const mode = ref<'ssh' | 'local'>(props.exposure.connectionMode ?? (props.exposure.updatedAt && props.exposure.upstreamUrl === 'http://127.0.0.1:8080' ? 'local' : 'ssh'))
const publicAccess = ref(!!props.exposure.publicBaseUrl)
const publicBaseUrl = ref(props.exposure.publicBaseUrl)
const ssh = ref<SshConfig>({ host: '', user: 'root', port: 22, identityFile: '' })
const sshEdited = ref(false)
const savePlan = ref<SavePlan | null>(null)
const connection = ref<{ ok: boolean; target: string; durationMs: number } | null>(null)
const tunnelCheck = ref('')
const exampleCapability = ref('')
const stepPanel = ref<HTMLElement | null>(null)
const activeCredentials = computed(() => saved.value.credentials.filter(item => (!item.policy?.expiresAt || Date.parse(item.policy.expiresAt) > currentTime.value) && item.capabilities.some(capability => saved.value.capabilities.includes(capability))))
const selectedCapabilities = computed(() => saved.value.catalog.filter(item => saved.value.capabilities.includes(item.id)))
const capabilitiesDirty = computed(() => JSON.stringify([...capabilities.value].sort()) !== JSON.stringify([...saved.value.capabilities].sort()))
const upstream = computed(() => mode.value === 'ssh' ? 'http://127.0.0.1:18080' : 'http://127.0.0.1:8080')
const placementDirty = computed(() => mode.value !== saved.value.connectionMode || upstream.value !== saved.value.upstreamUrl)
const tunnelDirty = computed(() => !tunnel.value?.config || JSON.stringify(ssh.value) !== JSON.stringify(tunnel.value.config))
const tunnelLocked = computed(() => !!(tunnel.value?.running || tunnel.value?.autostart))
const entryUrl = computed(() => publicAccess.value ? publicBaseUrl.value.trim() : '')
const entryDirty = computed(() => entryUrl.value !== saved.value.publicBaseUrl)
const connectionReady = computed(() => !!service.value?.running && !!saved.value.connectionMode && (saved.value.connectionMode === 'local' || !!tunnel.value?.connected))
const needsPreparation = computed(() => !saved.value.capabilities.length ? 'capabilities' : !activeCredentials.value.length ? 'credentials' : null)
const steps = computed(() => [
  { id: 'capabilities' as const, title: '开放能力', detail: saved.value.capabilities.length ? `已保存 ${saved.value.capabilities.length} 项能力` : '选择应用需要的接口', complete: saved.value.capabilities.length > 0 },
  { id: 'credentials' as const, title: '调用凭证', detail: activeCredentials.value.length ? `${activeCredentials.value.length} 个有效凭证` : '为调用方分配权限', complete: activeCredentials.value.length > 0 },
  { id: 'connection' as const, title: '启动与连接', detail: connectionReady.value ? (saved.value.connectionMode === 'ssh' ? 'API 与服务器已连接' : '本机 API 已运行') : '连接应用所在的服务器', complete: connectionReady.value },
  { id: 'verify' as const, title: '验证与调用', detail: verification.value.verified ? '公网授权调用已验证' : '获取地址并发起真实请求', complete: verification.value.verified },
])
const currentStep = computed(() => steps.value.find(item => item.id === step.value)!)
const connectLabel = computed(() => {
  if (busy.value) return progress.value || '操作中…'
  if (mode.value === 'local') return service.value?.running ? '前往验证与调用' : '启动 API 并继续'
  if (tunnel.value?.running && !tunnel.value.connected) return '刷新连接状态'
  if (tunnel.value?.connected && !tunnelDirty.value && !placementDirty.value && service.value?.running) return '前往验证与调用'
  return service.value?.running ? '保存并连接服务器' : '启动 API 并连接服务器'
})
const connectBlocked = computed(() => {
  if (loading.value) return '正在读取本机服务状态。'
  if (!service.value) return '服务状态读取失败，请刷新状态后再试。'
  if (!service.value.supported) return service.value.detail
  if (needsPreparation.value) return needsPreparation.value === 'capabilities' ? '先完成第 1 步，保存至少一项开放能力。' : '先完成第 2 步，创建未过期且包含开放能力的调用凭证。'
  if (mode.value === 'ssh' && !tunnel.value?.supported) return tunnel.value?.detail || '无法读取 SSH 隧道状态，请刷新后再试。'
  if (mode.value === 'ssh' && tunnelLocked.value && (tunnelDirty.value || placementDirty.value)) return '请先在运行管理中断开隧道并关闭自启，再修改配置。'
  return ''
})
const capabilityDetails: Record<string, { description: string; icon: typeof Image }> = {
  images: { description: '根据文字描述生成图片', icon: Image }, image_edits: { description: '上传参考图，按指令编辑图片', icon: Sparkles },
  chat: { description: 'OpenAI 兼容的聊天接口', icon: Blocks }, responses: { description: '通过 Responses 协议处理输入', icon: Blocks },
  models: { description: '查询可用模型目录', icon: Blocks }, embeddings: { description: '将文本转换为向量', icon: Blocks },
  agent: { description: '在隔离工作区执行任务，按需开放', icon: Terminal }, tools: { description: '调用已注册的只读 Runtime 工具', icon: Blocks },
}
const nginx = computed(() => selectedCapabilities.value.map(item => `location = ${item.path} {\n    proxy_pass ${saved.value.upstreamUrl};\n    proxy_http_version 1.1;\n    proxy_set_header Authorization $http_authorization;\n    proxy_set_header X-Request-ID $request_id;\n    proxy_buffering off;\n    proxy_read_timeout 600s;\n    client_max_body_size 58m;\n}`).join('\n\n') + `\n\nlocation = /health/live {\n    proxy_pass ${saved.value.upstreamUrl};\n}\n\nlocation / { return 404; }`)
const curl = computed(() => {
  const item = selectedCapabilities.value.find(item => item.id === exampleCapability.value) ?? selectedCapabilities.value[0]
  if (!item) return '请先保存至少一项开放能力。'
  const address = `${saved.value.publicBaseUrl || saved.value.upstreamUrl}${item.path}`
  if (item.id === 'image_edits') return `curl ${address} \\\n  -H 'Authorization: Bearer YOUR_SERVICE_TOKEN' \\\n  -F 'model=YOUR_IMAGE_MODEL' \\\n  -F 'prompt=将背景改为蓝色' -F 'image=@reference.png'`
  const payloads: Record<string, unknown> = {
    images: { model: 'YOUR_IMAGE_MODEL', prompt: '画一只猫', n: 1, size: '1024x1024', response_format: 'b64_json' },
    chat: { model: 'YOUR_MODEL', messages: [{ role: 'user', content: 'hello' }] },
    agent: { engine: 'codex', prompt: 'hello', workspace_id: 'demo', permission_mode: 'read_only' },
    embeddings: { model: 'YOUR_MODEL', input: 'hello' }, tools: { name: 'runtime.status' },
  }
  return `curl ${address} \\\n  -H 'Authorization: Bearer YOUR_SERVICE_TOKEN'${item.method === 'POST' ? ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(payloads[item.id] ?? { model: 'YOUR_MODEL', input: 'hello' })}'` : ''}`
})
function receiveExposure(value: ServiceExposure) {
  if (!capabilitiesDirty.value) capabilities.value = [...value.capabilities]
  if (!placementDirty.value && value.connectionMode) mode.value = value.connectionMode
  if (!entryDirty.value) { publicAccess.value = !!value.publicBaseUrl; publicBaseUrl.value = value.publicBaseUrl }
  saved.value = value
}
watch(() => props.exposure, receiveExposure)
watch(() => saved.value.updatedAt, () => { connection.value = null; void refreshVerification() })
function go(destination: Step) {
  if (pending.value) return
  navigated.value = true; step.value = destination; error.value = ''; message.value = ''
  void nextTick(() => stepPanel.value?.focus({ preventScroll: true }))
}
function describe(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
async function operate(label: string, action: () => Promise<void>) {
  if (pending.value) return
  busy.value = true; progress.value = label; error.value = ''; message.value = ''
  try { await action() } catch (reason) { error.value = describe(reason) }
  finally { busy.value = false; progress.value = '' }
}
async function reloadExposure() {
  try { receiveExposure((await api<Dashboard>('/api/state')).settings.exposure); currentTime.value = Date.now(); await refreshVerification(); emit('reload'); return true }
  catch (reason) { error.value = `配置已变更，但读取最新状态失败：${describe(reason)}。请刷新状态，不要重复创建凭证。`; return false }
}
async function refreshVerification() { verification.value = await api<typeof verification.value>('/api/exposure/verification').catch(() => ({ verified: false, verifiedAt: null })) }
async function readStatus() {
  const results = await Promise.allSettled([api<ServiceState>('/api/exposure/service'), api<TunnelState>('/api/exposure/tunnel')])
  if (results[0].status === 'fulfilled') service.value = results[0].value
  if (results[1].status === 'fulfilled') {
    const firstRead = !tunnel.value
    tunnel.value = results[1].value
    if (firstRead && !sshEdited.value && tunnel.value.config) ssh.value = { ...tunnel.value.config }
  }
  if (results[0].status === 'rejected') throw results[0].reason
  if (mode.value === 'ssh' && results[1].status === 'rejected') throw results[1].reason
}
async function refreshStatus() { await operate('刷新状态…', async () => { await readStatus(); await reloadExposure() }) }
onMounted(async () => {
  try { await Promise.all([readStatus(), refreshVerification()]) } catch (reason) { error.value = describe(reason) }
  finally { loading.value = false; if (!navigated.value) step.value = needsPreparation.value ?? (connectionReady.value ? 'verify' : 'connection') }
})
function persistedInput(): ExposureInput { return { publicBaseUrl: saved.value.publicBaseUrl, upstreamUrl: saved.value.upstreamUrl, ...(saved.value.connectionMode ? { connectionMode: saved.value.connectionMode } : {}), capabilities: [...saved.value.capabilities] } }
function prepareCapabilities() {
  if (capabilitiesDirty.value) savePlan.value = { input: { ...persistedInput(), capabilities: [...capabilities.value] }, next: capabilities.value.length ? 'credentials' : null, title: '确认开放能力' }
  else if (saved.value.capabilities.length) go('credentials')
}
async function persist(input: ExposureInput) {
  await api('/api/exposure', { method: 'POST', body: JSON.stringify(input) })
  saved.value = { ...saved.value, ...input, upstreamUrl: input.connectionMode === 'ssh' ? 'http://127.0.0.1:18080' : input.connectionMode === 'local' ? 'http://127.0.0.1:8080' : saved.value.upstreamUrl, updatedAt: new Date().toISOString() }
  verification.value = { verified: false, verifiedAt: null }; emit('reload')
}
async function confirmSave() {
  const plan = savePlan.value
  if (!plan) return
  await operate('保存配置…', async () => {
    await persist(plan.input); savePlan.value = null; message.value = '配置已保存。'
    if (plan.next === 'credentials') step.value = 'credentials'
    else if (plan.next === 'connect') await startConnection()
  })
}
async function continueCredentials() {
  await operate('读取凭证状态…', async () => {
    if (!await reloadExposure()) return
    if (!activeCredentials.value.length) throw new Error('请先创建有效调用凭证，再继续连接。')
    step.value = 'connection'; navigated.value = true
  })
}
async function saveSsh() { tunnel.value = await api<TunnelState>('/api/exposure/tunnel', { method: 'PUT', body: JSON.stringify(ssh.value) }); tunnelCheck.value = '' }
async function saveSshOnly() { await operate('保存 SSH 配置…', async () => { await saveSsh(); message.value = 'SSH 配置已保存。稍后可继续启动与连接。' }) }
async function beginConnection() {
  currentTime.value = Date.now()
  if (connectBlocked.value || pending.value) return
  if (placementDirty.value) { savePlan.value = { input: { ...persistedInput(), connectionMode: mode.value }, next: 'connect', title: '确认接入方式并启动' }; return }
  await operate('准备连接…', startConnection)
}
async function startConnection() {
  navigated.value = true
  if (mode.value === 'ssh' && tunnelDirty.value) { progress.value = '保存 SSH 配置…'; await saveSsh() }
  progress.value = '检查服务状态…'; await readStatus()
  if (!service.value?.running) {
    progress.value = '启动 API…'
    service.value = await api<ServiceState>('/api/exposure/service', { method: 'POST', body: JSON.stringify({ action: 'start' }) })
    if (!service.value.running) throw new Error('API 尚未运行，请刷新状态或展开运行管理查看日志。SSH 尚未启动。')
  }
  if (mode.value === 'ssh') {
    if (!tunnel.value?.running) {
      progress.value = '连接服务器…'
      tunnel.value = await api<TunnelState>('/api/exposure/tunnel', { method: 'POST', body: JSON.stringify({ action: 'start' }) })
    }
    if (!tunnel.value?.connected) { message.value = 'API 已运行，SSH 隧道正在连接。请稍后刷新连接状态；若持续未连接，展开运行管理查看日志。'; return }
  }
  step.value = 'verify'; message.value = '服务已就绪。现在可以获取调用地址，发送一次授权请求。'
}
function prepareEntry() {
  if (!entryDirty.value) { message.value = '访问地址已保存。'; return }
  savePlan.value = { input: { ...persistedInput(), publicBaseUrl: entryUrl.value }, next: null, title: '确认访问地址' }
}
async function controlService(action: string) {
  if (['start', 'restart', 'enable'].includes(action) && needsPreparation.value) { go(needsPreparation.value); return }
  await operate('更新 API 服务…', async () => { service.value = await api<ServiceState>('/api/exposure/service', { method: 'POST', body: JSON.stringify({ action }) }); message.value = service.value.detail })
}
async function controlTunnel(action: string) {
  await operate(action === 'test' ? '验证服务器端口…' : '更新 SSH 连接…', async () => {
    if (action === 'test') { const result = await api<{ ok: boolean; detail: string }>('/api/exposure/tunnel', { method: 'POST', body: JSON.stringify({ action }) }); tunnelCheck.value = result.ok ? result.detail : '服务器健康检查未通过，请检查隧道与 API 状态。' }
    else { tunnel.value = await api<TunnelState>('/api/exposure/tunnel', { method: 'POST', body: JSON.stringify({ action }) }); message.value = tunnel.value.detail }
  })
}
async function test(target: string) { await operate('检查连通性…', async () => { connection.value = await api('/api/exposure/test', { method: 'POST', body: JSON.stringify({ target }) }) }) }
function copy(value: string) { void navigator.clipboard.writeText(value).then(() => emit('notice', '已复制。')).catch(() => { error.value = '复制失败，请手动复制。' }) }
</script>

<template>
  <div class="exposure-workspace">
    <header class="exposure-overview">
      <div class="overview-title"><span class="overview-icon"><Globe2 :size="21" /></span><div><h2>把 Runtime 连接到你的应用</h2><p>选择能力、分配凭证，然后连接服务器并验证调用。</p></div></div>
      <div class="overview-status"><span class="status-pill" :class="{ ready: service?.running }"><i />API {{ loading ? '检查中' : service?.running ? '运行中' : '未启动' }}</span><button class="icon-button" :disabled="pending || loading" aria-label="刷新服务与连接状态" @click="refreshStatus"><RefreshCw :size="15" /></button></div>
    </header>
    <div class="exposure-layout">
      <aside class="setup-sidebar">
        <div class="sidebar-heading"><span>接入配置</span><small>{{ steps.filter(item => item.complete).length }} / 4 已完成</small></div>
        <nav aria-label="对外服务配置步骤"><ol><li v-for="(item, index) in steps" :key="item.id"><button :class="{ active: step === item.id, complete: item.complete }" :aria-current="step === item.id ? 'step' : undefined" :disabled="pending || loading" @click="go(item.id)"><span class="step-index"><Check v-if="item.complete" :size="15" /><template v-else>{{ index + 1 }}</template></span><span class="step-label"><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span><ArrowRight v-if="step === item.id" class="step-arrow" :size="14" /></button></li></ol></nav>
        <div class="sidebar-security"><ShieldCheck :size="18" /><p>只开放你授权的 API。<br />管理页面始终留在本机。</p></div>
      </aside>
      <div ref="stepPanel" class="setup-content" tabindex="-1" role="region" aria-label="当前配置步骤" :aria-busy="pending || loading">
        <div v-if="error" class="feedback error-feedback" role="alert"><X :size="17" /><p>{{ error }}</p></div>
        <div v-if="message" class="feedback success-feedback" role="status"><CircleCheck :size="17" /><p>{{ message }}</p></div>
        <div v-if="busy" class="operation-progress" role="status"><LoaderCircle :size="15" class="spinning" />{{ progress }}</div>
        <header class="step-heading"><span class="step-eyebrow">STEP 0{{ steps.findIndex(item => item.id === step) + 1 }}</span><h2>{{ currentStep.title }}</h2><p>{{ step === 'capabilities' ? '你的应用需要哪些能力？只勾选实际使用的接口。' : step === 'credentials' ? '为调用方创建专用凭证，用它访问已开放的能力。' : step === 'connection' ? '选择 Runtime 所在的位置，一次完成启动与服务器连接。' : '使用下面的地址和凭证，验证一次完整的授权调用。' }}</p></header>
        <section v-show="step === 'capabilities'" aria-label="开放能力配置">
          <div class="capability-options"><label v-for="item in saved.catalog" :key="item.id" class="capability-option" :class="{ selected: capabilities.includes(item.id) }"><span class="capability-symbol"><component :is="capabilityDetails[item.id]?.icon ?? Blocks" :size="20" /></span><span class="capability-copy"><strong>{{ item.name }}</strong><small>{{ capabilityDetails[item.id]?.description ?? '使用 Runtime 已实现的接口' }}</small></span><input v-model="capabilities" type="checkbox" :value="item.id" :disabled="pending" /><span class="selection-indicator"><Check v-if="capabilities.includes(item.id)" :size="13" /></span></label></div>
          <details class="technical-details"><summary>查看接口路径与能力说明</summary><div v-for="item in saved.catalog" :key="item.id" class="endpoint-row"><strong>{{ item.name }}</strong><code>{{ item.method }} {{ item.path }}</code></div><p>新增能力默认关闭，旧凭证不会自动扩权。Agent 执行有资源与权限影响；记忆检索尚未提供独立 API。</p></details>
          <footer class="step-footer"><p>{{ capabilities.length ? `已选择 ${capabilities.length} 项${capabilitiesDirty ? ' · 尚未保存' : ' · 已保存'}` : '尚未选择能力。保存空范围会关闭所有 API 能力。' }}</p><button class="button primary" :disabled="pending || (!capabilities.length && !capabilitiesDirty)" @click="prepareCapabilities">{{ capabilitiesDirty ? (capabilities.length ? '预览并继续' : '预览并关闭全部能力') : '下一步：调用凭证' }}<ArrowRight :size="15" /></button></footer>
        </section>
        <section v-show="step === 'credentials'" aria-label="调用凭证配置"><ExposureCredentials :exposure="saved" :disabled="busy || sshBusy" @busy="credentialBusy = $event" @reload="reloadExposure" @notice="emit('notice', $event)" @continue="continueCredentials" /><button class="text-button back-link" :disabled="pending" @click="go('capabilities')"><ArrowLeft :size="14" />返回开放能力</button></section>
        <section v-show="step === 'connection'" aria-label="启动与连接配置">
          <form @submit.prevent="beginConnection">
            <fieldset class="placement-choices" :disabled="pending || tunnelLocked"><legend>Runtime 运行在哪里？</legend><label :class="{ selected: mode === 'ssh' }"><input v-model="mode" type="radio" value="ssh" /><Monitor :size="23" /><strong>我的电脑</strong><small>通过 SSH 连接另一台服务器</small><span class="radio-dot" /></label><label :class="{ selected: mode === 'local' }"><input v-model="mode" type="radio" value="local" /><Server :size="23" /><strong>应用所在的服务器</strong><small>API 与反代同机，无需 SSH</small><span class="radio-dot" /></label></fieldset>
            <p v-if="tunnelLocked" class="configuration-note">隧道运行或已开启自启，连接配置暂时锁定。修改前请展开下方「运行管理与连接详情」，断开隧道并关闭自启。</p>
            <p v-if="!saved.connectionMode && !['http://127.0.0.1:8080', 'http://127.0.0.1:18080'].includes(saved.upstreamUrl)" class="configuration-note">旧版自定义上游 {{ saved.upstreamUrl }} 会在确认接入方式后替换为 {{ upstream }}；当前配置尚未修改。</p>
            <div v-show="mode === 'ssh'" class="ssh-configuration"><div class="subsection-heading"><h3>连接哪台服务器？</h3><span class="inline-state" :class="{ ready: tunnel?.connected }">{{ tunnel?.connected ? '已连接' : tunnel?.running ? '连接中' : '未连接' }}</span></div><fieldset class="ssh-fields" :disabled="pending || tunnelLocked || mode !== 'ssh'" @input="sshEdited = true"><label class="host-field">服务器 IP 或域名<input v-model.trim="ssh.host" required placeholder="例如 154.201.73.41" autocomplete="off" /></label><label>SSH 用户<input v-model.trim="ssh.user" required placeholder="root" autocomplete="off" /></label><label class="identity-field">本机 SSH 私钥路径<input v-model.trim="ssh.identityFile" required placeholder="填写已有私钥的绝对路径，不含 .pub" autocomplete="off" /><small>使用运行 Runtime 的这台电脑上的密钥。</small></label><label>SSH 端口<input v-model.number="ssh.port" required type="number" min="1" max="65535" /></label></fieldset><div class="ssh-save-row"><span>{{ tunnelDirty ? '服务器信息尚未保存' : '服务器信息已保存' }}</span><button type="button" class="text-button" :disabled="pending || !tunnel || !tunnelDirty || tunnelLocked" @click="saveSshOnly">仅保存 SSH 配置</button></div></div>
            <div v-if="mode === 'local'" class="local-explanation"><Server :size="25" /><div><strong>直接使用本机 API</strong><p>无需服务器地址或密钥。启动后，应用通过 <code>127.0.0.1:8080</code> 和调用凭证访问。</p></div></div>
            <div class="connection-preview"><span><Monitor :size="15" />Runtime API</span><span class="route-line">{{ mode === 'ssh' ? 'SSH 隧道' : '直接连接' }}</span><span><Server :size="15" />{{ mode === 'ssh' ? '远端服务器' : '本机应用' }}</span></div>
            <div v-if="connectBlocked" class="inline-guidance"><p>{{ connectBlocked }}</p><button v-if="needsPreparation" type="button" class="text-button" :disabled="pending" @click="go(needsPreparation)">{{ needsPreparation === 'capabilities' ? '去开放能力' : '去创建凭证' }}<ArrowRight :size="14" /></button></div>
            <footer class="step-footer"><div><button type="button" class="text-button" :disabled="pending" @click="go('credentials')"><ArrowLeft :size="14" />上一步</button><p>关闭 Web 后继续运行。首次连接不会开启自启。</p></div><button class="button primary" :disabled="pending || !!connectBlocked">{{ connectLabel }}<ArrowRight v-if="!busy" :size="15" /></button></footer>
          </form>
          <div v-show="mode === 'ssh'"><SshSetup :config="ssh" :disabled="busy || credentialBusy" :mutation-locked="tunnelLocked" @busy="sshBusy = $event" @identity="ssh.identityFile = $event; sshEdited = true" @notice="emit('notice', $event)" /></div>
          <details class="technical-details management-details"><summary>运行管理与连接详情</summary><div class="manager-section"><div class="subsection-heading"><h3>API 后台服务</h3><span class="inline-state" :class="{ ready: service?.running }">{{ service?.running ? '运行中' : '未运行' }}</span></div><p>{{ service?.detail || '读取服务状态中' }} · {{ service?.manager || '—' }}</p><code>{{ service?.baseUrl || 'http://127.0.0.1:8080' }}</code><p>日志：<code>{{ service?.logPath || '—' }}</code></p><div class="button-row"><button class="button" :disabled="pending || !service?.supported" @click="controlService(service?.autostart ? 'disable' : 'enable')">{{ service?.autostart ? '关闭 API 自启' : '开启 API 自启并启动' }}</button><button class="button" :disabled="pending || !service?.installed" @click="controlService('restart')">重启 API</button><button class="button danger" :disabled="pending || !service?.installed" @click="controlService('stop')">停止 API 并关闭自启</button></div></div><div v-if="mode === 'ssh'" class="manager-section"><div class="subsection-heading"><h3>SSH 隧道</h3><span class="inline-state" :class="{ ready: tunnel?.connected }">{{ tunnel?.connected ? '已连接' : '未确认连接' }}</span></div><p>{{ tunnel?.detail || '读取连接状态中' }}</p><p>服务器上游：<code>{{ upstream }}</code></p><p>日志：<code>{{ tunnel?.logPath || '—' }}</code></p><div class="button-row"><button class="button" :disabled="pending || !tunnel?.connected" @click="controlTunnel('test')">验证服务器端口</button><button class="button" :disabled="pending || !tunnel?.supported || (!tunnel.autostart && (tunnelDirty || placementDirty || !service?.running || !!needsPreparation))" @click="controlTunnel(tunnel?.autostart ? 'disable' : 'enable')">{{ tunnel?.autostart ? '关闭隧道自启' : '开启隧道自启并连接' }}</button><button class="button danger" :disabled="pending || !tunnel?.installed" @click="controlTunnel('stop')">断开隧道并关闭自启</button></div><p v-if="tunnelCheck" role="status">{{ tunnelCheck }}</p><p>修改部署位置、服务器或密钥前，先断开隧道并关闭自启。电脑休眠、断网或密钥代理不可用会影响连接；服务器需允许 TCP 远程转发。</p></div><button class="text-button" :disabled="pending" @click="refreshStatus"><RefreshCw :size="14" />刷新运行状态</button><p>macOS 登录后自启；Linux 无登录长期运行需管理员启用 linger。Windows 用户任务需要登录，适配尚待实机验收。</p></details>
        </section>
        <section v-show="step === 'verify'" class="verification-panel" aria-label="验证与调用配置">
          <div v-if="!connectionReady" class="inline-guidance"><p>API 或服务器尚未就绪。可先设置访问地址，发起调用前请完成连接。</p><button class="text-button" :disabled="pending" @click="go('connection')">返回启动与连接<ArrowRight :size="14" /></button></div>
          <section class="access-card"><div class="subsection-heading"><h3>从哪里调用？</h3><span v-if="verification.verified" class="inline-state ready"><Check :size="13" />公网调用已验证</span></div><div class="access-switch" role="group" aria-label="访问范围"><button :class="{ active: !publicAccess }" :aria-pressed="!publicAccess" :disabled="pending" @click="publicAccess = false">仅服务器内部</button><button :class="{ active: publicAccess }" :aria-pressed="publicAccess" :disabled="pending" @click="publicAccess = true">公网 HTTPS</button></div><form @submit.prevent="prepareEntry"><label v-if="publicAccess">公网 HTTPS 入口<input v-model="publicBaseUrl" required type="url" placeholder="https://ai.example.com" :disabled="pending" /><small>使用指向服务器的域名，保存后再部署 Nginx 与证书。</small></label><p v-else class="access-description">在{{ saved.connectionMode === 'ssh' ? '远端服务器' : '本机' }}内部，通过下面的地址和调用凭证访问。无需域名或 HTTPS 证书。</p><div class="endpoint-display"><div><span>{{ entryDirty ? '当前已保存的调用地址' : '调用地址' }}</span><code>{{ saved.publicBaseUrl || saved.upstreamUrl }}</code></div><button type="button" class="icon-button" aria-label="复制调用地址" @click="copy(saved.publicBaseUrl || saved.upstreamUrl)"><Copy :size="15" /></button></div><div v-if="entryDirty" class="entry-save"><span>访问范围或地址尚未保存</span><button class="button" :disabled="pending">预览并保存地址</button></div></form></section>
          <details v-if="saved.connectionMode === 'ssh' && saved.publicBaseUrl" class="technical-details deployment-details"><summary>部署公网入口 · Nginx 与 HTTPS</summary><RemoteDeployment :disabled="busy || playgroundBusy" @busy="deploymentBusy = $event" @notice="emit('notice', $event)" /></details>
          <ServicePlayground :exposure="saved" :disabled="busy || deploymentBusy" @busy="playgroundBusy = $event" @verified="refreshVerification" @notice="emit('notice', $event)" />
          <details class="technical-details"><summary>调用示例与手动反代配置</summary><label>示例能力<select v-model="exampleCapability"><option value="">默认能力</option><option v-for="item in selectedCapabilities" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><p>{{ saved.publicBaseUrl ? '在已部署的公网入口调用：' : '在应用服务器上执行以下命令：' }}</p><pre>{{ curl }}</pre><button class="button" @click="copy(curl)"><Copy :size="14" />复制调用示例</button><h3>Nginx 配置片段</h3><p>放入已配置 TLS 的独立 server 块，上游由接入方式自动生成。</p><pre>{{ nginx }}</pre><button class="button" @click="copy(nginx)"><Copy :size="14" />复制 Nginx 配置</button></details>
          <details class="technical-details"><summary>连通性检查与故障排查</summary><p>健康检查不调用模型，也不能证明凭证权限或模型可用。</p><div class="button-row"><button class="button" :disabled="pending" @click="test('upstream')">检查本机 API</button><button class="button" :disabled="pending || !saved.publicBaseUrl" @click="test('public')">检查公网入口</button><button v-if="saved.connectionMode === 'ssh'" class="button" :disabled="pending || !tunnel?.connected" @click="controlTunnel('test')">检查服务器转发端口</button></div><p v-if="connection" role="status">{{ connection.target === 'public' ? '公网入口' : '本机 API' }}：{{ connection.ok ? '健康检查通过' : '未连通或响应不符合 Runtime 协议' }} · {{ connection.durationMs }} ms</p><p v-if="tunnelCheck" role="status">{{ tunnelCheck }}</p><p>401：检查凭证是否过期或撤销；403：检查能力和模型范围；429：检查请求限流和额度。请求超时后先查看运行记录再重试。</p></details>
          <button class="text-button back-link" :disabled="pending" @click="go('connection')"><ArrowLeft :size="14" />返回启动与连接</button>
        </section>
      </div>
    </div>
    <div v-if="savePlan" class="modal-backdrop"><section class="modal exposure-confirm" role="dialog" aria-modal="true" aria-label="确认服务配置"><header class="card-head"><div><span class="step-eyebrow">REVIEW</span><h2>{{ savePlan.title }}</h2></div><button class="icon-button" :disabled="pending" aria-label="取消保存" @click="savePlan = null"><X :size="17" /></button></header><div class="review-row"><span>开放能力</span><strong>{{ saved.catalog.filter(item => savePlan?.input.capabilities.includes(item.id)).map(item => item.name).join('、') || '全部关闭' }}</strong></div><div class="review-row"><span>部署位置</span><strong>{{ savePlan.input.connectionMode === 'ssh' ? '我的电脑 → SSH 服务器' : savePlan.input.connectionMode === 'local' ? '与应用同机' : '保留现有接入方式' }}</strong></div><div class="review-row"><span>反代上游</span><strong>{{ savePlan.input.connectionMode === 'ssh' ? 'http://127.0.0.1:18080' : savePlan.input.connectionMode === 'local' ? 'http://127.0.0.1:8080' : savePlan.input.upstreamUrl }}</strong></div><div class="review-row"><span>公网入口</span><strong>{{ savePlan.input.publicBaseUrl || '仅服务器内部调用' }}</strong></div><p class="review-note">{{ savePlan.next === 'connect' ? (savePlan.input.connectionMode === 'local' ? '确认后保存接入方式并启动本机 API。已经运行的服务会跳过；不会开启自启或部署 Nginx。' : '确认后保存接入方式，启动 API 并连接服务器。已经完成的操作会跳过；不会开启自启或部署 Nginx。') : '保存后按新的范围检查请求。不会启动服务、连接 SSH 或部署反代。' }}</p><p v-if="error" class="feedback error-feedback" role="alert">{{ error }}</p><footer class="button-row"><button class="button" :disabled="pending" @click="savePlan = null">取消</button><button class="button primary" :disabled="pending" @click="confirmSave">{{ pending ? '保存中…' : savePlan.next === 'connect' ? '确认并启动连接' : '确认保存' }}</button></footer></section></div>
  </div>
</template>

<style scoped>
.exposure-workspace { --exposure-muted: #817b72; font-size: 13px; }
.exposure-overview { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 18px; padding: 0 0 26px; }
.overview-title, .overview-status { display: flex; align-items: center; gap: 12px; }
.overview-icon { width: 44px; height: 44px; display: grid; place-items: center; color: #7b6594; background: #ece6f2; border: 1px solid #e0d6e9; border-radius: 13px; flex: none; }
.overview-title h2 { margin: 0 0 6px; font-size: 17px; font-weight: 620; }
.overview-title p { margin: 0; color: var(--exposure-muted); font-size: 12px; line-height: 1.8; }
.status-pill { display: inline-flex; gap: 7px; align-items: center; padding: 7px 10px; background: #eeece5; border-radius: 20px; color: #8d8271; font-size: 11px; white-space: nowrap; }
.status-pill i { width: 6px; height: 6px; background: currentColor; border-radius: 50%; }
.status-pill.ready { color: #58785d; background: #e8eee5; }
.exposure-layout { display: grid; grid-template-columns: 222px minmax(0, 1fr); gap: 30px; align-items: start; }
.setup-sidebar { padding-top: 5px; position: sticky; top: 24px; }
.sidebar-heading { display: flex; justify-content: space-between; align-items: center; padding: 0 12px 18px; color: #82786a; font-size: 11px; }
.sidebar-heading small { color: #a49a89; font-size: 10px; }
.setup-sidebar ol { padding: 0; margin: 0; list-style: none; display: grid; gap: 8px; }
.setup-sidebar nav button { width: 100%; display: flex; align-items: center; gap: 12px; padding: 16px 12px; text-align: left; color: var(--ink); background: transparent; border: 1px solid transparent; border-radius: 11px; }
.setup-sidebar nav button:hover { background: #f0ede5; }
.setup-sidebar nav button.active { background: #ece6f2; border-color: #ded3e8; }
.step-index { display: grid; place-items: center; width: 29px; height: 29px; border: 1px solid #ddd7cb; background: #f9f7f1; color: #9b8e78; border-radius: 50%; font-size: 12px; flex: none; }
.active .step-index { background: #847095; color: white; border-color: #847095; }
.complete:not(.active) .step-index { background: #e7eee3; color: #66805c; border-color: #d7e2d1; }
.step-label { flex: 1; min-width: 0; }
.step-label strong { font-weight: 600; font-size: 13px; }
.step-label small { display: block; color: #9a9081; font-size: 10px; line-height: 1.7; margin-top: 5px; }
.active .step-label small { color: #9c8ca6; }
.step-arrow { color: #9380a2; flex: none; }
.sidebar-security { display: flex; gap: 10px; border-top: 1px solid var(--border); margin: 24px 12px 0; padding-top: 20px; color: #8d937e; }
.sidebar-security svg { flex: none; margin-top: 3px; }
.sidebar-security p { margin: 0; font-size: 11px; line-height: 1.9; }
.setup-content { min-width: 0; padding: 30px; border: 1px solid var(--border); border-radius: 15px; background: var(--paper); outline: none; }
.step-heading { padding-bottom: 24px; }
.step-eyebrow { display: block; color: #9c8eac; font-size: 10px; letter-spacing: 1.8px; font-weight: 600; margin-bottom: 12px; }
.step-heading h2 { font-size: 23px; margin: 0 0 10px; letter-spacing: .3px; font-weight: 630; }
.step-heading p { margin: 0; color: var(--exposure-muted); font-size: 13px; line-height: 1.8; }
.capability-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.capability-option { display: flex; align-items: center; gap: 12px; position: relative; padding: 19px 16px; border: 1px solid var(--border); border-radius: 11px; margin: 0; cursor: pointer; background: #fffefa; }
.capability-option:hover { border-color: #c7b9d2; }
.capability-option.selected { border-color: #b6a3c7; background: #f6f1fa; }
.capability-symbol { width: 36px; height: 36px; display: grid; place-items: center; color: #9b8b75; background: #f2eee6; border-radius: 9px; flex: none; }
.selected .capability-symbol { color: #8a6ba2; background: #ece2f3; }
.capability-copy { flex: 1; min-width: 0; }
.capability-copy strong { display: block; font-weight: 570; font-size: 13px; }
.capability-copy small { display: block; font-size: 11px; color: var(--exposure-muted); line-height: 1.7; margin-top: 6px; }
.capability-option input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.capability-option:has(input:focus-visible) { outline: 3px solid #b7a8d3; outline-offset: 3px; }
.selection-indicator { width: 17px; height: 17px; border: 1px solid #d8d0c1; border-radius: 5px; display: grid; place-items: center; flex: none; }
.selected .selection-indicator { color: white; background: #8b739f; border-color: #8b739f; }
.step-footer { border-top: 1px solid var(--border); margin-top: 28px; padding-top: 22px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
.step-footer p { font-size: 11px; color: var(--exposure-muted); line-height: 1.8; margin: 0; }
.step-footer > div > p { margin-top: 10px; }
.exposure-workspace :deep(.button) { min-height: 39px; font-size: 12px; box-shadow: none; padding: 10px 15px; }
.exposure-workspace :deep(.button.primary) { background: #806b91; border-color: #806b91; }
.exposure-workspace :deep(.button.primary:hover) { background: #6e5a80; }
.exposure-workspace :deep(.text-button) { font-size: 12px; }
.exposure-workspace :deep(label) { font-size: 12px; }
.exposure-workspace :deep(input:not([type='checkbox']):not([type='radio'])), .exposure-workspace :deep(select), .exposure-workspace :deep(textarea) { font-size: 13px; }
.exposure-workspace :deep(pre) { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; line-height: 1.9; max-height: 450px; overflow: auto; }
.exposure-workspace :deep(code) { overflow-wrap: anywhere; }
.technical-details { border-top: 1px solid var(--border); margin-top: 22px; padding-top: 17px; font-size: 12px; }
.technical-details > summary { cursor: pointer; color: #8b7e94; line-height: 1.8; font-size: 12px; }
.technical-details[open] > summary { margin-bottom: 20px; }
.technical-details p { color: var(--exposure-muted); font-size: 12px; line-height: 1.9; overflow-wrap: anywhere; }
.technical-details h3 { margin: 22px 0 10px; font-size: 13px; font-weight: 600; }
.endpoint-row { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 11px 0; border-bottom: 1px solid #f0ece4; font-size: 11px; }
.endpoint-row strong { font-weight: 500; }
.endpoint-row code { color: var(--exposure-muted); }
.placement-choices { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; min-width: 0; }
.placement-choices legend { margin-bottom: 15px; font-size: 13px; font-weight: 570; }
.placement-choices > label { position: relative; display: grid; justify-items: start; gap: 9px; border: 1px solid var(--border); border-radius: 11px; padding: 22px 18px; margin: 0; cursor: pointer; }
.placement-choices > label.selected { background: #f6f1fa; border-color: #b6a3c7; }
.placement-choices input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.placement-choices label:has(input:focus-visible) { outline: 3px solid #b7a8d3; outline-offset: 3px; }
.placement-choices svg { color: #9b8b75; margin-bottom: 6px; }
.placement-choices .selected svg { color: #8a6ba2; }
.placement-choices strong { font-size: 13px; font-weight: 570; }
.placement-choices small { font-size: 11px; line-height: 1.8; color: var(--exposure-muted); }
.placement-choices:disabled label { opacity: .65; cursor: not-allowed; }
.configuration-note { font-size: 11px; line-height: 1.9; color: var(--exposure-muted); margin: 15px 0 0; }
.radio-dot { position: absolute; top: 18px; right: 16px; border: 1px solid #d2c9ba; width: 17px; height: 17px; border-radius: 50%; }
.selected .radio-dot { border: 5px solid #89729e; background: white; }
.ssh-configuration { margin-top: 28px; }
.subsection-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
.subsection-heading h3 { margin: 0; font-size: 14px; font-weight: 580; }
.inline-state { display: inline-flex; gap: 5px; align-items: center; color: #9b8d77; font-size: 11px; }
.inline-state.ready { color: #65815f; }
.ssh-fields { display: grid; grid-template-columns: minmax(0, 1fr) 135px; gap: 18px; border: 0; margin: 0; padding: 0; min-width: 0; }
.ssh-fields label { margin: 0; }
.ssh-fields small, .access-card small { display: block; font-size: 11px; color: var(--exposure-muted); font-weight: 400; margin-top: 7px; line-height: 1.7; }
.ssh-save-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
.ssh-save-row > span { color: #a49a89; font-size: 11px; }
.connection-preview { display: flex; align-items: center; justify-content: center; gap: 18px; background: #f7f5ef; padding: 17px 12px; border-radius: 8px; margin-top: 24px; color: #857b6d; font-size: 11px; }
.connection-preview > span:not(.route-line) { display: inline-flex; align-items: center; gap: 7px; }
.route-line { font-size: 10px; color: #9f91a8; display: flex; align-items: center; gap: 8px; }
.route-line:before, .route-line:after { content: ''; height: 1px; width: 20px; background: #d4c9dd; }
.local-explanation { display: flex; gap: 16px; align-items: center; padding: 24px 0 0; }
.local-explanation > svg { color: #92829f; flex: none; }
.local-explanation strong { font-size: 13px; font-weight: 550; }
.local-explanation p { font-size: 12px; color: var(--exposure-muted); line-height: 1.9; margin: 7px 0 0; }
.inline-guidance { padding: 16px; border: 1px solid #e7dcc5; background: #fbf6e9; border-radius: 9px; margin: 20px 0; }
.inline-guidance p { color: #9c8764; font-size: 12px; line-height: 1.8; margin: 0; }
.inline-guidance .text-button { margin-top: 10px; }
.manager-section { margin-bottom: 24px; }
.manager-section .button-row { margin-top: 16px; }
.feedback { display: flex; align-items: flex-start; gap: 10px; padding: 13px 15px; border-radius: 9px; margin-bottom: 20px; font-size: 12px; line-height: 1.9; overflow-wrap: anywhere; }
.feedback svg { flex: none; margin-top: 3px; }
.feedback p { margin: 0; }
.error-feedback { background: #faeeea; color: #b16d60; border: 1px solid #ecd3c9; }
.success-feedback { background: #edf3e9; color: #69805b; border: 1px solid #dce6d4; }
.operation-progress { display: flex; gap: 8px; align-items: center; font-size: 12px; color: #8c789b; margin-bottom: 18px; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.access-card { padding: 22px; border: 1px solid var(--border); border-radius: 11px; background: #fdfbf6; }
.access-switch { display: inline-flex; gap: 4px; padding: 4px; border: 1px solid #e4ddd1; border-radius: 9px; background: #efebe3; margin-bottom: 20px; }
.access-switch button { border: 1px solid transparent; background: transparent; color: #948773; font-size: 12px; border-radius: 6px; padding: 9px 16px; }
.access-switch button.active { background: var(--paper); border-color: #e3dbce; color: #776481; box-shadow: 0 1px 3px #5a49380a; }
.access-description { font-size: 12px; color: var(--exposure-muted); line-height: 1.9; margin: 0 0 18px; }
.endpoint-display { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #f2eee5; border-radius: 8px; padding: 15px; }
.endpoint-display > div { min-width: 0; }
.endpoint-display span { display: block; font-size: 10px; color: #a49780; margin-bottom: 7px; }
.endpoint-display code { font-size: 13px; color: #73684f; }
.entry-save { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 16px; }
.entry-save > span { font-size: 11px; color: #ac9271; }
.back-link { margin-top: 24px; }
.exposure-workspace :deep(.setup-panel) { border: 0; border-top: 1px solid var(--border); padding: 17px 0 0; border-radius: 0; margin-top: 22px; }
.exposure-workspace :deep(.setup-panel > summary) { font-weight: 400; color: #8b7e94; }
.exposure-workspace :deep(.playground) { border: 0; border-radius: 0; box-shadow: none; padding: 28px 0 0; margin: 26px 0 0; border-top: 1px solid var(--border); }
.exposure-workspace :deep(.playground h2) { font-size: 15px; }
.exposure-workspace :deep(.playground .card-head p) { font-size: 12px; }
.deployment-details :deep(.card) { border: 0; padding: 0; margin: 0; box-shadow: none; }
.exposure-confirm { max-width: 540px; }
.exposure-confirm h2 { font-size: 20px; margin: 0; }
.review-row { display: flex; justify-content: space-between; gap: 20px; padding: 15px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.review-row > span { color: var(--exposure-muted); flex: none; }
.review-row > strong { font-weight: 500; overflow-wrap: anywhere; text-align: right; }
.review-note { font-size: 12px; line-height: 1.9; color: var(--exposure-muted); margin: 20px 0; }
.exposure-confirm .button-row { justify-content: flex-end; }
@media (max-width: 1200px) { .exposure-layout { grid-template-columns: 190px minmax(0, 1fr); gap: 20px; } .setup-content { padding: 26px; } .capability-options { grid-template-columns: 1fr; } }
@media (max-width: 900px) {
  .exposure-layout { grid-template-columns: 1fr; gap: 18px; } .setup-sidebar { position: static; padding: 0; } .sidebar-heading, .sidebar-security { display: none; }
  .setup-sidebar ol { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; } .setup-sidebar nav button { flex-direction: column; text-align: center; gap: 8px; padding: 12px 4px; }
  .step-label small, .step-arrow { display: none; } .step-label strong { font-size: 11px; } .capability-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .overview-icon { display: none; } .overview-title h2 { font-size: 16px; } .overview-title p { font-size: 11px; } .exposure-overview { gap: 12px; padding-bottom: 18px; }
  .setup-content { padding: 22px 18px; border-radius: 12px; } .step-heading h2 { font-size: 21px; } .step-heading p { font-size: 12px; }
  .capability-options { grid-template-columns: 1fr; } .capability-option { padding: 16px 13px; } .placement-choices { grid-template-columns: 1fr; gap: 10px; }
  .placement-choices > label { padding: 17px; grid-template-columns: 28px 1fr; gap: 6px 10px; } .placement-choices svg { grid-row: span 2; margin: 0; align-self: center; } .placement-choices small { grid-column: 2; padding-right: 15px; }
  .ssh-fields { grid-template-columns: minmax(0, 1fr) 95px; gap: 16px 12px; } .host-field, .identity-field { grid-column: 1 / -1; } .ssh-fields label:nth-child(2) { grid-row: 3; }
  .step-footer { align-items: stretch; gap: 18px; } .step-footer > .button { width: 100%; } .connection-preview { gap: 8px; font-size: 10px; } .route-line { gap: 5px; } .route-line:before, .route-line:after { width: 10px; }
  .access-card { padding: 18px 14px; } .access-switch { display: flex; } .access-switch button { flex: 1; padding: 9px 8px; }
}
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
</style>
