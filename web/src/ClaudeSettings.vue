<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type ProviderStatus } from './console-api'
const props = defineProps<{ providers: ProviderStatus[] }>()
const emit = defineEmits<{ notice: [message: string] }>()
const provider = ref(props.providers[0]?.name ?? '')
const model = ref('')
const state = ref<{ path: string; baseUrl: string; model: string; credentialConfigured: boolean } | null>(null)
const busy = ref(false)
const error = ref('')
async function load() { try { state.value = await api('/api/claude') } catch (reason) { error.value = String(reason) } }
async function save(action: string) {
  if (!confirm(action === 'clear' ? '清除 Runtime 管理的 Claude 连接字段？其他设置保留。' : '写入 Claude 用户级连接配置？原文件会先备份，重新启动 Claude Code 后生效。')) return
  busy.value = true; error.value = ''
  try { const result = await api<{ effect: string }>('/api/claude', { method: 'POST', body: JSON.stringify({ action, provider: action === 'clear' ? '' : provider.value, model: model.value }) }); emit('notice', result.effect); await load() }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
onMounted(load)
</script>
<template><section class="card spaced"><div class="card-head"><div><h2>Claude Code 用户配置</h2><p>连接设置持久写入用户 settings.json；其他字段保留，原文件保存在同目录备份。</p></div><span class="pill ok">可编辑</span></div><p v-if="state" class="footnote"><code>{{ state.path }}</code><br />当前地址：{{ state.baseUrl || '未设置' }} · 模型：{{ state.model || '默认' }}</p><form @submit.prevent="save('provider')"><label>Provider<select v-model="provider" :disabled="busy"><option v-for="item in providers" :key="item.name" :value="item.name">{{ item.name }}</option></select></label><label>模型<input v-model="model" placeholder="留空使用 Provider 默认模型" :disabled="busy" /></label><div class="button-row"><button class="button primary" :disabled="busy || !provider">备份并应用</button><button type="button" class="button" :disabled="busy || !state?.credentialConfigured" @click="save('clear')">清除连接字段</button></div></form><p v-if="error" class="error-banner">{{ error }}</p></section></template>
