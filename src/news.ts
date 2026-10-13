import type { Env } from './types'
import { kvGet, kvPut } from './store'

const RSS_CACHE_SECONDS = 300
const MAX_RSS_BYTES = 2 * 1024 * 1024
const MAX_TAVILY_BYTES = 1024 * 1024

export interface NewsSource {
  id: string
  name: string
  url: string
  ua?: string
}

export interface NewsItem {
  source: string
  title: string
  link: string
  publishedAt?: string
  description?: string
}

export interface NewsSourceStatus {
  id: string
  name: string
  ok: boolean
  cached: boolean
  stale: boolean
  item_count: number
  error?: string
}

export interface NewsBundle {
  items: NewsItem[]
  sourceStatus: NewsSourceStatus[]
  searchTerms: string[]
}

type NewsSourceResult = {
  items: NewsItem[]
  status: NewsSourceStatus
}

type LastGoodNews = {
  capturedAt: string
  items: NewsItem[]
}

/** 免费公开来源；优先选择官方机构或可稳定抓取的财经 RSS。 */
export const FREE_SOURCES: NewsSource[] = [
  {
    id: 'federalreserve',
    name: 'Federal Reserve',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
  },
  {
    id: 'ecb',
    name: 'European Central Bank',
    url: 'https://www.ecb.europa.eu/rss/press.html',
  },
  {
    id: 'bankofengland',
    name: 'Bank of England',
    url: 'https://www.bankofengland.co.uk/rss/news',
  },
  {
    id: 'oilprice',
    name: 'Oilprice (Energy/Crude)',
    url: 'https://oilprice.com/rss/main',
  },
  {
    id: 'cnbc',
    name: 'CNBC',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
  },
  {
    id: 'forexlive',
    name: 'ForexLive',
    url: 'https://www.forexlive.com/feed/news',
  },
]

const KEYWORD_ALIASES: Record<string, string[]> = {
  黄金: ['gold', 'xau', 'bullion'],
  白银: ['silver', 'xag'],
  美联储: ['federal reserve', 'fed', 'fomc'],
  非农: ['nonfarm', 'non-farm', 'payrolls', 'nfp'],
  通胀: ['inflation', 'cpi', 'pce'],
  利率: ['interest rate', 'rates', 'rate cut', 'rate hike'],
  降息: ['rate cut', 'easing'],
  加息: ['rate hike', 'tightening'],
  美元: ['dollar', 'usd', 'dxy'],
  欧元: ['euro', 'eur'],
  英镑: ['sterling', 'pound', 'gbp'],
  日元: ['yen', 'jpy'],
  原油: ['oil', 'crude', 'wti', 'brent'],
  欧央行: ['european central bank', 'ecb'],
  欧洲央行: ['european central bank', 'ecb'],
  英央行: ['bank of england', 'boe'],
  英国央行: ['bank of england', 'boe'],
  日本央行: ['bank of japan', 'boj'],
  央行: ['central bank'],
  就业: ['employment', 'jobs', 'payrolls'],
  衰退: ['recession'],
  避险: ['safe haven', 'risk-off'],
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > maximumBytes) throw new Error(`响应体超过 ${maximumBytes} 字节限制`)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel('response too large')
        throw new Error(`响应体超过 ${maximumBytes} 字节限制`)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}

export function expandSearchTerms(keyword: string): string[] {
  const normalized = keyword.trim().toLocaleLowerCase()
  if (!normalized) return []
  const terms = new Set<string>([normalized])
  for (const token of normalized.split(/[\s,，、/]+/u)) {
    if (token.length >= 2) terms.add(token)
  }
  for (const [chinese, aliases] of Object.entries(KEYWORD_ALIASES)) {
    if (normalized.includes(chinese)) aliases.forEach(alias => terms.add(alias))
  }
  return [...terms]
}

