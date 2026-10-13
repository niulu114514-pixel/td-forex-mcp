import type { Context } from 'hono'
import type { Env } from './types'
import { getKeys, addKey, removeKey, toggleKey, refreshKeyUsage } from './storage'
import { maskKey, testKey } from './twelve'
import { getTavilyConfig, setTavilyConfig, searchViaTavily } from './news'

export async function handleGetKeys(c: Context<{ Bindings: Env }>) {
  const keys = await getKeys(c.env)
  return c.json({ success: true, data: keyView(keys) })
}

function keyView(keys: Awaited<ReturnType<typeof getKeys>>) {
  return keys.map((k) => ({
    key: maskKey(k.key),
    full: k.key,
    enabled: k.enabled,
    note: k.note || null,
    addedAt: k.addedAt,
    usage: k.usage || null,
    usageError: k.usageError || null,
    usageCheckedAt: k.usageCheckedAt || null,
  }))
}

export async function handleRefreshKeyUsage(c: Context<{ Bindings: Env }>) {
  const body: unknown = await c.req.json().catch(() => ({}))
  const rawKey = body && typeof body === 'object' ? (body as { key?: unknown }).key : undefined
  const requestedKey = typeof rawKey === 'string' ? rawKey.trim() : undefined
  const result = await refreshKeyUsage(c.env, requestedKey)
  if (!result.found) return c.json({ success: false, message: '未找到指定的 Key' }, 404)
  return c.json({ success: true, data: keyView(result.keys), summary: result.summary })
}

export async function handleAddKey(c: Context<{ Bindings: Env }>) {
  const body: any = await c.req.json().catch(() => ({}))
  const added = await addKey(c.env, String(body.key || ''), body.note)
  if (!added) return c.json({ success: false, message: 'key 不能为空' }, 400)
  return c.json({ success: true, data: { key: maskKey(added.key), enabled: added.enabled } })
}

export async function handleRemoveKey(c: Context<{ Bindings: Env }>) {
  const body: any = await c.req.json().catch(() => ({}))
  const ok = await removeKey(c.env, String(body.key || ''))
  if (!ok) return c.json({ success: false, message: '未找到该 key' }, 404)
  return c.json({ success: true })
}

export async function handleToggleKey(c: Context<{ Bindings: Env }>) {
  const body: any = await c.req.json().catch(() => ({}))
  const upd = await toggleKey(c.env, String(body.key || ''), !!body.enabled)
  if (!upd) return c.json({ success: false, message: '未找到该 key' }, 404)
  return c.json({ success: true, data: { key: maskKey(upd.key), enabled: upd.enabled } })
}

export async function handleTestKey(c: Context<{ Bindings: Env }>) {
  const body: any = await c.req.json().catch(() => ({}))
  const key = String(body.key || '')
  if (!key) return c.json({ success: false, message: 'key 不能为空' }, 400)
  const r = await testKey(c.env, key)
  if (!r.ok) return c.json({ success: false, message: r.message }, 400)
  return c.json({ success: true, message: r.message })
}

// ===== Tavily Proxy 配置管理 =====

export async function handleGetTavilyConfig(c: Context<{ Bindings: Env }>) {
  const cfg = await getTavilyConfig(c.env)
  return c.json({ success: true, data: cfg })
}

export async function handleSaveTavilyConfig(c: Context<{ Bindings: Env }>) {
  const body: any = await c.req.json().catch(() => ({}))
  const url = String(body.url || '').trim()
  const authKey = String(body.authKey || '').trim()
  await setTavilyConfig(c.env, { url: url || undefined, authKey: authKey || undefined })
  return c.json({ success: true, data: { configured: !!(url && authKey) } })
}

export async function handleTestTavilyConfig(c: Context<{ Bindings: Env }>) {
  const body: any = await c.req.json().catch(() => ({}))
  // 若本次未传，则用已保存配置测试
  if (body.url || body.authKey) {
    await setTavilyConfig(c.env, { url: String(body.url || '').trim() || undefined, authKey: String(body.authKey || '').trim() || undefined })
  }
  try {
    const r = await searchViaTavily(c.env, { query: 'finance', max_results: 1, time_range: 'day' })
    return c.json({ success: true, message: 'tavily-proxy 连接正常', data: r })
  } catch (e: any) {
    return c.json({ success: false, message: e?.message || String(e) }, 400)
  }
}
