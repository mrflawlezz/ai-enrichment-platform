# AI Enrichment Platform

**Multi-tenant async lead enrichment pipeline** — StaffBridge AI Infrastructure Lead Assessment

**Stack:** Node.js 20 · TypeScript · BullMQ · Redis · PostgreSQL · Docker · OpenTelemetry

---

## 🚀 Quick Start — 1 Command

```bash
git clone https://github.com/mrflawlezz/ai-enrichment-platform.git
cd ai-enrichment-platform
cp .env.example .env
docker compose up --build
```

> **Prerequisite:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed.  
> First run downloads images (~2 min). Subsequent runs start in seconds.

---

## 🎨 Live Demo UI

Once running, open your browser at:

```
http://localhost:3000/demo
```

**What you'll see:**
- Submit a batch of leads as JSON
- Watch each lead being enriched **in real-time** via SSE streaming
- ICP scores (0–100), industry classification, and recommended action appear as they complete
- Live progress bar, batch stats (total / enriched / failed), and raw SSE event log

> The demo connects to the real backend — it's not a mock. Every card you see in the feed
> went through PostgreSQL → BullMQ → Worker → Redis Pub/Sub → SSE → Browser.

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

Returns immediately — processing is fully async.

### GET /jobs/:id — Poll job status + results

```bash
curl http://localhost:3000/jobs/550e8400-e29b-41d4-a716-446655440000
```

### GET /jobs/:id/stream — SSE real-time stream (Bonus A)

```bash
curl -N http://localhost:3000/jobs/550e8400-e29b-41d4-a716-446655440000/stream
```

Events: `lead_update` (per lead) · `job_complete` (when batch finishes) · `heartbeat` (every 30s)

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
                  │
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
       ▲                       │ dequeues
       │                       ▼
       │            ┌──────────────────────────────┐
       │            │  BullMQ Worker               │
       │            │  - 5 concurrent processors   │
       └────────────│  - 3 retries (exp backoff)   │
                    │  - Updates DB + publishes SSE │
                    └──────────────────────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │  Redis Pub/Sub           │
                    │  SSE → Browser           │
                    └──────────────────────────┘
```

---

## Bonus Features Implemented

### ✅ Bonus A — Real-time SSE Streaming

- **Endpoint:** `GET /jobs/:id/stream`
- Redis Pub/Sub decouples workers from HTTP connections (separate connections per SSE client)
- Heartbeat every 30s prevents proxy/load-balancer timeouts
- `res.writableEnded` guard + `req.on('error')` prevent write-after-close crashes
- Full design: [`design/bonus-a-streaming.md`](design/bonus-a-streaming.md)

### ✅ Bonus B — Observability (OpenTelemetry + Prometheus)

- Distributed traces via OTLP (compatible with Jaeger, Datadog, Honeycomb)
- PII-safe: only email **domain** stored in spans, never full email
- Prometheus metrics at `:9464/metrics`
- Full design: [`design/bonus-b-observability.md`](design/bonus-b-observability.md)

### ✅ Bonus C — Multi-Agent Enrichment Pipeline

Custom orchestrator with 3 specialist agents — no LangGraph dependency (justified in design doc):

| Agent | Role | Critical? |
|---|---|---|
| `ResearchAgent` | Industry, size, tech stack, funding stage | **Yes** — without research, cannot score |
| `ScoringAgent` | ICP score 0-100, fit classification, top signals | No — partial result still valuable |
| `FormattingAgent` | LinkedIn URL, enriched summary, CRM action | No — raw data returned as fallback |

Key design signals:
- `SpecialistAgent` interface: orchestrator only sees `run(state)` + `critical` flag
- Typed state machine: `init → researching → scoring → formatting → complete|partial|failed`  
- Zod validation on every agent output (same pattern as the LLM layer)
- Drop-in: replaces `mockEnrichLead()` in the BullMQ worker
- Full design + LangGraph comparison: [`design/bonus-c-multi-agent.md`](design/bonus-c-multi-agent.md)

### ✅ Bonus D — Cost Control

- Complexity-based model routing: economy (`gpt-5.4-mini`) → standard (`claude-haiku-4-5`) → premium (`mistral-large-3` via Groq / `claude-opus-4-6` for enterprise)
- Per-tenant budget tracking with 80% threshold alerting and graceful tier downgrade
- Env-var driven model config — swap models without code changes
- Full design: [`design/bonus-d-cost-control.md`](design/bonus-d-cost-control.md)

---

## Key Design Decisions

**1. Per-lead jobs (not per-batch)**  
Each lead is its own BullMQ job. One bad lead never blocks 99,999 others. The batch completes when all leads reach a terminal state.

**2. Idempotency via custom jobId**  
BullMQ jobs use `jobId: lead_{lead_id}` as an idempotency key. Duplicate webhook fires → no double processing.

**3. Exponential backoff (3 attempts: 1s → 2s → 4s)**  
Transient failures retry automatically. After 3 failures, lead is marked `failed` and the batch keeps moving.

**4. Transaction-safe job finalization**  
Incrementing the counter + checking if the job is done happens inside a single PostgreSQL transaction. No race conditions with concurrent workers.

**5. Separate Redis connections for BullMQ vs Pub/Sub**  
A subscriber connection enters a special mode where it can only run `SUBSCRIBE`/`UNSUBSCRIBE`. Sharing a BullMQ connection with pub/sub would crash — they use separate connections with `maxRetriesPerRequest: null`.

**6. Structured JSON logging throughout**  
Every log line is JSON with `level`, `message`, `timestamp`, and context fields. Ready for Datadog/CloudWatch ingestion without parsing.

---

## Database Schema

```sql
-- jobs: batch-level tracking
CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status          VARCHAR(20) CHECK (status IN ('pending','processing','complete','failed')),
  total_leads     INTEGER,
  completed_leads INTEGER DEFAULT 0,
  failed_leads    INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- leads: per-lead results
