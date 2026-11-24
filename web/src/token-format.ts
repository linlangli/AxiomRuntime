export function formatTokens(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  const [divisor, suffix] = absolute >= 100_000_000 ? [100_000_000, '亿'] : absolute >= 10_000 ? [10_000, 'w'] : absolute >= 1_000 ? [1_000, 'k'] : [1, '']
  return divisor === 1 ? new Intl.NumberFormat('zh-CN').format(value) : `${Number((value / divisor).toFixed(1))}${suffix}`
}
