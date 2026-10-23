<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { ArrowRight, ArrowUpRight, Check, Copy, Globe2, KeyRound, Monitor, RefreshCw, Server, ShieldCheck, X } from 'lucide-vue-next'
import { api, type ServiceExposure } from './console-api'
import ServicePlayground from './ServicePlayground.vue'
import SshSetup from './SshSetup.vue'
import RemoteDeployment from './RemoteDeployment.vue'

const props = defineProps<{ exposure: ServiceExposure }>()
const emit = defineEmits<{ reload: []; notice: [message: string] }>()
const tab = ref('反代接入')
const tabs = ['反代接入', '能力开放', '访问控制', '接入测试']
const publicBaseUrl = ref(props.exposure.publicBaseUrl)
const connectionMode = ref<'ssh' | 'local'>(props.exposure.connectionMode ?? (props.exposure.updatedAt !== null && props.exposure.upstreamUrl === 'http://127.0.0.1:8080' ? 'local' : 'ssh'))
const upstreamUrl = computed(() => connectionMode.value === 'ssh' ? 'http://127.0.0.1:18080' : 'http://127.0.0.1:8080')
const capabilities = ref([...props.exposure.capabilities])
const credentialName = ref('')
const credentialCapabilities = ref<string[]>([])
const credentialPolicy = ref({ providers: '', models: '', expiresAt: '', requestsPerMinute: '', requestQuota: '' })
const verification = ref({ verified: false, verifiedAt: null as string | null })
type ConnectionStep = 'placement' | 'server' | 'entry'
const connectionStep = ref<ConnectionStep>('placement')
const saveNext = ref<ConnectionStep | 'test' | null>(null)
const newToken = ref('')
const busy = ref(false)
const error = ref('')
const confirmSave = ref(false)
const connection = ref<{ ok: boolean; target: string; durationMs: number } | null>(null)
const exampleCapability = ref('')
const service = ref<{ supported: boolean; running: boolean; autostart: boolean; installed: boolean; manager: string; logPath: string; baseUrl: string; detail: string } | null>(null)
type TunnelState = { supported: boolean; running: boolean; connected: boolean; autostart: boolean; installed: boolean; logPath: string; detail: string; config: null | { host: string; user: string; port: number; identityFile: string } }
const tunnel = ref<TunnelState | null>(null)
const prerequisites = computed(() => [
  { title: '开放能力', ready: props.exposure.capabilities.length > 0, target: '能力开放' },
  { title: '调用凭证', ready: props.exposure.credentials.some(item => (!item.policy?.expiresAt || new Date(item.policy.expiresAt).getTime() > Date.now()) && item.capabilities.some(capability => props.exposure.capabilities.includes(capability))), target: '访问控制' },
  { title: 'API 服务', ready: !!service.value?.running, target: 'service' },
])
const missingServicePreparation = computed(() => prerequisites.value.slice(0, 2).find(item => !item.ready))
const servicePreparationHint = computed(() => missingServicePreparation.value?.target === '能力开放'
  ? '尚未保存开放能力。先选择需要提供的能力（例如图片生成），再创建调用凭证，最后启动 API。'
  : '尚无匹配开放能力的有效调用凭证。请在「访问控制」创建凭证并保存 Token，再启动 API。')
