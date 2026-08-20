/**
 * Module 01 §4.3 "Entitlement resolution" — shared types for the
 * `can(user, capability)` contract every future module (04 Rulebook, 05
 * Analytics, 06 Graduation) calls into, per Module 01 §12's "provides →
 * entitlement caps" relationship. Kept as its own file (no logic) so
 * every other file in this directory, and every future caller, imports
 * one stable shape.
 */

/** `subscriptions.plan` — 'trader_plus' is v1.1 (Module 01 §3.1's own
 *  comment) and deliberately not modeled yet; see the migration's check
 *  constraint for the same reasoning applied at the DB layer. */
export type Plan = 'free' | 'pro';

/**
 * Capabilities whose entitlement is a COUNT against a cap (Module 01
 * §4.3's table: "1 account", "3 rules", "0 (all soft)", etc). `null` in
 * `capability-table.ts` means unlimited for that plan.
 */
export type QuantityCapability =
  | 'account.connect'
  | 'rules.create'
  | 'rules.hard'
  | 'strategy.create'
  | 'fields.custom';

/**
 * Capabilities whose entitlement is a plain yes/no per plan — no
 * quantity to exceed, only "is this plan allowed to use this at all."
 */
export type BooleanCapability =
  | 'analytics.derived'
  | 'analytics.detection'
  | 'analytics.judgment'
  | 'graduation'
  | 'preview.engine'
  | 'streak'
  | 'adherence';

export type Capability = QuantityCapability | BooleanCapability;

export type EntitlementReason =
  /** Allowed — either unlimited, boolean-allowed, or within a finite cap. */
  | 'ok'
  /** Not allowed because the plan itself excludes this capability (a
   *  boolean `false`, or a quantity cap of exactly 0 — Module 01 §4.3's
   *  "0 (all soft)" for rules.hard on Free is this case, not 'quota'). */
  | 'plan'
  /** Not allowed because a real, finite, nonzero cap has been reached or
   *  exceeded by actual usage — this is the case Module 01 §9's
   *  `ENTITLEMENT_LIMIT` error and §4.1's "You're at 3 of 3 rules." copy
   *  are about. */
  | 'quota'
  /**
   * The plan permits this capability with a finite, nonzero cap, but
   * this resource's backing table doesn't exist yet in this codebase
   * (rules/strategy/fields — Modules 04/03 haven't shipped) and no
   * usage counter was injected for it. AGENTS.md "never fake it": this
   * is NOT the same as `allowed: true`. `allowed` defaults to `false`
   * here (fail closed — deny by default when a real check can't be
   * performed, same posture as app/(app)/layout.tsx's AAL-check-failure
   * handling) so nothing downstream can mistake "we don't know" for
   * "yes, go ahead."
   */
  | 'not_yet_checkable';

export interface EntitlementResult {
  allowed: boolean;
  reason: EntitlementReason;
  /** The plan's cap for this capability. `null` = unlimited. Always
   *  present for quantity capabilities; always `null` for boolean ones
   *  (a boolean capability has no numeric cap to report). */
  limit: number | null;
  /** Only present when a real usage count was available (either the
   *  capability is quantity-based AND a counter ran, successfully). */
  used?: number;
}

/** Injected per-capability usage counter — see `can.ts`'s own doc
 *  comment for why this is dependency-injected rather than this module
 *  importing `rules`/`strategy`/`fields` tables that don't exist. */
export type UsageCounter = (userId: string) => Promise<number>;
