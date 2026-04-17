import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { jobsRouter } from './routes/jobs';
import { streamRouter } from './routes/stream';

export function createApp(): express.Application {
  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────────────
  app.use(cors({ origin: '*' }));           // Allow demo.html from any origin (file:// or localhost)
  app.use(express.json({ limit: '10mb' })); // 10mb for large lead batches

  // Serve demo UI at GET /demo
  // process.cwd() = /app in Docker, project root locally — more reliable than __dirname
  const publicDir = path.join(process.cwd(), 'public');
  app.use('/public', express.static(publicDir));
  app.get('/demo', (_req, res) => res.sendFile(path.join(publicDir, 'demo.html')));


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
