<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowRight, Check, Copy, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from 'lucide-vue-next'
import { api, type ServiceExposure } from './console-api'

const props = defineProps<{ exposure: ServiceExposure; disabled?: boolean }>()
const emit = defineEmits<{ reload: []; notice: [message: string]; continue: []; busy: [value: boolean] }>()
type Credential = ServiceExposure['credentials'][number]
const name = ref('')
const capabilities = ref<string[]>([])
const policy = ref({ providers: '', models: '', expiresAt: '', requestsPerMinute: '', requestQuota: '' })
const pending = ref(false)
const error = ref('')
const currentTime = ref(Date.now())
let expirationTimer: ReturnType<typeof setInterval> | undefined
const revealed = ref<{ token: string; name: string; created: boolean } | null>(null)
const savedToken = ref(false)
const enabledCapabilities = computed(() => props.exposure.catalog.filter(item => props.exposure.capabilities.includes(item.id)))
const selectedCapabilities = computed(() => capabilities.value.filter(item => props.exposure.capabilities.includes(item)))
const blocked = computed(() => !!props.disabled || pending.value || !!revealed.value)
const usableCredentials = computed(() => props.exposure.credentials.filter(item => status(item) === '有效'))
const canCreate = computed(() => name.value.trim().length > 0 && selectedCapabilities.value.length > 0)

function status(credential: Credential) {
  if (credential.policy?.expiresAt) {
    const expiresAt = Date.parse(credential.policy.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= currentTime.value) return '已过期'
  }
  return credential.capabilities.some(item => props.exposure.capabilities.includes(item)) ? '有效' : '无匹配权限'
}
function capabilityNames(credential: Credential) {
  return credential.capabilities.map(id => props.exposure.catalog.find(item => item.id === id)?.name ?? id).join('、')
}
function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function splitList(value: string) {
  return value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
}
async function mutate(operation: () => Promise<void>) {
  if (blocked.value) return
  pending.value = true
  error.value = ''
  emit('busy', true)
  try { await operation() }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally {
    pending.value = false
    emit('busy', !!revealed.value)
  }
}
async function createCredential() {
  if (!canCreate.value) return
  await mutate(async () => {
    const draft = policy.value
    const result = await api<{ token: string }>('/api/exposure/credentials', {
      method: 'POST',
      body: JSON.stringify({ name: name.value.trim(), capabilities: selectedCapabilities.value, policy: {
        providers: splitList(draft.providers), models: splitList(draft.models),
        ...(draft.expiresAt ? { expiresAt: new Date(draft.expiresAt).toISOString() } : {}),
        ...(draft.requestsPerMinute ? { requestsPerMinute: Number(draft.requestsPerMinute) } : {}),
        ...(draft.requestQuota ? { requestQuota: Number(draft.requestQuota) } : {})
      } })
    })
    revealed.value = { token: result.token, name: name.value.trim(), created: true }
    savedToken.value = false
    name.value = ''
    capabilities.value = []
    policy.value = { providers: '', models: '', expiresAt: '', requestsPerMinute: '', requestQuota: '' }
    emit('reload')
  })
}
async function rotate(credential: Credential) {
  if (blocked.value || !confirm(`轮换「${credential.name}」的 Token？旧 Token 将立即失效，需要更新调用方配置。新 Token 只显示一次，请及时保存。`)) return
  await mutate(async () => {
    const result = await api<{ token: string }>(`/api/exposure/credentials/${encodeURIComponent(credential.id)}/rotate`, { method: 'POST', body: '{}' })
    revealed.value = { token: result.token, name: credential.name, created: false }
    savedToken.value = false
    emit('reload')
  })
}
async function revoke(credential: Credential) {
  if (blocked.value || !confirm(`撤销「${credential.name}」的调用凭证？使用这个 Token 的应用将立即无法访问。`)) return
  await mutate(async () => {
    await api(`/api/exposure/credentials/${encodeURIComponent(credential.id)}`, { method: 'DELETE', body: '{}' })
    emit('notice', '调用凭证已撤销。')
    emit('reload')
  })
}
async function copyToken() {
  if (!revealed.value) return
  try {
    await navigator.clipboard.writeText(revealed.value.token)
    emit('notice', '调用凭证已复制，请保存到调用方的安全配置中。')
  } catch { error.value = '复制失败，请选中并手动复制下方 Token。' }
}
function finishToken() {
  if (!savedToken.value || !revealed.value) return
  const shouldContinue = revealed.value.created
  revealed.value = null
  error.value = ''
  emit('busy', false)
  if (shouldContinue) emit('continue')
}
onMounted(() => { expirationTimer = setInterval(() => { currentTime.value = Date.now() }, 1000) })
onBeforeUnmount(() => { clearInterval(expirationTimer); revealed.value = null; emit('busy', false) })
</script>

