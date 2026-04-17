import { Pool, PoolClient } from 'pg';
import { config } from '../config/env';

// Singleton pool — reused across all requests
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,           // max connections in pool
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

pool.on('error', (err) => {
  console.error(JSON.stringify({
    level: 'error',
    message: 'PostgreSQL pool error',
    error: err.message,
    timestamp: new Date().toISOString(),
  }));
});

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

export async function queryOne<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { pool };
