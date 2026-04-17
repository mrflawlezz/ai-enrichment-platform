# Section 5 — Scaling & Trade-offs

## What Breaks at 10x? (1M → 10M leads/month)

### My Assumptions at Baseline (1M leads/month)
- ~33K leads/day, ~1,400/hour, ~23/minute
- Average enrichment: 2s (network + LLM)
- 5 concurrent workers per pod → ~2.5 leads/sec per pod
- 1 pod handles ~150K leads/month comfortably
- 1M/month → needs ~7 pods at moderate load

### What Breaks at 10M

| Component | Baseline (1M/mo) | At 10x (10M/mo) | Breaks? |
|---|---|---|---|
| BullMQ / Redis | Single Redis, fine | 10x more jobs in memory | ⚠️ Redis memory pressure |
| PostgreSQL writes | ~23 INSERTs/minute | ~230 INSERTs/minute | 🟢 Fine with connection pool |
| PostgreSQL reads (GET /jobs) | Low | Low (polling only) | 🟢 Fine |
| LLM API calls | ~33K/day | ~330K/day | 🔴 Cost explosion + rate limits |
| Enrichment API (Clearbit etc) | ~33K/day | ~330K/day | 🔴 Rate limit buckets |
| Worker pods | 7 pods | 70 pods | ⚠️ Orchestration complexity |
| DB connection pool | 20 connections, fine | Multiple pod instances → pool exhaustion | 🔴 Need PgBouncer |

### The Real Bottlenecks

**1. LLM cost** — Most dangerous. 330K LLM calls/day at $0.001/call = $330/day = $10K/month. Need semantic caching and batching ASAP.

**2. DB connection exhaustion** — 70 worker pods × 20 connections = 1,400 connections. PostgreSQL default max is 100. Need **PgBouncer** as connection proxy.

**3. Third-party API rate limits** — Clearbit allows 100 req/min. At 230 leads/min, we'd hit it immediately. Need: per-provider circuit breakers + queue throttling.

**4. Redis memory** — 10M jobs × 1KB each = 10GB Redis RAM. Need Redis Cluster + aggressive job cleanup (`removeOnComplete: { count: 1000 }`).

---

## What I Would Optimize First

### Sprint 1: PgBouncer + Redis Cluster (highest ROI, lowest risk)

**PgBouncer** (transaction mode):
```yaml
# docker-compose addition
pgbouncer:
  image: bitnami/pgbouncer
  environment:
    POSTGRESQL_HOST: postgres
    PGBOUNCER_POOL_MODE: transaction
    PGBOUNCER_MAX_CLIENT_CONN: 1000
    PGBOUNCER_DEFAULT_POOL_SIZE: 25
```

**Measure:** Track `pg_stat_activity` connection count before/after across all worker pods.

**Validate:** The fix is confirmed when:
- `SELECT count(*) FROM pg_stat_activity` stays below 100 (PostgreSQL default max) under 70-pod load
- Zero `connection timeout` errors in the worker error logs for 24h under production load
- Throughput (leads/second) is equal or higher than before — confirming we didn't add latency by going through PgBouncer in transaction mode

**Redis Cluster:** Move from single Redis to 3-node cluster via `ioredis` Cluster client. BullMQ supports Redis Cluster natively.

### Sprint 2: LLM semantic caching

Cache by `(company_domain, enrichment_type)` in Redis with 7-day TTL.

```typescript
const cacheKey = `llm:icp:${extractDomain(email)}`;
const cached = await redis.get(cacheKey);
if (cached) return JSON.parse(cached); // ~60% hit rate for same-company contacts
```

**Measure:** Log a `cache_hit: true/false` flag on every LLM call. Track ratio in your metrics dashboard.

**Validate:** The fix is confirmed when:
- Cache hit rate ≥ 40% within the first week (most batches have clusters of same-company contacts)
- LLM API invoice for the week is ≤ 60% of the previous week's invoice at same lead volume
- p95 enrichment latency for cache hits is < 20ms (vs 1-3s for live calls) — confirms caching doesn't introduce its own latency problem

---

## What I Would NOT Optimize Yet

### 1. Microservices split

At 10M leads/month, the monolith handles it fine. Splitting into separate ingestion-service, worker-service, and api-service adds deployment complexity, network latency between services, and distributed tracing overhead.

**Signal to revisit:** When different parts of the system have conflicting scaling needs AND the team has grown to 5+ engineers.

### 2. Custom LLM fine-tuning

Fine-tuning a model on our enrichment data would improve accuracy. But:
- Costs $10K+ upfront to train
- Requires curated labeled dataset we don't have yet
- Prompt engineering gets you 80% of the way for 1% of the cost

**Signal to revisit:** When we have 6 months of enrichment results and a way to measure quality (customer feedback scores).

### 3. Multi-region deployment

Adding a second AWS region for latency or redundancy. At 10M leads/month with one big customer in the US, the latency difference is irrelevant for async processing.

**Signal to revisit:** When we have paying customers in Europe AND they're complaining about batch completion time OR data residency becomes a compliance requirement.

---

## One Decision I'd Undo

**Storing enrichment results as JSONB in the `leads` table instead of a separate `enrichment_results` table.**

**Why I made it:** Simpler to read — `SELECT leads.enrichment_result FROM leads WHERE id = $1` is one join-free query. Reasonable at MVP.

**Why I'd undo it at 6 months:**
- The `leads` table becomes massive JSONB with varying schemas as we add new providers. Querying becomes slow.
- We can't add indexes on enrichment fields (JSONB requires GIN indexes which are expensive at scale).
- When a provider changes its response format, we have to migrate millions of rows.
- Version tracking becomes hard: "this lead was enriched with Clearbit v1 schema".

**What I'd do instead:**
```sql
CREATE TABLE enrichment_results (
  id              UUID PRIMARY KEY,
  lead_id         UUID REFERENCES leads(id),
  provider        TEXT NOT NULL,         -- 'clearbit', 'openai-gpt4o'
  version         TEXT NOT NULL,         -- '2026-04-17'
  industry        TEXT,                  -- indexable columns
  company_size    TEXT,
  icp_score       INTEGER,
  raw_response    JSONB,                 -- keep raw for reprocessing
  enriched_at     TIMESTAMPTZ
);

CREATE INDEX idx_enrichment_icp_score ON enrichment_results(icp_score DESC);
```

This gives us: per-provider history, indexable fields, clean re-enrichment on provider updates.
