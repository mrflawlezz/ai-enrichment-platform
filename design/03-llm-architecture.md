# Section 3 — LLM Integration Layer: Model-Agnostic Design

## The Problem

The platform needs LLMs to generate structured enrichment data. The system must work across OpenAI, Anthropic, and Mistral/Groq without upstream code knowing which provider is active.

---

## Provider Abstraction — Interface + Adapter Pattern

### Core Interface

```typescript
import { z } from 'zod';

// ─── LLM Provider Interface ───────────────────────────────────────────────────

export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface LLMResult<T> {
  data: T;
  usage: LLMUsage;
  provider: string;
  modelId: string;
  durationMs: number;
}

/**
 * Core provider interface — every LLM adapter implements this.
 * The generic T is the expected output shape, validated by a Zod schema.
 * Upstream code never calls OpenAI or Anthropic directly.
 */
export interface LLMProvider {
  readonly name: string;
  readonly modelId: string;

  /**
   * Generate structured output from a prompt.
   * @param systemPrompt - Role/instructions for the model
   * @param userPrompt   - The actual input
   * @param schema       - Zod schema to validate the response
   * @param opts         - Optional overrides (temperature, maxTokens)
   */
  generate<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
    opts?: LLMOptions
  ): Promise<LLMResult<T>>;
}

/**
 * Typed error hierarchy — upstream can catch and classify without knowing
 * which provider threw the error.
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly code: LLMErrorCode,
    public readonly provider: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export type LLMErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INVALID_RESPONSE'
  | 'SCHEMA_MISMATCH'
  | 'AUTH_ERROR'
  | 'QUOTA_EXCEEDED';
```

### OpenAI Adapter

```typescript
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly modelId: string;

  constructor(
    private readonly apiKey: string,
    modelId = 'gpt-5.4-mini'  // April 2026 — economy tier default (fast, lowest cost/token)
  ) {
    this.modelId = modelId;
  }

  async generate<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
    opts?: LLMOptions
  ): Promise<LLMResult<T>> {
    const start = Date.now();

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 15_000),
      body: JSON.stringify({
        model: this.modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        // OpenAI JSON mode — forces valid JSON output
        response_format: { type: 'json_object' },
        max_tokens: opts?.maxTokens ?? 512,
        temperature: opts?.temperature ?? 0.1,
      }),
    });

    if (!response.ok) {
      throw this.mapHttpError(response.status);
    }

    const raw = await response.json();
    const content = raw.choices[0]?.message?.content;

    return {
      data: this.parseAndValidate(content, schema),
      usage: {
        inputTokens:  raw.usage.prompt_tokens,
        outputTokens: raw.usage.completion_tokens,
        estimatedCostUsd: this.estimateCost(raw.usage, this.modelId),
      },
      provider: this.name,
      modelId: this.modelId,
      durationMs: Date.now() - start,
    };
  }

  private parseAndValidate<T>(content: string | null, schema: z.ZodSchema<T>): T {
    if (!content) {
      throw new LLMError('Empty response', 'INVALID_RESPONSE', this.name, true);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new LLMError(`Non-JSON response: ${content.slice(0, 100)}`, 'INVALID_RESPONSE', this.name, true);
    }

    // Zod validation — not blind JSON.parse()
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new LLMError(
        `Schema mismatch: ${result.error.message}`,
        'SCHEMA_MISMATCH',
        this.name,
        true  // Retry — might be a fluke
      );
    }

    return result.data;
  }

  private mapHttpError(status: number): LLMError {
    if (status === 429) return new LLMError('Rate limited', 'RATE_LIMITED', this.name, true);
    if (status === 401) return new LLMError('Auth error', 'AUTH_ERROR', this.name, false);
    if (status === 402) return new LLMError('Quota exceeded', 'QUOTA_EXCEEDED', this.name, false);
    return new LLMError(`HTTP ${status}`, 'INVALID_RESPONSE', this.name, status >= 500);
  }

  private estimateCost(usage: { prompt_tokens: number; completion_tokens: number }, model: string): number {
    // OpenAI pricing as of April 2026
    const rates: Record<string, { input: number; output: number }> = {
      'gpt-5.4-mini': { input: 0.00010, output: 0.00040 },   // Economy — lowest cost
      'gpt-4o':       { input: 0.00250, output: 0.01000 },   // Standard reference
      'o3':           { input: 0.01000, output: 0.04000 },   // Premium reasoning
    };
    const rate = rates[model] ?? { input: 0.001, output: 0.002 };
    return (usage.prompt_tokens / 1000) * rate.input + (usage.completion_tokens / 1000) * rate.output;
  }
}
```

