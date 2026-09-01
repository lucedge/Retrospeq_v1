import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { resolveDashboardKind, type DashboardKind } from '../dashboard-state';

/**
 * Module 08 (Onboarding & Home) §7/§10.1 — "Dashboard state resolution is
 * deterministic and total — every combination of inputs yields exactly one
 * state," applied to THIS dispatch's own narrower three-state space
 * (`open`/`closeout`/`clear`; `Review ready` is out of scope, blocked on
 * Module 06). Mirrors `lib/onboarding/__tests__/router.test.ts`'s own
 * exhaustive + property-based structure for the sibling pure resolver.
 */
describe('resolveDashboardKind', () => {
  it('open position always wins, regardless of the closeout signal (§7.1 ranking)', () => {
    expect(resolveDashboardKind(true, true)).toBe('open');
    expect(resolveDashboardKind(true, false)).toBe('open');
  });

  it('closeout wins over clear when there is no open position', () => {
    expect(resolveDashboardKind(false, true)).toBe('closeout');
  });

  it('clear when neither signal is present', () => {
    expect(resolveDashboardKind(false, false)).toBe('clear');
  });

  it('is total and deterministic — every boolean combination yields exactly one of the three real kinds, called twice always agrees', () => {
    const validKinds: DashboardKind[] = ['open', 'closeout', 'clear'];
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasOpen, hasCloseout) => {
        const first = resolveDashboardKind(hasOpen, hasCloseout);
        const second = resolveDashboardKind(hasOpen, hasCloseout);
        expect(first).toBe(second);
        expect(validKinds).toContain(first);
      }),
    );
  });

  it('never resolves to two states at once — the ranking is a strict priority order, not an OR', () => {
    // Exhaustively over all 4 real input combinations (fast-check's
    // fc.boolean() pair above already covers this generatively; this is
    // the same exhaustive check `router.test.ts` also does by hand for
    // its own small enum space).
    const cases: Array<[boolean, boolean, DashboardKind]> = [
      [true, true, 'open'],
      [true, false, 'open'],
      [false, true, 'closeout'],
      [false, false, 'clear'],
    ];
    for (const [hasOpen, hasCloseout, expected] of cases) {
      expect(resolveDashboardKind(hasOpen, hasCloseout)).toBe(expected);
    }
  });
});
