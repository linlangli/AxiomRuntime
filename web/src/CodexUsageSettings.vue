<script setup lang="ts">
import { ref, watch } from 'vue'
import { Plus, X } from 'lucide-vue-next'
import type { CodexUsageStatus, ProviderStatus } from './console-api'

const props = defineProps<{ status: CodexUsageStatus; providers: ProviderStatus[]; busy: boolean }>()
const emit = defineEmits<{ preview: [title: string, body: Record<string, unknown>, before: object] }>()
const enabled = ref(props.status.enabled)
const codexHome = ref(props.status.codexHome)
const mappings = ref<Array<{ identifier: string; provider: string }>>([])
const error = ref('')
watch(() => JSON.stringify([props.status.enabled, props.status.codexHome, props.status.providerMappings, props.status.unmappedProviderIds]), () => {
  enabled.value = props.status.enabled
  codexHome.value = props.status.codexHome
  mappings.value = [...new Set([...Object.keys(props.status.providerMappings), ...props.status.unmappedProviderIds])]
    .map(identifier => ({ identifier, provider: props.status.providerMappings[identifier] ?? '' }))
}, { immediate: true })
function save() {
  error.value = ''
  const selected = mappings.value.filter(row => row.provider)
  if (selected.some(row => !row.identifier.trim()) || new Set(selected.map(row => row.identifier.trim())).size !== selected.length) {
    error.value = '请填写唯一的 Codex Provider ID。'
    return
  }
  emit('preview', '保存 Codex App 用量采集', {
    action: 'codex-usage', enabled: enabled.value, codexHome: codexHome.value,
    providerMappings: Object.fromEntries(selected.map(row => [row.identifier.trim(), row.provider]))
  }, { enabled: props.status.enabled, codexHome: props.status.codexHome, providerMappings: props.status.providerMappings })
}
</script>

<template>
  <section class="card spaced">
    <div class="card-head"><div><h2>Codex App 用量采集 <span class="hand-tag">tokens!</span></h2><p>按实际 Provider 和模型汇入「用量统计」，沿用现有模型价格。</p></div><span class="pill" :class="status.enabled && !status.lastError ? 'ok' : 'unknown'">{{ status.enabled ? '已开启' : '未开启' }}</span></div>
    <div v-if="status.lastError" class="error-banner" role="alert">{{ status.lastError }}</div>
    <div v-if="status.unmappedProviderIds.length" class="note-paper">有 {{ status.unmappedProviderIds.length }} 个 Provider 尚未匹配。请在下方指定对应服务商，保存后补计启用以来的相关记录。</div>
    <form @submit.prevent="save">
      <div class="form-grid">
        <label>采集状态<select v-model="enabled"><option :value="true">开启采集</option><option :value="false">关闭采集</option></select></label>
        <label>Codex 本机目录<input v-model="codexHome" required placeholder="CODEX_HOME，例如 /Users/me/.codex" /></label>
      </div>
      <p class="footnote">从启用时开始，只读本机 App 会话中的真实 Token；刷新面板或执行 ai status 时同步。无需重启 App，不保存对话正文。已由 Runtime 代理记账的 CLI 会话自动排除。</p>
      <div class="file-row"><span>最近同步</span><span>{{ status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('zh-CN') : '尚未同步' }}</span></div>
      <div v-if="status.enabledAt" class="file-row"><span>本次采集起点</span><span>{{ new Date(status.enabledAt).toLocaleString('zh-CN') }}</span></div>
      <p v-if="status.invalidEvents" class="footnote">已跳过 {{ status.invalidEvents }} 条无法确认的用量记录，未估算或补造 Token。</p>
      <h3>Provider 对应关系</h3>
      <p class="footnote">同名或 Runtime 生成的 Provider ID 自动匹配。自定义 ID、ChatGPT 登录等无法对应时，请手动选择归属。</p>
      <div v-for="(row, index) in mappings" :key="index" class="mapping-row">
        <label>Codex Provider ID<input v-model="row.identifier" aria-label="Codex Provider ID" placeholder="例如 openai" /></label>
        <label>统计归属 Provider<select v-model="row.provider" aria-label="统计归属 Provider"><option value="">暂不归属，不计入统计</option><option v-for="provider in providers" :key="provider.name" :value="provider.name">{{ provider.name }}</option></select></label>
        <button type="button" class="icon-button" :disabled="busy" aria-label="删除对应关系" @click="mappings.splice(index, 1)"><X :size="16" /></button>
      </div>
      <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
      <div class="button-row"><button type="button" class="button" :disabled="busy" @click="mappings.push({ identifier: '', provider: '' })"><Plus :size="14" />添加对应关系</button><button class="button primary" :disabled="busy">预览并保存</button></div>
      <p class="footnote">关闭期间的用量与首次启用之前的历史不补录。此适配读取 Codex 本机会话格式，格式变化时可能暂停采集；云端任务不在采集范围内。</p>
    </form>
  </section>
</template>

<style scoped>
.mapping-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end; margin-bottom: 12px; }
.mapping-row .icon-button { margin-bottom: 10px; }
@media (max-width: 640px) { .mapping-row { grid-template-columns: 1fr; } }
</style>
