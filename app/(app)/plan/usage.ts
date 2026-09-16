import type { EntitlementResult } from '@/lib/entitlements/types';

/**
 * Frame 6.7: "fractions, never a bare percentage". Turning an
 * `EntitlementResult` into something renderable is where a fabricated
 * figure would get in — `resolveQuantityCapability` only reports `used`
 * when a real counter actually ran, so:
 *
 *  - an unlimited cap (`limit: null`) has no fraction at all, and must
 *    never render as "0 of ∞" or "0 (unlimited)";
 *  - a cap of exactly 0 is a plan exclusion, not a quota — and it comes
 *    back with no `used`, so "0 of 0" would be a number nobody counted
 *    (a downgraded Pro account can still own strategies, ADR/infra gap);
 *  - `not_yet_checkable` means the counter is missing entirely.
 *
 * Pure, and unit-tested for each of those four cases.
 */
export type UsageDisplay =
  | { kind: 'fraction'; used: number; limit: number; atLimit: boolean }
  | { kind: 'unlimited' }
  | { kind: 'plan-excluded' }
  | { kind: 'unknown' };

export function usageDisplay(entitlement: EntitlementResult): UsageDisplay {
  if (entitlement.limit === null) return { kind: 'unlimited' };
  if (entitlement.limit === 0) return { kind: 'plan-excluded' };
  if (entitlement.used === undefined) return { kind: 'unknown' };
  return {
    kind: 'fraction',
    used: entitlement.used,
    limit: entitlement.limit,
    atLimit: entitlement.used >= entitlement.limit,
  };
}

/** The words that stand in for a fraction when there isn't one. */
export function usageLabel(display: UsageDisplay): string {
  switch (display.kind) {
    case 'unlimited':
      return 'Unlimited';
    case 'plan-excluded':
      return 'Pro only';
    case 'unknown':
      return 'Not counted yet';
    case 'fraction':
      return `${display.used} of ${display.limit}`;
  }
}
