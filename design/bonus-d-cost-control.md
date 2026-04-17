# Bonus D — Cost Control Layer for LLM Calls

> **Status:** Design document. Implementation would extend the LLM provider layer from Section 3.

---

## The Problem

LLM calls are the highest per-unit cost in the platform. At 10M leads/month with no controls:
- If every lead gets GPT-4o: ~$250K/month
- If every lead gets GPT-4o-mini: ~$1,500/month
- Reality: most leads need simple classification, a few need deep analysis

The goal is a **cost-aware routing layer** that automatically picks the right model for each lead, enforces per-tenant budgets, alerts before exhaustion, and degrades gracefully when a budget runs out.

---

## Cost-Aware Model Routing

### Complexity scoring before LLM dispatch

Before calling any LLM, we score the lead's enrichment complexity. This happens synchronously in the worker (microseconds, no API call).

```typescript
// src/services/llm-router.service.ts

export type LLMTier = 'economy' | 'standard' | 'premium';

export interface LeadComplexitySignals {
  companySize: string | null;       // '1000+' = large enterprise
  icpScoreHint: number | null;      // pre-computed from company name heuristics
  hasLinkedIn: boolean;
  tenantPlan: 'starter' | 'growth' | 'enterprise';
  enrichmentType: 'icp_score' | 'persona_analysis' | 'full_profile';
}

/**
 * Determines which LLM tier to use for a given lead.
 * No external API calls — pure heuristic logic.
 *
 * Routing logic:
 *   premium  → large enterprise accounts, full profile requests, enterprise tenants
 *   standard → mid-market, persona analysis
 *   economy  → SMB, simple ICP scoring, high-volume starter tenants
 */
export function routeToTier(signals: LeadComplexitySignals): LLMTier {
  // Enterprise tenants always get premium (it's in their SLA)
  if (signals.tenantPlan === 'enterprise') return 'premium';

  // Full profile enrichment always needs a capable model
  if (signals.enrichmentType === 'full_profile') return 'premium';

  // Large companies with LinkedIn = high-value lead, worth the premium call
  if (signals.companySize === '1000+' && signals.hasLinkedIn) return 'premium';

  // Mid-market persona analysis = standard
  if (
    signals.enrichmentType === 'persona_analysis' &&
    ['201-500', '501-1000'].includes(signals.companySize ?? '')
  ) return 'standard';

  // Everything else = economy
  return 'economy';
}

// Model mapping per tier (environment-configurable)
export const TIER_MODELS: Record<LLMTier, { provider: 'openai' | 'anthropic'; modelId: string; costPer1kInput: number; costPer1kOutput: number }> = {
  economy:  { provider: 'openai',    modelId: 'gpt-4o-mini',               costPer1kInput: 0.00015, costPer1kOutput: 0.0006 },
  standard: { provider: 'anthropic', modelId: 'claude-3-5-haiku-20241022', costPer1kInput: 0.0008,  costPer1kOutput: 0.004  },
  premium:  { provider: 'openai',    modelId: 'gpt-4o',                    costPer1kInput: 0.0025,  costPer1kOutput: 0.010  },
};
```

---

## Per-Tenant Budget Enforcement

### Database schema

```sql
CREATE TABLE tenant_llm_budgets (
  tenant_id        UUID PRIMARY KEY REFERENCES tenants(id),
  monthly_limit_usd NUMERIC(10,4) NOT NULL DEFAULT 100.00,
  current_spend_usd NUMERIC(10,4) NOT NULL DEFAULT 0.00,
  alert_threshold   NUMERIC(3,2)  NOT NULL DEFAULT 0.80,  -- alert at 80%
  budget_period     TEXT          NOT NULL DEFAULT 'monthly',
  period_start      DATE          NOT NULL DEFAULT date_trunc('month', NOW()),
  status            TEXT          NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'warned', 'exhausted')),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Track every LLM call for auditability
CREATE TABLE llm_usage_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  lead_id         UUID REFERENCES leads(id),
  job_id          UUID REFERENCES jobs(id),
  tier            TEXT NOT NULL,              -- economy | standard | premium
  provider        TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cost_usd        NUMERIC(10,6) NOT NULL,
  enrichment_type TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_llm_usage_tenant_period ON llm_usage_log(tenant_id, created_at DESC);
```

### Budget check + reservation pattern

