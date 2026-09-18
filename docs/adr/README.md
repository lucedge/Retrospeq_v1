# Decision records

Every deliberate deviation from a convention in `00-foundation.md`, one
file each. Read the ADR when the code surprises you; write one when you
knowingly do something the conventions do not describe.

There are 46 of them, numbered 0001–0047 (0028 was never used).

## Start with these four

If you read nothing else, these four explain the shape of the system:

| # | Why it matters |
|---|---|
| [0005](0005-account-credentials-writes-via-service-role.md) | Why credential writes bypass RLS, and what guards that |
| [0006](0006-account-writes-direct-postgres.md) | Why `.from()` does not work here at all |
| [0021](0021-analytics-rules-eslint-boundary.md) | Why analytics may never import rule code |
| [0039](0039-weekly-review-compute-on-view-and-current-period.md) | Why the weekly review materialises on view |

## All records

| # | Decision | Supersedes | Superseded by |
|---|---|---|---|
| [0001](0001-flip-fill-split-via-trade-events.md) | Represent a zero-crossing ("flip") fill via `trade_events`, not a split `trade_fills` row | — | — |
| [0002](0002-shared-dev-supabase-project.md) | Shared dev/test Supabase project, isolated via a dedicated schema | — | 0045 |
| [0003](0003-rate-limiter-direct-postgres.md) | Rate limiter uses a direct Postgres connection, not supabase-js | — | — |
| [0004](0004-rate-limiter-fails-open.md) | The rate limiter fails open on unexpected infrastructure errors | — | — |
| [0005](0005-account-credentials-writes-via-service-role.md) | `account_credentials` writes go through the service role, not the owner's RLS-scoped session | — | — |
| [0006](0006-account-writes-direct-postgres.md) | `trading_accounts` / `account_credentials` reads and writes go through a direct Postgres connection, not supabase-js | — | — |
| [0007](0007-mfa-recovery-codes-own-system.md) | Recovery codes are Retrospeq's own system, not a Supabase Auth feature — and redemption disables 2FA via the admin API, not a same-session unenroll | — | — |
| [0008](0008-subscriptions-read-only-rls.md) | `subscriptions` RLS is read-only to the owner; every write goes through the service role | — | — |
| [0009](0009-data-requests-rls-shape.md) | `data_requests` is owner-select + owner-insert; every status transition goes through the service role | — | — |
| [0010](0010-erasure-explicit-delete-order.md) | Erasure execution deletes explicitly, table by table, rather than relying on `on delete cascade`; the tombstone lives in its own table | — | — |
| [0011](0011-ingestion-rls-shape.md) | RLS shape for Module 02's 11 ingestion tables, and the `trade_fills.user_id` addition | — | — |
| [0012](0012-risk-pct-stored-as-percentage-number.md) | `risk_pct` / `initial_risk_pct` stored as a percentage NUMBER, not a 0–1 fraction | — | — |
| [0013](0013-trading-accounts-starting-equity-nullable.md) | `trading_accounts.starting_equity`, nullable, no fabricated default | — | — |
| [0014](0014-no-compound-rules.md) | No compound rules (no AND, no OR), anywhere, ever | — | — |
| [0015](0015-iso-week-boundary-monday-start.md) | Week boundary convention: ISO week (Monday start), applied to `server_day` | — | — |
| [0016](0016-freeze-at-confirmation-not-broker-close.md) | Freeze rule evaluations at close-out confirmation, not at broker-reported close | — | — |
| [0017](0017-fields-composite-primary-key.md) | `fields.id` is a composite `(user_id, id)` primary key, not a bare global text PK | — | — |
| [0018](0018-strategy-edit-reuses-strategy-create-entitlement.md) | Strategy edit reuses the `strategy.create` capability; no new `strategy.edit` capability added | — | — |
| [0019](0019-field-creation-entitlement-gate.md) | Field creation is gated by the already-existing `fields.custom` capability, not a transitive/inherited check | — | — |
| [0020](0020-user-cohorts-read-only-rls.md) | `user_cohorts` RLS is read-only to the owner; every write goes through the service role | — | — |
| [0021](0021-analytics-rules-eslint-boundary.md) | the Module 04/05 isolation boundary is enforced by an ESLint import restriction, not a CI pipeline (yet) | — | — |
| [0022](0022-trigger-conditions-own-evaluation-table.md) | Trigger conditions evaluate through their own `trigger_evaluations` table, never as `rules`/`rule_versions` rows | — | — |
| [0023](0023-find-number-analytic-id.md) | `'find.number'` fills a real gap in `analytics-registry.md`'s own catalogue | — | — |
| [0024](0024-findings-supersession-write-semantics.md) | `findings` supersession is scoped per exact segment tuple, never per-strategy | — | — |
| [0025](0025-holm-correction-family-scoping.md) | Holm-Bonferroni family = every segment computed for one strategy in one run; one p-value per segment | — | — |
| [0026](0026-edge-engine-baseline-scoped-to-field-populated-trades.md) | a segment's baseline is scoped to trades that have a value for that field, not every other trade in the strategy | — | — |
| [0027](0027-strategy-builder-two-phase-create.md) | The strategy-creation builder writes in two phases when trigger conditions are present; `strategy_versions.triggers[]` is never seeded with client-generated ids | — | — |
| [0029](0029-detections-supersession-key.md) | `detections` supersession key is `(user_id, analytic_id)`, and a failed gate leaves the prior row untouched | — | — |
| [0030](0030-detection-engine-occurrence-definitions.md) | what counts as an "occurrence" for each of the five v1 detections, and other genuinely undecided detection-engine judgment calls | — | — |
| [0031](0031-detection-direction-and-rule-proposable.md) | `detections.rule_proposable`, `detections.direction`, and the standard/improvement mutual-exclusivity tie-break | — | — |
| [0032](0032-decay-check-delta-metric-and-trade-throttle.md) | decay checking's delta metric, "recompute the finding" mechanics, and the 30-trade throttle column | — | — |
| [0033](0033-asset-class-suppression-classification.md) | asset-class suppression — classification unit, `manual`'s treatment, and the write path | — | — |
| [0034](0034-weekday-canary-permanent-shadow.md) | `spec.weekday` is deliberately weak and structurally, permanently barred from promotion | — | — |
| [0035](0035-strategy-detail-finding-statement-synthesis.md) | Strategy-detail screen — finding-statement synthesis, representative-segment selection, and gating judgment calls | — | — |
| [0036](0036-weekly-review-read-payload-assembly.md) | Weekly review Part 1 ("the read") — payload composition, cross-strategy findings ranking, and multi-week period handling | — | — |
| [0037](0037-prompt-candidate-eligibility-judgment-calls.md) | Prompt-candidate eligibility (§4.4) — stable subject identity across supersession, and five other spec-under-determined judgment calls | — | — |
| [0038](0038-review-prompt-ranking-and-canrender-gate.md) | Review-prompt ranking/cap, the `canRender` gate closure, dormancy re-raise, and materialisation write shape | — | — |
| [0039](0039-weekly-review-compute-on-view-and-current-period.md) | Weekly review Part 1 UI — compute-on-view materialisation, current-period selection, and route naming | — | — |
| [0040](0040-graduation-decision-operand-threshold-and-progression.md) | Graduation decision flow — operand resolution, threshold derivation, defer semantics, and post-action progression | — | — |
| [0041](0041-relaxation-decision-recommit-adjust-and-scope.md) | Relaxation decision flow — recommit vs. defer, adjust's derived threshold, hard-rule scope, and per-prompt entitlement gating | — | — |
| [0042](0042-e2e-rate-limit-bypass.md) | E2E rate-limit bypass (dev/test only, fail-closed) | — | — |
| [0043](0043-monthly-edge-stability-uses-decay-tracking.md) | Monthly review "edge stability" uses decay-tracking data, not a month-over-month snapshot | — | — |
| [0044](0044-adherence-and-field-completeness-earn-no-xp.md) | Adherence, rule follows/breaks, and field completeness earn zero XP, by design | — | — |
| [0045](0045-own-supabase-project-and-vercel-environments.md) | Retrospeq's own Supabase project and Vercel environments | 0002 | — |
| [0046](0046-custom-field-rule-operands.md) | Custom fields as rule operands | — | — |
| [0047](0047-responsive-shell-breakpoints-and-side-rail.md) | Responsive shell: breakpoint tokens, a stepped column, and a side rail at 64rem | — | — |

## Supersession

```mermaid
flowchart LR
  A0002["0002"] -->|superseded by| A0045["0045"]
```

A superseded record stays in place — it explains why the earlier decision
was reasonable at the time, which is usually the more useful half.

## Writing one

Name it `NNNN-kebab-title.md`, next number up. Open with what was
decided and when, then: what the convention said, what you did instead,
why, and what it costs. An ADR that only records the decision without the
cost is half a record.
