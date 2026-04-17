import express, { Request, Response, NextFunction } from 'express';
import { jobsRouter } from './routes/jobs';
import { streamRouter } from './routes/stream';

export function createApp(): express.Application {
  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────────────
  app.use(express.json({ limit: '10mb' })); // 10mb for large lead batches

  // Request logger (structured)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(JSON.stringify({
      level: 'info',
      message: 'Incoming request',
      method: req.method,
      path: req.path,
      timestamp: new Date().toISOString(),
    }));
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/jobs', jobsRouter);    // POST /jobs, GET /jobs/:id
  app.use('/jobs', streamRouter);  // GET  /jobs/:id/stream  (SSE — Bonus A)

  // Health check — used by Docker healthchecks and load balancers
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Global error handler ────────────────────────────────────────────────────
  // Catches errors from next(err) calls — router knows nothing about error formatting
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Unhandled application error',
      error_name: err.name,
      error_message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    }));
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
