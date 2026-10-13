import type { Env } from './types'
import { normalizeSymbol } from './config'
import { callTwelveData } from './twelve'

export interface Candle {
  time: number // unix 秒
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

const INTERVAL_ALIAS: Record<string, string> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min',
  '1h': '1h', '2h': '2h', '4h': '4h',
  '1d': '1day', 'd': '1day', '1w': '1week', 'w': '1week', '1mo': '1month', 'mo': '1month', 'm': '1month',
}

// 解析 Twelve Data 时间字段（'YYYY-MM-DD HH:MM:SS' 或 'YYYY-MM-DD'，UTC）-> unix 秒
function toUnix(dt: string): number {
  const s = (dt || '').trim()
  if (!s) return 0
  const norm = s.indexOf(' ') >= 0 ? s : s + ' 00:00:00'
  const [d, t] = norm.split(' ')
  const [Y, M, D] = d.split('-').map((x) => parseInt(x, 10))
  const [h, mi, sec] = (t || '00:00:00').split(':').map((x) => parseInt(x, 10))
  return Math.floor(Date.UTC(Y || 0, (M || 1) - 1, D || 1, h || 0, mi || 0, sec || 0) / 1000)
}

export function resolveInterval(raw?: string): string {
  const k = (raw || '1day').toLowerCase()
  return INTERVAL_ALIAS[k] || k
}

function norm(val: any): number {
  const n = typeof val === 'number' ? val : parseFloat(String(val ?? ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * 获取 K 线（OHLCV）。复用 callTwelveData 的多 key LRU 轮询 + 冷却 + 缓存。
 * 返回按时间升序排列的蜡烛，可直接用于 lightweight-charts 等图表库。
 */
export async function fetchCandles(
  env: Env,
  opts: { symbol?: string; interval?: string; outputsize?: number; fresh?: boolean } = {}
) {
  const symbol = normalizeSymbol(opts.symbol || 'XAU/USD')
  const interval = resolveInterval(opts.interval)
  const outputsize = Math.min(Math.max(Number(opts.outputsize) || 120, 1), 2000)

  const r = await callTwelveData(
    env,
    '/time_series',
    {
      symbol,
      interval,
      outputsize: String(outputsize),
      order: 'asc',
      timezone: 'UTC',
      dp: '5',
    },
    { cacheTtlMs: opts.fresh ? 0 : 60_000 }
  )

  const data = r.data || {}
  const values: any[] = Array.isArray(data.values) ? data.values : []
  const candles: Candle[] = values
    .map((v) => ({
      time: toUnix(v.datetime),
      open: norm(v.open),
      high: norm(v.high),
      low: norm(v.low),
      close: norm(v.close),
      ...(v.volume !== undefined && v.volume !== null ? { volume: norm(v.volume) } : {}),
    }))
    .filter((cc: Candle) => cc.time > 0)

  return {
    symbol,
    interval,
    outputsize: candles.length,
    fetchedAt: new Date().toISOString(),
    cacheMode: opts.fresh ? 'fresh' : 'up-to-60s',
    meta: data.meta || null,
    candles,
  }
}
