<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type ProviderStatus } from './console-api'
const props = defineProps<{ providers: ProviderStatus[] }>()
const emit = defineEmits<{ notice: [message: string] }>()
const provider = ref('')
const model = ref('')
const defaults = ref({ defaultHaikuModel: '', defaultSonnetModel: '', defaultOpusModel: '', permissionMode: '' })
const state = ref<{ path: string; baseUrl: string; model: string; credentialConfigured: boolean; defaultHaikuModel: string; defaultSonnetModel: string; defaultOpusModel: string; permissionMode: string } | null>(null)
const models = ref<string[] | null>(null)
const availableModels = computed(() => (models.value ?? props.providers.find(item => item.name === provider.value)?.models ?? []).filter(item => /^claude/i.test(item)))
const busy = ref(false)
const discovering = ref(false)
const error = ref('')
const discoveryMessage = ref('')
let discoveryId = 0
async function load() {
  try {
    state.value = await api('/api/claude')
    if (!state.value) return
    model.value = state.value.model
    defaults.value = { defaultHaikuModel: state.value.defaultHaikuModel, defaultSonnetModel: state.value.defaultSonnetModel, defaultOpusModel: state.value.defaultOpusModel, permissionMode: state.value.permissionMode || 'default' }
    provider.value = props.providers.find(item => item.baseUrl.replace(/\/v1\/?$/, '') === state.value?.baseUrl.replace(/\/v1\/?$/, ''))?.name ?? ''
  } catch (reason) { error.value = String(reason) }
}
async function discover() {
  const selected = provider.value
  const id = ++discoveryId
  model.value = ''; models.value = null; discoveryMessage.value = ''
  if (!selected) { discovering.value = false; return }
  discovering.value = true
  try {
    const result = await api<{ models: string[]; health: string; lastError: string | null }>('/api/providers/models', { method: 'POST', body: JSON.stringify({ name: selected }) })
    if (id !== discoveryId) return
    models.value = result.models
    if (result.health === 'error' || result.lastError) discoveryMessage.value = '模型目录探测未成功，显示可用的缓存结果。'
    else if (!availableModels.value.length) discoveryMessage.value = '未发现 Claude 模型，可手动输入模型名称。'
  } catch { if (id === discoveryId) discoveryMessage.value = '模型目录探测失败，显示缓存结果；也可手动输入。' }
  finally { if (id === discoveryId) discovering.value = false }
}
async function save(action: string) {
  if (!confirm(action === 'clear' ? '清除 Runtime 管理的 Claude 连接字段？其他设置保留。' : '写入 Claude 用户级配置？原文件会先备份，重新启动 Claude Code 后生效。')) return
  busy.value = true; error.value = ''
  try {
    const result = await api<{ effect: string }>('/api/claude', { method: 'POST', body: JSON.stringify({ action, provider: action === 'clear' ? '' : provider.value, ...(action === 'clear' ? {} : { model: model.value, ...Object.fromEntries(Object.entries(defaults.value).filter(([key, value]) => value !== state.value?.[key as keyof typeof defaults.value])) }) }) })
    emit('notice', result.effect); await load()
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
onMounted(load)
</script>
<template>
  <section class="card">
    <div class="card-head"><div><h2>Claude Code 配置</h2><p>用户级 settings.json，保存前备份原文件。</p></div><span class="pill ok">可编辑</span></div>
    <template v-if="state">
      <div class="file-row"><span>配置文件</span><code>{{ state.path }}</code></div>
    </template>
    <form @submit.prevent="save('provider')">
      <label>Provider<select v-model="provider" :disabled="busy" @change="discover"><option value="">请选择 Provider</option><option v-for="item in providers" :key="item.name" :value="item.name">{{ item.name }}</option></select></label>
      <label>默认模型<input v-model="model" list="claude-models" placeholder="留空使用 Provider 默认模型" :disabled="busy" /><datalist id="claude-models"><option v-for="item in availableModels" :key="item" :value="item" /></datalist></label>
      <p v-if="discovering || discoveryMessage" class="footnote">{{ discovering ? '正在探测模型目录…' : discoveryMessage }}</p>
      <label>Haiku 默认模型<input v-model="defaults.defaultHaikuModel" list="claude-models" placeholder="默认" /></label>
      <label>Sonnet 默认模型<input v-model="defaults.defaultSonnetModel" list="claude-models" placeholder="默认" /></label>
      <label>Opus 默认模型<input v-model="defaults.defaultOpusModel" list="claude-models" placeholder="默认" /></label>
      <label>权限模式<select v-model="defaults.permissionMode"><option value="default">default</option><option value="acceptEdits">acceptEdits</option><option value="plan">plan</option><option value="dontAsk">dontAsk</option><option value="bypassPermissions">bypassPermissions</option><option v-if="defaults.permissionMode && !['default','acceptEdits','plan','dontAsk','bypassPermissions'].includes(defaults.permissionMode)" :value="defaults.permissionMode">{{ defaults.permissionMode }}（当前值）</option></select></label>
      <div class="button-row"><button class="button primary" :disabled="busy || !provider">备份并应用</button><button type="button" class="button" :disabled="busy || !state?.credentialConfigured" @click="save('clear')">清除连接字段</button></div>
    </form>
    <p v-if="error" class="error-banner">{{ error }}</p>
  </section>
</template>
