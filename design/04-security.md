# Section 4 — Security & Data Governance

## Row-Level Security (RLS)

### Implementation in PostgreSQL

```sql
-- Enable RLS on all tenant-scoped tables (MANDATORY from day 1)
ALTER TABLE leads     ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Policy: a tenant can only see their own leads
-- app.current_tenant_id is set at the start of every request via SET LOCAL
CREATE POLICY "tenant_isolation_leads"
  ON leads
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY "tenant_isolation_jobs"
  ON jobs
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

**How `app.current_tenant_id` is set:**
```typescript
// In every authenticated request handler, before any DB query:
await client.query(
  `SET LOCAL app.current_tenant_id = '${tenantId}'`
);
// SET LOCAL scopes to the current transaction — auto-cleared at commit/rollback
```

**Why `current_setting` over JWT claims:**
- Works with any auth system (not Supabase-specific)
- Easier to audit — the setting is visible in `pg_stat_activity`
- No dependency on JWT secret rotation to change access patterns

### Failure Modes of RLS

| Failure Mode | How to prevent |
|---|---|
| Developer calls DB without setting `app.current_tenant_id` | Default policy `USING (FALSE)` — rejects all rows if unset |
| Service role bypass (like Supabase admin key) | Never use service role key in the application data path. Only in migrations. |
| `SECURITY DEFINER` functions bypass RLS | Audit all SECURITY DEFINER functions quarterly. Only allow for specific cross-tenant reads like leaderboards. |
| Tenant ID parameter injection | Always use `::uuid` cast — non-UUID strings will throw, not return wrong data |

**Auditing RLS:**
```sql
-- Verify RLS is enabled on all tables
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = FALSE;
-- This should return 0 rows. If not, alert immediately.

-- Test policies with different tenant contexts
SET LOCAL app.current_tenant_id = 'tenant-a-uuid';
SELECT count(*) FROM leads; -- Should only return tenant A's leads
```

---

## Tenant Isolation Beyond RLS

### Database level
- **RLS on all tables** (as above)
- **Schema isolation** (optional for enterprise tenants): each enterprise tenant gets `CREATE SCHEMA tenant_{id}` — harder to misconfigure RLS on a per-schema basis
- **Connection tagging:** All DB connections include `application_name = 'enrichment-api:tenant:{id}'` — visible in `pg_stat_activity` for auditing

### Application level
- **Middleware tenant extraction:** JWT → tenant_id validated against `tenants` table on every request. Fails closed if tenant not found or suspended.
- **Input sanitization:** Tenant ID always validated as UUID before use in any query. No string interpolation — always parameterized queries.

### Queue level (Redis + BullMQ)
- **Namespaced queues:** `{tenant_id}:enrichment` prefix on all BullMQ queue names. A bug in tenant A's worker can't dequeue tenant B's jobs.
- **Per-tenant rate limits:** Redis sorted set sliding window counter: `ZADD ratelimit:{tenant_id} {timestamp} {uuid}` + `ZCOUNT` to check last 60s.

```typescript
async function checkTenantRateLimit(tenantId: string, limit: number): Promise<boolean> {
  const now = Date.now();
  const windowMs = 60_000;
  const key = `ratelimit:${tenantId}:api`;

  const pipeline = redis.pipeline();
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  pipeline.zremrangebyscore(key, 0, now - windowMs);
  pipeline.zcard(key);
  pipeline.expire(key, 120);

  const results = await pipeline.exec();
  const count = results?.[2]?.[1] as number;
  return count <= limit;
}
```

---

## API Key Management

### Storage
- Third-party API keys (OpenAI, Clearbit, Apollo) encrypted at rest with **AES-256-GCM** before storing in `tenants.llm_api_key` column
- Master encryption key stored in **AWS Secrets Manager** (or HashiCorp Vault)
- Application fetches the master key once at startup, caches in memory — never written to disk

```typescript
// Never this:
const apiKey = process.env.OPENAI_API_KEY; // Platform-wide, no per-tenant control

// Instead:
const encryptedKey = tenant.llm_api_key;
const apiKey = decrypt(encryptedKey, masterKey); // Per-tenant, rotatable
```

### Rotation
1. Generate new key from provider
2. Update `tenants.llm_api_key` with newly encrypted value
3. Old key remains valid for 24h (provider grace period)
4. After 24h, revoke old key at provider

### Leaked key detection
- Monitor provider dashboards for unusual usage spikes (via their usage APIs)
- Set spending alerts at 2x normal daily usage → auto-suspend the tenant's key + alert ops
- If confirmed leak: `UPDATE tenants SET suspended = TRUE WHERE id = $1` — immediately stops all processing for that tenant

---

## Audit Logging

### Events to log

```typescript
type AuditEvent =
  | 'job.created'
  | 'job.completed'
  | 'lead.enriched'
  | 'lead.failed'
  | 'tenant.api_key_rotated'
  | 'tenant.suspended'
  | 'data.exported'
  | 'data.deleted'
  | 'user.login'
  | 'user.permission_changed'
  | 'admin.rls_bypassed';   // Any service-role usage
```

### Audit log schema (SOC 2 ready)

```sql
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL,
  actor_id    UUID,                    -- user or service account
  actor_type  TEXT NOT NULL,           -- 'user' | 'service' | 'cron'
  event       TEXT NOT NULL,
  resource    TEXT NOT NULL,           -- 'job' | 'lead' | 'tenant'
  resource_id UUID,
  metadata    JSONB,                   -- event-specific context
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only: no UPDATE, no DELETE in application code (enforced by RLS)
CREATE POLICY "audit_log_append_only"
  ON audit_log
  FOR INSERT
  USING (true);  -- Allow inserts

-- REVOKE DELETE privilege from application role
REVOKE DELETE ON audit_log FROM enrichment_app_role;
REVOKE UPDATE ON audit_log FROM enrichment_app_role;
```

### Tamper-resistance
- Application role has INSERT-only on `audit_log` — updates and deletes are revoked at the DB level
- Daily audit log export to **immutable S3 bucket** (Object Lock enabled, 7-year retention for SOC 2)
- Log hash chain: each row stores `sha256(previous_row_hash || current_row_data)` — any tampering breaks the chain
