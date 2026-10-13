import type { Context, Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createSession, getSession, deleteSession } from './storage'
import { SESSION_TTL } from './config'
import type { Env } from './types'

export async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 固定长度摘要比较，避免直接字符串比较泄露凭据匹配时序。 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([hashPassword(a), hashPassword(b)])
  let diff = 0
  for (let index = 0; index < left.length; index++) diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

async function validBasicCredentials(c: Context<{ Bindings: Env }>, user: string, pass: string): Promise<boolean> {
  if (!c.env.ADMIN_USERNAME || !c.env.ADMIN_PASSWORD) return false
  const [userOk, passOk] = await Promise.all([
    safeEqual(user, c.env.ADMIN_USERNAME),
    safeEqual(pass, c.env.ADMIN_PASSWORD),
  ])
  return userOk && passOk
}

/** 管理后台鉴权：Session cookie 或 HTTP Basic（用于 /mcp 与 /admin/api/*） */
export async function adminAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, 'session_id')
  const url = new URL(c.req.url)

  if (url.pathname === '/admin/login') return next()

  if (!sessionId) {
    const auth = c.req.header('authorization') || ''
    const basicMatch = auth.match(/^Basic\s+([A-Za-z0-9+/=]+)$/)
    if (basicMatch) {
      try {
        const decoded = atob(basicMatch[1])
        const idx = decoded.indexOf(':')
        if (idx >= 0) {
          const user = decoded.slice(0, idx)
          const pass = decoded.slice(idx + 1)
          if (await validBasicCredentials(c, user, pass)) {
            ;(c as any).set('username', user)
            return next()
          }
        }
      } catch {
        /* fallthrough */
      }
    }
  }

  if (!sessionId) {
    if (url.pathname.startsWith('/admin/api/') || url.pathname === '/mcp') {
      return c.json({ success: false, message: '未登录或无效鉴权' }, 401)
    }
    return c.redirect('/admin/login')
  }

  const session = await getSession(c.env, sessionId)
  if (!session) {
    deleteCookie(c, 'session_id')
    if (url.pathname.startsWith('/admin/api/') || url.pathname === '/mcp') {
      return c.json({ success: false, message: 'Session 已过期' }, 401)
    }
    return c.redirect('/admin/login')
  }

  ;(c as any).set('username', session.username)
  return next()
}

/** MCP 端点鉴权：支持 x-api-key、HTTP Basic 或已登录的 Session。 */
export async function mcpAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  // 1) x-api-key（与行情/新闻 REST API 共用，适合服务间调用）
  const apiKey = c.req.header('x-api-key') || ''
  if (apiKey && c.env.MARKET_API_KEY && await safeEqual(apiKey, c.env.MARKET_API_KEY)) {
    return next()
  }
  // 2) HTTP Basic
  const auth = c.req.header('authorization') || ''
  const basicMatch = auth.match(/^Basic\s+([A-Za-z0-9+/=]+)$/)
  if (basicMatch) {
    try {
      const decoded = atob(basicMatch[1])
      const idx = decoded.indexOf(':')
      if (idx >= 0) {
        const user = decoded.slice(0, idx)
        const pass = decoded.slice(idx + 1)
        if (await validBasicCredentials(c, user, pass)) {
          ;(c as any).set('username', user)
          return next()
        }
      }
    } catch {
      /* fallthrough */
    }
  }
  // 3) Session cookie
  const sessionId = getCookie(c, 'session_id')
  if (sessionId) {
    const session = await getSession(c.env, sessionId)
    if (session) {
      ;(c as any).set('username', session.username)
      return next()
    }
  }
  return c.json({ error: 'Unauthorized: invalid or missing authentication' }, 401)
}

export async function handleLogin(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => null)
  if (!body) return c.json({ success: false, message: '请求格式无效' }, 400)
  const username = typeof body.username === 'string' ? body.username : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!c.env.ADMIN_USERNAME || !c.env.ADMIN_PASSWORD) {
    return c.json({ success: false, message: '未配置管理员账号' }, 500)
  }
  const [userOk, passOk] = await Promise.all([
    safeEqual(username, c.env.ADMIN_USERNAME),
    safeEqual(password, c.env.ADMIN_PASSWORD),
  ])
  if (!userOk || !passOk) {
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }
  const sessionId = await createSession(c.env, username, SESSION_TTL)
  setCookie(c, 'session_id', sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL,
  })
  return c.json({ success: true, message: '登录成功' })
}

export async function handleLogout(c: Context<{ Bindings: Env }>) {
  const sessionId = getCookie(c, 'session_id')
  if (sessionId) await deleteSession(c.env, sessionId)
  deleteCookie(c, 'session_id')
  return c.redirect('/admin/login')
}
