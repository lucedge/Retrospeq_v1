import type { ShadowRunRow, Uuid } from './types';

/**
 * Module 05 §4.9 — promotion criteria.
 *
 *   shadow → beta:
 *     ran without error on >= 30 real accounts
 *     output manually inspected on >= 10
 *     no case found where the statement is misleading
 *
 *   beta → live:
 *     >= 4 weeks in beta
 *     no accuracy complaints from the test cohort
 *     statement reads as true to a trader who knows their own history
 *
 * Only the first line of shadow→beta is mechanically checkable from
 * `shadow_runs` data. The other two lines of shadow→beta, and all of
 * beta→live, are human judgment calls by design (§4.9 says "manually
 * inspected", not "automatically verified") — this module computes the
 * checkable part and represents the rest as explicit non-automatable
 * fields rather than quietly omitting them or faking a verdict.
 *
 * beta→live is out of scope entirely: it operates on analytics that have
 * already left shadow status, which isn't something `shadow_runs` (or
 * this harness) tracks — that belongs to whatever owns `analytic_config`
 * status transitions (Module 01), not built yet.
 */

const SHADOW_TO_BETA_MIN_ACCOUNTS = 30;

export interface ShadowToBetaEligibility {
  analytic_id: string;
  distinct_accounts_run: number;
  /**
   * Because `runShadowAnalytic` never persists a row for a failed
   * compute (see runner.ts — errors throw, they are not written), every
   * row that exists in `shadow_runs` already represents a run that
   * completed without error. Counting distinct `user_id` therefore
   * answers "ran without error on N accounts" directly, with no separate
   * error-tracking needed here.
   */
  ran_without_error_threshold_met: boolean;
  manual_review_required: {
    output_inspected_on_at_least_10_accounts: 'not_automatable';
    no_misleading_case_found: 'not_automatable';
  };
  /** True only if the mechanical gate passed. Manual review still gates the actual promotion. */
  eligible_for_manual_promotion_review: boolean;
  /** Module 05 §4.10 — true forces this false regardless of the above. */
  permanently_shadow: boolean;
}

export function evaluateShadowToBetaPromotion(
  analyticId: string,
  runs: Pick<ShadowRunRow, 'user_id'>[],
  options: { permanentlyShadow?: boolean } = {},
): ShadowToBetaEligibility {
  const distinctAccounts = new Set(runs.map((run) => run.user_id)).size;
  const thresholdMet = distinctAccounts >= SHADOW_TO_BETA_MIN_ACCOUNTS;
  const permanentlyShadow = options.permanentlyShadow ?? false;

  return {
    analytic_id: analyticId,
    distinct_accounts_run: distinctAccounts,
    ran_without_error_threshold_met: thresholdMet,
    manual_review_required: {
      output_inspected_on_at_least_10_accounts: 'not_automatable',
      no_misleading_case_found: 'not_automatable',
    },
    eligible_for_manual_promotion_review: thresholdMet && !permanentlyShadow,
    permanently_shadow: permanentlyShadow,
  };
}

/** Convenience: distinct account count straight from a repository read. */
export function countDistinctAccounts(runs: Pick<ShadowRunRow, 'user_id'>[]): number {
  return new Set(runs.map((run) => run.user_id)).size;
}

export type { Uuid };
