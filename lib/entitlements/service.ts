import 'server-only';
import { can, type CanDeps } from './can';
import { countActiveTradingAccounts } from './account-usage';
import { countActiveRules } from './rules-usage';
import { getUserPlan } from './subscription-repository';
import type { Capability, EntitlementResult } from './types';

/**
 * The real, wired-up `CanDeps` this codebase can offer today — every
 * Server Action / page in this slice should call `canForUser()` below
 * rather than constructing `CanDeps` by hand, so the one real counter
 * (`account.connect`) is always included and nobody has to remember to
 * wire it in at each call site. Future modules (04 Rulebook, 05
 * Analytics) extend `usageCounters` here — or, if they'd rather keep
 * their own table entirely out of `lib/entitlements/`'s import graph,
 * construct their own `CanDeps` merging this object's `usageCounters`
 * with their own and call `can()` directly. Either is fine; `can()`
 * itself never assumes which.
 */
export const defaultCanDeps: CanDeps = {
  getPlan: getUserPlan,
  usageCounters: {
    'account.connect': countActiveTradingAccounts,
    // Module 04 (Rulebook & Evaluation) authoring pipeline — see
    // rules-usage.ts's own header for why 'active' is the right filter.
    'rules.create': countActiveRules,
  },
};

/** Convenience wrapper most call sites want: `can()` against the real,
 *  currently-available dependencies. */
export function canForUser(userId: string, capability: Capability): Promise<EntitlementResult> {
  return can(userId, capability, defaultCanDeps);
}
