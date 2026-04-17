import {
  SpecialistAgent,
  PipelineState,
  ScoringOutputSchema,
  AgentError,
} from './types';

/**
 * Scoring Agent
 *
 * Responsibility: Compute an ICP (Ideal Customer Profile) score for a lead
 * based on the research output from the Research Agent.
 *
 * Receives: ResearchOutput (industry, size, tech stack, funding stage)
 * Produces: ICP score 0-100, fit classification, rationale, top signals
 *
 * Design: This agent is non-critical. If scoring fails, the pipeline continues
 * and returns the research data with icp_score = null. A partial result is
 * better than no result for the customer.
 */
export class ScoringAgent implements SpecialistAgent {
  readonly name    = 'ScoringAgent';
  readonly stage   = 'scoring' as const;
  readonly critical = false; // Non-critical — partial result still valuable

  async run(state: PipelineState): Promise<Partial<PipelineState>> {
    if (!state.research) {
      // Research agent didn't run — can't score
      return {
        stage: 'partial',
        errors: [...state.errors, {
          agent: this.name,
          stage: this.stage,
          error: 'Cannot score without research output',
          recoverable: true,
        }],
      };
    }

    const { research } = state;

    try {
      // Heuristic scoring — in production this would be an LLM call with:
      //   const result = await provider.generate(systemPrompt, userPrompt, ScoringOutputSchema);
      const score = computeICPScore(research);
      const parsed = ScoringOutputSchema.safeParse(score);

      if (!parsed.success) {
        throw new Error(`Scoring schema mismatch: ${parsed.error.message}`);
      }

      return {
        scoring: parsed.data,
        stage: 'formatting',
      };
    } catch (err) {
      const agentError: AgentError = {
        agent: this.name,
        stage: this.stage,
        error: err instanceof Error ? err.message : String(err),
        recoverable: true, // Non-critical — continue to formatting with partial data
      };
      return {
        stage: 'formatting', // Still continue to formatting
        errors: [...state.errors, agentError],
      };
    }
  }
}

// ─── ICP scoring heuristics ────────────────────────────────────────────────────
// In production: LLM call with structured prompt + ZodSchema validation

interface ResearchForScoring {
  industry: string;
  estimated_size: string;
  funding_stage: string;
  web_presence: string;
  tech_stack: string[];
}

function computeICPScore(research: ResearchForScoring): {
  icp_score: number;
  icp_fit: 'strong' | 'moderate' | 'weak';
  rationale: string;
  top_signals: string[];
} {
  let score = 40; // Baseline
  const signals: string[] = [];

  // Size scoring — enterprise focus
  const sizeBonus: Record<string, number> = {
    '51-200':   15,
    '201-500':  20,
    '501-1000': 25,
    '1000+':    20, // Too big → might be slow sales cycle
  };
  score += sizeBonus[research.estimated_size] ?? 5;
  if ((sizeBonus[research.estimated_size] ?? 0) >= 15) {
    signals.push(`Company size (${research.estimated_size}) matches ICP`);
  }

  // High-value industries
  const highValueIndustries = ['SaaS', 'FinTech', 'HealthTech', 'CyberSecurity'];
  if (highValueIndustries.includes(research.industry)) {
    score += 15;
    signals.push(`Industry (${research.industry}) is high-value`);
  }

  // Funded companies have budget
  if (['series-a', 'series-b+'].includes(research.funding_stage)) {
    score += 10;
    signals.push(`Funding stage (${research.funding_stage}) indicates budget availability`);
  } else if (research.funding_stage === 'public') {
    score += 8;
  }

  // Tech-forward companies adopt new tools faster
  if (research.tech_stack.length >= 3) {
    score += 5;
    signals.push('Tech stack breadth indicates tech-forward organization');
  }

  // Web presence
  if (research.web_presence === 'strong') {
    score += 5;
    signals.push('Strong web presence indicates established business');
  }

  const capped = Math.min(100, Math.max(0, score));
  return {
    icp_score: capped,
    icp_fit:   capped >= 70 ? 'strong' : capped >= 45 ? 'moderate' : 'weak',
    rationale: `Score of ${capped}/100 based on ${signals.length} positive signals`,
    top_signals: signals.slice(0, 5),
  };
}
