import { KV_KEYS } from './config'
import type { Env, Session, TwelveDataKey } from './types'
import { kvGet, kvPut, kvDelete } from './store'
import { fetchKeyUsage } from './twelve-usage'

function maskUsageKey(key: string): string {
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

export interface UsageRefreshResult {
  mask: string
  ok: boolean
  error?: string
}

export interface UsageRefreshSummary {
  attempted: number
  succeeded: number
  failed: number
  results: UsageRefreshResult[]
}

// ===== Twelve Data Key 管理（D1 持久化，替代原 KV） =====

export async function getKeys(env: Env): Promise<TwelveDataKey[]> {
  const data = await kvGet(env, KV_KEYS.KEYS)
  return data ? JSON.parse(data) : []
}

export async function setKeys(env: Env, keys: TwelveDataKey[]): Promise<void> {
  await kvPut(env, KV_KEYS.KEYS, JSON.stringify(keys))
}

/** 首次运行从 Worker Secret 导入 Key；源码中不保存第三方凭据。 */
export async function seedKeys(env: Env): Promise<void> {
  const existing = await kvGet(env, KV_KEYS.KEYS)
  if (existing) return
  const seedKeys = Array.from(new Set(
    String(env.TWELVE_DATA_KEYS || '')
      .split(/[,\n\r]+/)
      .map((key) => key.trim())
      .filter(Boolean)
  ))
  if (seedKeys.length === 0) return
  const now = new Date().toISOString()
  const seeded: TwelveDataKey[] = seedKeys.map((k) => ({
    key: k,
    enabled: true,
    addedAt: now,
  }))
  await setKeys(env, seeded)
}

export async function addKey(env: Env, key: string, note?: string): Promise<TwelveDataKey | null> {
  const clean = key.trim()
  if (!clean) return null
  const keys = await getKeys(env)
  if (keys.some((k) => k.key === clean)) return keys.find((k) => k.key === clean) ?? null
  const entry: TwelveDataKey = {
    key: clean,
    enabled: true,
    note: note?.trim() || undefined,
    addedAt: new Date().toISOString(),
  }
  keys.push(entry)
  await setKeys(env, keys)
  return entry
}

export async function removeKey(env: Env, key: string): Promise<boolean> {
  const keys = await getKeys(env)
  const filtered = keys.filter((k) => k.key !== key.trim())
  if (filtered.length === keys.length) return false
  await setKeys(env, filtered)
  return true
}

export async function toggleKey(env: Env, key: string, enabled: boolean): Promise<TwelveDataKey | null> {
  const keys = await getKeys(env)
  const idx = keys.findIndex((k) => k.key === key)
  if (idx === -1) return null
  keys[idx].enabled = enabled
  await setKeys(env, keys)
  return keys[idx]
}

// ===== Session 管理 =====

export async function createSession(env: Env, username: string, ttlSeconds: number): Promise<string> {
  const sessionId = crypto.randomUUID()
  const session: Session = {
    username,
    expiresAt: Date.now() + ttlSeconds * 1000,
  }
  await kvPut(env, KV_KEYS.SESSION_PREFIX + sessionId, JSON.stringify(session), ttlSeconds)
  return sessionId
}

export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  const data = await kvGet(env, KV_KEYS.SESSION_PREFIX + sessionId)
  if (!data) return null
  const session: Session = JSON.parse(data)
  if (session.expiresAt < Date.now()) {
    await deleteSession(env, sessionId)
    return null
  }
  return session
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await kvDelete(env, KV_KEYS.SESSION_PREFIX + sessionId)
}

/**
 * Refresh one key or the entire pool. Results are fetched in small batches and
 * persisted once, so a single bad key cannot abort the batch or erase the last
 * successful balance for that key.
 */
export async function refreshKeyUsage(
  env: Env,
  requestedKey?: string,
): Promise<{ found: boolean; keys: TwelveDataKey[]; summary: UsageRefreshSummary }> {
  const keys = await getKeys(env)
  const clean = requestedKey?.trim()
  const selected = clean ? keys.filter((entry) => entry.key === clean) : keys
  if (clean && selected.length === 0) {
    return { found: false, keys, summary: { attempted: 0, succeeded: 0, failed: 0, results: [] } }
  }

  const results: UsageRefreshResult[] = []
  const checkedAt = new Date().toISOString()
  for (let index = 0; index < selected.length; index += 4) {
    const batch = selected.slice(index, index + 4)
    const settled = await Promise.all(batch.map(async (entry) => {
      try {
        const usage = await fetchKeyUsage(entry.key)
        entry.usage = usage
        entry.usageCheckedAt = usage.syncedAt
        delete entry.usageError
        return { mask: maskUsageKey(entry.key), ok: true } satisfies UsageRefreshResult
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
        entry.usageCheckedAt = checkedAt
        entry.usageError = message
        return { mask: maskUsageKey(entry.key), ok: false, error: message } satisfies UsageRefreshResult
      }
    }))
    results.push(...settled)
  }

  if (selected.length > 0) await setKeys(env, keys)
  const succeeded = results.filter((result) => result.ok).length
  return {
    found: true,
    keys,
    summary: { attempted: results.length, succeeded, failed: results.length - succeeded, results },
  }
}
