/**
 * D1-backed key-value store that mirrors the previous Cloudflare KV semantics.
 *
 * All KV keys are kept verbatim in a single `kv` table so migrating from the
 * old KV namespace is lossless. Replacing the KV binding with D1 removes the
 * KV per-operation free-plan count from the request hot path.
 */
import type { Env } from './types'

export async function kvGet(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT v FROM kv WHERE k = ?1 AND (expires_at IS NULL OR expires_at > ?2)'
  )
    .bind(key, Date.now())
    .first<{ v: string }>()
  return row ? row.v : null
}

export async function kvPut(
  env: Env,
  key: string,
  value: string,
  ttlSecs?: number
): Promise<void> {
  const expiresAt = typeof ttlSecs === 'number' && ttlSecs > 0 ? Date.now() + ttlSecs * 1000 : null
  await env.DB.prepare(
    'INSERT INTO kv (k, v, expires_at) VALUES (?1, ?2, ?3) ' +
      'ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at'
  )
    .bind(key, value, expiresAt)
    .run()
}

export async function kvDelete(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM kv WHERE k = ?1').bind(key).run()
}