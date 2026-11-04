<script setup lang="ts">
import { ref } from 'vue'
import { api } from './console-api'
const props = defineProps<{ config: { host: string; user: string; port: number; identityFile: string }; disabled?: boolean; mutationLocked?: boolean }>()
const emit = defineEmits<{ identity: [value: string]; notice: [message: string]; busy: [value: boolean] }>()
const busy = ref(false)
const password = ref('')
const scanId = ref('')
const fingerprints = ref('')
const publicKey = ref('')
const detail = ref('')
const checks = ref<Array<{ name: string; ok: boolean; detail: string }>>([])
const error = ref('')
function blockedReason(action: string) {
  if (busy.value || props.disabled) return '正在执行操作，请稍候。'
  if (['keygen', 'trust', 'authorize'].includes(action) && props.mutationLocked) return '先在「连接管理」断开并关闭自启，才能修改密钥或授权。'
  if (action === 'keygen') return ''
  if (!props.config.host.trim()) return '请先填写上方的服务器 IP 或域名。'
  if (!props.config.user.trim() || !Number.isInteger(props.config.port) || props.config.port < 1 || props.config.port > 65535) return '请先填写 SSH 用户和有效端口。'
  if (action === 'diagnose' && !props.config.identityFile.trim()) return '请先填写本机 SSH 私钥路径，或点击「生成本机专用密钥」。'
  if (action === 'authorize' && !password.value) return '请输入本次授权用的账户密码。'
  return ''
}
async function run(action: string) {
  const reason = blockedReason(action)
  if (reason) { error.value = reason; return }
  if (action === 'trust' && !confirm('已从服务器控制台或管理员核对指纹，确认信任此服务器？')) return
  if (action === 'authorize' && !confirm('使用本次输入的账户密码，将专用公钥追加到该账户的 authorized_keys？密码不会保存。')) return
  busy.value = true; emit('busy', true); error.value = ''
  try {
    const result = await api<{ detail?: string; identityFile?: string; publicKey?: string; scanId?: string; fingerprints?: string; checks?: typeof checks.value }>('/api/exposure/ssh-setup', { method: 'POST', body: JSON.stringify({ action, config: { ...props.config, identityFile: props.config.identityFile || '/unused-key-path' }, ...(action === 'authorize' ? { password: password.value } : {}), scanId: scanId.value }) })
    if (result.identityFile) emit('identity', result.identityFile)
    if (result.publicKey) publicKey.value = result.publicKey
    if (result.scanId) { scanId.value = result.scanId; fingerprints.value = result.fingerprints ?? '' }
    if (result.checks) checks.value = result.checks
    detail.value = result.detail ?? ''; emit('notice', detail.value)
    if (action === 'trust') { scanId.value = ''; fingerprints.value = '' }
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { password.value = ''; busy.value = false; emit('busy', false) }
}
</script>
<template>
  <details class="setup-panel">
    <summary>首次连接准备：信任指纹与生成密钥</summary>
    <p>没有密钥时可以直接生成；扫描指纹需填写服务器地址，诊断还需有本机密钥路径。已有可用密钥且信任过此主机时可跳过准备。</p>
    <p v-if="mutationLocked" class="note-paper">隧道运行或已开启自启，密钥与授权操作暂时锁定。扫描指纹和诊断仍可使用；需要修改时，请先到「连接管理」断开并关闭自启。</p>
    <div class="setup-actions">
      <div class="setup-action"><button type="button" class="button" :disabled="!!blockedReason('scan')" :title="blockedReason('scan') || '读取服务器主机公钥，不自动信任'" :aria-describedby="blockedReason('scan') ? 'ssh-scan-reason' : undefined" @click="run('scan')">扫描服务器指纹</button><small v-if="blockedReason('scan')" id="ssh-scan-reason">{{ blockedReason('scan') }}</small></div>
      <div class="setup-action"><button type="button" class="button" :disabled="!!blockedReason('keygen')" :title="blockedReason('keygen') || '在本机生成或复用专用密钥，无需服务器信息'" :aria-describedby="blockedReason('keygen') ? 'ssh-keygen-reason' : undefined" @click="run('keygen')">生成本机专用密钥</button><small v-if="blockedReason('keygen')" id="ssh-keygen-reason">{{ blockedReason('keygen') }}</small></div>
      <div class="setup-action"><button type="button" class="button" :disabled="!!blockedReason('diagnose')" :title="blockedReason('diagnose') || '检查本机私钥和 SSH 认证，不修改服务器'" :aria-describedby="blockedReason('diagnose') ? 'ssh-diagnose-reason' : undefined" @click="run('diagnose')">诊断 SSH 连接</button><small v-if="blockedReason('diagnose')" id="ssh-diagnose-reason">{{ blockedReason('diagnose') }}</small></div>
    </div>
    <div v-if="fingerprints" class="note-paper"><strong>请独立核对以下主机指纹</strong><pre>{{ fingerprints }}</pre><button type="button" class="button primary" :disabled="!!blockedReason('trust')" :title="blockedReason('trust')" @click="run('trust')">已核对，信任此主机</button></div>
    <div v-if="publicKey"><label>服务器需授权的公钥<textarea :value="publicKey" readonly rows="3" /></label><p>可以复制到服务器的 authorized_keys，或在下方使用账户密码授权。仅支持允许 SSH 密码登录的服务器；不会修改服务器认证策略。</p><label>本次授权用的服务器账户密码<input v-model="password" type="password" autocomplete="off" :disabled="busy || disabled || mutationLocked" /></label><button type="button" class="button" :disabled="!!blockedReason('authorize')" :title="blockedReason('authorize')" @click="run('authorize')">用密码授权专用公钥</button><small v-if="blockedReason('authorize')" class="action-hint">{{ blockedReason('authorize') }}</small></div>
    <p v-if="busy" role="status">正在执行 SSH 准备操作，请稍候…</p>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p><p v-if="detail" role="status">{{ detail }}</p><ul v-if="checks.length"><li v-for="check in checks" :key="check.name">{{ check.ok ? '✓' : '!' }} {{ check.name }}：{{ check.detail }}</li></ul>
    <p>专用私钥保存在本机受限权限文件中；页面只显示公钥和路径。准备完成后，使用上方的启动与连接按钮继续。</p>
  </details>
</template>
<style scoped>
.setup-panel { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-top: 20px; font-size: 12px; line-height: 1.8; }
summary { cursor: pointer; font-weight: 600; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
p { color: var(--muted); }
textarea { resize: vertical; }
li { padding: 4px 0; }
.setup-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.setup-action { min-width: 0; }
.setup-action .button { width: 100%; }
.setup-action small, .action-hint { display: block; margin-top: 7px; color: var(--muted); line-height: 1.7; overflow-wrap: anywhere; }
@media (max-width: 700px) { .setup-actions { grid-template-columns: 1fr; } }
</style>
