# Section 1 — System Design: Multi-Tenant AI Enrichment Platform

## Architecture Overview

```
                         ┌─────────────────────────────────────────────────────────┐
                         │                    INGESTION LAYER                       │
                         │                                                           │
  CSV Upload ───────────▶│  POST /jobs (JSON)                                       │
  API Payload ──────────▶│  POST /ingest/csv (multipart)                           │
  Webhook ──────────────▶│  POST /webhooks/inbound                                  │
                         │                                                           │
                         │  ① Validate schema (Zod)                                 │
                         │  ② Deduplicate by email + company within batch           │
                         │  ③ Create job record in PostgreSQL                       │
                         │  ④ Bulk-insert leads                                     │
                         │  ⑤ Return job_id immediately (202 Accepted)              │
                         └──────────────────────┬──────────────────────────────────┘
                                                │ enqueue (BullMQ)
                                                ▼
                         ┌─────────────────────────────────────────────────────────┐
                         │                       QUEUE LAYER                        │
                         │                  Redis + BullMQ v5                       │
                         │                                                           │
                         │  • Per-tenant priority queues                            │
                         │  • Each lead = individual job (not whole batch)          │
                         │  • 3 retries with exponential backoff (1s→2s→4s)        │
                         │  • Dead Letter Queue for permanently failed leads        │
                         │  • Idempotency keys prevent double-processing            │
                         └──────────────────────┬──────────────────────────────────┘
                                                │ dequeue
                                                ▼
                         ┌─────────────────────────────────────────────────────────┐
                         │                    WORKER POOL                           │
                         │             Node.js BullMQ Workers                       │
                         │                                                           │
                         │  ┌──────────────────────────────────────────────┐       │
                         │  │ Enrichment Worker (concurrency: 5-20 per pod)│       │
                         │  │                                              │       │
                         │  │  ① Fetch lead from DB                       │       │
                         │  │  ② Call enrichment provider chain:           │       │
                         │  │     Clearbit → Apollo → LinkedIn fallback   │       │
                         │  │  ③ Call LLM (ICP scoring, classification)   │       │
                         │  │  ④ Validate + persist result to PostgreSQL  │       │
                         │  │  ⑤ Update job completion counters           │       │
                         │  └──────────────────────────────────────────────┘       │
                         └──────────────────────┬──────────────────────────────────┘
                                                │ reads/writes
                                                ▼
                         ┌─────────────────────────────────────────────────────────┐
                         │                   STORAGE LAYER                          │
                         │                                                           │
                         │  PostgreSQL 16                                           │
                         │  ├── jobs         (batch-level status + counters)        │
                         │  ├── leads        (per-lead results + enrichment JSONB)  │
                         │  ├── tenants      (tenant config, API keys encrypted)    │
                         │  └── audit_log    (immutable event trail)                │
                         │                                                           │
                         │  Redis                                                   │
                         │  ├── BullMQ queues (namespaced per tenant)              │
                         │  └── Rate limit counters (sliding window)               │
                         └──────────────────────┬──────────────────────────────────┘
                                                │
                                                ▼
                         ┌─────────────────────────────────────────────────────────┐
                         │                    API LAYER                             │
                         │              Express.js REST API                         │
                         │                                                           │
                         │  GET  /jobs/:id       ← Poll status + results            │
                         │  GET  /jobs           ← List jobs for tenant             │
                         │  POST /jobs           ← Submit new batch                 │
                         │  GET  /health         ← Liveness probe                  │
                         │                                                           │
                         │  + Outbound webhooks (notify tenants on completion)      │
                         └─────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. Per-lead job granularity (not per-batch)

**Why:** A batch of 100K leads with one bad email shouldn't fail the entire job. Each lead as an individual BullMQ job means:
- Independent retry per lead
- Failed leads don't block the batch
- Workers can process leads in parallel across pods

**Trade-off:** More Redis memory usage. Acceptable — 100K jobs at ~1KB each = 100MB, well within Redis capacity.

### 2. Priority queues per tenant

**Why:** A tenant submitting 1M leads shouldn't starve another tenant's 10-lead batch. We use BullMQ priority queues:
- Tenants on higher plans get higher queue priority
- Fair-scheduling prevents starvation

**Implementation:**
```typescript
// Priority: lower number = higher priority in BullMQ
const priority = tenant.plan === 'enterprise' ? 1 : tenant.plan === 'growth' ? 5 : 10;
await enrichmentQueue.add('enrich-lead', data, { priority });
```

### 3. Enrichment provider chain with graceful degradation

**Why:** Third-party APIs are unreliable. If Clearbit returns 429, we don't fail the lead — we fall back.

```
Clearbit (full profile) → Apollo (basic contact) → LinkedIn scrape → Fail with partial data
```

Circuit breaker (via `opossum`) wraps each provider call. If error rate > 50% in 30s, the circuit opens and we skip that provider entirely for 60s.

### 4. Cost controls for LLM calls

**Problem:** Processing 10M leads/month means 10M LLM calls if naive. At $0.01/call = $100K/month.

**Solutions:**
- **Semantic caching:** Cache LLM responses by `(company_type + industry + size_range)` in Redis. ~60% cache hit rate for similar companies.
- **Batching:** Group leads by company → one LLM call for the company, applied to all contacts there.
- **Tiered LLM:** Use `gpt-5.4-mini` for ICP scoring (economy tier — cheap, fast), `claude-haiku-4-5` for structured extraction (standard), `mistral-large-3` via Groq or `claude-opus-4-6` only for enterprise-level persona analysis (premium — triggered on high ICP score).

### 5. Failure classification

| Error type | Action |
|---|---|
| Network timeout (3s) | Retry (transient) |
| HTTP 429 Rate limit | Retry with delay (transient) |
| HTTP 503 Service unavailable | Retry (transient) |
| HTTP 400 Invalid data | Mark failed immediately (permanent) |
| HTTP 401 Auth error | Alert ops, fail batch (permanent) |
| Malformed LLM response | Retry once, then fail with fallback |

### 6. Data quality handling

Inconsistent/missing input is expected. Strategy:
- **Missing email:** Reject at ingestion (required field)
- **Malformed email:** Normalize with `validator.js`, reject if unparseable
- **Duplicate leads within batch:** Deduplicate by `email.toLowerCase()` + `company.toLowerCase()` at ingestion
- **Duplicate across batches:** `UNIQUE(email, tenant_id)` in PostgreSQL + `ON CONFLICT DO UPDATE`
- **Missing company:** Accept but skip LLM company enrichment, mark field as `null`

### 7. Sync vs. Async Enrichment — When Does Each Make Sense?

**Async (this implementation) — the right default:**
Almost everything. Any batch > 1 lead, any enrichment that calls external APIs, any LLM call. Reasons:
- External API calls average 200-800ms each. Holding an HTTP connection open for 100K leads is not viable.
- A single provider timeout at 15s kills the entire request if sync.
- Async decouples submission throughput from processing capacity — a tenant can submit 100K leads in 2s, processing happens at whatever rate the workers can sustain.

**Sync — only one case justifies it:**
Real-time single-lead lookup via a dedicated `/enrich/single` endpoint, where:
- The caller is an interactive UI waiting < 2s for a result (e.g., a sales rep looking up a contact just added to CRM)
- The lead count is exactly 1
- We can set a hard 2s timeout and return a 202 + job_id if we exceed it (graceful degradation to async)

**Rule of thumb:** Never use sync for batches. A timeout in a sync batch doesn't just fail one lead — it fails the entire HTTP request and the caller has no job_id to poll. Async-first, sync only as a deliberate UX decision for single-lead interactive flows.

---

## Handling Large Batches (100K+ leads)

**Problem:** A single 100K-lead CSV shouldn't hold up the HTTP request.

**Flow:**
1. CSV upload → stream-parsed (no full memory load) via `csv-parser`
2. Leads bulk-inserted in chunks of 1,000 per SQL statement
3. BullMQ jobs enqueued in batches of 500 via `addBulk`
4. HTTP returns `job_id` after insert, before workers start

**Memory cost:** O(chunk size), not O(batch size).

---

## Observability

**Metrics to instrument from day 1:**
- `queue.depth` per tenant (alert if > 50K)
- `enrichment.latency.p95` per provider
- `enrichment.error_rate` per provider
- `job.completion_time` (from created_at to last lead terminal state)
- `llm.cost_per_lead` (tokens × price)

**Alerting thresholds:**
- Queue depth > 100K for > 5 min → PagerDuty
- Error rate > 30% on any provider → Circuit breaker fires
- p99 enrichment latency > 10s → Investigate

**Log structure (every event):**
```json
{
  "level": "error",
  "message": "Enrichment permanently failed",
  "timestamp": "2026-04-17T00:00:00Z",
  "tenant_id": "ten_abc123",
  "job_id": "uuid",
  "lead_id": "uuid",
  "email": "user@company.com",
  "attempts": 3,
  "error_code": "PROVIDER_TIMEOUT",
  "provider": "clearbit"
}
```
