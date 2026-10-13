export const KV_KEYS = {
  KEYS: 'td_keys', // Twelve Data API keys 列表
  HEALTH: 'td_health', // key 健康状态（冷却期/上次使用时间），用于 LRU 轮换
  CACHE_PREFIX: 'tdf_cache_',
  SESSION_PREFIX: 'tdf_session_',
} as const

// 命中"配额/限频"错误后，该 key 的冷却时长（秒）
export const KEY_COOLDOWN_SECS = 60

export const SESSION_TTL = 60 * 60 * 24 * 7 // 7 天

export const DEFAULT_SYMBOL = 'EUR/USD'

// 支持的外汇对符号归一化：EUR/USD、EURUSD、GBPJPY、XAU/USD、BTC/USD 均可。
// - 若已经含 '/'，转大写后原样返回（保留 XAU/USD、BTC/USD 等）；
// - 若为 6 字符无斜杠货币对（如 EURUSD、GBPJPY），补成 EUR/USD。
// - 含数字/点的（如 US100、USOIL、NATURAL_GAS、CL、AAPL）或其它非货币对原样转大写。
export function normalizeSymbol(symbol: string): string {
  const s = (symbol ?? '').trim()
  if (!s) return DEFAULT_SYMBOL
  const up = s.toUpperCase()
  if (up.includes('/')) return up
  // 6 位纯字母 = 无斜杠货币对（EURRUB、GBPJPY 等）
  if (/^[A-Z]{6}$/.test(up)) return up.slice(0, 3) + '/' + up.slice(3)
  return up
}
