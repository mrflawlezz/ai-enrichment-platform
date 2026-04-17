-- ─── Migration 001: Initial schema ──────────────────────────────────────────
-- Multi-tenant AI enrichment platform
-- Created: 2026-04-17

-- UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Jobs table (batch-level tracking) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  total_leads     INTEGER NOT NULL DEFAULT 0,
  completed_leads INTEGER NOT NULL DEFAULT 0,
  failed_leads    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Leads table (individual lead tracking) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id            UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  company           TEXT NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  enrichment_result JSONB,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes for performance ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_leads_job_id    ON leads(job_id);
CREATE INDEX IF NOT EXISTS idx_leads_status    ON leads(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_leads_email     ON leads(email);

-- ─── Auto-update updated_at trigger ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
