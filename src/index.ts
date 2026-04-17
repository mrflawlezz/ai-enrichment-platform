// ⚠️ OTel MUST be the first import — before express, pg, bullmq, etc.
import './telemetry/otel';

import { createApp } from './api/app';
import { startWorker } from './queue/worker';
import { config } from './config/env';
import { pool } from './db/pool';

async function main(): Promise<void> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Starting AI Enrichment Platform',
    node_env: config.NODE_ENV,
    timestamp: new Date().toISOString(),
  }));

  // Verify DB connection on startup
  try {
    await pool.query('SELECT 1');
    console.log(JSON.stringify({
      level: 'info',
      message: 'PostgreSQL connection verified',
      timestamp: new Date().toISOString(),
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Failed to connect to PostgreSQL',
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  }

  // Start the BullMQ worker
  const worker = startWorker();

  // Start the HTTP server
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(JSON.stringify({
      level: 'info',
      message: `HTTP server listening on port ${config.PORT}`,
      timestamp: new Date().toISOString(),
    }));
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  // Ensures in-flight jobs complete before shutdown.
  async function shutdown(signal: string): Promise<void> {
    console.log(JSON.stringify({
      level: 'info',
      message: `Received ${signal} — shutting down gracefully`,
      timestamp: new Date().toISOString(),
    }));

    server.close(async () => {
      await worker.close(); // Wait for in-flight jobs to finish
      await pool.end();
      console.log(JSON.stringify({
        level: 'info',
        message: 'Shutdown complete',
        timestamp: new Date().toISOString(),
      }));
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(JSON.stringify({
    level: 'error',
    message: 'Fatal startup error',
    error: err instanceof Error ? err.message : String(err),
    timestamp: new Date().toISOString(),
  }));
  process.exit(1);
});