<template>
  <div class="credential-panel">
    <p v-if="error" class="credential-error" role="alert">{{ error }}</p>
    <section v-if="revealed" class="token-card" aria-labelledby="credential-token-title">
      <span class="token-symbol"><KeyRound :size="22" /></span>
      <p class="eyebrow">{{ revealed.created ? '调用凭证已创建' : 'Token 已轮换' }}</p>
      <h3 id="credential-token-title">先保存好这枚 Token</h3>
      <p>「{{ revealed.name }}」的完整 Token 只在这里显示一次。离开后无法再次查看，请保存到调用方的安全配置中。</p>
      <pre class="token-value" tabindex="0" aria-label="调用凭证 Token">{{ revealed.token }}</pre>
      <button type="button" class="credential-button" @click="copyToken"><Copy :size="15" />复制 Token</button>
      <div class="token-confirm">
        <label><input v-model="savedToken" type="checkbox" />我已将 Token 保存到安全位置</label>
        <button type="button" class="credential-button primary" :disabled="!savedToken" @click="finishToken">{{ revealed.created ? '已保存凭证，下一步' : '已保存，关闭' }}<ArrowRight v-if="revealed.created" :size="15" /></button>
      </div>
    </section>
    <template v-else>
      <section v-if="usableCredentials.length" class="credential-ready" aria-label="调用凭证已就绪">
        <span class="ready-icon"><ShieldCheck :size="21" /></span>
        <div><strong>调用凭证已就绪</strong><p>已有 {{ usableCredentials.length }} 个有效凭证，可以继续配置服务。</p></div>
        <button type="button" class="credential-button ready-button" :disabled="blocked" @click="emit('continue')">使用已有凭证，继续<ArrowRight :size="15" /></button>
      </section>
      <section class="credential-form-card" aria-labelledby="credential-form-title">
        <div class="credential-heading"><span class="section-icon"><KeyRound :size="19" /></span><div><h3 id="credential-form-title">{{ usableCredentials.length ? '为新的调用方创建凭证' : '创建调用凭证' }}</h3><p>每个应用使用独立 Token，方便限制权限和单独撤销。</p></div></div>
        <form class="credential-form" @submit.prevent="createCredential">
          <fieldset :disabled="blocked">
            <label class="field-label" for="exposure-credential-name">调用方名称<input id="exposure-credential-name" v-model="name" required maxlength="80" placeholder="例如：我的业务服务器" autocomplete="off" /></label>
            <fieldset class="capability-fieldset"><legend>允许调用的能力<span>至少选择一项</span></legend><div class="capability-options"><label v-for="item in enabledCapabilities" :key="item.id" class="capability-option" :class="{ selected: capabilities.includes(item.id) }"><input v-model="capabilities" type="checkbox" :value="item.id" /><span>{{ item.name }}</span><Check v-if="capabilities.includes(item.id)" :size="14" /></label></div><p v-if="!enabledCapabilities.length" class="field-help">请先在上一步保存要开放的能力。</p><p v-else class="field-help">仅授予你选中的能力。实际权限同时受服务开放范围限制。</p></fieldset>
            <details class="credential-advanced"><summary>有效期与调用限制<span>选填</span></summary><div class="policy-grid"><label class="field-label">到期时间<input v-model="policy.expiresAt" type="datetime-local" /><small>留空则长期有效</small></label><label class="field-label">每分钟请求上限<input v-model="policy.requestsPerMinute" type="number" min="1" step="1" placeholder="不限制" /><small>限制这个凭证的请求频率</small></label><label class="field-label">Provider 白名单<input v-model="policy.providers" placeholder="例如：openai，留空不限制" /><small>多个名称用逗号分隔</small></label><label class="field-label">模型 ID 白名单<input v-model="policy.models" placeholder="留空不限制" /><small>填写完整模型 ID，多个用逗号分隔</small></label><label class="field-label">总请求额度<input v-model="policy.requestQuota" type="number" min="1" step="1" placeholder="不限制" /><small>失败请求也计入次数</small></label></div><p class="policy-note">额度限制的是请求次数；不代表 Token 或金额预算。计数不会因重启或轮换而重置。受限 Agent 调用需显式指定获准的 Provider 和模型。</p></details>
          </fieldset>
          <div class="credential-form-footer"><p>Token 创建后仅显示一次。</p><button class="credential-button primary" :disabled="blocked || !canCreate"><LoaderCircle v-if="pending" :size="15" class="spinning" /><KeyRound v-else :size="15" />{{ pending ? '正在处理…' : '创建调用凭证' }}</button></div>
        </form>
      </section>
      <details v-if="exposure.credentials.length" class="existing-credentials"><summary><span>管理已有凭证<span class="credential-count">{{ exposure.credentials.length }}</span></span><span class="summary-hint">查看、轮换或撤销</span></summary><div class="credential-list"><article v-for="credential in exposure.credentials" :key="credential.id" class="credential-row"><div class="credential-row-heading"><strong>{{ credential.name }}</strong><span class="credential-status" :class="{ valid: status(credential) === '有效' }">{{ status(credential) }}</span></div><p class="credential-capabilities">{{ capabilityNames(credential) || '未授予能力' }}</p><div class="credential-metadata"><span>创建于 {{ formatDate(credential.createdAt) }}</span><span>{{ credential.policy?.expiresAt ? `到期于 ${formatDate(credential.policy.expiresAt)}` : '长期有效' }}</span><span v-if="credential.policy?.requestsPerMinute">{{ credential.policy.requestsPerMinute }} 次/分钟</span><span v-if="credential.policy?.requestQuota">总额度 {{ credential.policy.requestQuota }} 次</span><span v-if="!credential.policy?.requestsPerMinute && !credential.policy?.requestQuota">未限制请求次数</span></div><p v-if="credential.policy?.providers?.length || credential.policy?.models?.length" class="credential-scopes"><span v-if="credential.policy?.providers?.length">Provider：{{ credential.policy.providers.join('、') }}</span><span v-if="credential.policy?.models?.length">模型：{{ credential.policy.models.join('、') }}</span></p><div class="credential-actions"><button type="button" class="credential-button small" :disabled="blocked" @click="rotate(credential)"><RefreshCw :size="13" />轮换 Token</button><button type="button" class="credential-button small danger" :disabled="blocked" @click="revoke(credential)"><Trash2 :size="13" />撤销</button></div></article></div><p class="storage-note">完整 Token 不会保存在 Runtime 中；仅存储 SHA-256 摘要。托管 API 使用这里创建的调用凭证。</p></details>
    </template>
  </div>
