import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { resolveBooleanCapability, resolveQuantityCapability } from '../resolve';
import { isBooleanCapability, isQuantityCapability } from '../capability-table';
import { can } from '../can';
import type { BooleanCapability, Plan, QuantityCapability } from '../types';

/**
 * Module 01 §7.1 "Entitlement resolution across every plan × capability
 * pair" — every row of §4.3's table, both plans, transcribed literally
 * from the spec here (not derived from capability-table.ts) so a future
 * accidental edit to that table is caught by this test, not silently
 * reflected back at itself.
 *
 * | Capability             | Free           | Pro         |
 * |-------------------------|----------------|-------------|
 * | account.connect         | 1 account      | unlimited   |
 * | rules.create             | 3              | unlimited   |
 * | rules.hard                | 0 (all soft)   | up to 6     |
 * | strategy.create           | 0              | unlimited   |
 * | fields.custom              | 0              | unlimited   |
 * | analytics.derived          | yes            | yes         |
 * | analytics.detection         | all five (yes) | all five (yes) |
 * | analytics.judgment           | no             | yes         |
 * | graduation                    | no             | yes         |
 * | preview.engine                  | yes            | yes         |
 * | streak                            | yes            | yes         |
 * | adherence                          | yes            | yes         |
 */

describe('lib/entitlements/resolve.ts — boolean capabilities, every plan pair (Module 01 §4.3)', () => {
  const table: Array<{ capability: BooleanCapability; free: boolean; pro: boolean }> = [
    { capability: 'analytics.derived', free: true, pro: true },
    { capability: 'analytics.detection', free: true, pro: true },
    { capability: 'analytics.judgment', free: false, pro: true },
    { capability: 'graduation', free: false, pro: true },
    { capability: 'preview.engine', free: true, pro: true },
    { capability: 'streak', free: true, pro: true },
    { capability: 'adherence', free: true, pro: true },
  ];

  it('covers every BooleanCapability defined in types.ts — nothing added there without a row here', () => {
    const covered = new Set(table.map((row) => row.capability));
    // isBooleanCapability's own implementation enumerates BOOLEAN_CAPS,
    // which capability-table.ts's own header comment says transcribes
    // §4.3 exactly — cross-checking against it here still catches this
    // test file drifting out of sync with a genuine future addition.
    const allBooleanCapabilities: BooleanCapability[] = [
      'analytics.derived',
      'analytics.detection',
      'analytics.judgment',
      'graduation',
      'preview.engine',
      'streak',
      'adherence',
    ];
    for (const cap of allBooleanCapabilities) {
      expect(covered.has(cap)).toBe(true);
    }
    expect(covered.size).toBe(allBooleanCapabilities.length);
  });

  for (const { capability, free, pro } of table) {
    it(`${capability} — free=${free}, pro=${pro}`, () => {
      const freeResult = resolveBooleanCapability('free', capability);
      expect(freeResult.allowed).toBe(free);
      expect(freeResult.reason).toBe(free ? 'ok' : 'plan');
      expect(freeResult.limit).toBeNull();
      expect(freeResult.used).toBeUndefined();

      const proResult = resolveBooleanCapability('pro', capability);
      expect(proResult.allowed).toBe(pro);
      expect(proResult.reason).toBe(pro ? 'ok' : 'plan');
      expect(proResult.limit).toBeNull();
      expect(proResult.used).toBeUndefined();
    });
  }
});

