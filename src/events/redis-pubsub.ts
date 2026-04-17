import Redis from 'ioredis';
import { config } from '../config/env';

/**
 * Redis Pub/Sub clients — SEPARATE from the BullMQ connection.
 *
 * BullMQ requires its own dedicated Redis connection that cannot be shared
 * with pub/sub subscribers (a subscriber connection enters a special mode
 * where it can only run SUBSCRIBE/UNSUBSCRIBE commands).
 *
 * We create:
 *   - publisher: used by the worker to PUBLISH events
 *   - createSubscriber(): factory that creates a new subscriber per SSE connection
 *     (each subscriber must maintain its own dedicated connection)
 */
export const publisher = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: null, // Required for pub/sub mode — same as BullMQ connections
  lazyConnect: true,
});

/**
 * Channel naming convention:
 *   job:{job_id}:events  — receives events for all leads in this job
 *
 * This allows clients to subscribe to a single job_id and get updates
 * for every lead as they complete/fail, plus the final job_complete event.
 */
export function jobChannel(jobId: string): string {
  return `job:${jobId}:events`;
}

/**
 * Event types published to Redis channels.
 * Consumers (SSE clients) receive these as JSON strings.
 */
export type LeadUpdateEvent = {
  event: 'lead_update';
  lead_id: string;
  job_id: string;
  // Human-readable lead info — included so the UI can display names instead of UUIDs
  name?: string;
  email?: string;
  company?: string;
  status: 'complete' | 'failed';
  icp_score?: number;
  industry?: string;
  company_size?: string;
  error_message?: string;
  timestamp: string;
};

export type JobCompleteEvent = {
  event: 'job_complete';
  job_id: string;
  final_status: 'complete' | 'failed';
  total_leads: number;
  completed_leads: number;
  failed_leads: number;
  timestamp: string;
};

export type StreamEvent = LeadUpdateEvent | JobCompleteEvent;

/**
 * Creates a new Redis subscriber connection.
 * Must be called once per SSE client — each needs its own subscriber instance.
 */
export function createSubscriber(): Redis {
  return new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    maxRetriesPerRequest: null, // Required for pub/sub mode — prevents silent failures on reconnect
    lazyConnect: true,
  });
}

/**
 * Publish an event to a job's Redis channel.
 * Called by the worker after each lead completes or fails.
 */
export async function publishEvent(jobId: string, event: StreamEvent): Promise<void> {
  await publisher.publish(jobChannel(jobId), JSON.stringify(event));
}
