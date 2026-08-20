import 'server-only';
import { isBooleanCapability, isQuantityCapability } from './capability-table';
import { resolveBooleanCapability, resolveQuantityCapability } from './resolve';
import type { Capability, EntitlementResult, Plan, QuantityCapability, UsageCounter } from './types';

/**
 * Module 01 §4.3's `can(user, capability)` — the generic, dependency-
 * injected orchestration layer every future module calls into (Module
 * 01 §12: "provides → entitlement caps" to 04 Rulebook, 05 Analytics,
 * 06 Graduation).
 *
 * WHY DEPENDENCY-INJECTED, per this slice's own dispatch: most of these
 * capabilities belong to modules that don't exist yet in this repo
 * (`rules`, `strategy`, `fields` tables — Modules 03/04 haven't
 * shipped). This module builds the full capability table and `can()`'s
 * general shape now, but cannot itself count rows in a table that
 * doesn't exist — and per AGENTS.md ("never fake it") it must not
 * invent one. `usageCounters` lets a FUTURE module wire in its own real
 * counter (e.g. `select count(*) from rules where user_id = $1 and
 * state != 'deactivated_by_plan'`) without this module ever importing
 * that table. The one counter this slice CAN and DOES wire in for
 * real — `account.connect`, since `trading_accounts` already exists —
 * lives in `account-usage.ts` / `default-deps.ts`, not here, keeping
 * this file itself free of any table-specific knowledge.
 */
export interface CanDeps {
  /** Resolves the caller's current plan. Always required — every
   *  capability check needs to know the plan even before quantity is
   *  considered. */
  getPlan: (userId: string) => Promise<Plan>;
  /** One counter per quantity capability whose backing resource exists.
   *  A capability with no entry here, and a real nonzero finite cap on
   *  the resolved plan, resolves to `reason: 'not_yet_checkable'` — see
   *  resolve.ts. */
  usageCounters?: Partial<Record<QuantityCapability, UsageCounter>>;
}

export async function can(
  userId: string,
  capability: Capability,
  deps: CanDeps,
): Promise<EntitlementResult> {
  const plan = await deps.getPlan(userId);

  if (isBooleanCapability(capability)) {
    return resolveBooleanCapability(plan, capability);
  }

  if (isQuantityCapability(capability)) {
    const counter = deps.usageCounters?.[capability];
    const used = counter ? await counter(userId) : undefined;
    return resolveQuantityCapability(plan, capability, used);
  }

  // Exhaustiveness guard — every string literal in the `Capability`
  // union is one of the two branches above; TypeScript's own type
  // narrowing already proves this is unreachable for a well-typed
  // caller, but a capability string arriving from outside the type
  // system (e.g. a future dynamic dispatch) should fail loudly, not
  // silently resolve to an unintended default.
  throw new Error(`Unknown capability: ${String(capability)}`);
}
