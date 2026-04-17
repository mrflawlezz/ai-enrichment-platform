import { config } from '../config/env';
import { EnrichmentResult } from '../types';

function log(level: 'info' | 'warn' | 'error', message: string, meta: Record<string, unknown> = {}): void {
  const line = { level, message, timestamp: new Date().toISOString(), ...meta };
  // Always structured JSON — easily parseable by Datadog, CloudWatch, etc.
  console.log(JSON.stringify(line));
}

/**
 * Simulates a third-party enrichment API (Clearbit, Apollo, etc.)
 *
 * Design decisions:
 * - 200-800ms random latency (as specified)
 * - 20% failure rate (as specified)
 * - Returns structured EnrichmentResult on success
 * - Throws typed error on failure for BullMQ retry logic
 */
export async function mockEnrichLead(
  leadId: string,
  name: string,
  email: string,
  company: string
): Promise<EnrichmentResult> {
  // Simulate network latency
  const latency =
    config.MOCK_ENRICHMENT_MIN_LATENCY_MS +
    Math.random() *
      (config.MOCK_ENRICHMENT_MAX_LATENCY_MS - config.MOCK_ENRICHMENT_MIN_LATENCY_MS);

  await sleep(latency);

  // Simulate 20% failure rate
  if (Math.random() < config.MOCK_ENRICHMENT_FAILURE_RATE) {
    const error = new EnrichmentProviderError(
      `Provider timeout for lead ${leadId} (${email})`,
      'PROVIDER_TIMEOUT',
      503
    );
    log('warn', 'Enrichment provider simulated failure', {
      lead_id: leadId,
      email,
      company,
      error_code: error.code,
      http_status: error.httpStatus,
    });
    throw error;
  }

  // Generate mock enrichment data
  const result: EnrichmentResult = {
    industry: pickRandom(INDUSTRIES),
    company_size: pickRandom(COMPANY_SIZES),
    icp_score: Math.round(40 + Math.random() * 60), // 40-100
    linkedin_url: `https://linkedin.com/company/${company.toLowerCase().replace(/\s+/g, '-')}`,
    enriched_at: new Date().toISOString(),
    provider: 'mock',
  };

  log('info', 'Lead enriched successfully', {
    lead_id: leadId,
    email,
    company,
    icp_score: result.icp_score,
    industry: result.industry,
    latency_ms: Math.round(latency),
  });

  return result;
}

// ─── Typed error class ────────────────────────────────────────────────────────

export class EnrichmentProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number
  ) {
    super(message);
    this.name = 'EnrichmentProviderError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const INDUSTRIES = [
  'SaaS',
  'FinTech',
  'HealthTech',
  'E-Commerce',
  'Manufacturing',
  'Logistics',
  'EdTech',
  'CyberSecurity',
  'Real Estate',
  'Marketing Technology',
];

const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