const placementDirty = computed(() => connectionMode.value !== props.exposure.connectionMode || upstreamUrl.value !== props.exposure.upstreamUrl)
const connectionSteps = computed(() => [
  { id: 'placement' as const, title: '选择部署位置', detail: '确定 Runtime 和反代的位置', complete: !placementDirty.value },
  ...(connectionMode.value === 'ssh' ? [{ id: 'server' as const, title: '连接服务器', detail: '填写 SSH 信息并连接', complete: !!tunnel.value?.connected && !tunnelDirty.value }] : []),
  { id: 'entry' as const, title: '设置访问地址', detail: '内部调用或公网 HTTPS', complete: verification.value.verified },
])
function openPreparation(target: string) {
  error.value = ''
  if (target === 'service' && missingServicePreparation.value) tab.value = missingServicePreparation.value.target
  else if (target === 'service') document.getElementById('exposure-service')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  else tab.value = target
}
function returnToConnection() {
  tab.value = '反代接入'
  connectionStep.value = connectionMode.value === 'ssh' ? 'server' : 'entry'
}
function continuePlacement() {
  const destination = connectionMode.value === 'ssh' ? 'server' : 'entry'
  if (dirty.value) { saveNext.value = destination; confirmSave.value = true }
  else connectionStep.value = destination
}
function continueEntry() {
  if (dirty.value) { saveNext.value = 'test'; confirmSave.value = true }
  else tab.value = '接入测试'
}
const ssh = ref({ host: '', user: 'root', port: 22, identityFile: '' })
const tunnelCheck = ref('')
const tunnelDirty = computed(() => !tunnel.value?.config || JSON.stringify(ssh.value) !== JSON.stringify(tunnel.value.config))
const sshPreparation = computed(() => {
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  return `ssh -F /dev/null -o StrictHostKeyChecking=ask -o PreferredAuthentications=publickey -i ${quote(ssh.value.identityFile || '/absolute/path/to/key')} -p ${quote(String(ssh.value.port))} -l ${quote(ssh.value.user)} -- ${quote(ssh.value.host || 'YOUR_SERVER')} true`
})
async function refreshTunnel() {
  try {
    tunnel.value = await api<TunnelState>('/api/exposure/tunnel')
    if (tunnel.value.config) ssh.value = { ...tunnel.value.config }
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
async function saveTunnel() {
  const result = await run<TunnelState>('/api/exposure/tunnel', ssh.value, 'PUT')
  if (result) { tunnel.value = result; tunnelCheck.value = ''; emit('notice', 'SSH 配置已保存，可稍后完成 API 准备再连接。') }
  return !!result
}
async function submitTunnel(event: SubmitEvent) {
  if ((event.submitter as HTMLButtonElement | null)?.value === 'save') await saveTunnel()
  else await connectTunnel()
}
async function connectTunnel() {
  if (busy.value) return
  if (missingServicePreparation.value) { openPreparation(missingServicePreparation.value.target); return }
  if (!service.value?.running) { openPreparation('service'); return }
  if (tunnelDirty.value && !await saveTunnel()) return
  await controlTunnel('start')
}
async function controlTunnel(action: string) {
  if (action === 'test') {
    const result = await run<{ ok: boolean; detail: string }>('/api/exposure/tunnel', { action })
    if (result) tunnelCheck.value = result.ok ? result.detail : '服务器健康检查响应不符合 Runtime 协议。'
  } else {
    const result = await run<TunnelState>('/api/exposure/tunnel', { action })
    if (result) { tunnel.value = result; tunnelCheck.value = ''; emit('notice', result.detail) }
  }
}
async function refreshService() {
  try { service.value = await api('/api/exposure/service') }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
async function controlService(action: string) {
  if (['start', 'restart', 'enable'].includes(action) && missingServicePreparation.value) {
    openPreparation(missingServicePreparation.value.target)
    return
  }
  const result = await run<NonNullable<typeof service.value>>('/api/exposure/service', { action })
  if (result) { service.value = result; emit('notice', result.detail) }
}
onMounted(refreshService)
onMounted(refreshTunnel)
async function refreshVerification() { verification.value = await api<typeof verification.value>('/api/exposure/verification').catch(() => ({ verified: false, verifiedAt: null })) }
onMounted(refreshVerification)
watch(() => props.exposure.updatedAt, refreshVerification)
const selectedCapabilities = computed(() => props.exposure.catalog.filter(item => props.exposure.capabilities.includes(item.id)))
const dirty = computed(() => connectionMode.value !== props.exposure.connectionMode || publicBaseUrl.value !== props.exposure.publicBaseUrl || upstreamUrl.value !== props.exposure.upstreamUrl || JSON.stringify([...capabilities.value].sort()) !== JSON.stringify([...props.exposure.capabilities].sort()))
const nginx = computed(() => selectedCapabilities.value.map(item => `location = ${item.path} {\n    proxy_pass ${props.exposure.upstreamUrl};\n    proxy_http_version 1.1;\n    proxy_set_header Authorization $http_authorization;\n    proxy_set_header X-Request-ID $request_id;\n    proxy_buffering off;\n    proxy_read_timeout 600s;\n    client_max_body_size 58m;\n}`).join('\n\n') + `\n\nlocation = /health/live {\n    proxy_pass ${props.exposure.upstreamUrl};\n}\n\nlocation / { return 404; }`)
const curl = computed(() => {
  const item = selectedCapabilities.value.find(capability => capability.id === exampleCapability.value) ?? selectedCapabilities.value[0]
  if (!item) return '请先选择并保存至少一项开放能力。'
  if (item.id === 'image_edits') return `curl ${props.exposure.publicBaseUrl || props.exposure.upstreamUrl}/v1/images/edits -H 'Authorization: Bearer YOUR_SERVICE_TOKEN' -F 'model=YOUR_IMAGE_MODEL' -F 'prompt=将背景改为蓝色' -F 'image=@reference.png'`
  if (item.id === 'images') return `curl ${props.exposure.publicBaseUrl || props.exposure.upstreamUrl}/v1/images/generations -H 'Authorization: Bearer YOUR_SERVICE_TOKEN' -H 'Content-Type: application/json' -d '{"model":"YOUR_IMAGE_MODEL","prompt":"画一只猫","n":1,"size":"1024x1024","response_format":"b64_json"}'`
  const payload = item.id === 'agent' ? '{"engine":"codex","prompt":"hello","workspace_id":"demo","permission_mode":"read_only"}' : item.id === 'chat' ? '{"model":"YOUR_MODEL","messages":[{"role":"user","content":"hello"}]}' : item.id === 'embeddings' ? '{"model":"YOUR_MODEL","input":"hello"}' : item.id === 'tools' ? '{"name":"runtime.status"}' : '{"model":"YOUR_MODEL","input":"hello"}'
  return `curl ${props.exposure.publicBaseUrl || props.exposure.upstreamUrl}${item.path} \\\n  -H 'Authorization: Bearer YOUR_SERVICE_TOKEN'${item.method === 'POST' ? ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${payload}'` : ''}`
})
async function run<T>(url: string, body: unknown, method = 'POST'): Promise<T | null> {
  if (busy.value) return null
  busy.value = true; error.value = ''
  try { return await api<T>(url, { method, body: JSON.stringify(body) }) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); return null }
  finally { busy.value = false }
}
async function save() {
  const result = await run<{ effect: string }>('/api/exposure', { publicBaseUrl: publicBaseUrl.value, connectionMode: connectionMode.value, capabilities: capabilities.value })
  if (result) {
    emit('notice', result.effect); emit('reload'); confirmSave.value = false; connection.value = null
    if (saveNext.value === 'test') tab.value = '接入测试'
    else if (saveNext.value) connectionStep.value = saveNext.value
    saveNext.value = null
  }
}
async function createCredential() {
  const policy = credentialPolicy.value
  const result = await run<{ token: string }>('/api/exposure/credentials', { name: credentialName.value, capabilities: credentialCapabilities.value, policy: { providers: policy.providers.split(/[,，\n]/).map(item => item.trim()).filter(Boolean), models: policy.models.split(/[,，\n]/).map(item => item.trim()).filter(Boolean), ...(policy.expiresAt ? { expiresAt: new Date(policy.expiresAt).toISOString() } : {}), ...(policy.requestsPerMinute ? { requestsPerMinute: Number(policy.requestsPerMinute) } : {}), ...(policy.requestQuota ? { requestQuota: Number(policy.requestQuota) } : {}) } })
  if (result) { newToken.value = result.token; credentialName.value = ''; credentialCapabilities.value = []; emit('reload') }
}
async function revoke(id: string) {
  if (!confirm('撤销这个调用凭证？对应应用将无法继续访问。')) return
  if (await run(`/api/exposure/credentials/${id}`, {}, 'DELETE')) { emit('notice', '调用凭证已撤销。'); emit('reload') }
}
async function rotate(id: string) {
  if (!confirm('立即轮换凭证？旧 Token 将立即失效，新 Token 只显示一次。')) return
  const result = await run<{ token: string }>(`/api/exposure/credentials/${id}/rotate`, {})
  if (result) { newToken.value = result.token; emit('reload'); void refreshVerification() }
}
async function test(target: string) {
  connection.value = await run('/api/exposure/test', { target })
}
function copy(value: string) { void navigator.clipboard.writeText(value).then(() => emit('notice', '已复制。')).catch(() => { error.value = '复制失败，请手动复制。' }) }
</script>

<template>
  <div class="exposure-settings">
  <section id="exposure-service" class="card service-overview" aria-label="API 后台服务">
    <div class="service-summary"><span class="exposure-icon"><Server :size="22" /></span><div><div class="title-line"><h2>API 后台服务</h2><span class="state-badge" :class="{ ready: service?.running }"><i />{{ service ? (service.running ? '运行中' : '未运行') : '读取状态中' }}</span></div><p>独立后台运行，关闭管理页面后服务继续保持。</p></div><button class="icon-button" :disabled="busy" aria-label="刷新服务状态" @click="refreshService"><RefreshCw :size="15" /></button></div>
    <template v-if="service">
      <div class="service-toolbar"><div class="service-endpoint"><span>本机 API</span><code>{{ service.baseUrl }}</code><span class="autostart-label">自启{{ service.autostart ? '已开启' : '已关闭' }}</span></div><div v-if="service.supported" class="button-row"><button class="button primary" :disabled="busy || service.running" @click="controlService('start')">{{ service.running ? '服务已启动' : '启动服务' }}</button><button class="button" :disabled="busy" @click="controlService(service.autostart ? 'disable' : 'enable')">{{ service.autostart ? '关闭自启' : '开启自启并启动' }}</button></div></div>
      <details class="advanced-panel"><summary>服务详情与管理</summary><p>{{ service.detail }} · {{ service.manager }}</p><p>日志：<code>{{ service.logPath }}</code></p><div v-if="service.supported" class="button-row"><button class="button" :disabled="busy || !service.installed" @click="controlService('restart')">重启服务</button><button class="button danger" :disabled="busy || !service.installed" @click="controlService('stop')">停止并关闭自启</button></div><p>先保存能力并创建凭证。macOS 登录后自启；Linux 无登录长期运行需管理员配置 linger。服务固定监听 127.0.0.1:8080。</p></details>
    </template>
  </section>
  <div class="subnav" aria-label="对外服务分类"><button v-for="item in tabs" :key="item" :class="{ active: tab === item }" :aria-pressed="tab === item" @click="tab = item">{{ item }}</button></div>
  <div class="exposure-security"><ShieldCheck :size="16" /><p>仅开放授权的 API 能力，管理页面始终保留在本机。反代与 HTTPS 在服务器部署。</p></div>
  <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div class="setup-prerequisites" aria-label="接入前准备">
      <span>接入前准备</span>
      <div class="prerequisite-list"><button v-for="item in prerequisites" :key="item.target" type="button" :class="{ ready: item.ready }" @click="openPreparation(item.target)"><Check v-if="item.ready" :size="13" /><span v-else class="prerequisite-dot" />{{ item.title }}<small>{{ item.ready ? '已就绪' : '去完成' }}</small><ArrowUpRight v-if="!item.ready" :size="12" /></button></div>
    </div>
    <div v-if="missingServicePreparation" class="preparation-help" role="status"><p>{{ servicePreparationHint }}SSH 信息可先单独保存。</p><button class="button" :disabled="busy" @click="openPreparation(missingServicePreparation.target)">{{ missingServicePreparation.target === '能力开放' ? '选择并保存开放能力' : '去创建调用凭证' }}<ArrowRight :size="14" /></button></div>
    <div v-else-if="tab === '能力开放' || tab === '访问控制'" class="preparation-help" role="status"><p>{{ service?.running ? 'API 已运行，可以继续连接配置。' : '能力和凭证已就绪。点击上方「启动服务」，然后返回连接配置。' }}</p><button class="button" :disabled="busy || placementDirty" @click="returnToConnection">返回连接配置<ArrowRight :size="14" /></button></div>
  <template v-if="tab === '反代接入'">
    <section class="card connection-wizard" aria-label="配置服务器接入">
      <div class="guide-heading"><div><h2>配置服务器接入</h2><p>按下面这一条流程操作，每次只需完成当前步骤。</p></div><span class="guide-count">{{ connectionSteps.findIndex(step => step.id === connectionStep) + 1 }} / {{ connectionSteps.length }}</span></div>
      <nav aria-label="反代接入配置步骤"><ol class="wizard-steps" :style="{ '--wizard-step-count': connectionSteps.length }"><li v-for="(step, index) in connectionSteps" :key="step.id"><button type="button" :class="{ active: connectionStep === step.id, complete: step.complete }" :aria-current="connectionStep === step.id ? 'step' : undefined" :disabled="busy || (step.id !== 'placement' && placementDirty)" :title="step.id !== 'placement' && placementDirty ? '先保存部署位置再继续' : undefined" @click="connectionStep = step.id"><span class="step-number"><Check v-if="step.complete" :size="15" /><template v-else>{{ index + 1 }}</template></span><span><strong>{{ step.title }}</strong><small>{{ step.detail }}</small></span></button></li></ol></nav>
      <div v-show="connectionStep === 'placement'" class="wizard-panel">
        <div class="card-head"><div><h3>Runtime 和反代服务器在哪里？</h3><p>这是接入方式的选择；需要 SSH 时，下一步再填写服务器信息。</p></div><Globe2 :size="22" /></div>
        <p v-if="!exposure.connectionMode && !['http://127.0.0.1:8080', 'http://127.0.0.1:18080'].includes(exposure.upstreamUrl)" class="note-paper">检测到旧版自定义上游 {{ exposure.upstreamUrl }}。保存部署位置后会替换为自动上游；原配置尚未修改。</p>
        <form class="deployment-form" @submit.prevent="continuePlacement">
          <fieldset class="deployment-choices" :disabled="busy || tunnel?.running || tunnel?.autostart"><legend class="sr-only">Runtime 和 Nginx 的部署位置</legend><label class="deployment-option" :class="{ selected: connectionMode === 'ssh' }"><input v-model="connectionMode" type="radio" value="ssh" /><span class="choice-icon"><Monitor :size="21" /></span><span><strong>Runtime 在我的电脑上</strong><small>通过 SSH 连接另一台服务器，由它转发请求</small></span><span class="radio-indicator" /></label><label class="deployment-option" :class="{ selected: connectionMode === 'local' }"><input v-model="connectionMode" type="radio" value="local" /><span class="choice-icon"><Server :size="21" /></span><span><strong>Runtime 就在反代服务器上</strong><small>两者在同一台机器，自动跳过 SSH 配置</small></span><span class="radio-indicator" /></label></fieldset>
          <p class="wizard-hint">{{ connectionMode === 'ssh' ? '接下来只需准备服务器地址、SSH 账户和本机密钥。连接端口由 Runtime 自动配置。' : '无需填写远端服务器或 SSH 密钥，下一步直接设置访问地址。' }}</p>
          <p v-if="tunnel?.running || tunnel?.autostart" class="note-paper">部署位置已锁定。需要切换时，先到「连接服务器 → 连接管理」断开并关闭自启。</p>
          <div class="form-footer"><p>反代上游自动生成，无需填写。</p><button class="button primary" :disabled="busy">{{ dirty ? '保存并继续' : '下一步' }}<ArrowRight :size="14" /></button></div>
        </form>
      </div>
      <div v-if="connectionMode === 'ssh'" v-show="connectionStep === 'server'" class="wizard-panel">
        <div class="card-head"><div><h3>填写服务器信息并连接</h3><p>连接从运行 Runtime 的这台电脑发起。首次使用时，展开下方准备指纹和密钥。</p></div><span class="state-badge" :class="{ ready: tunnel?.connected }"><i />{{ tunnel?.connected ? '已连接' : tunnel?.running ? '连接中' : '未连接' }}</span></div>
        <form id="exposure-ssh-form" class="ssh-form" @submit.prevent="submitTunnel">
          <fieldset class="ssh-fields" :disabled="busy || tunnel?.running || tunnel?.autostart">
            <label>服务器 IP 或域名<input v-model="ssh.host" required placeholder="例如：154.201.73.41" /></label>
            <label>SSH 用户<input v-model="ssh.user" required placeholder="root" /></label>
            <label>SSH 端口<input v-model.number="ssh.port" required type="number" min="1" max="65535" /></label>
            <label>本机 SSH 私钥路径<input v-model="ssh.identityFile" required placeholder="已有密钥填绝对路径；没有密钥可在下方生成" /></label>
          </fieldset>
        </form>
        <SshSetup :config="ssh" :disabled="busy" :mutation-locked="!!(tunnel?.running || tunnel?.autostart)" @identity="ssh.identityFile = $event" @notice="emit('notice', $event)" />
        <p v-if="!service?.running" id="ssh-api-preparation" class="note-paper">{{ missingServicePreparation ? '连接前请按上方提示完成开放能力与调用凭证，再启动 API。' : '能力和凭证已就绪，点击上方「启动服务」后即可连接。' }}你可以先保存 SSH 配置；切换分类补齐准备项时，已填写的信息也会保留。</p>
        <div v-if="tunnel?.supported" class="button-row connect-actions"><button form="exposure-ssh-form" type="submit" class="button" value="save" :disabled="busy || !tunnelDirty || tunnel.running || tunnel.autostart">{{ tunnelDirty ? '仅保存 SSH 配置' : 'SSH 配置已保存' }}</button><button form="exposure-ssh-form" type="submit" class="button primary" :aria-describedby="!service?.running ? 'ssh-api-preparation' : undefined" :disabled="busy || !!missingServicePreparation || !service?.running || tunnel.running || (tunnel.autostart && tunnelDirty) || placementDirty">{{ tunnel.connected ? '服务器已连接' : tunnel.running ? '正在连接…' : tunnelDirty ? '保存并连接服务器' : '连接服务器' }}</button><button class="button" :disabled="busy" @click="refreshTunnel">刷新连接状态</button></div>
        <template v-if="tunnel">
          <details class="advanced-panel"><summary>连接管理：自启、验证与断开</summary><p>{{ tunnel.detail }}</p><p>自启{{ tunnel.autostart ? '已开启' : '已关闭' }} · 日志：<code>{{ tunnel.logPath }}</code></p><div v-if="tunnel.supported" class="button-row"><button class="button" :disabled="busy || !tunnel.connected" @click="controlTunnel('test')">验证服务器端口</button><button class="button" :disabled="busy || (!tunnel.autostart && (tunnelDirty || placementDirty || !service?.running))" @click="controlTunnel(tunnel.autostart ? 'disable' : 'enable')">{{ tunnel.autostart ? '关闭隧道自启' : '开启隧道自启并连接' }}</button><button class="button danger" :disabled="busy || !tunnel.installed" @click="controlTunnel('stop')">断开并关闭自启</button></div><p>关闭 Web 不会断开；更换服务器前先断开并关闭自启。电脑休眠、断网或 SSH 权限仍会影响连接。自动上游为服务器的 127.0.0.1:18080。</p></details>
          <p v-if="!tunnel.supported" class="note-paper">{{ tunnel.detail }}</p>
          <p v-if="tunnelCheck" class="note-paper" role="status">{{ tunnelCheck }}</p>
        </template>
        <details class="advanced-panel"><summary>使用终端准备 SSH（可选）</summary><p>也可使用已授权的密钥，在本机终端核对指纹。带口令的密钥需确保后台服务能访问已解锁的密钥代理。服务器需允许 TCP 远程转发，远端健康验证需要 curl。固定的服务器 18080 端口需保持可用。</p><pre>{{ sshPreparation }}</pre><button class="button" @click="copy(sshPreparation)">复制首次连接命令</button></details>
        <div class="form-footer wizard-footer"><button class="button" :disabled="busy" @click="connectionStep = 'placement'">上一步</button><div><p>{{ tunnel?.connected ? '连接已建立，下一步选择从哪里访问。' : '连接成功后继续；也可点击上方「设置访问地址」先保存入口。' }}</p><button class="button primary" :disabled="busy || !tunnel?.connected || tunnelDirty" @click="connectionStep = 'entry'">下一步：设置访问地址<ArrowRight :size="14" /></button></div></div>
      </div>
      <div v-show="connectionStep === 'entry'" class="wizard-panel">
        <div class="card-head"><div><h3>设置调用方使用的访问地址</h3><p>仅服务器内部调用可留空；需要公网访问时，填写自己的 HTTPS 域名。</p></div><ShieldCheck :size="22" /></div>
        <div class="connection-route" aria-label="服务连接路径"><span><Globe2 :size="16" />{{ connectionMode === 'ssh' ? '远端服务器' : '本机服务器' }}</span><ArrowRight :size="16" /><span v-if="connectionMode === 'ssh'">SSH 隧道</span><ArrowRight v-if="connectionMode === 'ssh'" :size="16" /><span><Server :size="16" />Runtime API</span></div>
        <form class="deployment-form entry-form" @submit.prevent="continueEntry">
          <div class="deployment-fields"><label>公网 HTTPS 入口 <span class="optional-label">选填</span><input v-model="publicBaseUrl" type="url" placeholder="https://ai.example.com" :disabled="busy" /><small>有域名时，在下一页部署 Nginx 与证书，再发起授权测试。</small></label><div class="upstream-preview"><span>服务器上的反代上游 <span class="auto-label">自动配置</span></span><code>{{ upstreamUrl }}</code><small>{{ connectionMode === 'ssh' ? '服务器通过这个地址访问电脑上的 Runtime。' : '反代直接连接同一台机器上的 Runtime。' }}</small></div></div>
          <p v-if="!publicBaseUrl" class="note-paper">仅服务器内部使用：在服务器上通过上游地址和调用凭证请求 API，无需配置公网反代或证书。</p>
          <p v-if="connectionMode === 'ssh' && !tunnel?.connected" class="note-paper">服务器尚未确认连接。可以先保存地址，发起调用前请回到上一步完成连接。</p>
          <p v-if="verification.verified" class="note-paper" role="status">当前配置已通过公网授权调用验证。</p>
          <div class="form-footer wizard-footer"><button type="button" class="button" :disabled="busy" @click="connectionStep = connectionMode === 'ssh' ? 'server' : 'placement'">上一步</button><div><p>下一页提供部署计划、调用示例和实际请求测试。</p><button class="button primary" :disabled="busy">{{ dirty ? '保存并前往接入测试' : '前往接入测试' }}<ArrowRight :size="14" /></button></div></div>
        </form>
      </div>
    </section>
  </template>
  <template v-else-if="tab === '能力开放'"><div class="section-heading"><div><h2>按能力开放，而不是开放整个本机</h2><p>新增能力默认关闭。保存后，已启用此配置的 API 服务逐请求读取开放范围。</p></div><button class="button primary" :disabled="busy || !dirty" @click="saveNext = null; confirmSave = true">预览并保存</button></div><div class="capability-grid"><label v-for="item in exposure.catalog" :key="item.id" class="card capability-card" :class="{ checked: capabilities.includes(item.id) }"><div class="card-head"><span class="capability-icon"><ArrowUpRight :size="19" /></span><input v-model="capabilities" type="checkbox" :value="item.id" /></div><h2>{{ item.name }}</h2><code>{{ item.method }} {{ item.path }}</code><p>{{ item.id === 'agent' ? '远程执行有资源与权限影响，按需开启。' : '复用已实现的 Runtime API 接口。' }}</p></label><section v-for="name in ['记忆检索']" :key="name" class="card capability-card unavailable"><span class="pill unknown">尚未提供独立 API</span><h2>{{ name }}</h2><p>接口与权限边界完成后才能开放。</p></section></div><p class="footnote">当前开放控制粒度为接口能力。凭证支持 Provider／模型白名单、请求频率与总请求额度；embedding 路由仍受模型兼容性限制。</p></template>
  <template v-else-if="tab === '访问控制'"><section class="card form-card"><div class="card-head"><div><h2>为调用方创建独立凭证</h2><p>权限取“服务开放范围”与“凭证能力”的交集，可独立撤销。</p></div><KeyRound :size="22" /></div><form @submit.prevent="createCredential"><label>调用方名称<input v-model="credentialName" required maxlength="80" placeholder="例如：我的服务器" /></label><div class="checkbox-list"><label v-for="item in selectedCapabilities" :key="item.id"><input v-model="credentialCapabilities" type="checkbox" :value="item.id" />{{ item.name }}</label></div><p v-if="!selectedCapabilities.length" class="footnote">先在「能力开放」选择并保存至少一项能力。</p><details class="advanced-panel"><summary>有效期、模型范围与请求额度</summary><div class="form-grid"><label>Provider 白名单<input v-model="credentialPolicy.providers" placeholder="逗号分隔，留空不限" /></label><label>模型 ID 白名单<input v-model="credentialPolicy.models" placeholder="逗号分隔，留空不限" /></label><label>到期时间<input v-model="credentialPolicy.expiresAt" type="datetime-local" /></label><label>每分钟请求上限<input v-model="credentialPolicy.requestsPerMinute" type="number" min="1" placeholder="留空不限" /></label><label>总请求额度<input v-model="credentialPolicy.requestQuota" type="number" min="1" placeholder="留空不限；失败请求也计数" /></label></div><p>请求计数按凭证 ID 持久化，重启或轮换不会重置。这里限制请求次数，不是 Token 或金额预算。受限 Agent 必须显式指定获准的 Provider/模型。</p></details><button class="button primary" :disabled="busy || !credentialCapabilities.length">创建调用凭证</button></form></section><section class="card spaced"><h2>已创建凭证</h2><div v-for="credential in exposure.credentials" :key="credential.id" class="file-row"><div><strong>{{ credential.name }}</strong><small class="table-sub">{{ credential.capabilities.join(' · ') }} · {{ new Date(credential.createdAt).toLocaleDateString('zh-CN') }}</small></div><div><small class="table-sub">{{ credential.policy?.expiresAt ? `到期：${new Date(credential.policy.expiresAt).toLocaleString()}` : '长期有效' }} · {{ credential.policy?.requestsPerMinute ? `${credential.policy.requestsPerMinute} 次/分钟` : '不限频率' }} · {{ credential.policy?.requestQuota ? `总额度 ${credential.policy.requestQuota} 次` : '不限次数' }}</small><div class="button-row"><button class="button" :disabled="busy" @click="rotate(credential.id)">轮换 Token</button><button class="button danger" :disabled="busy" @click="revoke(credential.id)">撤销</button></div></div></div><div v-if="!exposure.credentials.length" class="empty">还没有调用凭证。密钥只在创建时显示一次，落盘仅保存 SHA-256 摘要。</div><p class="footnote">托管 API 只接受这里创建的调用凭证；旧环境变量服务 Token 仅适用于前台启动方式。</p></section></template>
  <template v-else><div class="equal-grid"><section class="card"><div class="card-head"><div><h2>检查服务连接</h2><p>测试已保存地址的 /health/live，不发送模型请求。</p></div></div><div class="button-row"><button class="button" :disabled="busy || !exposure.updatedAt" @click="test('upstream')">检查本机 API</button><button class="button" :disabled="busy || !exposure.publicBaseUrl" @click="test('public')">检查公网</button></div><div v-if="connection" class="note-paper">{{ connection.target === 'public' ? '公网' : '上游' }}：{{ connection.ok ? '已连通' : '未连通或响应不符合 Runtime 健康协议' }} · {{ connection.durationMs }} ms</div><p class="footnote">反代片段同时提供 /health/live 健康检查。连通后仍需使用真实授权调用验证能力；连接检查不证明凭证权限或模型可用。</p><h2 class="spaced">调用示例</h2><label>示例能力<select v-model="exampleCapability"><option value="">默认</option><option v-for="item in selectedCapabilities" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><pre>{{ curl }}</pre><button class="button" @click="copy(curl)"><Copy :size="14" />复制示例</button></section><section class="card"><div class="card-head"><div><h2>Nginx 配置片段</h2><p>放入你为此域名配置好 TLS 的独立 server 块。</p></div><button class="icon-button" aria-label="复制反代配置" @click="copy(nginx)"><Copy :size="15" /></button></div><pre class="code-panel">{{ nginx }}</pre><p class="footnote">按已保存能力生成精确路径，禁用响应缓冲以支持流式输出；其余路径返回 404。可复制手动部署；SSH 模式也可在上方预览并确认执行远端部署。</p></section></div><section class="card spaced"><h2>启动与生效</h2><p class="body-copy">保存开放能力并创建凭证后，点击上方「启动服务」，或执行 <code>ai server start</code>。后台服务固定监听 127.0.0.1:8080；关闭管理页面后继续运行。能力修改与凭证撤销逐请求生效。反代上游按部署方式自动生成。远端隧道端口请在「反代接入」验证；本页的本机检查不会访问远端 loopback。</p></section></template>
  <RemoteDeployment v-if="tab === '接入测试' && exposure.connectionMode === 'ssh' && !!exposure.publicBaseUrl" @notice="emit('notice', $event)" />
  <ServicePlayground v-if="tab === '接入测试'" :exposure="exposure" @verified="refreshVerification" @notice="emit('notice', $event)" />
  <div v-if="confirmSave" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="确认服务开放配置"><div class="card-head"><div><h2>保存服务开放配置</h2><p>不会自动部署反代，也不会启动 API 服务。</p></div><button class="icon-button" :disabled="busy" aria-label="取消保存" @click="confirmSave = false; saveNext = null"><X :size="16" /></button></div><div class="file-row"><span>公网入口</span><strong>{{ publicBaseUrl || '未设置' }}</strong></div><div class="file-row"><span>上游地址</span><strong>{{ upstreamUrl }}</strong></div><div class="file-row"><span>开放能力</span><strong>{{ capabilities.join(' · ') || '全部关闭' }}</strong></div><p v-if="error" class="error-banner">{{ error }}</p><div class="button-row"><button class="button" :disabled="busy" @click="confirmSave = false; saveNext = null">取消</button><button class="button primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '确认保存' }}</button></div></section></div>
  <div v-if="newToken" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="新调用凭证"><h2>保存好你的调用凭证</h2><p class="body-copy">只显示这一次。关闭后无法再次查看，遗失时需要创建新凭证。</p><pre class="secret-value">{{ newToken }}</pre><div class="button-row"><button class="button" @click="copy(newToken)"><Copy :size="14" />复制凭证</button><button class="button primary" @click="newToken = ''">已保存，关闭</button></div></section></div>
  </div>
</template>

<style scoped>
.exposure-settings { display: grid; gap: 20px; --exposure-muted: #817b70; }
.exposure-settings .spaced { margin-top: 0; }
.exposure-settings .card { padding: 26px; }
.exposure-settings .card h2 { font-size: 16px; letter-spacing: 0; }
.exposure-settings .card-head p, .exposure-settings .card > p, .exposure-settings .footnote { font-size: 12px; line-height: 1.8; color: var(--exposure-muted); }
.exposure-settings .card-head > svg { color: var(--accent); }
.service-overview { border-top: 3px solid #b4a4c9; }
.service-summary { display: flex; align-items: center; gap: 14px; }
.service-summary > div { flex: 1; min-width: 0; }
.service-summary p { font-size: 12px; color: var(--exposure-muted); margin: 6px 0 0; }
.exposure-icon, .choice-icon { width: 44px; height: 44px; border-radius: 12px; background: #eee9f4; color: #7a6595; display: inline-grid; place-items: center; flex: none; }
.title-line { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.title-line h2 { margin: 0; }
.state-badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 20px; background: #f0eee7; color: #857d70; font-size: 11px; padding: 5px 10px; white-space: nowrap; }
.state-badge i { height: 6px; width: 6px; background: currentColor; border-radius: 50%; }
.state-badge.ready { background: #e9f1e9; color: #53785b; }
.service-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-top: 22px; }
.service-endpoint { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--exposure-muted); }
.service-endpoint code { color: var(--ink); }
.autostart-label { border-left: 1px solid var(--border); padding-left: 12px; }
.exposure-settings .button { min-height: 37px; font-size: 12px; box-shadow: none; border-radius: 8px; }
.exposure-settings .button-row { margin: 0; gap: 8px; }
.exposure-settings .subnav { margin: 0; }
.exposure-security { display: flex; align-items: center; gap: 9px; color: #7e826e; }
.exposure-security svg { flex: none; }
.exposure-security p { font-size: 12px; margin: 0; line-height: 1.7; }
.guide-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 16px; }
.guide-heading h2 { font-size: 17px; margin: 0 0 6px; font-weight: 620; }
.guide-heading p { font-size: 12px; color: var(--exposure-muted); margin: 0; }
.guide-count { color: var(--accent); background: #ede8f3; border-radius: 20px; padding: 6px 12px; font-size: 11px; white-space: nowrap; }
.setup-prerequisites { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 2px 0; color: var(--exposure-muted); font-size: 12px; }
.prerequisite-list { display: flex; flex-wrap: wrap; gap: 8px; }
.prerequisite-list button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 18px; background: var(--paper); padding: 7px 10px; font-size: 11px; color: var(--ink); }
.prerequisite-list button.ready { color: #53785b; background: #eff4ed; border-color: #dce7d8; }
.prerequisite-list small { color: var(--exposure-muted); font-size: 10px; }
.prerequisite-dot { width: 6px; height: 6px; border-radius: 50%; background: #b69d7b; }
.preparation-help { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 14px 18px; border: 1px solid var(--border); border-radius: 9px; background: #f7f5ef; }
.preparation-help p { flex: 1 1 260px; margin: 0; font-size: 12px; line-height: 1.8; color: var(--exposure-muted); }
.wizard-steps { display: grid; grid-template-columns: repeat(var(--wizard-step-count), minmax(0, 1fr)); gap: 8px; padding: 0; margin: 24px 0 0; list-style: none; }
.wizard-steps button { width: 100%; height: 100%; display: flex; align-items: center; gap: 10px; padding: 15px 12px; border: 1px solid transparent; border-bottom: 2px solid var(--border); border-radius: 9px 9px 0 0; background: #f7f5ef; text-align: left; color: var(--ink); }
.wizard-steps button.active { background: #f2edf7; border-bottom-color: #9279aa; }
.wizard-steps button:disabled { opacity: .5; cursor: not-allowed; }
.step-number { width: 27px; height: 27px; flex: none; display: grid; place-items: center; background: #ece8df; color: #8c8171; border-radius: 50%; font-size: 12px; }
.active .step-number { background: #8a72a4; color: white; }
.complete:not(.active) .step-number { background: #e6efe3; color: #60805b; }
.wizard-steps strong { display: block; font-size: 12px; font-weight: 600; }
.wizard-steps small { display: block; font-size: 11px; color: var(--exposure-muted); margin-top: 5px; line-height: 1.5; }
.wizard-panel { padding-top: 28px; }
.wizard-panel h3 { font-size: 15px; margin: 0; }
.wizard-panel .card-head { margin-bottom: 22px; }
.wizard-panel .card-head > svg { color: var(--accent); }
.wizard-panel .card-head p { font-size: 12px; line-height: 1.8; color: var(--exposure-muted); margin: 7px 0 0; }
.wizard-hint { font-size: 12px; color: var(--exposure-muted); margin: 0; line-height: 1.8; }
.connect-actions { padding-top: 20px; }
.wizard-footer { margin-top: 24px; }
.wizard-footer > div { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; }
.wizard-footer p { max-width: 350px; }
.entry-form { margin-top: 24px; }
.exposure-settings form { max-width: none; }
.deployment-form { display: grid; gap: 22px; }
.deployment-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 0; padding: 0; border: 0; min-width: 0; }
.deployment-option { position: relative; display: flex; align-items: center; gap: 13px; padding: 20px 18px; margin: 0; border: 1px solid var(--border); border-radius: 11px; cursor: pointer; background: #fdfcf9; }
.deployment-option.selected { background: #f4eff9; border-color: #b5a1cc; box-shadow: 0 0 0 1px #b5a1cc; }
.deployment-option input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.deployment-option:has(input:focus-visible) { outline: 3px solid #b7a8d3; outline-offset: 3px; }
.deployment-choices:disabled .deployment-option { opacity: .65; cursor: not-allowed; }
.deployment-option strong { display: block; font-size: 13px; font-weight: 600; line-height: 1.6; }
.deployment-option small { display: block; color: var(--exposure-muted); font-size: 11px; margin-top: 5px; line-height: 1.6; }
.choice-icon { width: 39px; height: 39px; background: #efede6; color: #918676; }
.selected .choice-icon { background: #e7ddf1; color: #806696; }
.radio-indicator { width: 16px; height: 16px; flex: none; border: 1px solid #cdc6ba; border-radius: 50%; margin-left: auto; }
.selected .radio-indicator { border: 5px solid #8a72a4; background: #fff; }
.connection-route { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 16px; background: #f7f5ef; border-radius: 9px; padding: 18px; font-size: 12px; color: #817767; }
.connection-route > span { display: inline-flex; align-items: center; gap: 8px; }
.connection-route > svg { color: #b7ad9b; flex: none; }
.connection-route code { font-size: 11px; color: #9b8c72; }
.deployment-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; align-items: start; }
.exposure-settings label { font-size: 12px; }
.deployment-fields label { margin: 0; }
.deployment-fields small, .upstream-preview small { display: block; font-size: 11px; color: var(--exposure-muted); margin-top: 9px; line-height: 1.7; }
.optional-label { color: #a39b8c; font-size: 10px; margin-left: 6px; font-weight: 400; }
.upstream-preview > span { font-size: 12px; color: #817767; display: flex; align-items: center; gap: 8px; }
.auto-label { font-size: 10px; padding: 2px 6px; color: #698269; background: #edf2e8; border-radius: 4px; }
.upstream-preview > code { display: block; margin-top: 9px; padding: 12px 14px; border: 1px dashed #dcd6c9; border-radius: 8px; background: #f9f7f1; font-size: 13px; overflow-wrap: anywhere; }
.form-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; border-top: 1px solid var(--border); padding-top: 18px; }
.form-footer p { margin: 0; font-size: 11px; color: var(--exposure-muted); line-height: 1.7; }
.ssh-fields { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 16px; }
.ssh-fields label { margin: 0; }
.ssh-fields label:last-child { grid-column: 1 / -1; }
.ssh-form .form-footer { margin-top: 18px; }
.advanced-panel { border-top: 1px solid var(--border); padding-top: 14px; margin-top: 18px; font-size: 12px; color: var(--exposure-muted); }
.advanced-panel summary { cursor: pointer; width: fit-content; line-height: 1.7; }
.advanced-panel p { font-size: 12px; line-height: 1.9; overflow-wrap: anywhere; }
.advanced-panel pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.exposure-settings .file-row strong { overflow-wrap: anywhere; }
#exposure-service { scroll-margin-top: 20px; }
.sr-only { position: absolute; height: 1px; width: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 1150px) {
  .deployment-choices, .deployment-fields { grid-template-columns: 1fr; }
}
@media (max-width: 650px) {
  .exposure-settings .card { padding: 20px; }
  .guide-heading { align-items: flex-start; }
  .guide-heading h2 { font-size: 15px; }
  .guide-count { font-size: 10px; padding: 5px 8px; }
  .wizard-steps { grid-template-columns: 1fr; gap: 6px; }
  .wizard-steps button { padding: 12px; border-radius: 8px; border-bottom-width: 1px; }
  .wizard-steps button.active { border-color: #b5a1cc; }
  .wizard-steps small { display: none; }
  .wizard-footer > div { width: 100%; align-items: flex-start; flex-direction: column; }
  .deployment-option { padding: 16px 12px; gap: 10px; }
  .ssh-fields { grid-template-columns: 1fr 1fr; }
  .ssh-fields label:first-child { grid-column: 1 / -1; }
  .connection-route { gap: 10px; padding: 14px 10px; }
  .service-summary { gap: 10px; }
  .service-summary .exposure-icon { display: none; }
  .service-endpoint { font-size: 11px; }
}
</style>