```typescript
// src/services/budget.service.ts

export type BudgetCheckResult =
  | { allowed: true;  tier: LLMTier }
  | { allowed: false; reason: 'exhausted' | 'degraded' }

/**
 * Check if tenant has remaining budget and return the appropriate tier.
 * Uses an optimistic spend reservation to avoid race conditions:
 *   1. Read current spend
 *   2. If within budget → allow, reserve the estimated cost
 *   3. At call completion → update with actual cost (may differ from estimate)
 *
 * This is NOT a locking pattern — we accept minor budget overruns (< 5%)
 * rather than serializing every LLM call through a lock.
 */
export async function checkAndReserveBudget(
  tenantId: string,
  requestedTier: LLMTier,
  estimatedCostUsd: number
): Promise<BudgetCheckResult> {
  const budget = await queryOne<TenantBudget>(
    `SELECT * FROM tenant_llm_budgets WHERE tenant_id = $1`,
    [tenantId]
  );

  if (!budget) return { allowed: true, tier: requestedTier }; // No budget set = no limit

  if (budget.status === 'exhausted') {
    // Graceful degradation: downgrade to economy if not already, otherwise deny
    if (requestedTier !== 'economy') {
      return { allowed: true, tier: 'economy' }; // Silently downgrade
    }
    return { allowed: false, reason: 'exhausted' };
  }

  const projectedSpend = Number(budget.current_spend_usd) + estimatedCostUsd;
  const limit = Number(budget.monthly_limit_usd);

  if (projectedSpend > limit) {
    // Over budget entirely
    await updateBudgetStatus(tenantId, 'exhausted');
    return { allowed: false, reason: 'exhausted' };
  }

  // Between 80% and 100% — warn and downgrade tier if possible
  if (projectedSpend / limit >= Number(budget.alert_threshold)) {
    if (budget.status === 'active') {
      await updateBudgetStatus(tenantId, 'warned');
      await sendBudgetAlert(tenantId, projectedSpend, limit); // async, fire-and-forget
    }
    // Downgrade tier to stretch the remaining budget
    const downgradedTier = requestedTier === 'premium' ? 'standard'
                         : requestedTier === 'standard' ? 'economy'
                         : 'economy';
    return { allowed: true, tier: downgradedTier };
  }

  return { allowed: true, tier: requestedTier };
}

export async function recordActualSpend(
  tenantId: string,
  leadId: string,
  jobId: string,
  usage: LLMUsage // from the provider adapter
): Promise<void> {
  await withTransaction(async (client) => {
    // Log the call
    await client.query(
      `INSERT INTO llm_usage_log
         (tenant_id, lead_id, job_id, tier, provider, model_id, input_tokens, output_tokens, cost_usd, enrichment_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, leadId, jobId, usage.tier, usage.provider, usage.modelId,
       usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd, usage.enrichmentType]
    );

    // Update running total
    await client.query(
      `UPDATE tenant_llm_budgets
       SET current_spend_usd = current_spend_usd + $1,
           updated_at = NOW()
       WHERE tenant_id = $2`,
      [usage.estimatedCostUsd, tenantId]
    );
  });
}
```

---

## Alert System

### 80% threshold alert

```typescript
// src/services/alerts.service.ts

async function sendBudgetAlert(tenantId: string, currentSpend: number, limit: number): Promise<void> {
  const pct = Math.round((currentSpend / limit) * 100);
  const remaining = (limit - currentSpend).toFixed(4);

  // Structured log → triggers alert pipeline (PagerDuty / Slack via log aggregator)
  console.warn(JSON.stringify({
    level: 'warn',
    alert_type: 'LLM_BUDGET_THRESHOLD',
    tenant_id: tenantId,
    spend_usd: currentSpend.toFixed(4),
    limit_usd: limit.toFixed(2),
    utilization_pct: pct,
    remaining_usd: remaining,
    message: `Tenant ${tenantId} has used ${pct}% of monthly LLM budget. $${remaining} remaining.`,
    timestamp: new Date().toISOString(),
  }));

  // Could also POST to Slack webhook, send email via SendGrid, etc.
  // Kept out of scope here — the log alert is the reliable trigger.
}
```

---

## Graceful Degradation Tiers

| Budget Status | Requested Tier | Actual Tier Served | Notes |
|---|---|---|---|
| `active` | `premium` | `premium` | Full service |
| `active` | `economy` | `economy` | Full service |
| `warned` (>80%) | `premium` | `standard` | Auto-downgrade to stretch budget |
| `warned` (>80%) | `standard` | `economy` | Auto-downgrade |
| `exhausted` | `premium` | `economy` | Max degradation attempt |
| `exhausted` | `economy` | **denied** | Mark lead `failed`, not retried |

**Design philosophy:** A lead marked `failed` due to budget exhaustion is distinguishable from a provider error by the `error_message = 'LLM budget exhausted'` field. The customer can see exactly why enrichment stopped — not a mystery failure.

---

## Budget Reset (Monthly Cron)

```sql
-- Runs on the 1st of each month at 00:00 UTC
UPDATE tenant_llm_budgets
SET current_spend_usd = 0,
    period_start = date_trunc('month', NOW()),
    status = 'active',
    updated_at = NOW();
```

---

## Per-Tenant Cost Dashboard (What I'd Build)

**Query for a tenant's cost breakdown this month:**
```sql
SELECT
  model_id,
  tier,
  COUNT(*)               AS calls,
  SUM(input_tokens)      AS total_input_tokens,
  SUM(output_tokens)     AS total_output_tokens,
  SUM(cost_usd)          AS total_cost_usd,
  AVG(cost_usd)          AS avg_cost_per_call
FROM llm_usage_log
WHERE tenant_id = $1
  AND created_at >= date_trunc('month', NOW())
GROUP BY model_id, tier
ORDER BY total_cost_usd DESC;
```

**Surfaced via API:** `GET /billing/llm-usage` (tenant-scoped via RLS) — usable in a Metabase dashboard or built-in tenant portal.
