<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api, type ServiceExposure } from './console-api'

const props = defineProps<{ exposure: ServiceExposure; disabled?: boolean }>()
const emit = defineEmits<{ verified: []; notice: [message: string]; busy: [value: boolean] }>()
const capability = ref('chat')
const target = ref('local')
const token = ref('')
const model = ref('')
const prompt = ref('')
const engine = ref('codex')
const provider = ref('')
const workspace = ref('web-playground')
const permission = ref('read_only')
const tool = ref('runtime.status')
const size = ref('1024x1024')
const files = ref<File[]>([])
const busy = ref(false)
const error = ref('')
const result = ref<{ ok: boolean; status: number; durationMs: number; requestId: string; result: unknown; verified: boolean } | null>(null)
const available = computed(() => props.exposure.catalog.filter(item => props.exposure.capabilities.includes(item.id)))
const images = computed(() => {
  const data = result.value?.result as { data?: Array<{ b64_json?: string; url?: string }> } | null
  return Array.isArray(data?.data) ? data.data.filter(item => item && (item.b64_json || item.url)) : []
})
watch(available, items => { if (!items.some(item => item.id === capability.value)) capability.value = items[0]?.id ?? '' }, { immediate: true })
watch(capability, () => { result.value = null; error.value = '' })
watch(() => props.exposure.publicBaseUrl, value => { if (!value && target.value === 'public') target.value = 'local'; result.value = null })
function safeUrl(value?: string) { try { const url = new URL(value ?? ''); return url.protocol === 'https:' ? url.href : '' } catch { return '' } }
async function submit() {
  if (busy.value || props.disabled) return
  busy.value = true; emit('busy', true); error.value = ''; result.value = null
  try {
    let body: Record<string, unknown> = { model: model.value }
    if (capability.value === 'chat') body.messages = [{ role: 'user', content: prompt.value }]
    else if (capability.value === 'responses' || capability.value === 'embeddings') body.input = prompt.value
    else if (capability.value === 'agent') body = { engine: engine.value, prompt: prompt.value, workspace_id: workspace.value, permission_mode: permission.value, ...(provider.value ? { provider: provider.value } : {}), ...(model.value ? { model: model.value } : {}) }
    else if (capability.value === 'tools') body = { name: tool.value }
    else if (capability.value.startsWith('image')) {
      body = { ...body, prompt: prompt.value, n: 1, size: size.value, response_format: 'b64_json' }
      if (capability.value === 'image_edits') {
        if (!files.value.length || files.value.length > 8 || files.value.some(file => file.size > 20 * 1024 * 1024) || files.value.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024) throw new Error('选择 1–8 张参考图，单张不超过 20 MiB，合计不超过 40 MiB。')
        body.images = await Promise.all(files.value.map(async file => {
          const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
          return { type: file.type, data }
        }))
      }
    }
    result.value = await api('/api/exposure/call', { method: 'POST', body: JSON.stringify({ capability: capability.value, target: target.value, token: token.value, body }) })
    if (result.value?.verified) emit('verified')
    emit('notice', result.value?.ok ? '授权调用成功。' : '调用失败，请查看响应和运行记录。')
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false; emit('busy', false) }
}
</script>

<template>
  <section class="card playground">
    <div class="card-head"><div><h2>实际调用工作台</h2><p>直接调用已有 Runtime API，验证授权与返回结果。真实模型及 Agent 请求会产生费用。</p></div><span class="pill" :class="result?.ok ? 'ok' : 'unknown'">{{ busy ? '执行中' : result ? `HTTP ${result.status}` : '等待调用' }}</span></div>
    <div v-if="!available.length" class="empty">先完成「开放能力」与「调用凭证」，再发起请求。</div>
    <form v-else @submit.prevent="submit">
      <fieldset :disabled="busy || disabled"><div class="form-grid"><label>调用能力<select v-model="capability"><option v-for="item in available" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><label>调用目标<select v-model="target"><option value="local">本机 API · 127.0.0.1:8080</option><option value="public" :disabled="!exposure.publicBaseUrl">已保存的公网 HTTPS 入口</option></select></label></div>
      <label>调用凭证<input v-model="token" required type="password" autocomplete="off" placeholder="仅用于本次请求，不保存到配置或日志" /></label>
      <template v-if="!['models', 'tools'].includes(capability)"><div class="form-grid"><label>模型 ID<input v-model="model" :required="capability !== 'agent'" placeholder="填写 Provider 支持的模型 ID" /></label><label v-if="capability.startsWith('image')">图片尺寸<input v-model="size" placeholder="1024x1024" /></label></div><label>输入内容<textarea v-model="prompt" required rows="5" placeholder="输入问题、图片描述或任务指令" /></label></template>
      <label v-if="capability === 'image_edits'">参考图（PNG / JPEG / WebP）<input type="file" accept="image/png,image/jpeg,image/webp" multiple @change="files = Array.from(($event.target as HTMLInputElement).files ?? [])" /></label>
      <div v-if="capability === 'agent'" class="form-grid"><label>执行引擎<select v-model="engine"><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label><label>Provider<input v-model="provider" placeholder="可选；受限凭证必须指定" /></label><label>隔离工作区 ID<input v-model="workspace" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" /></label><label>文件权限<select v-model="permission"><option value="read_only">只读</option><option value="workspace_write">允许修改隔离工作区</option></select></label></div>
      <label v-if="capability === 'tools'">注册工具<select v-model="tool"><option value="runtime.status">Runtime 状态</option><option value="providers.list">Provider 列表</option></select></label>
      <p class="footnote">公网授权调用成功后，接入引导才会标记部署验证完成。超时可能发生在服务处理之后，请查看记录再重试。Agent 仅访问服务端隔离工作区，权限请求默认拒绝。</p>
      <button class="button primary" :disabled="busy">{{ busy ? '正在执行，请等待…' : '发送授权请求' }}</button></fieldset>
    </form>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <div v-if="result" class="call-result"><p>HTTP {{ result.status }} · {{ result.durationMs }} ms · {{ result.requestId || '无请求 ID' }}</p><div class="image-results"><template v-for="(image, index) in images" :key="index"><a v-if="image.b64_json" :href="`data:image/png;base64,${image.b64_json}`" download="runtime-image.png"><img :src="`data:image/png;base64,${image.b64_json}`" alt="Runtime 生成的图片，点击下载" /></a><a v-else-if="safeUrl(image.url)" :href="safeUrl(image.url)" target="_blank" rel="noopener noreferrer">打开 Provider 图片链接</a></template></div><details :open="!images.length"><summary>原始响应</summary><pre>{{ JSON.stringify(result.result, null, 2) }}</pre></details></div>
  </section>
</template>

<style scoped>
.playground { margin-top: 20px; } fieldset { border: 0; padding: 0; margin: 0; min-width: 0; } textarea { resize: vertical; } .footnote { font-size: 12px; line-height: 1.8; color: var(--muted); } .call-result { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; font-size: 12px; } pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 480px; overflow: auto; } .image-results { display: flex; flex-wrap: wrap; gap: 16px; margin: 16px 0; } .image-results img { width: min(320px, 100%); max-height: 400px; object-fit: contain; border-radius: 12px; } .image-results a { min-width: 0; max-width: 100%; } summary { cursor: pointer; }
</style>
