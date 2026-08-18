import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { uuidv7 } from 'uuidv7';
import { countDistinctAccounts, evaluateShadowToBetaPromotion } from '../promotion';

function runsFor(userIds: string[]) {
  return userIds.map((user_id) => ({ user_id }));
}

describe('evaluateShadowToBetaPromotion', () => {
  it('is not eligible at 29 distinct accounts (Module 05 §4.9: threshold is >= 30)', () => {
    const runs = runsFor(Array.from({ length: 29 }, () => uuidv7()));
    const eligibility = evaluateShadowToBetaPromotion('find.example', runs);

    expect(eligibility.distinct_accounts_run).toBe(29);
    expect(eligibility.ran_without_error_threshold_met).toBe(false);
    expect(eligibility.eligible_for_manual_promotion_review).toBe(false);
  });

  it('crosses the mechanical threshold at exactly 30 distinct accounts', () => {
    const runs = runsFor(Array.from({ length: 30 }, () => uuidv7()));
    const eligibility = evaluateShadowToBetaPromotion('find.example', runs);

    expect(eligibility.distinct_accounts_run).toBe(30);
    expect(eligibility.ran_without_error_threshold_met).toBe(true);
    expect(eligibility.eligible_for_manual_promotion_review).toBe(true);
  });

  it('still marks the manual-review criteria as not automatable even when the mechanical gate passes', () => {
    const runs = runsFor(Array.from({ length: 50 }, () => uuidv7()));
    const eligibility = evaluateShadowToBetaPromotion('find.example', runs);

    expect(eligibility.manual_review_required.output_inspected_on_at_least_10_accounts).toBe(
      'not_automatable',
    );
    expect(eligibility.manual_review_required.no_misleading_case_found).toBe('not_automatable');
  });

  it('counts distinct accounts, not rows — repeated runs for the same user do not inflate the count', () => {
    const user = uuidv7();
    const runs = runsFor(Array.from({ length: 100 }, () => user)); // same user, 100 nightly runs
    const eligibility = evaluateShadowToBetaPromotion('find.example', runs);

    expect(eligibility.distinct_accounts_run).toBe(1);
    expect(eligibility.ran_without_error_threshold_met).toBe(false);
  });

  it('never marks a permanently-shadow analytic eligible, no matter how many accounts it ran on (Module 05 §4.10)', () => {
    const runs = runsFor(Array.from({ length: 10_000 }, () => uuidv7()));
    const eligibility = evaluateShadowToBetaPromotion('spec.weekday', runs, {
      permanentlyShadow: true,
    });

    expect(eligibility.ran_without_error_threshold_met).toBe(true); // mechanical gate did pass
    expect(eligibility.permanently_shadow).toBe(true);
    expect(eligibility.eligible_for_manual_promotion_review).toBe(false); // but never eligible
  });

  it('distinct account count is order-independent and duplicate-insensitive (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.uuid()), (userIds) => {
        const runs = runsFor(userIds);
        const expected = new Set(userIds).size;
        expect(countDistinctAccounts(runs)).toBe(expected);

        // Shuffling and duplicating rows must not change the distinct count.
        const doubled = runsFor([...userIds, ...userIds].reverse());
        expect(countDistinctAccounts(doubled)).toBe(expected);
      }),
    );
  });
});
