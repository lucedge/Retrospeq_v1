import type { SyncTier } from './adapter';

/**
 * Generic "does this account's reported sync tier meet a required tier"
 * comparator — Module 01 §4.2: "`capabilities()` drives the analytics
 * registry at runtime. An account whose adapter reports T0-only must not
 * be offered rules over T1 operands, and T1 analytics must be hidden
 * rather than silently never firing."
 *
 * DELIBERATELY NOT the same file as `lib/rules/operand-catalogue.ts`'s
 * own `operandExceedsTier`/`TIER_RANK` (Module 04), even though the
 * underlying ranking (t0 < t1 < t2) is identical: `lib/rules/**` is
 * Module 04's own code, and Module 05 (`lib/analytics/**`) may never
 * import it — AGENTS.md's non-negotiable "Analytics code cannot import
 * rule code," enforced by `eslint.config.mjs`'s own `no-restricted-
 * imports` override (see docs/adr/0021). `lib/broker/` is neutral,
 * Module 01/02 territory (this file's own `SyncTier` type already lives
 * here, `adapter.ts`) — the natural, non-boundary-violating shared home
 * for a comparator BOTH Module 04's operand-tier gating and Module 05's
 * `account_tier_supports` (§4.8) need, since both are really asking the
 * same underlying Module 01 question: "does this account's sync tier
 * meet a required capability tier."
 *
 * `lib/rules/operand-catalogue.ts`'s own `TIER_RANK`/`operandExceedsTier`
 * are NOT refactored to delegate here in this slice — that file is
 * already-shipped, already-reviewed Module 04 code, and touching it is
 * out of this slice's own scope. A future cleanup could have Module 04
 * delegate to this shared comparator too (there is nothing Module-04-
 * specific about t0/t1/t2 ranking itself), but until then this is a
 * SECOND, independently-verified implementation of the exact same
 * ranking — a deliberate, documented cost of the isolation boundary,
 * not an oversight, and considerably cheaper than the alternative (a
 * lib/analytics -> lib/rules import).
 */

const SYNC_TIER_RANK: Record<SyncTier, number> = { t0: 0, t1: 1, t2: 2 };

/**
 * True when `accountTier` meets or exceeds `requiredTier`'s capability.
 * An unrecognised `accountTier` string is treated as the LEAST capable
 * (t0), never as unlimited — fails closed, matching
 * `operand-catalogue.ts`'s own `operandExceedsTier` posture for the
 * identical "malformed/unexpected sync_tier value" case.
 */
export function syncTierAtLeast(accountTier: string, requiredTier: SyncTier): boolean {
  const accountRank = SYNC_TIER_RANK[accountTier as SyncTier] ?? SYNC_TIER_RANK.t0;
  return accountRank >= SYNC_TIER_RANK[requiredTier];
}

export type { SyncTier };