CREATE TABLE leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID REFERENCES jobs(id) ON DELETE CASCADE,
  name              TEXT,
  email             TEXT,
  company           TEXT,
  status            VARCHAR(20) DEFAULT 'pending',
  enrichment_result JSONB,
  attempt_count     INTEGER DEFAULT 0,
  error_message     TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Project Structure

```
/src
├── api/
│   ├── app.ts                  ← Express factory (testable, no side effects)
│   └── routes/
│       ├── jobs.ts             ← POST /jobs, GET /jobs/:id
│       └── stream.ts           ← GET /jobs/:id/stream (SSE)
├── agents/                     ← Bonus C: multi-agent pipeline
│   ├── types.ts                ← Interfaces, Zod schemas, PipelineState
│   ├── orchestrator.ts         ← EnrichmentOrchestrator (state machine)
│   ├── research.agent.ts       ← ResearchAgent (CRITICAL)
│   ├── scoring.agent.ts        ← ScoringAgent (non-critical)
│   └── formatting.agent.ts     ← FormattingAgent (non-critical)
├── services/
│   ├── job.service.ts          ← Business logic: create job + enqueue
│   └── enrichment.service.ts   ← Mock enrichment provider
├── queue/
│   ├── producer.ts             ← BullMQ queue + enqueue
│   └── worker.ts               ← BullMQ worker: process + retry + SSE publish
├── events/
│   └── redis-pubsub.ts         ← Redis Pub/Sub for SSE streaming
├── repository/
│   └── lead.repository.ts      ← All SQL queries
├── db/
│   ├── pool.ts                 ← PostgreSQL connection pool
│   └── migrations/001_init.sql ← Schema
├── telemetry/
│   ├── otel.ts                 ← OTel bootstrap (Bonus B)
│   └── tracing.ts              ← withEnrichmentSpan helper
├── config/env.ts               ← Zod-validated env config
├── types/index.ts              ← Shared TypeScript types
└── index.ts                    ← Entry point: boot DB + worker + HTTP
/public
└── demo.html                   ← 🎨 Live demo UI (SSE streaming dashboard)
/design
├── 01-system-design.md         ← Section 1: architecture diagrams
├── 02-database.md              ← Section 2: schema + RLS
├── 03-llm-architecture.md      ← Section 3: LLM adapter pattern
├── 04-security.md              ← Section 4: multi-tenant security
├── 05-scaling.md               ← Section 5: horizontal scaling
├── bonus-a-streaming.md        ← Bonus A: SSE design
├── bonus-b-observability.md    ← Bonus B: OTel + Prometheus
├── bonus-c-multi-agent.md      ← Bonus C: multi-agent architecture
└── bonus-d-cost-control.md     ← Bonus D: cost routing
```

---

## What I Would Add With More Time

1. **Real enrichment adapters** — Clearbit, Apollo, LinkedIn APIs behind the `EnrichmentProvider` interface
2. **Multi-tenant isolation** — `tenant_id` on all tables + PostgreSQL RLS policies
3. **Per-tenant rate limiting** — `ioredis` sliding window counters
4. **Webhook outgoing** — Notify tenants when their batch completes
5. **BullMQ Dashboard** — `@bull-board/express` for visual queue monitoring
6. **Integration tests** — Jest + Supertest
7. **Circuit breaker** — `opossum` around enrichment provider calls

---

## Running Type Checks

```bash
npm run build   # Compile TypeScript → dist/ (0 errors)
npm run dev     # Dev server with ts-node (requires local PG + Redis)
```
