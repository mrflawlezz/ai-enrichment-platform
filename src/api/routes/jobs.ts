import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createEnrichmentJob, createJobSchema } from '../../services/job.service';
import { getJobById, getLeadsByJobId } from '../../repository/lead.repository';
import { GetJobResponse } from '../../types';

export const jobsRouter = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /jobs
 * Accepts a batch of leads, enqueues them for async enrichment.
 * Returns job_id immediately — does NOT block until enrichment completes.
 */
jobsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate input
    const parseResult = createJobSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await createEnrichmentJob(parseResult.data);

    res.status(202).json(result); // 202 Accepted — processing is async
  } catch (err) {
    next(err);
  }
});

/**
 * GET /jobs/:id
 * Returns job status + all lead results.
 * Status options: pending | processing | complete | failed
 */
jobsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Invalid job ID format' });
      return;
    }

    const job = await getJobById(id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const leads = await getLeadsByJobId(id);

    const response: GetJobResponse = { job, leads };
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
});
