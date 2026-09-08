import { planAtLeast } from '@/lib/entitlements/plan-rank';
import type { Plan } from '@/lib/entitlements/types';
import { syncTierAtLeast, type SyncTier } from '@/lib/broker/sync-tier';

/**
 * Module 05 (Analytics & Findings) §4.8 — the registry runtime.
 *
 *   canRender(analytic_id, user, surface) =
 *         analytic_config[id].enabled                  // fails closed if unreadable
 *     AND plan_at_least(user, analytic_config[id].min_plan)
 *     AND (NOT analytic_config[id].cohort_only OR user in cohort)
 *     AND NOT suppressed(user, analytic_id)
 *     AND account_tier_supports(analytic_id, user.accounts)
 *
 * "Config is cached 60 s. If config cannot be read, nothing renders.
 * Silence is always the safe failure." (§4.8) — §9's own
 * `ANALYTIC_CONFIG_UNAVAILABLE` row: "Config unreadable -> Render
 * nothing. Never a default-on." The 60-second cache this quotes is real
 * (`config-cache.ts`, wired into `config-repository.ts`'s
 * `getAnalyticConfig` — not implemented until 2026-09-08, found missing
 * by an independent tester dispatch the same day this slice was built;
 * see that file's own header for the caching contract in full).
 *
 * This file is the PURE half: every input the formula needs is already
 * resolved (no I/O, nothing can throw for a data reason) — the genuine
 * "did the read fail" case is represented as a real value
 * (`AnalyticConfigLookup`'s `'unavailable'` status), not an exception, so
 * this function's own return type is exhaustive and its behaviour is a
 * pure function of its inputs, directly truth-table-testable without a
 * database. `registry-runtime-service.ts` is the orchestration half that
 * actually performs the reads and converts a thrown I/O error into the
 * `'unavailable'` status this file already knows how to handle.
 */

export type Surface = 'onboarding' | 'dashboard' | 'weekly' | 'strategy' | 'preview';

export interface AnalyticConfigRow {
  analyticId: string;
  enabled: boolean;
  minPlan: Plan;
  cohortOnly: boolean;
  /** See the migration's own header for why this column exists beyond
   *  Module 01 §3.1's literal 5-column DDL. */
  minAccountTier: SyncTier;
}

/**
 * The three real outcomes of "read analytic_config for this id":
 *
 *  - `found`: a real, readable row exists.
 *  - `not_found`: the table was read successfully, but no row exists for
 *    this analytic_id (e.g. a real analytic that has genuinely never had
 *    its config row created yet). Distinguished from `unavailable`
 *    because it is a DIFFERENT operational condition worth telling apart
 *    (a config gap vs. a read failure), even though `canRenderPure`
 *    below treats both identically as "render nothing" — see §9's own
 *    `ANALYTIC_CONFIG_UNAVAILABLE` row, which does not actually
 *    distinguish "unreadable" from "absent" in its own stated behaviour
 *    ("Config unreadable -> Render nothing. Never a default-on" reads
 *    naturally as covering "we don't have an affirmative enabled=true
 *    row," not narrowly as "the SQL query itself errored").
 *  - `unavailable`: the read itself failed (a thrown error — DB
 *    connectivity, a malformed row, anything). THE adversarial case this
 *    slice's own dispatch calls out by name: "if analytic_config is
 *    unreadable ... canRender must return false, never throw."
 */
export type AnalyticConfigLookup =
  | { status: 'found'; config: AnalyticConfigRow }
  | { status: 'not_found' }
  | { status: 'unavailable' };

export type CanRenderReason =
  | 'ok'
  | 'config_unavailable'
  | 'not_configured'
  | 'disabled'
  | 'plan'
  | 'cohort'
  | 'suppressed'
  | 'tier';

export interface CanRenderResult {
  canRender: boolean;
  reason: CanRenderReason;
}

export interface CanRenderInputs {
  configLookup: AnalyticConfigLookup;
  userPlan: Plan;
  /** Membership in the one cohort this repo's runtime currently checks
   *  ("the test cohort," §4.8's own singular phrasing) — see
   *  `cohort-repository.ts`'s `BETA_COHORT` for the naming judgment call. */
  userInCohort: boolean;
  suppressed: boolean;
  /** Every currently-active trading account's own reported `sync_tier`
   *  string, unfiltered/unvalidated — `accountTierSupports` below treats
   *  an empty array and an unrecognised tier string the same
   *  fail-closed way `syncTierAtLeast` already does. */
  accountSyncTiers: readonly string[];
}

/**
 * §4.8's own `account_tier_supports(analytic_id, user.accounts)` term —
 * true when AT LEAST ONE of the user's currently-active accounts meets
 * `requiredTier`'s capability. `t0` is always satisfied regardless of
 * account count (including zero) — mirrors
 * `lib/rules/validate-tier.ts`'s own `hasSufficientTierAccount`
 * reasoning for the identical "t0 is the baseline, not a real
 * capability gate" case, independently re-derived here rather than
 * imported (see `lib/broker/sync-tier.ts`'s own header for why).
 */
export function accountTierSupports(requiredTier: SyncTier, accountSyncTiers: readonly string[]): boolean {
  if (requiredTier === 't0') return true;
  return accountSyncTiers.some((tier) => syncTierAtLeast(tier, requiredTier));
}

/**
 * The pure formula. Evaluated in the SAME order §4.8's own AND-chain
 * lists its five terms, so `reason` on a `false` result names the FIRST
 * term that failed — matches this slice's own dispatch: "each of the 5
 * AND-ed conditions independently toggled true/false."
 */
export function canRenderPure(inputs: CanRenderInputs): CanRenderResult {
  const { configLookup } = inputs;

  if (configLookup.status === 'unavailable') {
    return { canRender: false, reason: 'config_unavailable' };
  }
  if (configLookup.status === 'not_found') {
    return { canRender: false, reason: 'not_configured' };
  }

  const { config } = configLookup;

  if (!config.enabled) {
    return { canRender: false, reason: 'disabled' };
  }
  if (!planAtLeast(inputs.userPlan, config.minPlan)) {
    return { canRender: false, reason: 'plan' };
  }
  if (config.cohortOnly && !inputs.userInCohort) {
    return { canRender: false, reason: 'cohort' };
  }
  if (inputs.suppressed) {
    return { canRender: false, reason: 'suppressed' };
  }
  if (!accountTierSupports(config.minAccountTier, inputs.accountSyncTiers)) {
    return { canRender: false, reason: 'tier' };
  }

  return { canRender: true, reason: 'ok' };
}
