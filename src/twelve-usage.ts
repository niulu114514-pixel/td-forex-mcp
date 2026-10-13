import type { TwelveDataUsage } from './types'

const TWELVEDATA_BASE = 'https://api.twelvedata.com'

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Normalize Twelve Data's /api_usage response for storage and display. */
export function parseApiUsage(payload: unknown, syncedAt = new Date().toISOString()): TwelveDataUsage {
  if (!payload || typeof payload !== 'object') throw new Error('Twelve Data 返回了无效的额度数据')
  const data = payload as Record<string, unknown>
  if (data.status === 'error') {
    const message = Array.isArray(data.message) ? data.message.join(' ') : String(data.message || '额度查询失败')
    throw new Error(message)
  }

  const currentUsage = finiteNumber(data.current_usage)
  const planLimit = finiteNumber(data.plan_limit)
  if (currentUsage === null || planLimit === null) throw new Error('Twelve Data 额度响应缺少 current_usage 或 plan_limit')
  const dailyUsage = finiteNumber(data.daily_usage)
  const dailyLimit = finiteNumber(data.plan_daily_limit)

  return {
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : undefined,
    currentUsage,
    planLimit,
    remaining: Math.max(0, planLimit - currentUsage),
    dailyUsage,
    dailyLimit,
    dailyRemaining: dailyUsage === null || dailyLimit === null ? null : Math.max(0, dailyLimit - dailyUsage),
    planCategory: typeof data.plan_category === 'string' ? data.plan_category : 'unknown',
    syncedAt,
  }
}

/** Query a key's live usage. Twelve Data counts this request as one API credit. */
export async function fetchKeyUsage(key: string): Promise<TwelveDataUsage> {
  const response = await fetch(`${TWELVEDATA_BASE}/api_usage`, {
    headers: { Authorization: `apikey ${key.trim()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    const message = data?.message
    throw new Error(Array.isArray(message) ? message.join(' ') : String(message || `HTTP ${response.status}`))
  }
  return parseApiUsage(payload)
}
