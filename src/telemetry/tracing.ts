import { trace, context, SpanStatusCode, Span } from '@opentelemetry/api';

const tracer = trace.getTracer('enrichment-worker', '1.0.0');

/**
 * Wraps an enrichment job in an OpenTelemetry span.
 *
 * Every span includes:
 *   - tenant_id       → per-tenant SLA dashboards
 *   - job_id          → correlate with job status API
 *   - lead_id         → trace individual lead failures
 *   - enrichment_provider → per-provider latency analysis
 *   - attempt         → distinguish first try vs retries
 *
 * Usage:
 *   const result = await withEnrichmentSpan({ tenantId, jobId, leadId, provider, attempt }, async (span) => {
 *     return await doEnrichment();
 *   });
 */
export async function withEnrichmentSpan<T>(
  attrs: {
    tenantId: string;
    jobId: string;
    leadId: string;
    email: string;
    company: string;
    provider: string;
    attempt: number;
    enrichmentType?: string;
  },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(
    `enrichment.process_lead`,
    {
      attributes: {
        'tenant.id':           attrs.tenantId,
        'job.id':              attrs.jobId,
        'lead.id':             attrs.leadId,
        'lead.email_domain':   attrs.email.split('@')[1] ?? 'unknown', // PII-safe — no full email
        'lead.company':        attrs.company,
        'enrichment.provider': attrs.provider,
        'enrichment.attempt':  attrs.attempt,
        'enrichment.type':     attrs.enrichmentType ?? 'icp_score',
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Span for the full job batch ingestion.
 * Called once per POST /jobs request.
 */
export async function withJobIngestionSpan<T>(
  attrs: {
    tenantId: string;
    jobId: string;
    leadCount: number;
    source: 'api' | 'csv' | 'webhook';
  },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(
    'enrichment.ingest_job',
    {
      attributes: {
        'tenant.id':   attrs.tenantId,
        'job.id':      attrs.jobId,
        'job.leads':   attrs.leadCount,
        'job.source':  attrs.source,
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    }
  );
}
