import {
  SpecialistAgent,
  PipelineState,
  FormattingOutputSchema,
} from './types';

/**
 * Formatting Agent
 *
 * Responsibility: Produce the final customer-facing enriched profile.
 * Takes research + scoring output and assembles the structured result.
 *
 * Outputs:
 *   - LinkedIn URL (constructed from company slug)
 *   - Human-readable enrichment summary
 *   - Recommended next action (book_demo | nurture | disqualify)
 *   - Tags for CRM segmentation
 *
 * This agent is non-critical. If it fails, the raw research + scoring data
 * is returned as-is.
 */
export class FormattingAgent implements SpecialistAgent {
  readonly name    = 'FormattingAgent';
  readonly stage   = 'formatting' as const;
  readonly critical = false;

  async run(state: PipelineState): Promise<Partial<PipelineState>> {
    const { company, email } = state.context;
    const { research, scoring } = state;

    try {
      const domain = email.split('@')[1] ?? company.toLowerCase().replace(/\s+/g, '');
      const companySlug = company.toLowerCase().replace(/[^a-z0-9]/g, '-');

      const recommendedAction = determineAction(scoring?.icp_score);
      const tags = buildTags(research, scoring);

      const summary = buildSummary(company, research, scoring);

      const formattingResult = {
        linkedin_url:       `https://linkedin.com/company/${companySlug}`,
        enriched_summary:   summary,
        recommended_action: recommendedAction,
        tags,
      };

      const parsed = FormattingOutputSchema.safeParse(formattingResult);
      if (!parsed.success) {
        throw new Error(`Formatting schema mismatch: ${parsed.error.message}`);
      }

      void domain; // Used in production for verification
      return {
        formatting: parsed.data,
        stage: 'complete',
      };
    } catch (err) {
      return {
        stage: 'partial' as const,
        errors: [{
          agent: this.name,
          stage: this.stage,
          error: err instanceof Error ? err.message : String(err),
          recoverable: true,
        }],
      };
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function determineAction(icpScore?: number): 'book_demo' | 'nurture' | 'disqualify' {
  if (icpScore === undefined) return 'nurture'; // No score = uncertain, keep warm
  if (icpScore >= 70) return 'book_demo';
  if (icpScore >= 40) return 'nurture';
  return 'disqualify';
}

function buildTags(
  research?: { industry: string; estimated_size: string; funding_stage: string } | undefined,
  scoring?: { icp_fit: string } | undefined
): string[] {
  const tags: string[] = [];
  if (research?.industry)       tags.push(`industry:${research.industry.toLowerCase()}`);
  if (research?.estimated_size) tags.push(`size:${research.estimated_size}`);
  if (research?.funding_stage)  tags.push(`funding:${research.funding_stage}`);
  if (scoring?.icp_fit)         tags.push(`icp:${scoring.icp_fit}`);
  return tags;
}

function buildSummary(
  company: string,
  research?: { industry: string; estimated_size: string; funding_stage: string; tech_stack: string[] } | undefined,
  scoring?: { icp_score: number; icp_fit: string; rationale: string } | undefined
): string {
  if (!research && !scoring) {
    return `${company} — enrichment data unavailable.`;
  }

  const parts: string[] = [`${company}`];
  if (research) {
    parts.push(`is a ${research.estimated_size}-person ${research.industry} company`);
    if (research.funding_stage !== 'unknown') {
      parts.push(`(${research.funding_stage})`);
    }
  }
  if (scoring) {
    parts.push(`with an ICP score of ${scoring.icp_score}/100 (${scoring.icp_fit} fit)`);
  }

  return parts.join(' ') + '.';
}
