# AI Enrichment Platform

**Multi-tenant async lead enrichment pipeline** — StaffBridge Technical Assessment

**Stack:** Node.js · TypeScript · BullMQ · Redis · PostgreSQL · Docker

---

## Quick Start

### Option A — Docker (recommended)

```bash
# Start all services (PostgreSQL + Redis + App)
docker-compose up --build

# The app will be available at http://localhost:3000
```

The SQL migration (`001_init.sql`) runs automatically on first PostgreSQL startup via the `docker-entrypoint-initdb.d` mount.

### Option B — Local dev (requires PostgreSQL + Redis running locally)

```bash
npm install

# Copy env template and fill in your DB/Redis URLs
cp .env.example .env

# Start dev server with hot reload
npm run dev
```

---

## API Reference

### POST /jobs — Submit a batch of leads

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "leads": [
      { "name": "Maria Lopez", "email": "maria@acmecorp.com", "company": "Acme Corp" },
      { "name": "John Doe",   "email": "john@techco.io",    "company": "TechCo" },
      { "name": "Ana Torres", "email": "ana@startup.co",    "company": "Startup" }
    ]
  }'
```

**Response (202 Accepted):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Job created and queued for enrichment",
  "total_leads": 3
}
```

Returns immediately — processing is async.

### GET /jobs/:id — Check job status and results

```bash
curl http://localhost:3000/jobs/550e8400-e29b-41d4-a716-446655440000
```

**Response (200 OK):**
```json
{
  "job": {
    "id": "550e8400...",
    "status": "complete",
    "total_leads": 3,
    "completed_leads": 2,
    "failed_leads": 1,
    "created_at": "2026-04-17T00:00:00Z",
    "updated_at": "2026-04-17T00:00:05Z"
  },
  "leads": [
    {
      "id": "...",
      "job_id": "...",
      "name": "Maria Lopez",
      "email": "maria@acmecorp.com",
      "company": "Acme Corp",
      "status": "complete",
      "enrichment_result": {
        "industry": "SaaS",
        "company_size": "51-200",
        "icp_score": 87,
        "linkedin_url": "https://linkedin.com/company/acme-corp",
        "enriched_at": "2026-04-17T00:00:02Z",
        "provider": "mock"
      },
      "attempt_count": 1,
      "error_message": null
    }
  ]
}
```

**Job status values:** `pending` → `processing` → `complete` | `failed`  
**Lead status values:** `pending` → `processing` → `complete` | `failed`

### GET /health — Health check

```bash
curl http://localhost:3000/health
# → { "status": "ok", "timestamp": "..." }
```

---

## Architecture

```
POST /jobs
    │
    ▼
┌─────────────────────────────────────────┐
│  Express Router (HTTP layer)            │
│  - Input validation (Zod)               │
│  - Returns 202 Accepted immediately     │
└─────────────────┬───────────────────────┘
                  │ calls
                  ▼
┌─────────────────────────────────────────┐
│  Job Service (business logic)           │
│  - Create job record in PostgreSQL      │
│  - Bulk-insert all leads                │
│  - Enqueue each lead individually       │
└──────────┬──────────────────────────────┘
           │                    │
           ▼                    ▼
┌──────────────┐    ┌──────────────────────┐
│  PostgreSQL  │    │  Redis + BullMQ      │
│  jobs table  │    │  enrichment queue    │
│  leads table │    │  (per-lead jobs)     │
└──────────────┘    └──────────┬───────────┘
                               │ dequeues
                               ▼
                   ┌──────────────────────────────┐
                   │  BullMQ Worker               │
                   │  - 5 concurrent processors   │
                   │  - Calls mock enrichment API │
                   │  - 3 retries (exp backoff)   │
                   │  - Updates lead status in PG │
                   │  - Finalizes job when done   │
                   └──────────────────────────────┘
```

### Key Design Decisions

**1. Per-lead jobs (not per-batch)**  
Each lead is its own BullMQ job. This means one bad lead (permanent failure) never blocks the other 99,999 leads in the batch. The job completes as soon as all leads reach a terminal state.

**2. Idempotency via jobId**  
BullMQ jobs use `jobId: lead:{lead_id}` as an idempotency key. If the same webhook fires twice, BullMQ deduplicates it — no double processing.

**3. Exponential backoff (3 attempts: 1s → 2s → 4s)**  
Transient provider failures (network timeout, 503) are retried automatically. After 3 failures, the lead is marked `failed` and the batch moves on.

**4. Transaction-safe job finalization**  
When a lead completes, incrementing the counter and checking if the job is done happens inside a single PostgreSQL transaction. No race conditions if multiple workers finish simultaneously.

**5. Clean module boundaries**  
- Router knows nothing about BullMQ or PostgreSQL  
- Service knows nothing about HTTP (no req/res)  
- Repository knows nothing about queues  
- Worker knows nothing about HTTP  

**6. Structured JSON logging throughout**  
Every log line is a JSON object with `level`, `message`, `timestamp`, and relevant context fields. Ready for Datadog / CloudWatch ingestion without additional parsing.

---

## Database Schema

```sql
-- jobs: batch-level tracking
CREATE TABLE jobs (
  id              UUID PRIMARY KEY,
  status          VARCHAR(20) CHECK (status IN ('pending','processing','complete','failed')),
  total_leads     INTEGER,
  completed_leads INTEGER,
  failed_leads    INTEGER,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ  -- auto-updated by trigger
);

-- leads: per-lead results
CREATE TABLE leads (
  id                UUID PRIMARY KEY,
  job_id            UUID REFERENCES jobs(id) ON DELETE CASCADE,
  name              TEXT,
  email             TEXT,
  company           TEXT,
  status            VARCHAR(20),
  enrichment_result JSONB,
  attempt_count     INTEGER,
  error_message     TEXT,
  created_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ  -- auto-updated by trigger
);
```

---

## Project Structure

```
/src
├── api/
│   ├── app.ts              ← Express factory (testable, no side effects)
│   └── routes/jobs.ts      ← HTTP router: POST /jobs, GET /jobs/:id
├── services/
│   ├── job.service.ts      ← Business logic: create job + enqueue
│   └── enrichment.service.ts ← Mock enrichment provider (swap for real)
├── queue/
│   ├── producer.ts         ← BullMQ queue + enqueue function
│   └── worker.ts           ← BullMQ worker: process + retry + fail
├── repository/
│   └── lead.repository.ts  ← All SQL queries (no SQL anywhere else)
├── db/
│   ├── pool.ts             ← PostgreSQL connection pool (singleton)
│   └── migrations/
│       └── 001_init.sql    ← Schema migration
├── config/
│   └── env.ts              ← Zod-validated env (fails fast on bad config)
├── types/
│   └── index.ts            ← All shared TypeScript types
└── index.ts                ← Entry point: boot DB, worker, HTTP server
```

---

## What I Would Add With More Time

1. **Real enrichment adapters** — Clearbit, Apollo, LinkedIn APIs behind the same `EnrichmentProvider` interface
2. **Multi-tenant isolation** — `tenant_id` on all tables + PostgreSQL RLS policies (see `design/04-security.md`)
3. **Per-tenant rate limiting** — Express middleware via `ioredis` sliding window counters
4. **Webhook outgoing** — Notify tenants when their batch is complete
5. **BullMQ Dashboard** — `@bull-board/express` for queue observability in dev
6. **Integration tests** — Jest + Supertest for the API layer
7. **Circuit breaker** — `opossum` around enrichment provider calls

---

## Running Tests

```bash
npm run lint   # TypeScript + ESLint check
npm run build  # Compile TypeScript → dist/
```
