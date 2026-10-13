-- TD Forex MCP storage, migrated from Cloudflare KV to D1.
-- A single key-value table mirrors the previous KV semantics so all existing
-- keys (td_keys, td_health, tdf_cache_*, tdf_session_*, tdf_tavily, news cache)
-- move over losslessly. This removes the KV free-plan operation quotas from the
-- request hot path (health map is read/written on every quote/finance call).

CREATE TABLE IF NOT EXISTS kv (
  k          TEXT    NOT NULL PRIMARY KEY,
  v          TEXT    NOT NULL,
  expires_at INTEGER              -- millisecond epoch; NULL = never expires
);

CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv (expires_at);