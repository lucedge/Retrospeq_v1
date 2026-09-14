import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { resolveDashboardKind, type DashboardKind } from '../dashboard-state';

/**
 * Module 08 (Onboarding & Home) §7/§10.1 — "Dashboard state resolution is
 * deterministic and total — every combination of inputs yields exactly one
 * state," now over the full four-state space (open / closeout / review /
 * clear). Mirrors `lib/onboarding/__tests__/router.test.ts`'s own
 * exhaustive + property-based structure for the sibling pure resolver.
 */
describe('resolveDashboardKind', () => {
  it('open position always wins, regardless of the closeout or review signals (§7.1 ranking)', () => {
    expect(resolveDashboardKind(true, true, true)).toBe('open');
    expect(resolveDashboardKind(true, false, true)).toBe('open');
    expect(resolveDashboardKind(true, true, false)).toBe('open');
    expect(resolveDashboardKind(true, false, false)).toBe('open');
  });

  it('closeout wins over review and clear when there is no open position', () => {
    expect(resolveDashboardKind(false, true, true)).toBe('closeout');
    expect(resolveDashboardKind(false, true, false)).toBe('closeout');
  });

  it('review wins over clear when there is no open position or closeout', () => {
    expect(resolveDashboardKind(false, false, true)).toBe('review');
  });

  it('clear when none of the three signals are present', () => {
    expect(resolveDashboardKind(false, false, false)).toBe('clear');
  });

  it('is total and deterministic — every boolean combination yields exactly one of the four real kinds, called twice always agrees', () => {
    const validKinds: DashboardKind[] = ['open', 'closeout', 'review', 'clear'];
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (hasOpen, hasCloseout, hasReview) => {
        const first = resolveDashboardKind(hasOpen, hasCloseout, hasReview);
        const second = resolveDashboardKind(hasOpen, hasCloseout, hasReview);
        expect(first).toBe(second);
        expect(validKinds).toContain(first);
      }),
    );
  });

  it('never resolves to two states at once — the ranking is a strict priority order, not an OR', () => {
    // Exhaustive over all 8 real input combinations (fast-check's own
    // triple-boolean property above already covers this generatively;
    // this is the same exhaustive check `router.test.ts` also does by
    // hand for its own small enum space).
    const cases: Array<[boolean, boolean, boolean, DashboardKind]> = [
      [true, true, true, 'open'],
      [true, true, false, 'open'],
      [true, false, true, 'open'],
      [true, false, false, 'open'],
      [false, true, true, 'closeout'],
      [false, true, false, 'closeout'],
      [false, false, true, 'review'],
      [false, false, false, 'clear'],
    ];
    for (const [hasOpen, hasCloseout, hasReview, expected] of cases) {
      expect(resolveDashboardKind(hasOpen, hasCloseout, hasReview)).toBe(expected);
    }
  });
});