function publishedTimestamp(item: NewsItem): number {
  if (!item.publishedAt) return 0
  const timestamp = Date.parse(item.publishedAt)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function filterAndSortNews(items: NewsItem[], keyword = '', limit = 30): NewsItem[] {
  const seen = new Set<string>()
  const unique = items.filter(item => {
    const normalizedTitle = item.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const key = normalizedTitle || item.link.trim().toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const terms = expandSearchTerms(keyword)
  const filtered = terms.length
    ? unique.filter(item => {
        const text = `${item.title} ${item.description || ''}`.toLocaleLowerCase()
        return terms.some(term => text.includes(term))
      })
    : unique
  return filtered
    .sort((left, right) => publishedTimestamp(right) - publishedTimestamp(left))
    .slice(0, Math.min(Math.max(limit, 1), 100))
}

async function fetchRssResult(env: Env, source: NewsSource, cacheTtlSeconds = RSS_CACHE_SECONDS): Promise<NewsSourceResult> {
  const cacheKey = `tdf_news_v3_${source.id}`
  const lastGoodKey = `tdf_news_last_good_v3_${source.id}`
  const cached = parseJson<NewsItem[]>(await kvGet(env, cacheKey))
  if (cached) {
    return {
      items: cached,
      status: { id: source.id, name: source.name, ok: true, cached: true, stale: false, item_count: cached.length },
    }
  }

  try {
    const response = await fetch(source.url, {
      headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
        'User-Agent': source.ua || 'Mozilla/5.0 (compatible; TD-Forex-MCP/1.0; +https://fx.312522.xyz)',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const xml = await readBoundedText(response, MAX_RSS_BYTES)
    const items = parseRss(xml, source.name)
    if (!items.length) throw new Error('RSS 未解析到任何新闻')
    const lastGood: LastGoodNews = { capturedAt: new Date().toISOString(), items }
    await Promise.all([
      kvPut(env, cacheKey, JSON.stringify(items), Math.max(60, cacheTtlSeconds)),
      kvPut(env, lastGoodKey, JSON.stringify(lastGood)),
    ])
    return {
      items,
      status: { id: source.id, name: source.name, ok: true, cached: false, stale: false, item_count: items.length },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({ message: 'news source fetch failed', source: source.id, error: message }))
    const lastGood = parseJson<LastGoodNews>(await kvGet(env, lastGoodKey))
    const fallbackItems = Array.isArray(lastGood?.items) ? lastGood.items : []
    return {
      items: fallbackItems,
      status: {
        id: source.id,
        name: source.name,
        ok: false,
        cached: Boolean(fallbackItems.length),
        stale: Boolean(fallbackItems.length),
        item_count: fallbackItems.length,
        error: message.slice(0, 200),
      },
    }
  }
}

/** 兼容现有调用：只返回单个来源的新闻数组。 */
export async function fetchRss(env: Env, source: NewsSource, cacheTtlMs = RSS_CACHE_SECONDS * 1000): Promise<NewsItem[]> {
  return (await fetchRssResult(env, source, Math.floor(cacheTtlMs / 1000))).items
}

export async function fetchNewsBundle(
  env: Env,
  options: { sources?: string[]; keyword?: string; limit?: number } = {},
): Promise<NewsBundle> {
  const requested = options.sources?.filter(Boolean) || []
  const pool = requested.length ? FREE_SOURCES.filter(source => requested.includes(source.id)) : FREE_SOURCES
  const results = await Promise.all(pool.map(source => fetchRssResult(env, source)))
  const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 100)
  return {
    items: filterAndSortNews(results.flatMap(result => result.items), options.keyword, limit),
    sourceStatus: results.map(result => result.status),
    searchTerms: expandSearchTerms(options.keyword || ''),
  }
}

/** 聚合多个源的新闻，跨源去重、中文别名检索并按发布时间倒序。 */
export async function fetchAllNews(env: Env, options?: { sources?: string[]; keyword?: string; limit?: number }): Promise<NewsItem[]> {
  return (await fetchNewsBundle(env, options)).items
}

/** 极简 RSS/Atom 解析（不引入额外依赖，抽取 item/entry 关键字段）。 */
export function parseRss(xml: string, sourceName: string): NewsItem[] {
  const items: NewsItem[] = []
  const itemPattern = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)\s*>/gi
  let match: RegExpExecArray | null
  while ((match = itemPattern.exec(xml)) !== null && items.length < 50) {
    const block = match[1]
    const title = stripTags(extract(block, '<title[^>]*>', '</title>')) || '(无标题)'
    const link = cleanCdata(extract(block, '<link[^>]*>', '</link>') || extractAttr(block, '<link', 'href') || '')
    const published = cleanCdata(
      extract(block, '<pubDate[^>]*>', '</pubDate>')
        || extract(block, '<updated[^>]*>', '</updated>')
        || extract(block, '<published[^>]*>', '</published>'),
    )
    const description = stripTags(htmlDecode(
      extract(block, '<description[^>]*>', '</description>') || extract(block, '<summary[^>]*>', '</summary>'),
    ))
    items.push({
      source: sourceName,
      title: htmlDecode(title.trim()),
      link: link.trim(),
      publishedAt: published.trim() || undefined,
      description: description.slice(0, 500) || undefined,
    })
  }
  return items
}

function extract(text: string, open: string, close: string): string {
  const index = text.search(new RegExp(open, 'i'))
  if (index === -1) return ''
  const start = text.indexOf('>', index) + 1
  const end = text.toLocaleLowerCase().indexOf(close.toLocaleLowerCase(), start)
  return end === -1 ? '' : text.slice(start, end)
}

function extractAttr(text: string, tag: string, attribute: string): string {
  const match = new RegExp(`${tag}[^>]*\\b${attribute}=["']([^"']+)["']`, 'i').exec(text)
  return match ? match[1] : ''
}

function stripTags(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function cleanCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

export interface TavilyConfig {
  url?: string
  authKey?: string
}

export async function getTavilyConfig(env: Env): Promise<TavilyConfig> {
  return parseJson<TavilyConfig>(await kvGet(env, 'tdf_tavily')) || {}
}

export async function setTavilyConfig(env: Env, config: TavilyConfig): Promise<void> {
  await kvPut(env, 'tdf_tavily', JSON.stringify(config))
}

export async function searchViaTavily(
  env: Env,
  input: { query: string; max_results?: number; time_range?: string },
): Promise<unknown> {
  const config = await getTavilyConfig(env)
  const runtime = env as Env & { TAVILY_PROXY_URL?: string; TAVILY_AUTH_KEY?: string }
  const baseUrl = config.url || runtime.TAVILY_PROXY_URL
  const authKey = config.authKey || runtime.TAVILY_AUTH_KEY
  if (!baseUrl || !authKey) {
    throw new Error('未配置 tavily-proxy（请在管理页面填写 URL 与 Auth Key，或设置环境变量 TAVILY_PROXY_URL / TAVILY_AUTH_KEY）')
  }

  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const mcpUrl = normalizedBase.endsWith('/mcp') ? normalizedBase : `${normalizedBase}/mcp`
  const request = (body: unknown, sessionId?: string) => fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-api-key': authKey,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })

  const initialize = await request({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'td-forex-mcp', version: '1.0.0' },
    },
  })
  const sessionId = initialize.headers.get('Mcp-Session-Id') || undefined
  await consumeMcpResponse(initialize)

  if (sessionId) {
    const initialized = await request({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
    if (!initialized.ok) await consumeMcpResponse(initialized)
    else if (initialized.body) await initialized.body.cancel()
  }

  const call = await request({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'tavily-search',
      arguments: {
        query: input.query,
        max_results: Math.min(Math.max(Number(input.max_results) || 5, 1), 10),
        topic: 'news',
        ...(input.time_range ? { time_range: input.time_range } : {}),
      },
    },
  }, sessionId)
  return consumeMcpResponse(call)
}

function extractMcpResult(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return null
  const result = (payload as { result?: { content?: Array<{ type?: string; text?: string }> } }).result
  if (!Array.isArray(result?.content)) return null
  const text = result.content.filter(item => item.type === 'text').map(item => item.text || '').join('\n')
  if (!text) return null
  return parseJson<unknown>(text) ?? { raw: text }
}

async function consumeMcpResponse(response: Response): Promise<unknown> {
  const text = await readBoundedText(response, MAX_TAVILY_BYTES)
  if (!response.ok) throw new Error(`tavily-proxy 请求失败（HTTP ${response.status}）：${text.slice(0, 200)}`)

  const direct = parseJson<unknown>(text)
  const directResult = extractMcpResult(direct)
  if (directResult !== null) return directResult

  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = parseJson<unknown>(line.slice(5).trim())
    const result = extractMcpResult(payload)
    if (result !== null) return result
  }
  return { raw: text.slice(0, 2000) }
}