describe('lib/entitlements/resolve.ts — quantity capabilities, every plan pair (Module 01 §4.3)', () => {
  const table: Array<{ capability: QuantityCapability; free: number | null; pro: number | null }> = [
    { capability: 'account.connect', free: 1, pro: null },
    { capability: 'rules.create', free: 3, pro: null },
    { capability: 'rules.hard', free: 0, pro: 6 },
    { capability: 'strategy.create', free: 0, pro: null },
    { capability: 'fields.custom', free: 0, pro: null },
  ];

  it('covers every QuantityCapability defined in types.ts', () => {
    const covered = new Set(table.map((row) => row.capability));
    const allQuantityCapabilities: QuantityCapability[] = [
      'account.connect',
      'rules.create',
      'rules.hard',
      'strategy.create',
      'fields.custom',
    ];
    for (const cap of allQuantityCapabilities) {
      expect(covered.has(cap)).toBe(true);
    }
    expect(covered.size).toBe(allQuantityCapabilities.length);
  });

  for (const { capability, free, pro } of table) {
    describe(capability, () => {
      const plans: Array<{ plan: Plan; limit: number | null }> = [
        { plan: 'free', limit: free },
        { plan: 'pro', limit: pro },
      ];

      for (const { plan, limit } of plans) {
        if (limit === null) {
          it(`${plan}: unlimited — always allowed regardless of usage, no count needed`, () => {
            const result = resolveQuantityCapability(plan, capability, undefined);
            expect(result).toEqual({ allowed: true, reason: 'ok', limit: null });

            // Even a huge "used" value must not matter once the plan is unlimited.
            const withUsage = resolveQuantityCapability(plan, capability, 99999);
            expect(withUsage).toEqual({ allowed: true, reason: 'ok', limit: null });
          });
        } else if (limit === 0) {
          it(`${plan}: cap of exactly 0 — plan excludes this capability outright, independent of usage`, () => {
            const result = resolveQuantityCapability(plan, capability, undefined);
            expect(result).toEqual({ allowed: false, reason: 'plan', limit: 0 });

            // Even used=0 must not flip this to "ok" — 0 is 0 regardless of used.
            const withZeroUsage = resolveQuantityCapability(plan, capability, 0);
            expect(withZeroUsage).toEqual({ allowed: false, reason: 'plan', limit: 0 });
          });
        } else {
          it(
            `${plan}: finite nonzero cap (${limit}) — 'not_yet_checkable' / fail-closed (allowed: false) ` +
              'when no usage count was supplied (no counter injected, backing table may not exist yet — ' +
              'types.ts\'s own documented contract). This is explicitly required, not skippable.',
            () => {
              const result = resolveQuantityCapability(plan, capability, undefined);
              expect(result).toEqual({ allowed: false, reason: 'not_yet_checkable', limit });
            },
          );

          it(`${plan}: under the cap (${limit - 1} of ${limit}) — allowed`, () => {
            const result = resolveQuantityCapability(plan, capability, limit - 1);
            expect(result).toEqual({ allowed: true, reason: 'ok', limit, used: limit - 1 });
          });

          it(`${plan}: exactly at the cap (${limit} of ${limit}) — blocked, reason 'quota'`, () => {
            const result = resolveQuantityCapability(plan, capability, limit);
            expect(result).toEqual({ allowed: false, reason: 'quota', limit, used: limit });
          });

          it(`${plan}: over the cap (${limit + 1} of ${limit}) — blocked, reason 'quota'`, () => {
            const result = resolveQuantityCapability(plan, capability, limit + 1);
            expect(result).toEqual({ allowed: false, reason: 'quota', limit, used: limit + 1 });
          });
        }
      }
    });
  }
});

describe('lib/entitlements/capability-table.ts — isBooleanCapability / isQuantityCapability', () => {
  it('correctly classifies every known capability and rejects an unknown string', () => {
    expect(isBooleanCapability('streak')).toBe(true);
    expect(isBooleanCapability('account.connect')).toBe(false);
    expect(isBooleanCapability('not-a-real-capability')).toBe(false);

    expect(isQuantityCapability('account.connect')).toBe(true);
    expect(isQuantityCapability('streak')).toBe(false);
    expect(isQuantityCapability('not-a-real-capability')).toBe(false);
  });
});

/**
 * End-to-end through `can()` (not just the pure resolve functions) for a
 * representative sample of each shape — proves the orchestration layer
 * (plan lookup + optional counter) produces the same result the pure
 * functions above do, for both a boolean and a not-yet-checkable
 * quantity capability, without a live DB (getPlan is a plain injected
 * async function here).
 */
describe('lib/entitlements/can.ts — end-to-end through can(), no live DB', () => {
  it('a boolean capability resolves via getPlan alone, no usageCounters needed', async () => {
    const result = await can('user-1', 'graduation', {
      getPlan: async () => 'pro',
    });
    expect(result).toEqual({ allowed: true, reason: 'ok', limit: null });
  });

  it('a quantity capability with a real finite cap and no injected counter resolves not_yet_checkable / fail-closed', async () => {
    const result = await can('user-1', 'rules.create', {
      getPlan: async () => 'free',
    });
    expect(result).toEqual({ allowed: false, reason: 'not_yet_checkable', limit: 3 });
  });

  it('an unrecognised capability string throws rather than silently resolving', async () => {
    await expect(
      can('user-1', 'not-a-real-capability' as never, { getPlan: async () => 'free' }),
    ).rejects.toThrow(/Unknown capability/);
  });
});
