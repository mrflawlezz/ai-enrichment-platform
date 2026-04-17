# Bonus C — Multi-Agent Enrichment Pipeline

> **Status:** Prototype implemented. See `src/agents/` directory.
> Full LLM integration hooks documented inline in each agent file.

---

## Architecture

```
                            Lead (name, email, company)
                                        │
                                        ▼
                        ┌───────────────────────────────┐
                        │     EnrichmentOrchestrator     │
                        │                                │
                        │  Manages: PipelineState        │
                        │  Knows: nothing about LLMs     │
                        │  Knows: nothing about HTTP     │
                        │  Knows: agent sequence + rules │
                        └──────────────┬────────────────┘
                                       │
                      ┌────────────────┼────────────────┐
                      │                │                │
                      ▼                ▼                ▼
             ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
             │ ResearchAgent│ │ ScoringAgent │ │FormattingAgent│
             │              │ │              │ │               │
             │ critical: ✅  │ │ critical: ❌ │ │ critical: ❌  │
             │              │ │              │ │               │
             │ LLM call:    │ │ Heuristics + │ │ Template +    │
             │ "What is     │ │ LLM prompt   │ │ LLM format    │
             │ this company?"│ │ for scoring" │ │ polish"       │
             └──────┬───────┘ └──────┬───────┘ └──────┬────────┘
                    │                │                 │
                    └───────Shared PipelineState───────┘
                                       │
                                       ▼
                              OrchestrationResult
                         (complete | partial | failed)
```

### Key design decisions

#### 1. Sequential, not parallel — and why that's correct here

Each agent **depends on the previous agent's output**:
- Scoring requires research (can't score without knowing company size/industry)
- Formatting requires scoring (recommended action depends on ICP score)

You could parallelize Research + a lightweight "company name check" agent, but the main enrichment chain must be sequential. **Premature parallelization would add complexity without throughput gain** — the LLM latency dominates, not the orchestrator overhead.

**When to parallelize:** If you add independent agents (e.g., "EmailVerification" and "PhoneEnrichment") that don't depend on research, those can run in parallel alongside the research stage using `Promise.all()`.

#### 2. Critical vs non-critical agents

```typescript
readonly critical = true;   // ResearchAgent  — pipeline stops on failure
readonly critical = false;  // ScoringAgent   — pipeline continues, partial result
readonly critical = false;  // FormattingAgent — pipeline continues, partial result
```

**Why:** A lead with `icp_score: null` is still useful to the customer — they can see the company was researched. A lead with no research data at all is worthless. The distinction maps directly to customer experience.

#### 3. Orchestrator knows nothing about agents' internals

The orchestrator only:
- Calls `agent.run(state)`
- Merges the returned `Partial<PipelineState>`
- Decides whether to continue based on `agent.critical`

It doesn't read `state.research.industry` or call LLMs directly. This is the clean separation that lets you swap, add, or reorder agents without touching the orchestrator.

#### 4. State as a typed object, not message passing

Each agent reads from `PipelineState` and returns a `Partial<PipelineState>`. The orchestrator merges with spread: `state = { ...state, ...update }`.

This is simpler than LangGraph's full graph for this use case. **LangGraph would be the right choice when:**
- You need conditional branching (e.g., high ICP → trigger outreach agent automatically)
- You need cycles (e.g., formatting agent asks research agent to clarify)
- You need human-in-the-loop checkpoints
- You have 7+ agents with complex dependency graphs

For a 3-agent linear pipeline, a simple state machine is the right tool.

---

## The `SpecialistAgent` Interface

Every agent implements this — the Orchestrator only sees this interface:

```typescript
export interface SpecialistAgent {
  readonly name: string;
  readonly stage: PipelineStage;
  readonly critical: boolean;  // If false, pipeline continues on failure

  run(state: PipelineState): Promise<Partial<PipelineState>>;
}
```

Adding a new agent = implement this interface + add to the `pipeline` array in `orchestrator.ts`. Zero other changes needed.

---

## Pipeline State Machine

```
        init
         │
         ▼ ResearchAgent runs
         │
    ┌────┴──────┐
    │ Success   │ Failure
    ▼           ▼
researching    failed ──────────────────────────────── (terminal)
    │
    ▼ ScoringAgent runs
    │
 ┌──┴──────┐
 │ Success │ Failure (non-critical)
 ▼         ▼
scoring   formatting (continues with research only)
    │
    ▼ FormattingAgent runs
    │
 ┌──┴──────┐
 │ Success │ Failure (non-critical)
 ▼         ▼
complete  partial ──────────────────────────── (terminal, some data available)
```

**Terminal states:**
| State | Meaning | Data available |
|---|---|---|
| `complete` | All 3 agents succeeded | Full enriched profile |
| `partial` | 1+ non-critical agent failed | Partial data (e.g., research only) |
| `failed` | Critical agent (Research) failed | None |

---

## Connecting to the Existing BullMQ Pipeline

The multi-agent orchestrator **replaces the current `mockEnrichLead()` call** in the worker:

```typescript
// BEFORE (worker.ts)
const result = await mockEnrichLead(lead_id, name, email, company);

// AFTER — plugs into the existing pipeline
import { EnrichmentOrchestrator } from '../agents/orchestrator';

const orchestrator = new EnrichmentOrchestrator();
const result = await orchestrator.run({
  leadId:   lead_id,
  jobId:    job_id,
  tenantId: tenantId,
  name,
  email,
  company,
});

// Map result to the existing EnrichmentResult shape
if (result.stage === 'failed') {
  throw new Error(`Agent pipeline failed: ${result.errors[0]?.error}`);
}

const enrichmentResult = {
  industry:       result.data.industry ?? 'unknown',
  company_size:   result.data.estimated_size ?? 'unknown',
  icp_score:      result.data.icp_score ?? 0,
  linkedin_url:   result.data.linkedin_url ?? null,
  enriched_at:    new Date().toISOString(),
  provider:       'multi-agent',
};
```

The orchestrator is a **drop-in replacement** — no changes to the BullMQ infrastructure, DB schema, or API layer.

---

## Adding LangGraph (when to upgrade)

This prototype uses a custom orchestrator. To migrate to LangGraph:

```typescript
// LangGraph version (for complex agentic workflows)
import { StateGraph, END } from '@langchain/langgraph';

const workflow = new StateGraph({ channels: pipelineStateChannels })
  .addNode('research',   researchAgent)
  .addNode('scoring',    scoringAgent)
  .addNode('formatting', formattingAgent)
  .addEdge('__start__',  'research')
  .addConditionalEdges('research', routeAfterResearch,  { scoring: 'scoring', failed: END })
  .addEdge('scoring',    'formatting')
  .addEdge('formatting', END);

const app = workflow.compile();
```

**Migrate when:**
- You need graph-based branching (not linear pipeline)
- You need streaming intermediate agent outputs to the UI
- You need built-in persistence for long-running workflows
- Team size > 5 engineers working on different agents

---

## Observability

Every agent call emits a structured log with `agent`, `stage`, `lead_id`, `job_id`.
The orchestrator logs entry and exit of each agent.

In production, wrap each `agent.run()` with an OTel span:
```typescript
await withEnrichmentSpan({ ...context, enrichmentType: agent.name }, async () => {
  return agent.run(state);
});
```
This gives per-agent latency in Grafana Tempo — you can see exactly which agent is slow.
