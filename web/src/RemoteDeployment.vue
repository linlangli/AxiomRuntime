<script setup lang="ts">
import { ref } from 'vue'
import { api } from './console-api'
const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ notice: [message: string]; busy: [value: boolean] }>()
const email = ref('')
const install = ref(false)
const busy = ref(false)
const error = ref('')
const output = ref('')
const plan = ref<{ planId: string; host: string; domain: string; config: string; script: string; effect: string } | null>(null)
async function run(action: string) {
  if (busy.value || props.disabled) return
  if (action === 'deploy' && !confirm(`确认在 ${plan.value?.host} 为 ${plan.value?.domain} 部署 Nginx HTTPS 站点并申请证书？${install.value ? '将安装缺失的 nginx/certbot 软件包。' : ''}其他站点不应受影响，但会重新加载 Nginx。`)) return
  busy.value = true; error.value = ''; output.value = ''
  emit('busy', true)
  try {
    const result = await api<typeof plan.value & { output?: string }>('/api/exposure/deployment', { method: 'POST', body: JSON.stringify({ action, email: email.value, installDependencies: install.value, planId: plan.value?.planId }) })
    if (action === 'preview') plan.value = result
    else { output.value = result?.output ?? ''; plan.value = null; emit('notice', result?.effect ?? '部署完成') }
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false; emit('busy', false) }
}
</script>
<template><section class="card spaced"><div class="card-head"><div><h2>远端部署 Nginx 与 HTTPS</h2><p>SSH 模式下，使用已保存的服务器连接部署独立站点。需要 root 账户、systemd、域名解析，以及开放的 80/443 端口。</p></div></div><form @submit.prevent="run('preview')"><label>证书联系邮箱<input v-model="email" type="email" required :disabled="busy || disabled" @input="plan = null" /></label><label class="install-option"><input v-model="install" type="checkbox" :disabled="busy || disabled" @change="plan = null" />允许通过 apt/dnf 安装缺失的 Nginx 与 Certbot</label><p class="footnote">会拒绝覆盖未由当前 Runtime 管理的站点。部署失败恢复原 Nginx 配置；软件包、证书及 ACME 账户不会自动删除。复杂网关或自定义站点请使用下方配置片段由管理员部署。</p><button class="button" :disabled="busy || disabled">预览部署计划</button></form><div v-if="plan" class="deploy-preview"><p>{{ plan.host }} · {{ plan.domain }}</p><p>{{ plan.effect }}</p><details open><summary>将写入的 Nginx 配置</summary><pre>{{ plan.config }}</pre></details><details><summary>完整执行脚本</summary><pre>{{ plan.script }}</pre></details><button class="button primary" :disabled="busy || disabled" @click="run('deploy')">确认执行此部署计划</button></div><p v-if="busy" role="status">{{ plan ? '操作执行中，请等待；最长约 3 分钟。' : '正在生成计划…' }}</p><p v-if="error" class="error-banner" role="alert">{{ error }}</p><pre v-if="output">{{ output }}</pre></section></template>
<style scoped>.install-option { display: flex; align-items: center; gap: 8px; } .deploy-preview { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 20px; font-size: 12px; line-height: 1.8; } pre { max-height: 400px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; } summary { cursor: pointer; } details { margin-bottom: 16px; }</style>
