<script setup lang="ts">
import { ref } from 'vue'
import { api } from './console-api'
const props = defineProps<{ config: { host: string; user: string; port: number; identityFile: string }; disabled?: boolean }>()
const emit = defineEmits<{ identity: [value: string]; notice: [message: string] }>()
const busy = ref(false)
const password = ref('')
const scanId = ref('')
const fingerprints = ref('')
const publicKey = ref('')
const detail = ref('')
const checks = ref<Array<{ name: string; ok: boolean; detail: string }>>([])
const error = ref('')
async function run(action: string) {
  if (action === 'trust' && !confirm('已从服务器控制台或管理员核对指纹，确认信任此服务器？')) return
  if (action === 'authorize' && !confirm('使用本次输入的账户密码，将专用公钥追加到该账户的 authorized_keys？密码不会保存。')) return
  busy.value = true; error.value = ''
  try {
    const result = await api<{ detail?: string; identityFile?: string; publicKey?: string; scanId?: string; fingerprints?: string; checks?: typeof checks.value }>('/api/exposure/ssh-setup', { method: 'POST', body: JSON.stringify({ action, config: { ...props.config, identityFile: props.config.identityFile || '/unused-key-path' }, ...(action === 'authorize' ? { password: password.value } : {}), scanId: scanId.value }) })
    if (result.identityFile) emit('identity', result.identityFile)
    if (result.publicKey) publicKey.value = result.publicKey
    if (result.scanId) { scanId.value = result.scanId; fingerprints.value = result.fingerprints ?? '' }
    if (result.checks) checks.value = result.checks
    detail.value = result.detail ?? ''; emit('notice', detail.value)
    if (action === 'trust') { scanId.value = ''; fingerprints.value = '' }
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { password.value = ''; busy.value = false }
}
</script>
<template><details class="setup-panel"><summary>在 Web 中准备 SSH 连接</summary><p>先填写服务器地址与账户。扫描并核对指纹后信任主机，再准备专用密钥和公钥授权。</p><div class="button-row"><button type="button" class="button" :disabled="busy || disabled || !config.host" @click="run('scan')">1. 扫描服务器指纹</button><button type="button" class="button" :disabled="busy || disabled || !config.host" @click="run('keygen')">2. 生成本机专用密钥</button><button type="button" class="button" :disabled="busy || disabled || !config.identityFile" @click="run('diagnose')">诊断 SSH 连接</button></div><div v-if="fingerprints" class="note-paper"><strong>请独立核对以下主机指纹</strong><pre>{{ fingerprints }}</pre><button type="button" class="button primary" :disabled="busy" @click="run('trust')">已核对，信任此主机</button></div><div v-if="publicKey"><label>服务器需授权的公钥<textarea :value="publicKey" readonly rows="3" /></label><p>可以复制到服务器的 authorized_keys，或在下方使用账户密码授权。仅支持允许 SSH 密码登录的服务器；不会修改服务器认证策略。</p><label>本次授权用的服务器账户密码<input v-model="password" type="password" autocomplete="off" /></label><button type="button" class="button" :disabled="busy || !password" @click="run('authorize')">3. 用密码授权专用公钥</button></div><p v-if="error" class="error-banner" role="alert">{{ error }}</p><p v-if="detail" role="status">{{ detail }}</p><ul v-if="checks.length"><li v-for="check in checks" :key="check.name">{{ check.ok ? '✓' : '!' }} {{ check.name }}：{{ check.detail }}</li></ul><p>专用私钥保存在本机受限权限文件中；页面只显示公钥和路径。授权后保存服务器配置，再连接隧道。</p></details></template>
<style scoped>.setup-panel { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-top: 20px; font-size: 12px; line-height: 1.8; } summary { cursor: pointer; font-weight: 600; } pre { white-space: pre-wrap; overflow-wrap: anywhere; } p { color: var(--muted); } textarea { resize: vertical; } li { padding: 4px 0; }</style>