### Anthropic Adapter

```typescript
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly modelId: string;

  constructor(
    private readonly apiKey: string,
    modelId = 'claude-haiku-4-5'  // April 2026 standard Anthropic model
  ) {
    this.modelId = modelId;
  }

  async generate<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
    opts?: LLMOptions
  ): Promise<LLMResult<T>> {
    const start = Date.now();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 15_000),
      body: JSON.stringify({
        model: this.modelId,
        // Anthropic requires JSON instruction in the system prompt — there is no
        // separate response_format flag like OpenAI. We append the instruction here
        // so the caller's system prompt doesn't need to know which provider is active.
        system: systemPrompt + '\n\nYou must respond with valid JSON only. No markdown, no explanation — only a raw JSON object.',
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: opts?.maxTokens ?? 512,
        temperature: opts?.temperature ?? 0.1,
      }),
    });

    if (!response.ok) {
      throw this.mapHttpError(response.status);
    }

    const raw = await response.json();
    // Anthropic response structure differs from OpenAI — adapter handles this
    const content = raw.content[0]?.text;

    return {
      data: this.parseAndValidate(content, schema),
      usage: {
        inputTokens:  raw.usage.input_tokens,
        outputTokens: raw.usage.output_tokens,
        estimatedCostUsd: this.estimateCost(raw.usage, this.modelId),
      },
      provider: this.name,
      modelId: this.modelId,
      durationMs: Date.now() - start,
    };
  }

  private parseAndValidate<T>(content: string | null, schema: z.ZodSchema<T>): T {
    // Same pattern as OpenAI adapter
    if (!content) throw new LLMError('Empty response', 'INVALID_RESPONSE', this.name, true);
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { throw new LLMError('Non-JSON response', 'INVALID_RESPONSE', this.name, true); }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new LLMError(`Schema mismatch: ${result.error.message}`, 'SCHEMA_MISMATCH', this.name, true);
    return result.data;
  }

  private mapHttpError(status: number): LLMError {
    if (status === 429) return new LLMError('Rate limited', 'RATE_LIMITED', this.name, true);
    if (status === 401) return new LLMError('Auth error', 'AUTH_ERROR', this.name, false);
    if (status === 529) return new LLMError('Anthropic overloaded', 'RATE_LIMITED', this.name, true);
    return new LLMError(`HTTP ${status}`, 'INVALID_RESPONSE', this.name, status >= 500);
  }

  private estimateCost(usage: { input_tokens: number; output_tokens: number }, model: string): number {
    // Anthropic pricing as of April 2026 (per 1M tokens)
    const rates: Record<string, { input: number; output: number }> = {
      'claude-haiku-4-5':   { input: 0.00080, output: 0.00400 },  // Standard — best ROI
      'claude-opus-4-6':    { input: 0.01500, output: 0.07500 },  // Premium — enterprise
      'claude-opus-4-7':    { input: 0.01800, output: 0.09000 },  // Cutting edge (Apr 16 2026)
    };
    const rate = rates[model] ?? { input: 0.003, output: 0.015 };
    return (usage.input_tokens / 1_000_000) * rate.input
         + (usage.output_tokens / 1_000_000) * rate.output;
  }
}
```

### Factory + Fallback Chain

