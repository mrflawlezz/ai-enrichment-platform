import { z } from 'zod';

// ─── Lead context passed to the orchestrator ──────────────────────────────────

export interface AgentContext {
  leadId: string;
  jobId: string;
  tenantId: string;
  name: string;
  email: string;
  company: string;
}

// ─── Per-agent output schemas (Zod-validated, just like LLM outputs) ──────────

export const ResearchOutputSchema = z.object({
  industry:       z.string(),
  estimated_size: z.enum(['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']),
  tech_stack:     z.array(z.string()).max(10),
  funding_stage:  z.enum(['bootstrapped', 'seed', 'series-a', 'series-b+', 'public', 'unknown']),
  web_presence:   z.enum(['strong', 'moderate', 'weak']),
  confidence:     z.enum(['high', 'medium', 'low']),
});

export const ScoringOutputSchema = z.object({
  icp_score:    z.number().int().min(0).max(100),
  icp_fit:      z.enum(['strong', 'moderate', 'weak']),
  rationale:    z.string().max(300),
  // min(0) not min(1): low-signal leads may have no positive indicators
  // — the rationale string still explains the score
  top_signals:  z.array(z.string()).min(0).max(5),
});

export const FormattingOutputSchema = z.object({
  // z.string() not z.string().url() — constructed LinkedIn slugs can produce
  // technically valid but non-conventional URLs for edge-case company names.
  // URL format is validated at display time, not ingestion time.
  linkedin_url:     z.string().nullable(),
  enriched_summary: z.string().max(500),
  recommended_action: z.enum(['book_demo', 'nurture', 'disqualify']),
  tags:             z.array(z.string()).max(10),
});

export type ResearchOutput  = z.infer<typeof ResearchOutputSchema>;
export type ScoringOutput   = z.infer<typeof ScoringOutputSchema>;
export type FormattingOutput = z.infer<typeof FormattingOutputSchema>;

// ─── Pipeline state machine ────────────────────────────────────────────────────

export type PipelineStage =
  | 'init'
  | 'researching'
  | 'scoring'
  | 'formatting'
  | 'complete'
  | 'partial'   // Some agents failed — partial result returned
  | 'failed';   // All critical agents failed — no usable result

export interface AgentError {
  agent: string;
  stage: PipelineStage;
  error: string;
  recoverable: boolean;  // If true, pipeline continues with partial data
}

/**
 * Typed state object shared across the pipeline.
 * Each agent reads its inputs from state and writes its output back.
 * The orchestrator never inspects agent internals — only reads the state.
 */
export interface PipelineState {
  context: AgentContext;
  stage: PipelineStage;

  // Outputs written by each specialist agent (optional — may be missing if agent failed)
  research?:   ResearchOutput;
  scoring?:    ScoringOutput;
  formatting?: FormattingOutput;

  // Error log — doesn't stop pipeline unless the failed agent is critical
  errors: AgentError[];

  // Timing for observability
  startedAt: string;
  completedAt?: string;
}

// ─── Agent interface ────────────────────────────────────────────────────────────

/**
 * Every specialist agent implements this interface.
 * The orchestrator calls run() and passes the full current state.
 * Agents must not modify state directly — they return a partial state update.
 */
export interface SpecialistAgent {
  readonly name: string;
  readonly stage: PipelineStage;
  readonly critical: boolean;  // If false, pipeline continues even if this agent fails

  run(state: PipelineState): Promise<Partial<PipelineState>>;
}
