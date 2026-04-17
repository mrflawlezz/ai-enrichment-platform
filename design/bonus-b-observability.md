# Bonus B — Tenant-Aware Observability with OpenTelemetry

> **Status:** Implemented. See `src/telemetry/otel.ts` (SDK bootstrap) and `src/telemetry/tracing.ts` (span helpers).

---

## What's Instrumented

Every enrichment job processed by the BullMQ worker is wrapped in an OpenTelemetry span via `withEnrichmentSpan()`. This is a **mandatory span** — not optional logging.

### Span: `enrichment.process_lead`

Emitted per lead. Attributes:

| Attribute | Type | Example | Purpose |
|---|---|---|---|
| `tenant.id` | string | `uuid` | Per-tenant SLA dashboards |
| `job.id` | string | `uuid` | Correlate with job status API |
| `lead.id` | string | `uuid` | Trace individual lead failures |
| `lead.email_domain` | string | `acmecorp.com` | PII-safe (no full address) |
| `lead.company` | string | `Acme Corp` | Provider-level grouping |
| `enrichment.provider` | string | `clearbit` | Per-provider latency |
| `enrichment.attempt` | int | `1`, `2`, `3` | Distinguish retries from first tries |
| `enrichment.type` | string | `icp_score` | Cost attribution by enrichment type |
| `enrichment.icp_score` | int | `87` | Result quality tracking |
| `enrichment.industry` | string | `SaaS` | Distribution analysis |
| `enrichment.company_size` | string | `51-200` | Segment analysis |

On **error**, the span records the exception and sets `SpanStatusCode.ERROR` — no manual error logging needed in the span path.

### Span: `enrichment.ingest_job`

Emitted per POST /jobs request. Attributes:

| Attribute | Type | Purpose |
|---|---|---|
| `tenant.id` | string | Identify submitting tenant |
| `job.id` | string | Link to processing spans |
| `job.leads` | int | Batch size for sizing alerts |
| `job.source` | string | `api` / `csv` / `webhook` |

---

## Architecture

```
BullMQ Worker (Node.js)
        │
        │ withEnrichmentSpan(...)
        ▼
┌──────────────────────────────────┐
│  OpenTelemetry SDK               │
│  (sdk-node + auto-instrumentations)│
└──────────────┬───────────────────┘
               │ OTLP/HTTP
               ▼
┌──────────────────────────────────────────────────────┐
│  Trace Backend (one of):                              │
│  • Grafana Tempo (self-hosted, cheapest)              │
│  • Honeycomb (SaaS, great DX for startups)           │
│  • Datadog APM (full-featured, expensive at scale)   │
│  • Jaeger (self-hosted OSS, good for dev)            │
└──────────────────────────────────────────────────────┘

:9464/metrics (Prometheus scrape)
        │
        ▼
┌──────────────────────┐
│  Prometheus          │
│  + Grafana           │
│  (SLA dashboards)    │
└──────────────────────┘
```

---

## Where to Export Traces + Why

### My recommendation: Grafana Tempo + Grafana Cloud

**Why for a startup:**
- Free tier covers 50GB traces/month — enough for 5M leads
- Unified stack: Tempo (traces) + Loki (logs) + Prometheus (metrics) in one UI
- OTel-native — just point `OTEL_EXPORTER_OTLP_ENDPOINT` at their ingestion URL
- No vendor lock-in: swap to Datadog later when scale justifies the cost

**Environment config (zero code change to swap backends):**
```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://tempo-prod-us-central1.grafana.net/tempo
OTEL_EXPORTER_OTLP_HEADERS={"Authorization":"Basic <base64 token>"}
```

**For local dev:** Run Jaeger all-in-one via Docker:
```yaml
# docker-compose.yml addition
jaeger:
  image: jaegertracing/all-in-one:latest
  ports:
    - "16686:16686"  # Jaeger UI
    - "4318:4318"    # OTLP HTTP receiver
```

---

## Per-Tenant SLA Dashboard

### Core metrics to track

```promql
# p95 enrichment latency per tenant (ms)
histogram_quantile(0.95,
  rate(enrichment_process_lead_duration_bucket{tenant_id="$tenant_id"}[5m])
)

# Enrichment success rate per tenant (last 1h)
sum(rate(enrichment_process_lead_total{tenant_id="$tenant_id", status="ok"}[1h]))
/
sum(rate(enrichment_process_lead_total{tenant_id="$tenant_id"}[1h]))

# Queue depth per tenant (from BullMQ → Redis → Prometheus exporter)
bullmq_queue_waiting{tenant_id="$tenant_id"}
```

### Dashboard panels (Grafana)

| Panel | Query | Alert threshold |
|---|---|---|
| **Enrichment p95 latency** | `histogram_quantile(0.95, ...)` | > 10s → warn |
| **Success rate** | `success / total` | < 85% → alert |
| **Jobs submitted (24h)** | `increase(jobs_created_total[24h])` | — |
| **Avg batch size** | `sum(leads) / count(jobs)` | — |
| **Failed leads (24h)** | `increase(leads_failed_total[24h])` | > 1K → alert |
| **Cost estimate (LLM)** | Custom metric from `llm_usage_log` | > 80% budget → alert |

### SLA definition (example)

> 99% of leads enriched within 60 seconds of job submission, measured per tenant, per calendar week.

With the spans above, this is a single Tempo query:
```
{tenant.id="<id>"} | duration > 60s
```

---

## PII Considerations

- **Email addresses are NOT stored in spans** — only `email_domain` (`company.com`)
- **Names and phone numbers excluded** from all span attributes
- This allows trace data to be stored without GDPR personal data classification
- Full PII stays only in PostgreSQL (RLS-protected, encrypted at rest)

---

## Auto-Instrumentation Included

The `@opentelemetry/auto-instrumentations-node` package automatically instruments:
- **Express** → spans per HTTP request, latency, status codes
- **pg** → spans per SQL query, query text (sanitized), duration
- **ioredis** → spans per Redis command, key patterns
- **http/https** → all outbound HTTP calls (enrichment API, LLM calls)

Zero additional code needed for these — they're captured automatically once the SDK boots.
