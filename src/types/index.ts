// ─── Domain types ─────────────────────────────────────────────────────────────

export type LeadStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface Lead {
  id: string;
  job_id: string;
  name: string;
  email: string;
  company: string;
  status: LeadStatus;
  enrichment_result: EnrichmentResult | null;
  attempt_count: number;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnrichmentResult {
  industry: string;
  company_size: string;
  icp_score: number;
  linkedin_url: string | null;
  enriched_at: string;
  provider: 'mock';
}

export type JobStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface Job {
  id: string;
  status: JobStatus;
  total_leads: number;
  completed_leads: number;
  failed_leads: number;
  created_at: Date;
  updated_at: Date;
}

// ─── API types ────────────────────────────────────────────────────────────────

export interface CreateJobRequest {
  leads: Array<{
    name: string;
    email: string;
    company: string;
  }>;
}

export interface CreateJobResponse {
  job_id: string;
  message: string;
  total_leads: number;
}

export interface GetJobResponse {
  job: Job;
  leads: Lead[];
}

// ─── Queue types ──────────────────────────────────────────────────────────────

export interface EnrichmentJobData {
  lead_id: string;
  job_id: string;
  name: string;
  email: string;
  company: string;
}

// ─── Structured log types ─────────────────────────────────────────────────────

export interface StructuredLog {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  [key: string]: unknown;
}
