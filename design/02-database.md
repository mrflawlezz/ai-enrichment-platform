# Section 2 — Database Design

## Schema Overview

The database uses two core tables: `jobs` (batch-level) and `leads` (per-lead results). In a full multi-tenant deployment, a `tenants` table and an `audit_log` table complete the schema.

---

## Full Schema

```sql
-- ─── Extension ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ─── JOBS ────────────────────────────────────────────────────────────────────
-- One row per enrichment batch submitted via POST /jobs
CREATE TABLE jobs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID,                                           -- NULL in dev/single-tenant
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','complete','failed')),
  total_leads     INTEGER     NOT NULL DEFAULT 0,
  completed_leads INTEGER     NOT NULL DEFAULT 0,
  failed_leads    INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── LEADS ───────────────────────────────────────────────────────────────────
-- One row per lead in a batch
CREATE TABLE leads (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  email             TEXT        NOT NULL,
  company           TEXT        NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','complete','failed')),
  enrichment_result JSONB,                          -- populated on success
  attempt_count     INTEGER     NOT NULL DEFAULT 0, -- incremented on each retry
  error_message     TEXT,                           -- populated on permanent failure
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── TRIGGER: auto-update updated_at ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── INDEXES ─────────────────────────────────────────────────────────────────
-- Fast job lookups by tenant (for multi-tenant pagination)
CREATE INDEX idx_jobs_tenant_created   ON jobs(tenant_id, created_at DESC);

-- Fast lead lookups within a job (most common query pattern)
CREATE INDEX idx_leads_job_id          ON leads(job_id);

-- Fast filtering by status (for dashboard queries)
CREATE INDEX idx_leads_job_status      ON leads(job_id, status);

-- Fast lookup of failed leads (for retry dashboards)
CREATE INDEX idx_leads_failed          ON leads(status) WHERE status = 'failed';
```

---

## `enrichment_result` JSONB Schema

When a lead is successfully enriched, the result is stored as JSONB:

```json
{
  "industry":     "SaaS",
  "company_size": "51-200",
  "icp_score":    87,
  "linkedin_url": "https://linkedin.com/company/acme-corp",
  "enriched_at":  "2026-04-17T10:00:00.000Z",
  "provider":     "mock"
}
```

**Why JSONB over separate columns?**
- The enrichment schema evolves — adding a new field (e.g., `tech_stack`, `funding_stage`) requires no migration
- Querying specific fields is still fast: `enrichment_result->>'icp_score'` uses GIN index
- Allows different providers to return different fields without nullable columns
- `CHECK` constraints on status + NOT NULL on critical fields keeps data quality without over-normalizing

**For high-priority ICP score queries:**
```sql
-- Create a GIN index for fast JSONB field lookups
CREATE INDEX idx_leads_enrichment_gin ON leads USING gin(enrichment_result);

-- Or a functional index on icp_score specifically
CREATE INDEX idx_leads_icp_score
  ON leads((enrichment_result->>'icp_score')::integer)
  WHERE status = 'complete';
```

---

## Concurrency: Atomic Job Finalization

The most critical query is finalizing a job when the last lead completes. This runs inside a transaction to prevent race conditions between concurrent workers:

```sql
-- Atomically increment counter AND check if all leads are done
-- Returns the updated job row only if THIS call completed the batch
WITH updated AS (
  UPDATE jobs
  SET completed_leads = completed_leads + 1,
      status = CASE
        WHEN (completed_leads + 1 + failed_leads) >= total_leads THEN 'complete'
        ELSE 'processing'
      END,
      updated_at = NOW()
  WHERE id = $1
  RETURNING *
)
SELECT * FROM updated
WHERE status IN ('complete', 'failed');
```

**Why this is safe:**
- `UPDATE ... RETURNING` is atomic in PostgreSQL — two concurrent workers cannot both see the row as "now complete"
- Only the worker whose `UPDATE` flips the status to terminal gets a row back → only that worker publishes `job_complete`
- No application-level locking needed

---

## Multi-Tenant Extension

In a production multi-tenant deployment, two additional tables are needed:

```sql
-- ─── TENANTS ─────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  plan            TEXT        NOT NULL DEFAULT 'starter'
                  CHECK (plan IN ('starter', 'growth', 'enterprise')),
  suspended       BOOLEAN     NOT NULL DEFAULT FALSE,
  llm_api_key     TEXT,                  -- AES-256-GCM encrypted
  monthly_budget_usd NUMERIC(10,2),      -- cost cap per month
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── AUDIT LOG ───────────────────────────────────────────────────────────────
-- Append-only — no UPDATE, no DELETE (enforced by REVOKE at DB level)
CREATE TABLE audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,
  actor_id    UUID,
  actor_type  TEXT        NOT NULL CHECK (actor_type IN ('user','service','cron')),
  event       TEXT        NOT NULL,   -- 'job.created', 'lead.enriched', etc.
  resource    TEXT        NOT NULL,
  resource_id UUID,
  metadata    JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent any modifications
REVOKE UPDATE ON audit_log FROM enrichment_app_role;
REVOKE DELETE ON audit_log FROM enrichment_app_role;
```

### Row-Level Security (RLS)

```sql
ALTER TABLE jobs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- Default deny (protect against unset context)
CREATE POLICY "default_deny_jobs"  ON jobs  FOR ALL USING (FALSE);
CREATE POLICY "default_deny_leads" ON leads FOR ALL USING (FALSE);

-- Tenant isolation policy (applied when app.current_tenant_id is set)
CREATE POLICY "tenant_isolation_jobs" ON jobs
  FOR ALL USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY "tenant_isolation_leads" ON leads
  FOR ALL USING (job_id IN (
    SELECT id FROM jobs WHERE tenant_id = current_setting('app.current_tenant_id', true)::uuid
  ));
```

The application sets `app.current_tenant_id` at the start of every authenticated request:
```typescript
await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
// SET LOCAL scopes to current transaction — auto-cleared at commit/rollback
```

---

## Scalability Considerations

| Scale | Strategy |
|---|---|
| **0–1M leads/month** | Single PostgreSQL instance, JSONB + GIN index |
| **1–10M leads/month** | Read replica for GET /jobs/:id polling; write to primary |
| **10M+ leads/month** | Partition `leads` by `created_at` (monthly); archive completed partitions to cold storage |
| **100M+ leads/month** | Shard by `tenant_id` hash; consider ClickHouse for analytics queries |

**Partition example for high-scale:**
```sql
-- Partition leads by month for easy archival
CREATE TABLE leads_2026_04 PARTITION OF leads
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
```
