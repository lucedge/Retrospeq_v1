import type { BooleanCapability, Plan, QuantityCapability } from './types';

/**
 * Module 01 §4.3's capability table, transcribed exactly (no capability
 * invented, none omitted — every row of that markdown table has an
 * entry here, and every entry here traces back to a row of that table):
 *
 * | Capability | Free | Pro |
 * |---|---|---|
 * | `account.connect` | 1 account | unlimited |
 * | `rules.create` | 3 | unlimited |
 * | `rules.hard` | 0 (all soft) | up to 6 |
 * | `strategy.create` | 0 | unlimited |
 * | `fields.custom` | 0 | unlimited |
 * | `analytics.derived` | yes | yes |
 * | `analytics.detection` | **all five** | all five |
 * | `analytics.judgment` | no | yes |
 * | `graduation` | no | yes |
 * | `preview.engine` | **yes** | yes |
 * | `streak`, `adherence` | yes | yes |
 *
 * `null` = unlimited for a quantity capability. This is the ONLY place
 * in the codebase these numbers should live — `resolve.ts` reads this
 * table, nothing else should hardcode a cap.
 */
export const QUANTITY_CAPS: Record<QuantityCapability, Record<Plan, number | null>> = {
  'account.connect': { free: 1, pro: null },
  'rules.create': { free: 3, pro: null },
  'rules.hard': { free: 0, pro: 6 },
  'strategy.create': { free: 0, pro: null },
  'fields.custom': { free: 0, pro: null },
};

/**
 * "analytics.detection: all five" reads as a fixed constant (five
 * specific T0-safe detection analytics, Module 05's own registry — not
 * built yet), not a plan-varying quantity — both plans get literally the
 * same five, so it's modeled as a plain boolean-true-for-both here,
 * matching every other "yes/yes" row's shape rather than inventing a
 * third capability kind just for this one row.
 */
export const BOOLEAN_CAPS: Record<BooleanCapability, Record<Plan, boolean>> = {
  'analytics.derived': { free: true, pro: true },
  'analytics.detection': { free: true, pro: true },
  'analytics.judgment': { free: false, pro: true },
  graduation: { free: false, pro: true },
  'preview.engine': { free: true, pro: true },
  streak: { free: true, pro: true },
  adherence: { free: true, pro: true },
};

export const QUANTITY_CAPABILITIES = Object.keys(QUANTITY_CAPS) as QuantityCapability[];
export const BOOLEAN_CAPABILITIES = Object.keys(BOOLEAN_CAPS) as BooleanCapability[];

export function isQuantityCapability(
  capability: string,
): capability is QuantityCapability {
  return Object.prototype.hasOwnProperty.call(QUANTITY_CAPS, capability);
}

export function isBooleanCapability(capability: string): capability is BooleanCapability {
  return Object.prototype.hasOwnProperty.call(BOOLEAN_CAPS, capability);
}
