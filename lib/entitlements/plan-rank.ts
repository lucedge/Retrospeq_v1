import type { Plan } from './types';

/**
 * Module 01 §4.8 (via Module 05's own `canRender`, §4.8): "plan_at_least
 * (user, analytic_config[id].min_plan)". No plan-ranking comparator
 * existed anywhere in this repo before this slice (`can()`/`resolve.ts`
 * only ever check plan MEMBERSHIP against a fixed per-capability table —
 * `BOOLEAN_CAPS[capability][plan]` — never "is this plan at least that
 * plan," since no capability needed an ORDERED comparison until now).
 *
 * Lives in `lib/entitlements/`, not `lib/analytics/`, per this slice's
 * own dispatch: "reuse Module 01's existing entitlement/plan-checking
 * infrastructure ... don't reinvent plan comparison" — Module 01 already
 * owns the `Plan` type and every other plan-related comparison in this
 * repo (`capability-table.ts`, `resolve.ts`); a plan-ORDERING comparator
 * is the same kind of fact, just one no capability needed yet. Module 05
 * imports this (an Module 01 file, not `lib/rules/**`) freely — the
 * AGENTS.md/ESLint boundary (docs/adr/0021) is specifically about
 * Module 04 (`lib/rules/**`), not Module 01.
 */

const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1 };
// 'trader_plus' intentionally absent -- v1.1, not modeled in the `Plan`
// union yet (types.ts's own comment: "deliberately not modeled yet").

/** True when `userPlan` meets or exceeds `minPlan`'s rank. */
export function planAtLeast(userPlan: Plan, minPlan: Plan): boolean {
  return PLAN_RANK[userPlan] >= PLAN_RANK[minPlan];
}
