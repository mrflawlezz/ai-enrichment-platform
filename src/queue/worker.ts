import { Worker, Job } from 'bullmq';
import { redisConnection } from './producer';
import { config } from '../config/env';
import { mockEnrichLead, EnrichmentProviderError } from '../services/enrichment.service';
import { updateLeadStatus, finalizeJobIfComplete, getJobById } from '../repository/lead.repository';
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

          // Update job-level counter (transactional) + finalize if all leads done
          await finalizeJobIfComplete(job_id, 'completed_leads');

          // → Publish event to Redis — SSE clients receive this in real time
          await publishEvent(job_id, {
            event: 'lead_update',
            lead_id,
            job_id,
            status: 'complete',
            icp_score: result.icp_score,
            industry: result.industry,
            company_size: result.company_size,
            timestamp: new Date().toISOString(),
          });

          // Check if job is now fully complete and publish job_complete
          const updatedJob = await getJobById(job_id);
          if (updatedJob && (updatedJob.status === 'complete' || updatedJob.status === 'failed')) {
            await publishEvent(job_id, {
              event: 'job_complete',
              job_id,
              final_status: updatedJob.status as 'complete' | 'failed',
              total_leads: updatedJob.total_leads,
              completed_leads: updatedJob.completed_leads,
              failed_leads: updatedJob.failed_leads,
              timestamp: new Date().toISOString(),
            });
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

    const { lead_id, job_id, email } = job.data;
    const isExhausted = job.attemptsMade >= (job.opts.attempts ?? 3);

    if (isExhausted) {
      // Permanent failure — mark lead as failed and move on
      // DO NOT throw here — we must not block the rest of the batch
      try {
        await updateLeadStatus(lead_id, 'failed', {
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        await finalizeJobIfComplete(job_id, 'failed_leads');

        // → Publish failed lead event — SSE clients track failures too
        await publishEvent(job_id, {
          event: 'lead_update',
          lead_id,
          job_id,
          status: 'failed',
          error_message: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });

        // Check if job is now fully done after this failure
        const updatedJob = await getJobById(job_id);
        if (updatedJob && (updatedJob.status === 'complete' || updatedJob.status === 'failed')) {
          await publishEvent(job_id, {
            event: 'job_complete',
            job_id,
            final_status: updatedJob.status as 'complete' | 'failed',
            total_leads: updatedJob.total_leads,
            completed_leads: updatedJob.completed_leads,
            failed_leads: updatedJob.failed_leads,
            timestamp: new Date().toISOString(),
          });
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
