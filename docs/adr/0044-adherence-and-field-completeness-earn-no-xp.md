# ADR 0044 — Adherence, rule follows/breaks, and field completeness earn zero XP, by design

**Date:** 2026-09-15 · **Status:** accepted

## Deviation
None from the spec — this ADR exists because Module 07 §2.2 explicitly asks for one ("This will look like an oversight to anyone reading the code. It is the opposite, and it gets an ADR"). The deviation is from the *obvious* implementation a reader would expect: a discipline-and-XP product that never rewards following its own rules looks, on first read of `engagement_events`, like a missing feature.

## Why
Module 07 §2 ("never reward anything the trader can fabricate") and §2.2: if breaking a rule cost XP, traders would write soft rules and simply stop logging breaks — the same failure the streak design already excludes (design doc §11). Adherence is self-set and self-reported; unlike a broker fill or a review close, nothing outside the trader's own control verifies it. Rewarding or penalising it would corrupt the exact adherence signal Module 04's hard-adherence number depends on, and Module 04 §1 already calls that number "the most trust-sensitive figure in the product."

Field completeness is excluded for the identical reason (§2.1): a filled field has no verification source outside the trader typing it. Rewarding density would make traders fill fields to earn XP rather than to record something true, injecting noise into the exact dataset the edge engine and Module 10 (AI coach) both depend on.

## Enforcement, concretely
`engagement_events.kind` is DB-CHECK-constrained to exactly four values (`day_closed`, `review_completed`, `pre_entry_verified`, `milestone_reached`) — no `rule_followed`/`rule_broken`/`field_completed`/`adherence_*` kind can even be persisted, even by a buggy service-role job. `lib/engagement/events-repository.ts` has no import from `lib/rules` or `lib/analytics` and no code path that reads `rule_evaluations`/`adherence_weekly`/`findings`. `lib/engagement/__tests__/events-repository.test.ts` greps every application source file for an `engagement_events` insert with a `kind:` literal outside the closed list and fails the build if one ever appears (§8.2's own "no event exists whose verification_source is the trader's own unverified input" / "no engagement event references a rule, evaluation, finding, or P&L value" property tests, made concrete).

## Cost
None identified. The absence is the point (§4.1: "the absence should be visible in the schema") — there is no lost functionality here, only a design decision that reads as surprising until this ADR is read alongside it.
