import { z } from 'zod';
import {
  createJob,
  createLeads,
  updateJobStatus,
} from '../repository/lead.repository';
import { enqueueLeads } from '../queue/producer';
import { CreateJobRequest, CreateJobResponse } from '../types';

// ─── Input validation schema ──────────────────────────────────────────────────

export const createJobSchema = z.object({
  leads: z
    .array(
      z.object({
        name: z.string().min(1, 'Name is required'),
        email: z.string().email('Invalid email format'),
        company: z.string().min(1, 'Company is required'),
      })
    )
    .min(1, 'At least one lead is required')
    .max(100_000, 'Maximum 100,000 leads per batch'),
});

/**
 * Job service — orchestrates the full job creation flow.
 *
 * Responsibilities:
 *   1. Validate input (Zod)
 *   2. Create job record in PostgreSQL
 *   3. Bulk-insert lead records
 *   4. Enqueue each lead as an individual BullMQ job
 *   5. Mark job as 'processing'
 *
 * The service knows nothing about HTTP (Express) or the queue internals.
 * It only talks to the repository and queue producer.
 */
export async function createEnrichmentJob(
  body: CreateJobRequest
): Promise<CreateJobResponse> {
  const { leads } = body;

  // Create the parent job record
  const job = await createJob(leads.length);

  // Bulk-insert all lead records (single SQL INSERT)
  const createdLeads = await createLeads(job.id, leads);

  // Enqueue each lead individually (not the whole batch at once)
  // If this fails, mark the job as failed — don't leave leads in DB with no queue jobs
  try {
    await enqueueLeads(
      createdLeads.map((lead) => ({
        lead_id: lead.id,
        job_id: job.id,
        name: lead.name,
        email: lead.email,
        company: lead.company,
      }))
    );
  } catch (err) {
    // Partial failure: leads exist in DB but queue is down. Mark job failed immediately.
    await updateJobStatus(job.id, 'failed');
    throw new Error(
      `Failed to enqueue leads — Redis may be unavailable. Job ${job.id} marked failed. Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Mark job as processing (leads are in the queue)
  await updateJobStatus(job.id, 'processing');

  return {
    job_id: job.id,
    message: 'Job created and queued for enrichment',
    total_leads: leads.length,
  };
}

