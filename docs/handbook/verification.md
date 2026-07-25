# Verification automation (design)

Design draft — **not implemented**. Goal: move verification from “human runs commands and pastes output” toward “machine runs assertions and attaches evidence”, while keeping short narrative docs for root cause / tradeoffs.

## TL;DR

1. **Why**: `apps/server/docs/ai-context/verifications/` has structured runbooks (scenario → command → expected/actual → evidence → last verified), but expiry and fresh evidence are still manual.
2. **Idea**: keep those markdown docs as the narrative source of truth; pair each with an executable artifact whose last green run is “last verified”.
3. **Plan**: three layers — unit/integration in-repo, live verifier against deployed env, CI doctor for stale `last_verified`.

## Background

Under `apps/server/docs/ai-context/verifications/` (count and names drift; treat the directory listing as truth), docs typically share:

- Scenario / user path
- Commands / steps
- Expected vs actual output
- Evidence (commit SHA, test paths, log excerpts)
- Status / last verified (manual today)

Some docs already point at vitest unit tests; others are still live curl + real Resend / DB / staging.

## Evidence classes

1. **Pure code** — already covered by `*.test.ts` / `expect()`.
2. **Cross-boundary** — needs Postgres, Redis, Hono app, metrics scrape together → `*.integration.test.ts` + testcontainers (not built yet).
3. **Deploy-only** — Resend delivery, Stripe webhook, Grafana slopes, OIDC handoff → `*.verifier.ts` against staging/prod (not built yet).

## Proposed frontmatter

```yaml
---
feature: flux-unbilled-exploit-fix
owner: example@example.com
automated_by:
  - kind: unit
    path: apps/server/src/services/billing/tests/billing-service.test.ts
  - kind: integration
    path: apps/server/tests/verifications/flux-unbilled.integration.test.ts
  - kind: live
    path: apps/server/tests/verifications/flux-unbilled.verifier.ts
    schedule: post-deploy
last_verified:
  unit: 2026-05-15
  integration: 2026-05-15
  live: 2026-05-14
expires_after_days: 30
---
```

## Implementation sketch (future)

| Layer | Artifact | Trigger |
|-------|----------|---------|
| Unit | existing `*.test.ts` | PR CI (already) |
| Integration | `*.integration.test.ts` + testcontainers | PR when `apps/server/**` or `packages/server-*/**` change |
| Live | `*.verifier.ts` against staging URL | post-deploy |
| Doctor | `scripts/verification-doctor.ts` | warn/fail on expired `last_verified` |

Helpers for metric scrape / app mount should live under `apps/server` testing utilities — not `packages/server-runtime` (that package is the local WS hub, not the hosted API test harness).

## Out of scope for this handbook page

- Replacing root `AGENTS.md` (this fork uses it for agent communication rules only).
- Claiming any of the automation above already ships.

When implementing, update this page’s status line and link the real workflows/scripts.
