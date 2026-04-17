import { Worker, Job } from 'bullmq';
import { redisConnection } from './producer';
import { config } from '../config/env';
import { mockEnrichLead, EnrichmentProviderError } from '../services/enrichment.service';
import { updateLeadStatus, finalizeJobIfComplete } from '../repository/lead.repository';
import { EnrichmentJobData } from '../types';

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

      // Save successful result
      await updateLeadStatus(lead_id, 'complete', {
        enrichmentResult: result,
      });

      // Update job-level counter (transactional)
      await finalizeJobIfComplete(job_id, 'completed_leads');

      structuredLog('info', 'Lead enrichment complete', {
        lead_id,
        job_id,
        icp_score: result.icp_score,
        industry: result.industry,
      });
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