</template>

<style scoped>
.credential-panel { display: grid; gap: 20px; min-width: 0; font-size: 13px; color: var(--ink, #423f38); --credential-muted: #817b73; }
.credential-panel p { margin: 0; line-height: 1.75; }
.credential-panel h3 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -.2px; }
.credential-panel button, .credential-panel input { font: inherit; }
.credential-panel button { cursor: pointer; }
.credential-panel button:disabled { opacity: .48; cursor: not-allowed; }
.credential-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 9px 14px; background: #fffdf9; color: #625c67; border: 1px solid #ddd6e0; border-radius: 8px; font-weight: 500; transition: background .15s, border-color .15s; }
.credential-button:not(:disabled):hover { background: #f4eff6; border-color: #bcaacb; }
.credential-button.primary { background: #80678f; border-color: #80678f; color: #fff; }
.credential-button.primary:not(:disabled):hover { background: #70577f; border-color: #70577f; }
.credential-button:focus-visible, .credential-panel summary:focus-visible { outline: 3px solid #bcacd0; outline-offset: 3px; }
.credential-button.small { min-height: 33px; padding: 6px 10px; font-size: 12px; }
.credential-button.danger { color: #a66762; border-color: #e6d5d1; }
.credential-error { border: 1px solid #e7c9c3; color: #a15c55; padding: 12px 15px; background: #fff3f0; border-radius: 9px; overflow-wrap: anywhere; }
.credential-ready { display: flex; align-items: center; gap: 14px; padding: 18px 20px; border: 1px solid #d6e4d2; border-radius: 12px; background: #f0f6ee; }
.ready-icon { display: grid; place-items: center; flex: none; height: 39px; width: 39px; color: #658465; border-radius: 50%; background: #e4eedd; }
.credential-ready > div { flex: 1; min-width: 0; }
.credential-ready strong { color: #506c4e; font-weight: 600; }
.credential-ready p { color: #778771; font-size: 12px; margin-top: 3px; }
.ready-button { border-color: #cfddc9; color: #5b7657; background: #f9fcf6; flex: none; }
.credential-form-card { border: 1px solid var(--border, #e5dfd4); border-radius: 12px; background: #fffefa; overflow: hidden; }
.credential-heading { display: flex; align-items: flex-start; gap: 12px; padding: 25px 26px 0; }
.credential-heading p { margin-top: 6px; color: var(--credential-muted); }
.section-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: #8c769b; background: #f1ebf4; flex: none; }
.credential-form { max-width: none; }
.credential-form > fieldset { display: grid; gap: 25px; min-width: 0; padding: 25px 26px; margin: 0; border: 0; }
.field-label { display: grid; gap: 9px; margin: 0; min-width: 0; font-size: 13px; color: #5e5852; }
.field-label input { display: block; min-width: 0; width: 100%; box-sizing: border-box; min-height: 42px; border: 1px solid #ded8ce; border-radius: 8px; background: #fffefa; padding: 10px 12px; color: var(--ink, #423f38); }
.field-label input:focus { outline: none; border-color: #af98c1; box-shadow: 0 0 0 3px #eee7f3; }
.field-label input::placeholder { color: #aaa398; }
.field-label small, .field-help { font-size: 12px; color: var(--credential-muted); line-height: 1.6; }
.field-label small { margin-top: -4px; }
.capability-fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.capability-fieldset legend { padding: 0; margin-bottom: 12px; color: #5e5852; }
.capability-fieldset legend span { margin-left: 10px; color: #a29a90; font-size: 11px; }
.capability-options { display: flex; flex-wrap: wrap; gap: 9px; }
.capability-option { display: flex; align-items: center; gap: 8px; min-height: 38px; box-sizing: border-box; padding: 8px 12px; border: 1px solid #e3dcd3; border-radius: 8px; cursor: pointer; color: #746d63; background: #fcfaf6; margin: 0; }
.capability-option.selected { color: #7b618d; border-color: #bca6cd; background: #f5eff9; }
.credential-panel input[type="checkbox"] { width: 14px; height: 14px; min-height: 0; padding: 0; margin: 0; accent-color: #8a729c; flex: none; }
.capability-fieldset .field-help { margin-top: 11px; }
.credential-advanced { border-top: 1px solid #eee9e1; }
.credential-advanced summary { display: flex; gap: 9px; align-items: center; cursor: pointer; padding: 17px 0 0; color: #857789; width: fit-content; }
.credential-advanced summary::before { content: '+'; display: inline-grid; place-items: center; height: 16px; width: 16px; font-size: 15px; color: #a191a7; }
.credential-advanced[open] summary::before { content: '−'; }
.credential-advanced summary span { font-size: 11px; color: #a39b92; }
.policy-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 21px 18px; padding-top: 23px; }
.policy-note { margin-top: 18px !important; font-size: 12px; color: var(--credential-muted); background: #f7f4ef; padding: 12px 14px; border-radius: 7px; }
.credential-form-footer { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 19px 26px; border-top: 1px solid #ece6dd; background: #fbf9f4; }
.credential-form-footer p { color: #9b9184; font-size: 12px; }
.existing-credentials { border: 1px solid var(--border, #e5dfd4); border-radius: 11px; background: #fcfaf6; min-width: 0; }
.existing-credentials > summary { cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 18px 21px; color: #6d655b; }
.existing-credentials > summary > span:first-child { display: inline-flex; gap: 9px; align-items: center; }
.existing-credentials > summary::after { content: '+'; color: #a69886; font-size: 17px; }
.existing-credentials[open] > summary::after { content: '−'; }
.credential-count { border-radius: 10px; padding: 1px 7px; color: #9c8b74; background: #eee8dc; font-size: 11px; }
.summary-hint { margin-left: auto; font-size: 11px; color: #a39a8c; }
.credential-list { padding: 0 21px; }
.credential-row { padding: 20px 0; border-top: 1px solid #e9e3d8; }
.credential-row-heading { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.credential-row-heading strong { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.credential-status { font-size: 10px; padding: 3px 8px; border-radius: 10px; color: #a18e72; background: #f0e9db; }
.credential-status.valid { color: #678460; background: #eaf0e5; }
.credential-capabilities { color: #7b6c85; margin-top: 9px !important; font-size: 12px; overflow-wrap: anywhere; }
.credential-metadata { display: flex; flex-wrap: wrap; gap: 3px 15px; margin-top: 6px; font-size: 11px; line-height: 1.8; color: #a09485; }
.credential-scopes { display: grid; margin-top: 6px !important; color: #9a8d7e; font-size: 11px; overflow-wrap: anywhere; }
.credential-actions { display: flex; gap: 8px; margin-top: 13px; }
.storage-note { padding: 0 21px 18px; color: #a09485; font-size: 11px; }
.token-card { border: 1px solid #d4c3e0; border-radius: 13px; padding: 27px; background: #f9f5fc; }
.token-symbol { display: grid; place-items: center; height: 46px; width: 46px; color: #876799; background: #ece1f4; border-radius: 13px; margin-bottom: 18px; }
.token-card .eyebrow { color: #9a82a7; font-size: 11px; margin-bottom: 6px; }
.token-card h3 { font-size: 19px; margin-bottom: 10px; }
.token-card > p:not(.eyebrow) { color: #8e7e98; }
.token-value { margin: 20px 0 13px; padding: 17px 18px; color: #6b4f7e; background: #fffdfd; border: 1px solid #e0d2e8; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-all; font-size: 13px; line-height: 1.8; user-select: all; }
.token-confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 17px; margin-top: 26px; padding-top: 20px; border-top: 1px solid #e8deed; }
.token-confirm label { display: inline-flex; gap: 8px; align-items: center; color: #8c7c96; margin: 0; font-size: 12px; }
.spinning { animation: credential-spin 1s linear infinite; }
@keyframes credential-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
@media (max-width: 700px) {
  .credential-ready { flex-wrap: wrap; padding: 17px; gap: 12px; }
  .ready-button { width: 100%; }
  .credential-heading { padding: 21px 18px 0; gap: 10px; }
  .credential-form > fieldset { padding: 23px 18px; }
  .credential-form-footer { padding: 17px 18px; flex-wrap: wrap; gap: 12px; }
  .credential-form-footer .credential-button { width: 100%; }
  .policy-grid { grid-template-columns: minmax(0, 1fr); }
  .existing-credentials > summary { padding: 17px 18px; }
  .summary-hint { display: none; }
  .credential-list { padding: 0 18px; }
  .storage-note { padding: 0 18px 17px; }
  .token-card { padding: 22px 18px; }
  .token-confirm .credential-button { width: 100%; }
}
</style>
