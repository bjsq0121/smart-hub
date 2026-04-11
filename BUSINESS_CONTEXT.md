# Business Context

## Owner

- Solo developer
- Building with Codex, Claude Code, n8n
- Goal: earn revenue with API-driven products and automation

## Current Stack

- GCP for infrastructure
- n8n server already running on GCP
- Korea Investment & Securities API
- Upbit API
- Smart Hub project as the main product surface

## Working Assumptions

- Speed matters
- Low-ops architecture is preferred
- Reusable automation is more important than one-off scripts
- Shipping and validation matter more than perfect architecture

## My Role

- Think like a technical co-founder and operator
- Help with product direction, system design, automation design, implementation, and prioritization
- Bias toward practical revenue paths, not just clean code

## Near-Term Product Direction

Build a single hub that turns financial signals and automation outputs into actions a user would pay for.

Core themes:

- market monitoring
- signal aggregation
- alerting
- summarization
- dashboarding
- scheduled automation

## Immediate Priorities

1. Define one clear paid user outcome
2. Build one repeatable data pipeline end-to-end
3. Save outputs in a durable store
4. Expose them in the web product
5. Add alerting and history
6. Validate willingness to pay before broadening scope

## Candidate Revenue Paths

### 1. Retail trading assistant

- Korean stocks + crypto monitoring
- signal summaries
- scheduled reports
- actionable alerts

### 2. Personal market operations hub

- one place for n8n workflows, alerts, summaries, watchlists, and decisions
- useful first for you, then for similar users

### 3. B2B/B2B-lite automation service

- custom alert/report bots for small teams or individual traders
- monthly subscription or setup fee + maintenance

## Practical Rule

Do not build broad platform features first.
Ship one narrow workflow that is valuable enough to be used daily.

## First Wedge Suggestion

Start with this:

- collect market data on schedule
- generate compact AI summary
- store summary and signal results
- show them in Smart Hub
- send high-priority alerts only when thresholds are met

This is small enough to ship and strong enough to test demand.

## System Strategy

- n8n handles orchestration and scheduled ingestion
- backend/API handles validation, storage, auth, and product-facing endpoints
- frontend shows daily value clearly: alerts, summaries, watchlists, recent actions
- AI is used for ranking, summarizing, and explanation, not as the only source of truth

## Decision Filter

When choosing work, prefer items that do at least one of these:

- increase daily usefulness
- reduce manual operations
- create reusable API/data assets
- improve monetization readiness
- make trust/safety stronger

Avoid work that only adds surface complexity without increasing retained value.

## Current Collaboration Rule

From this point, treat business thinking, product thinking, system design, and implementation as one connected track.
