import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { config } from '../config/env';
import { EnrichmentJobData } from '../types';

// Shared Redis connection — reused by both producer and worker
export const redisConnection = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: null, // Required by BullMQ
});

// The main enrichment queue
export const enrichmentQueue = new Queue<EnrichmentJobData>('enrichment', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000, // 1s → 2s → 4s
    },
    removeOnComplete: { count: 1000 }, // Keep last 1000 completed jobs in Redis
    removeOnFail: { count: 500 },
  },
});

/**
 * Enqueue a batch of leads for enrichment.
 * Each lead becomes an individual BullMQ job — not the whole batch at once.
 * This ensures one bad lead can't block the entire batch.
 */
export async function enqueueLeads(
  leads: Array<{
    lead_id: string;
    job_id: string;
    name: string;
    email: string;
    company: string;
  }>
): Promise<void> {
  const jobs = leads.map((lead) => ({
    name: 'enrich-lead',
    data: {
      lead_id: lead.lead_id,
      job_id: lead.job_id,
      name: lead.name,
      email: lead.email,
      company: lead.company,
    } satisfies EnrichmentJobData,
    opts: {
      jobId: `lead:${lead.lead_id}`, // Idempotency — prevents duplicate processing
    },
  }));

  await enrichmentQueue.addBulk(jobs);
}
