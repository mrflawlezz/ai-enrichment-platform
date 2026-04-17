import {
  AgentContext,
  PipelineState,
  SpecialistAgent,
  PipelineStage,
} from './types';
import { ResearchAgent } from './research.agent';
import { ScoringAgent } from './scoring.agent';
import { FormattingAgent } from './formatting.agent';

// ─── Orchestrator result ───────────────────────────────────────────────────────

export interface OrchestrationResult {
  leadId: string;
  stage: PipelineStage;           // Terminal stage: complete | partial | failed
  data: {
    industry?:            string;
    estimated_size?:      string;
    tech_stack?:          string[];
    funding_stage?:       string;
    icp_score?:           number;
    icp_fit?:             'strong' | 'moderate' | 'weak';
    icp_rationale?:       string;
    top_signals?:         string[];
    linkedin_url?:        string | null;
    enriched_summary?:    string;
    recommended_action?:  'book_demo' | 'nurture' | 'disqualify';
    tags?:                string[];
  };
  errors: Array<{ agent: string; error: string }>;
  durationMs: number;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * EnrichmentOrchestrator
 *
 * Manages the multi-agent enrichment pipeline for a single lead.
 *
 * Agent pipeline (sequential — each agent receives the output of the previous):
 *
 *   AgentContext
 *       │
 *       ▼
 *   ResearchAgent  (CRITICAL)
 *   "What is this company?"
 *       │
 *       ▼  (only if research succeeded)
 *   ScoringAgent   (NON-CRITICAL)
 *   "How well does this company fit our ICP?"
 *       │
 *       ▼  (always runs, uses whatever data is available)
 *   FormattingAgent (NON-CRITICAL)
 *   "Format the final enriched profile for the customer"
 *       │
 *       ▼
 *   OrchestrationResult
 *
 * Error handling strategy:
 *   - CRITICAL agents (Research): failure → stage 'failed', pipeline stops
 *   - NON-CRITICAL agents (Scoring, Formatting): failure → stage 'partial',
 *     pipeline continues with whatever data is available
 *
 * The orchestrator itself doesn't know about LLMs, databases, or HTTP.
 * It only knows about agents and state.
 */
export class EnrichmentOrchestrator {
  /**
   * Agent pipeline definition.
   * Order matters — each agent can read outputs of all previous agents.
   */
  private readonly pipeline: SpecialistAgent[] = [
    new ResearchAgent(),
    new ScoringAgent(),
    new FormattingAgent(),
  ];

  /**
   * Run the enrichment pipeline for a single lead.
   * Returns a structured result regardless of individual agent failures.
   */
  async run(context: AgentContext): Promise<OrchestrationResult> {
    const startedAt = Date.now();

    // Initialize pipeline state
    let state: PipelineState = {
      context,
      stage: 'init',
      errors: [],
      startedAt: new Date().toISOString(),
    };

    // ── Run agents sequentially ──────────────────────────────────────────────
    for (const agent of this.pipeline) {
      // Skip if pipeline already in terminal failure state
      if (state.stage === 'failed') break;

      try {
        const update = await agent.run(state);
        state = { ...state, ...update };

        structuredLog('info', `Agent ${agent.name} completed`, {
          lead_id: context.leadId,
          job_id: context.jobId,
          agent: agent.name,
          stage: state.stage,
          had_errors: state.errors.length > 0,
        });
      } catch (err) {
        // Unexpected error from agent (not caught internally by the agent)
        const message = err instanceof Error ? err.message : String(err);

        structuredLog('error', `Agent ${agent.name} threw unexpectedly`, {
          lead_id: context.leadId,
          agent: agent.name,
          error: message,
        });

        state.errors.push({
          agent: agent.name,
          stage: agent.stage,
          error: message,
          recoverable: !agent.critical,
        });

        state.stage = agent.critical ? 'failed' : 'partial';
      }
    }

    // Mark completion time
    state.completedAt = new Date().toISOString();

    return this.buildResult(state, Date.now() - startedAt);
  }

  /**
   * Merge pipeline state into a flat result object.
   * Non-critical fields are optional — caller handles undefined gracefully.
   */
  private buildResult(state: PipelineState, durationMs: number): OrchestrationResult {
    return {
      leadId:    state.context.leadId,
      stage:     state.stage === 'init' ? 'failed' : state.stage,
      durationMs,
      data: {
        // Research outputs
        industry:       state.research?.industry,
        estimated_size: state.research?.estimated_size,
        tech_stack:     state.research?.tech_stack,
        funding_stage:  state.research?.funding_stage,

        // Scoring outputs
        icp_score:    state.scoring?.icp_score,
        icp_fit:      state.scoring?.icp_fit,
        icp_rationale: state.scoring?.rationale,
        top_signals:  state.scoring?.top_signals,

        // Formatting outputs
        linkedin_url:        state.formatting?.linkedin_url,
        enriched_summary:    state.formatting?.enriched_summary,
        recommended_action:  state.formatting?.recommended_action,
        tags:                state.formatting?.tags,
      },
      errors: state.errors.map((e) => ({ agent: e.agent, error: e.error })),
    };
  }
}

// ─── Structured logger (same pattern as the rest of the codebase) ──────────────

function structuredLog(
  level: 'info' | 'warn' | 'error',
  message: string,
  meta: Record<string, unknown>
): void {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta }));
}
