import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Env } from './types'
import { adminAuthMiddleware, mcpAuthMiddleware, handleLogin, handleLogout, safeEqual } from './auth'
import { handleGetKeys, handleAddKey, handleRemoveKey, handleToggleKey, handleTestKey, handleRefreshKeyUsage, handleGetTavilyConfig, handleSaveTavilyConfig, handleTestTavilyConfig } from './admin'
import { renderLoginPage, renderAdminPage } from './pages'
import { createMcpServer } from './mcp'
import { seedKeys } from './storage'
import { fetchCandles } from './market'
import { fetchNewsBundle, FREE_SOURCES, searchViaTavily } from './news'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors())
app.use('*', logger())
app.use('*', async (c, next) => {
  c.header('X-Request-Id', c.req.header('cf-ray') || crypto.randomUUID())
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  await next()
})

async function hasMarketAccess(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const expected = c.env.MARKET_API_KEY
  const provided = c.req.header('x-api-key') || ''
  return Boolean(expected && provided && await safeEqual(provided, expected))
}

let seeded = false
app.use('*', async (c, next) => {
  if (!seeded) {
    await seedKeys(c.env)
    seeded = true
  }
  return next()
})

// ===== 首页/健康检查 =====
app.get('/', async (c) =>
  c.json({
    service: 'td-forex-mcp',
    mcp: 'https://' + c.req.header('host') + '/mcp  (POST, 需 HTTP Basic Authorization)',
    description: 'Twelve Data 外汇数据 MCP Server',
  })
)

// ===== 行情 REST 端点（供 trading-journal 等外部服务联动，x-api-key 鉴权） =====
app.get('/api/kline', async (c) => {
  const key = c.env.MARKET_API_KEY
  if (!key) {
    return c.json({ success: false, message: '行情端点未启用（未设置 MARKET_API_KEY）' }, 503)
  }
  if (!(await hasMarketAccess(c))) {
    return c.json({ success: false, message: '未授权' }, 401)
  }
  try {
    const data = await fetchCandles(c.env, {
      symbol: c.req.query('symbol') as string | undefined,
      interval: c.req.query('interval') as string | undefined,
      outputsize: c.req.query('outputsize') ? Number(c.req.query('outputsize')) : undefined,
      fresh: ['1', 'true', 'yes'].includes((c.req.query('fresh') || '').toLowerCase()),
    })
    c.header('Cache-Control', 'no-store')
    return c.json({ success: true, ...data })
  } catch (e: any) {
    return c.json({ success: false, message: e?.message || '获取K线失败' }, 502)
  }
})

// ===== 财经新闻 REST 端点（供 trading-journal 服务端调用）=====
app.get('/api/news', async (c) => {
  const key = c.env.MARKET_API_KEY
  if (!key) return c.json({ success: false, message: '新闻端点未启用（未设置 MARKET_API_KEY）' }, 503)
  if (!(await hasMarketAccess(c))) return c.json({ success: false, message: '未授权' }, 401)

  const keyword = String(c.req.query('keyword') || '').trim().slice(0, 200)
  const sourceIds = String(c.req.query('sources') || '').split(',').map((item) => item.trim()).filter(Boolean)
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 30, 1), 100)
  const deep = ['1', 'true', 'yes'].includes(String(c.req.query('deep') || '').toLowerCase())
  const timeRange = String(c.req.query('time_range') || 'day').slice(0, 20)
  try {
    const news = await fetchNewsBundle(c.env, { sources: sourceIds, keyword, limit })
    let search: unknown = null
    let searchWarning = ''
    if (deep && keyword) {
      try {
        search = await searchViaTavily(c.env, { query: keyword, max_results: Math.min(limit, 10), time_range: timeRange })
      } catch (error) {
        searchWarning = error instanceof Error ? error.message : String(error)
      }
    }
    c.header('Cache-Control', 'private, max-age=60')
    return c.json({
      success: true,
      items: news.items,
      search,
      search_warning: searchWarning || undefined,
      search_terms: news.searchTerms,
      source_status: news.sourceStatus,
      sources: FREE_SOURCES.map(({ id, name }) => ({ id, name }))
    })
  } catch (error) {
    return c.json({ success: false, message: error instanceof Error ? error.message : '获取财经新闻失败' }, 502)
  }
})

// ===== 登录/退出 =====
app.get('/admin/login', async (c) => renderLoginPage(c))
app.post('/admin/login', handleLogin)
app.get('/admin/logout', handleLogout)

// ===== MCP 端点（支持 x-api-key / HTTP Basic / Session） =====
app.use('/mcp', mcpAuthMiddleware)
app.post('/mcp', async (c) => {
  const server = createMcpServer(c.env)
  // Stateless 模式：每个请求创建独立 transport（适合 Workers，无会话存储）
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(c.req.raw)
  } catch (error) {
    console.error('MCP 处理失败:', error)
    return c.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP server error' }, id: null }, 500)
  }
})
// GET/DELETE 等其它方法由 transport 内部统一处理(如 SSE 流、会话删除)
app.get('/mcp', async (c) => {
  const server = createMcpServer(c.env)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  try {
    await server.connect(transport)
    return await transport.handleRequest(c.req.raw)
  } catch (error) {
    console.error('MCP GET 处理失败:', error)
    return c.json({ error: 'Internal MCP server error' }, 500)
  }
})

// ===== 管理后台 =====
app.use('/admin/*', adminAuthMiddleware)
app.get('/admin', async (c) => renderAdminPage(c))
app.get('/admin/api/keys', handleGetKeys)
app.post('/admin/api/keys/add', handleAddKey)
app.post('/admin/api/keys/remove', handleRemoveKey)
app.post('/admin/api/keys/toggle', handleToggleKey)
app.post('/admin/api/keys/usage', handleRefreshKeyUsage)
app.post('/admin/api/test-key', handleTestKey)
app.use('/admin/api/tavily', adminAuthMiddleware)
app.get('/admin/api/tavily', handleGetTavilyConfig)
app.post('/admin/api/tavily/save', handleSaveTavilyConfig)
app.post('/admin/api/tavily/test', handleTestTavilyConfig)

// ===== 404 / 错误 =====
app.notFound((c) => c.json({ success: false, message: '接口不存在' }, 404))
app.onError((err, c) => {
  console.error('未捕获的错误:', err)
  return c.json({ success: false, message: '服务器内部错误' }, 500)
})

export default app
