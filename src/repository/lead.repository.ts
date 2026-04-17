import { query, queryOne, withTransaction } from '../db/pool';
import { Job, Lead, LeadStatus, JobStatus, EnrichmentResult } from '../types';
import { PoolClient } from 'pg';

// ─── Job repository ────────────────────────────────────────────────────────────

export async function createJob(totalLeads: number): Promise<Job> {
  const row = await queryOne<Job>(
    `INSERT INTO jobs (total_leads, status)
     VALUES ($1, 'pending')
     RETURNING *`,
    [totalLeads]
  );
  if (!row) throw new Error('Failed to create job');
  return row;
}

export async function getJobById(jobId: string): Promise<Job | null> {
  return queryOne<Job>(
    `SELECT * FROM jobs WHERE id = $1`,
    [jobId]
  );
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus
): Promise<void> {
  await query(
    `UPDATE jobs SET status = $1 WHERE id = $2`,
    [status, jobId]
  );
}

export async function incrementJobCounter(
  jobId: string,
  field: 'completed_leads' | 'failed_leads',
  client?: PoolClient
): Promise<void> {
  const sql = `UPDATE jobs SET ${field} = ${field} + 1 WHERE id = $1`;
  if (client) {
    await client.query(sql, [jobId]);
  } else {
    await query(sql, [jobId]);
  }
}

// ─── Lead repository ───────────────────────────────────────────────────────────

export async function createLeads(
  jobId: string,
  leads: Array<{ name: string; email: string; company: string }>
): Promise<Lead[]> {
  if (leads.length === 0) return [];

  // Bulk insert with a single query — much faster than N inserts
  // 4 columns per row: job_id, name, email, company
  const placeholders = leads.map(
    (_, i) => `($${i * 4 + 1}::uuid, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
  ).join(', ');

  const values = leads.flatMap((l) => [jobId, l.name, l.email, l.company]);

  return query<Lead>(
    `INSERT INTO leads (job_id, name, email, company)
     VALUES ${placeholders}
     RETURNING *`,
    values
  );
}

export async function getLeadById(leadId: string): Promise<Lead | null> {
  return queryOne<Lead>(
    `SELECT * FROM leads WHERE id = $1`,
    [leadId]
  );
}

export async function getLeadsByJobId(jobId: string): Promise<Lead[]> {
  return query<Lead>(
    `SELECT * FROM leads WHERE job_id = $1 ORDER BY created_at ASC`,
    [jobId]
  );
}

export async function updateLeadStatus(
  leadId: string,
  status: LeadStatus,
  opts?: {
    enrichmentResult?: EnrichmentResult;
    errorMessage?: string;       // Always overwrites previous error — captures the LAST failure reason
    incrementAttempt?: boolean;
  }
): Promise<Lead | null> {
  return queryOne<Lead>(
    `UPDATE leads
     SET status = $1,
         enrichment_result = COALESCE($2, enrichment_result),
         error_message = $3,
         attempt_count = attempt_count + $4
     WHERE id = $5
     RETURNING *`,
    [
      status,
      opts?.enrichmentResult ? JSON.stringify(opts.enrichmentResult) : null,
      opts?.errorMessage ?? null,   // Intentionally overwrites — last failure reason wins
      opts?.incrementAttempt ? 1 : 0,
      leadId,
    ]
  );
}

// ─── Job completion logic (run inside a transaction) ──────────────────────────

/**
 * Atomically increments the lead outcome counter and finalizes the job status
 * if all leads have reached a terminal state.
 *
 * Returns the finalized Job object if the batch just completed (this invocation
 * was the one that flipped the status), or null if the job is still in progress.
 *
 * The caller uses this return value to publish the job_complete SSE event,
 * avoiding a second DB read and the race condition that would create.
 */
export async function finalizeJobIfComplete(
  jobId: string,
  outcomeField: 'completed_leads' | 'failed_leads'
): Promise<Job | null> {
  // Safe mapping instead of direct string interpolation — avoids any SQL injection surface
  // even though TypeScript's type system already constrains outcomeField to two safe values.
  const fieldSql = outcomeField === 'completed_leads'
    ? 'completed_leads = completed_leads + 1'
    : 'failed_leads = failed_leads + 1';

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE jobs SET ${fieldSql} WHERE id = $1`,
      [jobId]
    );

    // Check if all leads are done (read WITHIN the same transaction for consistency)
    const result = await client.query(
      `SELECT * FROM jobs WHERE id = $1`,
      [jobId]
    );
    const job = result.rows[0] as Job | undefined;
    if (!job) return null;

    const done = job.completed_leads + job.failed_leads;
    if (done >= job.total_leads) {
      const finalStatus: JobStatus = job.failed_leads === job.total_leads ? 'failed' : 'complete';
      await client.query(
        `UPDATE jobs SET status = $1 WHERE id = $2`,
        [finalStatus, jobId]
      );
      // Return the job with the UPDATED status for the caller to use
      return { ...job, status: finalStatus } as Job;
    }

    return null; // Job is not done yet
  });
}
