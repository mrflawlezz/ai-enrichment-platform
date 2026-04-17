import { z } from 'zod';
import {
  SpecialistAgent,
  PipelineState,
  ResearchOutputSchema,
  AgentError,
} from './types';

/**
 * Research Agent
 *
 * Responsibility: Gather company-level intelligence for a given lead.
 * Uses an LLM to infer industry, size, tech stack, funding stage, and web presence
 * from the company name and email domain.
 *
 * In production, this would also call:
 *   - Clearbit/Apollo for structured company data
 *   - LinkedIn company profile scraping
 *   - Crunchbase for funding data
 *
 * For this prototype, we use an LLM with a structured prompt + Zod validation.
 */
export class ResearchAgent implements SpecialistAgent {
  readonly name = 'ResearchAgent';
  readonly stage = 'researching' as const;
  readonly critical = true; // Without research, scoring is impossible

  async run(state: PipelineState): Promise<Partial<PipelineState>> {
    const { company, email, leadId } = state.context;
    const domain = email.split('@')[1] ?? 'unknown';

    const systemPrompt = `You are a B2B sales intelligence researcher.
Given a company name and domain, infer its industry, employee count range,
technology stack, funding stage, and web presence strength.
Base your analysis on the company name and domain patterns.
You must respond with valid JSON only.`;

    const userPrompt = `Company: ${company}
Domain: ${domain}

Analyze this company and return a JSON object with:
- industry: string (e.g., "SaaS", "FinTech", "E-Commerce")
- estimated_size: one of "1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"
- tech_stack: array of likely technologies (max 5)
- funding_stage: "bootstrapped" | "seed" | "series-a" | "series-b+" | "public" | "unknown"
- web_presence: "strong" | "moderate" | "weak"
- confidence: "high" | "medium" | "low" based on how sure you are`;

    try {
      const raw = await callLLM(systemPrompt, userPrompt);
      const parsed = ResearchOutputSchema.safeParse(raw);

      if (!parsed.success) {
        throw new Error(`Schema mismatch: ${parsed.error.message}`);
      }

      return {
        research: parsed.data,
        stage: 'scoring', // Hand off to scoring agent
      };
    } catch (err) {
      const agentError: AgentError = {
        agent: this.name,
        stage: this.stage,
        error: err instanceof Error ? err.message : String(err),
        recoverable: false, // Research is critical — can't score without it
      };

      return {
        stage: 'failed',
        errors: [...state.errors, agentError],
      };
    }
  }
}

// ─── Lightweight LLM caller (uses the existing mock for the prototype) ─────────
// In production: inject the LLMProvider interface from Section 3

async function callLLM(systemPrompt: string, userPrompt: string): Promise<unknown> {
  // For the prototype, we simulate the LLM call with realistic mock data.
  // In production, replace with:
  //   const provider = new OpenAIProvider(process.env.OPENAI_API_KEY!);
  //   const result = await provider.generate(systemPrompt, userPrompt, ResearchOutputSchema);
  //   return result.data;

  void systemPrompt; // Used in production
  void userPrompt;

  // Simulate async latency
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));

  const industries = ['SaaS', 'FinTech', 'E-Commerce', 'HealthTech', 'EdTech'];
  const sizes = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'] as const;
  const stages = ['bootstrapped', 'seed', 'series-a', 'series-b+'] as const;

  return {
    industry:       industries[Math.floor(Math.random() * industries.length)],
    estimated_size: sizes[Math.floor(Math.random() * sizes.length)],
    tech_stack:     ['React', 'Node.js', 'PostgreSQL'].slice(0, 2 + Math.floor(Math.random() * 2)),
    funding_stage:  stages[Math.floor(Math.random() * stages.length)],
    web_presence:   Math.random() > 0.3 ? 'strong' : 'moderate',
    confidence:     Math.random() > 0.2 ? 'high' : 'medium',
  };
}
