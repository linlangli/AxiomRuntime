const storageKey = 'axiom.local.web.token'
const hashToken = location.hash.match(/^#access=([a-f0-9]{64})$/)?.[1]
if (hashToken) {
  sessionStorage.setItem(storageKey, hashToken)
  history.replaceState(null, '', '/')
}

export const accessToken = sessionStorage.getItem(storageKey)

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!accessToken) throw new Error('请从终端运行 ai web 重新打开控制面板。')
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`)
  return payload as T
}

export interface ProviderStatus {
  name: string; baseUrl: string; mode: string; level: number; model: string; proxyUrl?: string
  health: 'ok' | 'error' | 'unknown'; healthScore: number | null; weeklyTokens: number
  usageShare: number; credentialConfigured: boolean; models: string[]; lastCheckedAt: string | null
  lastError: string | null; circuitOpenUntil: string | null
  claude: { state: string; model: string | null }; codex: { state: string; model: string | null }
}
export interface DailyUsage {
  date: string; inputTokens: number; outputTokens: number; totalTokens: number
  estimatedCostUsd: number; unpricedEvents: number
}
export interface LogItem {
  timestamp: string; level: string; category: string; action: string; traceId: string | null
  provider: string | null; model: string | null; status: string | null; attempt: number | null
}
export interface SessionItem {
  id: string; tool: string; provider: string; model: string; startedAt: string; endedAt: string | null
  status: string; fallbackFrom: string | null
}
export interface Dashboard {
  generatedAt: string; configRoot: string; providers: ProviderStatus[]
  usage: {
    totalTokens: number; estimatedCostUsd: number; unpricedEvents: number; daily: DailyUsage[]
    providers: Array<{ provider: string; totalTokens: number; estimatedCostUsd: number; daily: Array<{ date: string; inputTokens: number; outputTokens: number; totalTokens: number }> }>
  }
  logs: LogItem[]; sessions: SessionItem[]
  codex: { providerId: string; model: string | null; proxy: string | null; authConfigured: boolean; configPresent: boolean; configPath: string; authPath: string }
}
