import { KV_KEYS, KEY_COOLDOWN_SECS } from './config'
import type { Env } from './types'
import { getKeys } from './storage'
import { kvGet, kvPut } from './store'

const TWELVEDATA_BASE = 'https://api.twelvedata.com'

interface KeyResult {
  data: any
  usedKey?: string
}

/** key 健康状态：冷却到期时间(ms)，无则可用；lastUsedAt 用于 LRU 排序 */
interface KeyHealth {
  cooldownUntil?: number
  lastUsedAt?: number
}

async function getHealthMap(env: Env): Promise<Record<string, KeyHealth>> {
  const raw = await kvGet(env, KV_KEYS.HEALTH)
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function setHealthMap(env: Env, map: Record<string, KeyHealth>): Promise<void> {
  await kvPut(env, KV_KEYS.HEALTH, JSON.stringify(map))
}

// 是否命中"配额/限频"类错误
function isQuotaError(json: any): boolean {
  const joined = Array.isArray(json?.message) ? json.message.join(' ') : typeof json?.message === 'string' ? json.message : ''
  return /credit|limit|plan|quota|api usage|you have reached/i.test(joined)
}

/**
 * 依 LRU（上次使用最早）选取可用 key；跳过处于冷却期的 key。
 */
function pickKey(keys: { key: string }[], health: Record<string, KeyHealth>, now: number): { key: string }[] {
  const usable = keys.filter((k) => {
    const h = health[k.key]
    return !h?.cooldownUntil || h.cooldownUntil <= now
  })
  return usable.sort((a, b) => (health[a.key]?.lastUsedAt ?? 0) - (health[b.key]?.lastUsedAt ?? 0))
}

/**
 * 调用 Twelve Data 接口。
 * - 多 key LRU 轮询 + 冷却期跳过（配额/限频的 key 暂不参与），规避免费版限频（8 次/分钟/key）
 * - 写入 KV 短期缓存，降低上游请求频率
 */
export async function callTwelveData(
  env: Env,
  path: string,
  params: Record<string, string>,
  opts?: { cacheTtlMs?: number }
): Promise<KeyResult> {
  const cacheKey = KV_KEYS.CACHE_PREFIX + `${path}?${Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join('&')}`
  const ttl = opts?.cacheTtlMs ?? 15_000

  // cacheTtlMs=0 表示显式请求最新数据，用于实时行情刷新。
  if (ttl > 0) {
    const cached = await kvGet(env, cacheKey)
    if (cached) {
      try {
        return { data: JSON.parse(cached) }
      } catch {
        /* 忽略坏缓存 */
      }
    }
  }

  const keys = (await getKeys(env)).filter((k) => k.enabled)
  if (keys.length === 0) {
    throw new Error('尚未配置可用的 Twelve Data API Key，请先在管理页面添加')
  }

  const now = Date.now()
  const health = await getHealthMap(env)
  const ordered = pickKey(keys, health, now)

  const qs = new URLSearchParams(params)
  let lastErr: string = '未知错误'
  const healthDirty = new Map<string, KeyHealth>()

  for (const entry of ordered) {
    const url = `${TWELVEDATA_BASE}${path}?${qs.toString()}&apikey=${encodeURIComponent(entry.key)}`
    let resp: Response
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    } catch {
      lastErr = '网络请求失败'
      continue
    }

    let json: any
    try {
      json = await resp.json()
    } catch {
      lastErr = `响应解析失败（HTTP ${resp.status}）`
      healthDirty.set(entry.key, { ...health[entry.key], cooldownUntil: now + KEY_COOLDOWN_SECS * 1000 })
      continue
    }

    if (!resp.ok) {
      lastErr = `HTTP ${resp.status}${json?.message ? `：${Array.isArray(json.message) ? json.message.join(' ') : json.message}` : ''}`
      // 4xx 类配额/限频错误：标记冷却；其它错误视为该 key 不可用，继续下一个
      const msg = json?.message
      if (resp.status === 429 || /credit|limit|quota/i.test(Array.isArray(msg) ? msg.join(' ') : String(msg ?? ''))) {
        healthDirty.set(entry.key, { ...health[entry.key], cooldownUntil: now + KEY_COOLDOWN_SECS * 1000 })
      }
      continue
    }

    // Twelve Data 限频/配额错误：返回 200 但带 error / code 429 等
    if (json?.status === 'error' && isQuotaError(json)) {
      lastErr = Array.isArray(json.message) ? json.message.join(' ') : String(json.message)
      healthDirty.set(entry.key, { ...health[entry.key], cooldownUntil: now + KEY_COOLDOWN_SECS * 1000 })
      continue
    }
    if (json?.status === 'error') {
      lastErr = Array.isArray(json.message) ? json.message.join(' ') : String(json.message ?? json.code ?? 'error')
      continue
    }

    // 记录最近成功使用的时间（LRU）
    healthDirty.set(entry.key, { ...health[entry.key], lastUsedAt: now })

    // D1 缓存以分钟粒度清理；显式 fresh 请求不读写缓存。
    if (ttl > 0) {
      await kvPut(env, cacheKey, JSON.stringify(json), Math.max(60, Math.floor(ttl / 1000)))
    }
    if (healthDirty.size > 0) {
      const merged = { ...health }
      for (const [k, v] of healthDirty) merged[k] = v
      await setHealthMap(env, merged)
    }
    return { data: json, usedKey: maskKey(entry.key) }
  }

  if (healthDirty.size > 0) {
    const merged = { ...health }
    for (const [k, v] of healthDirty) merged[k] = v
    await setHealthMap(env, merged)
  }
  throw new Error(`Twelve Data 请求失败（所有 key 均不可用或限频）：${lastErr}`)
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

/** 校验 key 是否可用（用于页面添加 key 时的即时检测） */
export async function testKey(env: Env, key: string): Promise<{ ok: boolean; message: string }> {
  const url = `${TWELVEDATA_BASE}/price?symbol=EUR/USD&apikey=${encodeURIComponent(key.trim())}`
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    const json: any = await resp.json()
    if (json && json.price) return { ok: true, message: `可用，EUR/USD = ${json.price}` }
    if (json && json.message) return { ok: false, message: Array.isArray(json.message) ? json.message.join(' ') : String(json.message) }
    return { ok: false, message: '没有返回价格数据' }
  } catch {
    return { ok: false, message: '网络请求失败' }
  }
}