```typescript
export type ProviderConfig =
  | { type: 'openai';    apiKey: string; modelId?: string }
  | { type: 'anthropic'; apiKey: string; modelId?: string }
  | { type: 'mistral';   apiKey: string; modelId?: string };

export class LLMProviderFactory {
  static create(config: ProviderConfig): LLMProvider {
    switch (config.type) {
      case 'openai':    return new OpenAIProvider(config.apiKey, config.modelId);
      case 'anthropic': return new AnthropicProvider(config.apiKey, config.modelId);
      default: throw new Error(`Unknown provider: ${config.type}`);
    }
  }
}

/**
 * Fallback chain — tries providers in order until one succeeds.
 * Upstream code calls this identically to a direct provider.
 */
export class FallbackLLMProvider implements LLMProvider {
  readonly name = 'fallback-chain';
  readonly modelId = 'multi-provider';

  constructor(private readonly providers: LLMProvider[]) {
    if (providers.length === 0) throw new Error('FallbackLLMProvider requires at least one provider');
  }

  async generate<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
    opts?: LLMOptions
  ): Promise<LLMResult<T>> {
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        return await provider.generate(systemPrompt, userPrompt, schema, opts);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't try next provider if it's a permanent error (auth, quota)
        if (err instanceof LLMError && !err.retryable) throw err;

        console.warn(JSON.stringify({
          level: 'warn',
          message: 'LLM provider failed, trying next',
          failed_provider: provider.name,
          error: lastError.message,
          timestamp: new Date().toISOString(),
        }));
      }
    }

    throw lastError ?? new Error('All LLM providers failed');
  }
}
```

---

## Provider Configuration

**Per-tenant setting (preferred for multi-tenant):**

```typescript
// Stored in tenants table:
// llm_provider: 'openai' | 'anthropic' | 'mistral'
// llm_api_key: encrypted in DB (AES-256-GCM)

const tenantConfig = await getTenantConfig(tenantId);
const provider = LLMProviderFactory.create({
  type: tenantConfig.llm_provider,
  apiKey: decrypt(tenantConfig.llm_api_key),
});
```

**Platform-level fallback (shared key):**
```env
LLM_PRIMARY_PROVIDER=openai
LLM_FALLBACK_PROVIDER=anthropic
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Structured Outputs

**Strategy: Zod schema validation — NOT blind JSON.parse()**

```typescript
// Example: ICP scoring schema
const ICPScoreSchema = z.object({
  industry: z.string(),
  size_bracket: z.enum(['1-10', '11-50', '51-200', '201-500', '501+']),
  icp_score: z.number().int().min(0).max(100),
  icp_fit: z.enum(['strong', 'moderate', 'weak']),
  summary: z.string().max(500),
});

type ICPScore = z.infer<typeof ICPScoreSchema>;

// Usage
const result = await provider.generate<ICPScore>(
  'You are a B2B sales intelligence analyst...',
  `Company: ${company}, LinkedIn: ${linkedinUrl}`,
  ICPScoreSchema
);
// result.data is fully typed — TypeScript knows the shape
```

**What happens when the schema doesn't match:**
1. First: retry (LLMs can output inconsistent JSON)
2. After N retries: fall back to next provider
3. Final fallback: mark enrichment as `partial` with `icp_score: null` — incomplete data is better than no data for the customer

---

## Hallucination Handling

Hallucinations are a **data integrity problem**, not just a model problem.

**Mitigation strategies:**
1. **Schema constraints:** `size_bracket` is an enum — the LLM can't invent a new value
2. **Cross-reference:** After enrichment, compare `industry` claim against Clearbit's industry field. Divergence > 80% → flag for human review
3. **Confidence field:** Require the LLM to output `confidence: 'high' | 'medium' | 'low'`. Low-confidence records get a `needs_review` flag in the DB
4. **Provenance tracking:** Every enrichment result stores `provider: 'openai'` + `model_id` — so if a model version starts hallucinating, we can quarantine affected records
