import { Worker, Job } from 'bullmq';
import { redisConnection } from './producer';
import { config } from '../config/env';
import { mockEnrichLead, EnrichmentProviderError } from '../services/enrichment.service';
import { updateLeadStatus, finalizeJobIfComplete } from '../repository/lead.repository';
import { EnrichmentJobData } from '../types';
import { withEnrichmentSpan } from '../telemetry/tracing';
import { publishEvent } from '../events/redis-pubsub';

function structuredLog(
  level: 'info' | 'warn' | 'error',
  message: string,
  meta: Record<string, unknown>
): void {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta }));
}

/**
 * BullMQ Worker — processes each lead enrichment job.
 *
 * Flow:
 *   1. Mark lead as 'processing'
 *   2. Call enrichment provider (mock)
 *   3a. On success → save result + mark 'complete'
 *   3b. On failure (retryable) → BullMQ retries with exponential backoff
 *   3c. On permanent failure (exhausted 3 retries) → mark 'failed', DO NOT block batch
 *   4. Update job-level counters (transactional)
 */
export function startWorker(): Worker<EnrichmentJobData> {
  const worker = new Worker<EnrichmentJobData>(
    'enrichment',
    async (job: Job<EnrichmentJobData>) => {
      const { lead_id, job_id, name, email, company } = job.data;

      // NOTE: tenant_id would come from job.data in a real multi-tenant impl.
      // For this assessment, we use a placeholder — the span structure is what matters.
      const tenantId = (job.data as EnrichmentJobData & { tenant_id?: string }).tenant_id ?? 'default';

      await withEnrichmentSpan(
        {
          tenantId,
          jobId: job_id,
          leadId: lead_id,
          email,
          company,
          provider: 'mock',
          attempt: job.attemptsMade + 1,
          enrichmentType: 'icp_score',
        },
        async (span) => {
          structuredLog('info', 'Processing enrichment job', {
            lead_id,
            job_id,
            attempt: job.attemptsMade + 1,
            max_attempts: job.opts.attempts,
            email,
          });

          // Mark as processing
          await updateLeadStatus(lead_id, 'processing', { incrementAttempt: true });

          // Call the enrichment service — throws on failure (triggers BullMQ retry)
          const result = await mockEnrichLead(lead_id, name, email, company);

          // Enrich the span with result attributes
          span.setAttribute('enrichment.icp_score', result.icp_score);
          span.setAttribute('enrichment.industry', result.industry);
          span.setAttribute('enrichment.company_size', result.company_size);

          // Save successful result
          await updateLeadStatus(lead_id, 'complete', { enrichmentResult: result });

          // Update job-level counter + finalize if all leads done (atomic)
          // Returns the finalized Job if THIS call was the one that completed the batch
          const finalizedJob = await finalizeJobIfComplete(job_id, 'completed_leads');

          // Publish events — wrapped in try/catch so Redis failures don't crash the worker
          try {
            await publishEvent(job_id, {
              event: 'lead_update',
              lead_id,
              job_id,
              name,
              email,
              company,
              status: 'complete',
              icp_score: result.icp_score,
              industry: result.industry,
              company_size: result.company_size,
              timestamp: new Date().toISOString(),
            });

            // Only publish job_complete if THIS invocation was the one that finalized the job
            // This prevents duplicate job_complete events from concurrent workers
            if (finalizedJob) {
              await publishEvent(job_id, {
                event: 'job_complete',
                job_id,
                final_status: finalizedJob.status as 'complete' | 'failed',
                total_leads: finalizedJob.total_leads,
                completed_leads: finalizedJob.completed_leads,
                failed_leads: finalizedJob.failed_leads,
                timestamp: new Date().toISOString(),
              });
            }
          } catch {
            // Redis pub/sub failure — log but don't fail the job
            // SSE clients will miss events but job results are safely in PostgreSQL
            structuredLog('warn', 'Failed to publish SSE event to Redis', { lead_id, job_id });
          }

          structuredLog('info', 'Lead enrichment complete', {
            lead_id,
            job_id,
            icp_score: result.icp_score,
            industry: result.industry,
          });
        }
      );
    },
    {
      connection: redisConnection,
      concurrency: config.QUEUE_CONCURRENCY,
    }
  );

  // ── This runs ONLY after all retries are exhausted ──────────────────────────
  worker.on('failed', async (job, error) => {
    if (!job) return;

    const { lead_id, job_id, name, email, company } = job.data;
    const isExhausted = job.attemptsMade >= (job.opts.attempts ?? 3);

    if (isExhausted) {
      // Permanent failure — mark lead as failed and move on
      // DO NOT throw here — we must not block the rest of the batch
      try {
        await updateLeadStatus(lead_id, 'failed', {
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        const finalizedJob = await finalizeJobIfComplete(job_id, 'failed_leads');

        // Publish events — inner try/catch so Redis failures don't suppress the DB writes above
        try {
          await publishEvent(job_id, {
            event: 'lead_update',
            lead_id,
            job_id,
            name,
            email,
            company,
            status: 'failed',
            error_message: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          });

          // Only publish job_complete if THIS invocation flipped the job to terminal
          if (finalizedJob) {
            await publishEvent(job_id, {
              event: 'job_complete',
              job_id,
              final_status: finalizedJob.status as 'complete' | 'failed',
              total_leads: finalizedJob.total_leads,
              completed_leads: finalizedJob.completed_leads,
              failed_leads: finalizedJob.failed_leads,
              timestamp: new Date().toISOString(),
            });
          }
        } catch {
          structuredLog('warn', 'Failed to publish SSE event to Redis (failed lead)', { lead_id, job_id });
        }

        structuredLog('error', 'Lead enrichment permanently failed', {
          lead_id,
          job_id,
          email,
          attempts: job.attemptsMade,
          error_name: error instanceof Error ? error.name : 'UnknownError',
          error_message: error instanceof Error ? error.message : String(error),
          is_provider_error: error instanceof EnrichmentProviderError,
          error_code: error instanceof EnrichmentProviderError ? error.code : null,
        });
      } catch (dbError) {
        structuredLog('error', 'Failed to persist lead failure to DB', {
          lead_id,
          job_id,
          db_error: dbError instanceof Error ? dbError.message : String(dbError),
        });
      }
    } else {
      // Transient failure — BullMQ will retry
      structuredLog('warn', 'Lead enrichment failed — will retry', {
        lead_id,
        job_id,
        email,
        attempt: job.attemptsMade,
        next_attempt_in_ms: Math.pow(2, job.attemptsMade) * 1000,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  worker.on('error', (error) => {
    structuredLog('error', 'Worker-level error', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  structuredLog('info', 'Enrichment worker started', {
    concurrency: config.QUEUE_CONCURRENCY,
    queue: 'enrichment',
  });

  return worker;
}
