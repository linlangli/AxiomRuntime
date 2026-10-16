<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowUpRight, Copy, Globe2, KeyRound, LockKeyhole, ShieldCheck, X } from 'lucide-vue-next'
import { api, type ServiceExposure } from './console-api'

const props = defineProps<{ exposure: ServiceExposure }>()
const emit = defineEmits<{ reload: []; notice: [message: string] }>()
const tab = ref('反代接入')
const tabs = ['反代接入', '能力开放', '访问控制', '接入测试']
const publicBaseUrl = ref(props.exposure.publicBaseUrl)
const upstreamUrl = ref(props.exposure.upstreamUrl)
const capabilities = ref([...props.exposure.capabilities])
const credentialName = ref('')
const credentialCapabilities = ref<string[]>([])
const newToken = ref('')
const busy = ref(false)
const error = ref('')
const confirmSave = ref(false)
const connection = ref<{ ok: boolean; target: string; durationMs: number } | null>(null)
const selectedCapabilities = computed(() => props.exposure.catalog.filter(item => props.exposure.capabilities.includes(item.id)))
const dirty = computed(() => publicBaseUrl.value !== props.exposure.publicBaseUrl || upstreamUrl.value !== props.exposure.upstreamUrl || JSON.stringify([...capabilities.value].sort()) !== JSON.stringify([...props.exposure.capabilities].sort()))
const nginx = computed(() => selectedCapabilities.value.map(item => `location = ${item.path} {\n    proxy_pass ${props.exposure.upstreamUrl};\n    proxy_http_version 1.1;\n    proxy_set_header Authorization $http_authorization;\n    proxy_set_header X-Request-ID $request_id;\n    proxy_buffering off;\n    proxy_read_timeout 600s;\n    client_max_body_size 16m;\n}`).join('\n\n') + `\n\nlocation = /health/live {\n    proxy_pass ${props.exposure.upstreamUrl};\n}\n\nlocation / { return 404; }`)
const curl = computed(() => {
  const item = selectedCapabilities.value.find(capability => capability.id === 'models') ?? selectedCapabilities.value[0]
  if (!item) return '请先选择并保存至少一项开放能力。'
  const payload = item.id === 'agent' ? '{"engine":"codex","prompt":"hello","workspace_id":"demo","permission_mode":"read_only"}' : item.id === 'chat' ? '{"model":"YOUR_MODEL","messages":[{"role":"user","content":"hello"}]}' : item.id === 'embeddings' ? '{"model":"YOUR_MODEL","input":"hello"}' : '{"model":"YOUR_MODEL","input":"hello"}'
  return `curl ${props.exposure.publicBaseUrl || 'https://your-domain.example'}${item.path} \\\n  -H 'Authorization: Bearer YOUR_SERVICE_TOKEN'${item.method === 'POST' ? ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${payload}'` : ''}`
})
async function run<T>(url: string, body: unknown, method = 'POST'): Promise<T | null> {
  if (busy.value) return null
  busy.value = true; error.value = ''
  try { return await api<T>(url, { method, body: JSON.stringify(body) }) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); return null }
  finally { busy.value = false }
}
async function save() {
  const result = await run<{ effect: string }>('/api/exposure', { publicBaseUrl: publicBaseUrl.value, upstreamUrl: upstreamUrl.value, capabilities: capabilities.value })
  if (result) { emit('notice', result.effect); emit('reload'); confirmSave.value = false; connection.value = null }
}
async function createCredential() {
  const result = await run<{ token: string }>('/api/exposure/credentials', { name: credentialName.value, capabilities: credentialCapabilities.value })
  if (result) { newToken.value = result.token; credentialName.value = ''; credentialCapabilities.value = []; emit('reload') }
}
async function revoke(id: string) {
  if (!confirm('撤销这个调用凭证？对应应用将无法继续访问。')) return
  if (await run(`/api/exposure/credentials/${id}`, {}, 'DELETE')) { emit('notice', '调用凭证已撤销。'); emit('reload') }
}
async function test(target: string) {
  connection.value = await run('/api/exposure/test', { target })
}
function copy(value: string) { void navigator.clipboard.writeText(value).then(() => emit('notice', '已复制。')).catch(() => { error.value = '复制失败，请手动复制。' }) }
</script>

<template>
  <div class="subnav" aria-label="对外服务分类"><button v-for="item in tabs" :key="item" :class="{ active: tab === item }" :aria-pressed="tab === item" @click="tab = item">{{ item }}</button></div>
  <div class="info-banner"><ShieldCheck :size="18" /><p><strong>本机管理与远程调用独立授权。</strong>这里保存服务接入配置，不会将 ai web 管理页面暴露到公网。API 服务通过 <code>npm run server</code> 启动，反代与 TLS 在你的服务器部署。</p></div>
  <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
  <div v-if="tab === '反代接入'" class="equal-grid"><section class="card"><div class="card-head"><div><h2>连接你的服务器 <span class="hand-tag">hello, server!</span></h2><p>先确定入口与上游，再选择能力和创建凭证。</p></div><Globe2 :size="22" /></div><form @submit.prevent="confirmSave = true"><label>公网 HTTPS 入口<input v-model="publicBaseUrl" type="url" placeholder="https://ai.example.com" /></label><label>反代可以访问的上游地址<input v-model="upstreamUrl" required type="url" placeholder="http://127.0.0.1:8080" /></label><div class="note-paper">上游地址从反代服务器的视角填写。Runtime 在你的电脑上时，需要先建立 VPN 或隧道，使服务器能访问它。</div><button class="button primary" :disabled="busy || !dirty">预览并保存</button></form></section><section class="card"><h2>接入路径</h2><div class="connection-flow"><div><Globe2 :size="22" /><strong>你的应用 / 服务器</strong><small>{{ publicBaseUrl || '等待配置 HTTPS 入口' }}</small></div><span>↓ HTTPS + 调用凭证</span><div><LockKeyhole :size="22" /><strong>反向代理</strong><small>TLS 终止 · 流式转发</small></div><span>↓ 内网 / VPN / 隧道</span><div><ShieldCheck :size="22" /><strong>Runtime API</strong><small>能力检查 → 唯一执行主链 → 用量账本</small></div></div><p class="footnote">保存状态：{{ exposure.updatedAt ? new Date(exposure.updatedAt).toLocaleString('zh-CN') : '尚未配置' }}。保存不代表服务器已经部署或连通。</p></section></div>
  <template v-else-if="tab === '能力开放'"><div class="section-heading"><div><h2>按能力开放，而不是开放整个本机</h2><p>新增能力默认关闭。保存后，已启用此配置的 API 服务逐请求读取开放范围。</p></div><button class="button primary" :disabled="busy || !dirty" @click="confirmSave = true">预览并保存</button></div><div class="capability-grid"><label v-for="item in exposure.catalog" :key="item.id" class="card capability-card" :class="{ checked: capabilities.includes(item.id) }"><div class="card-head"><span class="capability-icon"><ArrowUpRight :size="19" /></span><input v-model="capabilities" type="checkbox" :value="item.id" /></div><h2>{{ item.name }}</h2><code>{{ item.method }} {{ item.path }}</code><p>{{ item.id === 'agent' ? '远程执行有资源与权限影响，按需开启。' : '复用已实现的 Runtime API 接口。' }}</p></label><section v-for="name in ['图片接口', '记忆检索', '工具执行']" :key="name" class="card capability-card unavailable"><span class="pill unknown">尚未提供独立 API</span><h2>{{ name }}</h2><p>接口与权限边界完成后才能开放。</p></section></div><p class="footnote">当前开放控制粒度为接口能力。按 Provider／模型限制、限流和额度仍未实现；embedding 路由仍受现有模型候选兼容性限制。</p></template>
  <template v-else-if="tab === '访问控制'"><section class="card form-card"><div class="card-head"><div><h2>为调用方创建独立凭证</h2><p>权限取“服务开放范围”与“凭证能力”的交集，可独立撤销。</p></div><KeyRound :size="22" /></div><form @submit.prevent="createCredential"><label>调用方名称<input v-model="credentialName" required maxlength="80" placeholder="例如：我的服务器" /></label><div class="checkbox-list"><label v-for="item in selectedCapabilities" :key="item.id"><input v-model="credentialCapabilities" type="checkbox" :value="item.id" />{{ item.name }}</label></div><p v-if="!selectedCapabilities.length" class="footnote">先在「能力开放」选择并保存至少一项能力。</p><button class="button primary" :disabled="busy || !credentialCapabilities.length">创建调用凭证</button></form></section><section class="card spaced"><h2>已创建凭证</h2><div v-for="credential in exposure.credentials" :key="credential.id" class="file-row"><div><strong>{{ credential.name }}</strong><small class="table-sub">{{ credential.capabilities.join(' · ') }} · {{ new Date(credential.createdAt).toLocaleDateString('zh-CN') }}</small></div><button class="button danger" :disabled="busy" @click="revoke(credential.id)">撤销</button></div><div v-if="!exposure.credentials.length" class="empty">还没有调用凭证。密钥只在创建时显示一次，落盘仅保存 SHA-256 摘要。</div><p class="footnote">现有环境变量服务 token 仍可使用；启用开放配置后，它同样受全局能力范围限制。</p></section></template>
  <template v-else><div class="equal-grid"><section class="card"><div class="card-head"><div><h2>检查服务连接</h2><p>测试已保存地址的 /health/live，不发送模型请求。</p></div></div><div class="button-row"><button class="button" :disabled="busy || !exposure.updatedAt" @click="test('upstream')">检查上游</button><button class="button" :disabled="busy || !exposure.publicBaseUrl" @click="test('public')">检查公网</button></div><div v-if="connection" class="note-paper">{{ connection.target === 'public' ? '公网' : '上游' }}：{{ connection.ok ? '已连通' : '未连通或响应不符合 Runtime 健康协议' }} · {{ connection.durationMs }} ms</div><p class="footnote">反代片段同时提供 /health/live 健康检查。连通后仍需使用真实授权调用验证能力；连接检查不证明凭证权限或模型可用。</p><h2 class="spaced">调用示例</h2><pre>{{ curl }}</pre><button class="button" @click="copy(curl)"><Copy :size="14" />复制示例</button></section><section class="card"><div class="card-head"><div><h2>Nginx 配置片段</h2><p>放入你为此域名配置好 TLS 的独立 server 块。</p></div><button class="icon-button" aria-label="复制反代配置" @click="copy(nginx)"><Copy :size="15" /></button></div><pre class="code-panel">{{ nginx }}</pre><p class="footnote">按已保存能力生成精确路径，禁用响应缓冲以支持流式输出；其余路径返回 404。代码不会自动写入你的服务器。</p></section></div><section class="card spaced"><h2>启动与生效</h2><p class="body-copy">在运行 Runtime 的机器执行 <code>npm run server</code>，默认监听 127.0.0.1:8080。首次保存开放配置后，需要重新启动已有 API 服务；之后能力修改与凭证撤销逐请求生效。监听地址与端口仍由 AI_GATEWAY_SERVER_HOST / AI_GATEWAY_SERVER_PORT 配置。</p></section></template>
  <div v-if="confirmSave" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="确认服务开放配置"><div class="card-head"><div><h2>保存服务开放配置</h2><p>不会自动部署反代，也不会启动 API 服务。</p></div><button class="icon-button" :disabled="busy" aria-label="取消保存" @click="confirmSave = false"><X :size="16" /></button></div><div class="file-row"><span>公网入口</span><strong>{{ publicBaseUrl || '未设置' }}</strong></div><div class="file-row"><span>上游地址</span><strong>{{ upstreamUrl }}</strong></div><div class="file-row"><span>开放能力</span><strong>{{ capabilities.join(' · ') || '全部关闭' }}</strong></div><p v-if="error" class="error-banner">{{ error }}</p><div class="button-row"><button class="button" :disabled="busy" @click="confirmSave = false">取消</button><button class="button primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '确认保存' }}</button></div></section></div>
  <div v-if="newToken" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="新调用凭证"><h2>保存好你的调用凭证</h2><p class="body-copy">只显示这一次。关闭后无法再次查看，遗失时需要创建新凭证。</p><pre class="secret-value">{{ newToken }}</pre><div class="button-row"><button class="button" @click="copy(newToken)"><Copy :size="14" />复制凭证</button><button class="button primary" @click="newToken = ''">已保存，关闭</button></div></section></div>
</template>
