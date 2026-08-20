import { BOOLEAN_CAPS, QUANTITY_CAPS } from './capability-table';
import type {
  BooleanCapability,
  EntitlementResult,
  Plan,
  QuantityCapability,
} from './types';

/**
 * Pure resolution functions — Module 01 §4.3's formula:
 *
 *   can(user, capability) =
 *       plan_capabilities[subscription.plan].includes(capability)
 *       AND NOT quota_exceeded(user, capability)
 *
 * split into its two real cases (quantity vs boolean capability) and
 * kept free of any I/O so §7.1's "Entitlement resolution across every
 * plan × capability pair" can be unit-tested exhaustively without a
 * database. `can.ts` is the thin orchestration layer that fetches a
 * plan/usage count and calls into these.
 */

export function resolveQuantityCapability(
  plan: Plan,
  capability: QuantityCapability,
  used: number | undefined,
): EntitlementResult {
  const limit = QUANTITY_CAPS[capability][plan];

  // A cap of exactly 0 means the plan excludes this capability outright
  // (Module 01 §4.3's "0 (all soft)" for rules.hard on Free) — this is
  // a PLAN exclusion, not a quota that happens to already be full, and
  // no usage count is needed to know that (0 is 0 regardless of `used`).
  if (limit === 0) {
    return { allowed: false, reason: 'plan', limit: 0 };
  }

  // `null` means unlimited on this plan — always allowed, no count needed.
  if (limit === null) {
    return { allowed: true, reason: 'ok', limit: null };
  }

  // A real, finite, nonzero cap exists, but nobody supplied a usage
  // count (no counter injected, and the backing resource's table may
  // not exist yet — see types.ts's `not_yet_checkable` doc comment).
  // Fail closed: never assume "under the cap" just because it wasn't
  // checked.
  if (used === undefined) {
    return { allowed: false, reason: 'not_yet_checkable', limit };
  }

  if (used >= limit) {
    return { allowed: false, reason: 'quota', limit, used };
  }
  return { allowed: true, reason: 'ok', limit, used };
}

export function resolveBooleanCapability(
  plan: Plan,
  capability: BooleanCapability,
): EntitlementResult {
  const allowed = BOOLEAN_CAPS[capability][plan];
  return { allowed, reason: allowed ? 'ok' : 'plan', limit: null };
}
