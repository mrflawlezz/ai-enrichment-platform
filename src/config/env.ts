import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  QUEUE_CONCURRENCY: z.coerce.number().default(5),
  MOCK_ENRICHMENT_FAILURE_RATE: z.coerce.number().default(0.2),
  MOCK_ENRICHMENT_MIN_LATENCY_MS: z.coerce.number().default(200),
  MOCK_ENRICHMENT_MAX_LATENCY_MS: z.coerce.number().default(800),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
