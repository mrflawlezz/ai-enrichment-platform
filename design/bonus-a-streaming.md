# Bonus A — Streaming Enrichment Results (SSE)

> **Status:** Implemented. See `src/events/redis-pubsub.ts`, `src/api/routes/stream.ts`, and the updated `src/queue/worker.ts`.

## Endpoint

```
GET /jobs/:id/stream
```

**Response:** `Content-Type: text/event-stream` (Server-Sent Events)

The client connects once and receives push events until the job completes or the connection drops.

---

## Design: Why SSE over WebSockets?

| | SSE | WebSockets |
|---|---|---|
| Direction | Server → Client only | Bidirectional |
| Protocol | HTTP/1.1 | Separate WS upgrade |
| Proxies/firewalls | ✅ Works natively | ⚠️ Often needs config |
| Auto-reconnect | ✅ Built into browser | ❌ Manual |
| Back-pressure | ✅ HTTP flow control | ❌ Manual |
| Use case fit | ✅ Job progress stream | Overkill (client never sends after subscribing) |

**Verdict:** SSE is the right choice for read-only job progress. WebSockets would be warranted if clients needed to send mid-stream control commands (pause, cancel) — not the case here.

---

## Event Types

### `lead_update` — fired after each lead completes or fails

```
event: lead_update
id: {lead_id}
data: {"event":"lead_update","lead_id":"uuid","job_id":"uuid","status":"complete","icp_score":87,"industry":"SaaS","company_size":"51-200","timestamp":"..."}

```

```
event: lead_update
id: {lead_id}
data: {"event":"lead_update","lead_id":"uuid","job_id":"uuid","status":"failed","error_message":"Provider timeout","timestamp":"..."}

```

### `job_complete` — fired once when ALL leads reach terminal state

```
event: job_complete
data: {"event":"job_complete","job_id":"uuid","final_status":"complete","total_leads":100,"completed_leads":84,"failed_leads":16,"timestamp":"..."}

```

### `heartbeat` — every 15 seconds to keep the connection alive through proxies

```
: heartbeat 2026-04-17T00:00:00Z

```

---

## Architecture

```
POST /jobs → leads enqueued to BullMQ

GET /jobs/:id/stream (SSE)
    │
    │ subscribe to Redis channel: job:{job_id}:events
    ▼
┌────────────────────────────────────┐
│  Redis Pub/Sub                     │
│  channel: job:{job_id}:events      │
└──────────┬─────────────────────────┘
           │ PUBLISH
           │
     Worker (BullMQ)
     After each lead completes:
       → publishEvent(job_id, { event: 'lead_update', ... })
     After job finalization:
       → publishEvent(job_id, { event: 'job_complete', ... })
```

**Why Redis Pub/Sub instead of polling the DB?**
- Polling keeps the SSE endpoint saturating PostgreSQL with `SELECT` queries
- Pub/Sub pushes events in real time, zero DB load from streaming clients
- Decouples the worker from the HTTP layer — worker doesn't know about SSE connections

---

## Client Usage Example

```javascript
// Browser / Node.js EventSource
const source = new EventSource('http://localhost:3000/jobs/JOB_ID/stream');

source.addEventListener('lead_update', (e) => {
  const data = JSON.parse(e.data);
  console.log(`Lead ${data.lead_id}: ${data.status} (ICP: ${data.icp_score})`);
});

source.addEventListener('job_complete', (e) => {
  const data = JSON.parse(e.data);
  console.log(`Job done: ${data.completed_leads}/${data.total_leads} succeeded`);
  source.close(); // Done — no more events
});

source.onerror = () => {
  // EventSource auto-reconnects on error by default
  console.warn('SSE connection dropped, browser will retry...');
};
```

---

## Connection Lifecycle

```
Client connects to GET /jobs/:id/stream
    │
    ├── Job not found → 404, close connection immediately
    │
    ├── Job already complete → send job_complete event immediately, close
    │
    └── Job in progress:
            │
            ├── Subscribe to Redis channel job:{id}:events
            ├── Send SSE headers (Content-Type: text/event-stream)
            ├── Start 15s heartbeat timer (prevents proxy timeouts)
            │
            ├── On Redis message → forward as SSE event
            │
            ├── On 'job_complete' event → close connection after 1s drain
            │
            └── On client disconnect → cleanup subscriber + heartbeat timer
```

---

## Failure Modes

| Scenario | Behavior |
|---|---|
| Client disconnects mid-stream | `req.on('close')` fires → subscriber destroyed + heartbeat cleared |
| Redis pub/sub subscriber dies | Worker continues, SSE client receives no events — client must poll GET /jobs/:id as fallback |
| Job was already complete when client subscribes | Check DB first, emit `job_complete` immediately without subscribing to Redis |
| Multiple clients watching same job | Each gets its own Redis subscriber on the same channel — Redis broadcasts to all |
| Worker crashes before publishing job_complete | SSE connection stays open until timeout. Client falls back to GET /jobs/:id polling. |
