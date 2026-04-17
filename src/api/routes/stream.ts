import { Router, Request, Response } from 'express';
import { getJobById } from '../../repository/lead.repository';
import { createSubscriber, jobChannel, StreamEvent } from '../../events/redis-pubsub';

export const streamRouter = Router();

/**
 * GET /jobs/:id/stream
 *
 * Server-Sent Events endpoint — streams per-lead enrichment results in real time.
 *
 * Protocol: text/event-stream (SSE)
 *   - Each event has a named type (lead_update | job_complete)
 *   - Heartbeat comment every 15s keeps the connection alive through load balancers
 *   - Connection closes automatically when the job reaches a terminal state
 *
 * Client reconnection is handled by the browser's EventSource API automatically
 * using the Last-Event-ID header. For simplicity, we don't implement event replay
 * here — clients should fall back to GET /jobs/:id if they've missed events.
 */
streamRouter.get('/:id/stream', async (req: Request, res: Response) => {
  const { id: jobId } = req.params;

  // ── 1. Validate job exists ─────────────────────────────────────────────────
  const job = await getJobById(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  // ── 2. If job is already terminal, respond immediately without subscribing ─
  if (job.status === 'complete' || job.status === 'failed') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

    sendEvent(res, 'job_complete', {
      event: 'job_complete',
      job_id: jobId,
      final_status: job.status,
      total_leads: job.total_leads,
      completed_leads: job.completed_leads,
      failed_leads: job.failed_leads,
      timestamp: new Date().toISOString(),
    });

    res.end();
    return;
  }

  // ── 3. Set SSE headers ─────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
  res.flushHeaders();

  // ── 4. Subscribe to Redis pub/sub channel for this job ────────────────────
  const subscriber = createSubscriber();
  await subscriber.subscribe(jobChannel(jobId));

  let isOpen = true;

  // ── 5. Heartbeat — prevents proxy/load-balancer timeout (every 15s) ───────
  const heartbeat = setInterval(() => {
    if (isOpen) {
      // SSE comment — keeps TCP connection alive, not shown as an event to clients
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }
  }, 15_000);

  // ── 6. Forward Redis messages to the SSE client ───────────────────────────
  subscriber.on('message', (_channel: string, message: string) => {
    if (!isOpen) return;

    let event: StreamEvent;
    try {
      event = JSON.parse(message) as StreamEvent;
    } catch {
      return; // Malformed message — skip silently
    }

    sendEvent(res, event.event, event);

    // Close the connection after the job reaches terminal state
    if (event.event === 'job_complete') {
      cleanup();
    }
  });

  // ── 7. Cleanup on client disconnect ─────────────────────────────────────────
  req.on('close', cleanup);

  function cleanup(): void {
    if (!isOpen) return;
    isOpen = false;
    clearInterval(heartbeat);
    subscriber.unsubscribe().catch(() => {});
    subscriber.quit().catch(() => {});
    if (!res.writableEnded) {
      res.end();
    }
  }
});

/**
 * Write a properly formatted SSE event to the response.
 *
 * SSE format:
 *   event: {type}\n
 *   id: {optional id}\n
 *   data: {JSON string}\n
 *   \n  ← blank line terminates the event
 */
function sendEvent(res: Response, eventType: string, data: unknown, id?: string): void {
  if (id) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
