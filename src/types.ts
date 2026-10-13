export interface TwelveDataUsage {
  /** Twelve Data 返回的统计时间。 */
  timestamp?: string
  currentUsage: number
  planLimit: number
  remaining: number
  dailyUsage: number | null
  dailyLimit: number | null
  dailyRemaining: number | null
  planCategory: string
  syncedAt: string
}

export interface TwelveDataKey {
  key: string
  enabled: boolean
  note?: string
  addedAt: string
  /** 最近一次成功查询 /api_usage 的缓存结果。 */
  usage?: TwelveDataUsage
  /** 失败时保留旧 usage，同时记录最近错误。 */
  usageError?: string
  usageCheckedAt?: string
}

export interface Session {
  username: string
  expiresAt: number
}

export interface Env {
  DB: D1Database
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
  /** 行情 REST 端点专用访问密钥（trading-journal 等外部服务通过 x-api-key 调用） */
  MARKET_API_KEY?: string
  /** 可选：首次启动时导入的 Twelve Data Key，逗号或换行分隔；请使用 Worker Secret。 */
  TWELVE_DATA_KEYS?: string
}
