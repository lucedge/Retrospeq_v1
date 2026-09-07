import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

// Real network/DB round trips against the shared dev/test Supabase
// Postgres project -- matches `strategy-repository.live.test.ts`'s own
// per-file timeout override and reasoning exactly.
vi.setConfig({ testTimeout: 20_000 });

import {
  createField,
  FieldEntitlementLimitError,
  FieldKindScopeMismatchError,
  FieldNameConflictError,
  FieldNameInvalidError,
} from '../fields-repository';
import { FieldConfigInvalidError, FieldDuplicatesDerivedError } from '../field-validation';
import { StrategyNotFoundError, createStrategy } from '../strategy-repository';

/**
 * Module 03 (Field Registry & Strategy) Slice 03c -- live-DB proof for
 * `lib/fields/fields-repository.ts`'s `createField`: the pruning-rule
 * check, config-shape validation, the entitlement gate, the real
 * `(user_id, name, owner_strategy_id)` collision path, and the
 * cross-user strategy-ownership adversarial case, all against the real
 * schema (`20260902010000_field_registry_schema.sql`) and its real RLS
 * policies/partial unique indexes -- not mocked.
 */

const env = readRlsTestEnv();

async function setPlan(db: Client, userId: string, plan: 'free' | 'pro'): Promise<void> {
  await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
}

async function cleanupUser(db: Client, userId: string): Promise<void> {
  await db.query('begin');
  await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
  await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
  await db.query('delete from retrospeq.fields where user_id = $1 and kind <> $2', [userId, 'derived']);
  await db.query('commit');
}

describe.skipIf(!env)('createField -- creation, pruning rule, config validation (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-create');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('creates a kind=account field with a real acct.-prefixed uuidv7 id, origin=captured, state=active', async () => {
    const result = await createField({
      userId: user.id,
      name: 'Conviction',
      kind: 'account',
      dataType: 'rating',
      config: {},
      ownerStrategyId: null,
    });

    expect(result.fieldId).toMatch(/^acct\.[0-9a-f-]{36}$/);
    expect(result.config).toEqual({ min: 1, max: 5 }); // §4.3 default applied

    const row = await db.query(
      `select kind, data_type, origin, state, owner_strategy_id, config, min_tier
         from retrospeq.fields where user_id = $1 and id = $2`,
      [user.id, result.fieldId],
    );
    expect(row.rows[0]).toMatchObject({
      kind: 'account',
      data_type: 'rating',
      origin: 'captured',
      state: 'active',
      owner_strategy_id: null,
      min_tier: 't0',
    });
    expect(row.rows[0].config).toEqual({ min: 1, max: 5 });
  });

  it('creates a kind=strategy_var field scoped to a real owned strategy, with a str.-prefixed id', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Scoped-field host strategy', fields: [], triggers: [] });

    const result = await createField({
      userId: user.id,
      name: 'PD array',
      kind: 'strategy_var',
      dataType: 'pick_one',
      config: { options: ['Bullish', 'Bearish', 'None'] },
      ownerStrategyId: strategy.strategyId,
    });

    expect(result.fieldId).toMatch(/^str\.[0-9a-f-]{36}$/);

    const row = await db.query(`select kind, owner_strategy_id, config from retrospeq.fields where user_id = $1 and id = $2`, [
      user.id,
      result.fieldId,
    ]);
    expect(row.rows[0]).toMatchObject({ kind: 'strategy_var', owner_strategy_id: strategy.strategyId });
    expect(row.rows[0].config).toEqual({ options: ['Bullish', 'Bearish', 'None'] });
  });

  it('trims options[] entries on write', async () => {
    const result = await createField({
      userId: user.id,
      name: 'Timeframe used',
      kind: 'account',
      dataType: 'pick_one',
      config: { options: [' M5 ', 'M15'] },
      ownerStrategyId: null,
    });
    expect(result.config.options).toEqual(['M5', 'M15']);
  });

  // -----------------------------------------------------------------
  // §4.1 pruning rule -- live end-to-end, not just the pure unit test
  // -----------------------------------------------------------------

  it('refuses a field duplicating a derived one -- FIELD_DUPLICATES_DERIVED, no row written', async () => {
    const before = await db.query(`select count(*)::text as c from retrospeq.fields where user_id = $1 and kind <> 'derived'`, [
      user.id,
    ]);

    await expect(
      createField({ userId: user.id, name: 'Session', kind: 'account', dataType: 'pick_one', config: { options: ['a'] }, ownerStrategyId: null }),
    ).rejects.toThrow(FieldDuplicatesDerivedError);

    const after = await db.query(`select count(*)::text as c from retrospeq.fields where user_id = $1 and kind <> 'derived'`, [
      user.id,
    ]);
    expect(after.rows[0].c).toBe(before.rows[0].c); // no partial write
  });

  // -----------------------------------------------------------------
  // §4.3 config validation -- live end-to-end
  // -----------------------------------------------------------------

  it('rejects a pick_one field with no options[], writes nothing', async () => {
    await expect(
      createField({ userId: user.id, name: 'Broken picker', kind: 'account', dataType: 'pick_one', config: {}, ownerStrategyId: null }),
    ).rejects.toThrow(FieldConfigInvalidError);

    const row = await db.query(`select 1 from retrospeq.fields where user_id = $1 and name = $2`, [user.id, 'Broken picker']);
    expect(row.rowCount).toBe(0);
  });

  it('rejects a number field with min > max, writes nothing', async () => {
    await expect(
      createField({
        userId: user.id,
        name: 'Broken number',
        kind: 'account',
        dataType: 'number',
        config: { min: 10, max: 0, step: 1 },
        ownerStrategyId: null,
      }),
    ).rejects.toThrow(FieldConfigInvalidError);

    const row = await db.query(`select 1 from retrospeq.fields where user_id = $1 and name = $2`, [user.id, 'Broken number']);
    expect(row.rowCount).toBe(0);
  });

  // -----------------------------------------------------------------
  // kind / ownerStrategyId consistency
  // -----------------------------------------------------------------

  it('rejects kind=strategy_var with no ownerStrategyId', async () => {
    await expect(
      createField({ userId: user.id, name: 'Missing scope', kind: 'strategy_var', dataType: 'bool', config: {}, ownerStrategyId: null }),
    ).rejects.toThrow(FieldKindScopeMismatchError);
  });

  it('rejects kind=account with a non-null ownerStrategyId', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Should not scope an account field', fields: [], triggers: [] });
    await expect(
      createField({
        userId: user.id,
        name: 'Wrongly scoped',
        kind: 'account',
        dataType: 'bool',
        config: {},
        ownerStrategyId: strategy.strategyId,
      }),
    ).rejects.toThrow(FieldKindScopeMismatchError);
  });

  // -----------------------------------------------------------------
  // Name validation
  // -----------------------------------------------------------------

  it('rejects an empty name', async () => {
    await expect(
      createField({ userId: user.id, name: '   ', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null }),
    ).rejects.toThrow(FieldNameInvalidError);
  });

  it('rejects a name over 40 characters (§5.2 maxlength)', async () => {
    await expect(
      createField({ userId: user.id, name: 'x'.repeat(41), kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null }),
    ).rejects.toThrow(FieldNameInvalidError);
  });

  // -----------------------------------------------------------------
  // Real (user_id, name, owner_strategy_id) collision -> clean error
  // -----------------------------------------------------------------

  it('a real duplicate-name collision on an unscoped (account) field surfaces FieldNameConflictError, not a raw Postgres error', async () => {
    await createField({ userId: user.id, name: 'Setup grade', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    await expect(
      createField({ userId: user.id, name: 'Setup grade', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null }),
    ).rejects.toThrow(FieldNameConflictError);
  });

  it('a real duplicate-name collision on a scoped (strategy_var) field, within the SAME strategy, surfaces FieldNameConflictError', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Collision host', fields: [], triggers: [] });
    await createField({
      userId: user.id,
      name: 'Liquidity note',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });

    await expect(
      createField({
        userId: user.id,
        name: 'Liquidity note',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: strategy.strategyId,
      }),
    ).rejects.toThrow(FieldNameConflictError);
  });

  it('the SAME name is allowed for an account field AND a strategy_var field in a DIFFERENT scope -- the two partial unique indexes are independent', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Independent scope host', fields: [], triggers: [] });

    await createField({ userId: user.id, name: 'Reused name', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    await expect(
      createField({
        userId: user.id,
        name: 'Reused name',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: strategy.strategyId,
      }),
    ).resolves.toBeDefined();
  });

  // -----------------------------------------------------------------
  // Cross-user strategy-ownership adversarial case (defense in depth)
  // -----------------------------------------------------------------

  it('a client-supplied ownerStrategyId pointing at ANOTHER user\'s strategy is rejected with StrategyNotFoundError, no row written', async () => {
    const otherUser = await createTestAuthUser(env!, 'fields-create-other');
    try {
      await setPlan(db, otherUser.id, 'pro');
      const otherStrategy = await createStrategy({ userId: otherUser.id, name: "Other user's strategy", fields: [], triggers: [] });

      await expect(
        createField({
          userId: user.id,
          name: 'Hijack attempt',
          kind: 'strategy_var',
          dataType: 'bool',
          config: {},
          ownerStrategyId: otherStrategy.strategyId,
        }),
      ).rejects.toThrow(StrategyNotFoundError);

      const row = await db.query(`select 1 from retrospeq.fields where user_id = $1 and name = $2`, [user.id, 'Hijack attempt']);
      expect(row.rowCount).toBe(0);
    } finally {
      await cleanupUser(db, otherUser.id);
      await deleteTestAuthUser(env!, otherUser.id).catch(() => {});
    }
  }, 15_000);

  it('a malformed (non-UUID-shaped) ownerStrategyId is rejected with StrategyNotFoundError, never reaches Postgres as a raw type error', async () => {
    await expect(
      createField({
        userId: user.id,
        name: 'Malformed scope',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: 'not-a-uuid',
      }),
    ).rejects.toThrow(StrategyNotFoundError);
  });

  it('a genuinely nonexistent (but well-formed) ownerStrategyId is rejected with StrategyNotFoundError', async () => {
    await expect(
      createField({
        userId: user.id,
        name: 'Nonexistent scope',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: '00000000-0000-7000-8000-000000000000',
      }),
    ).rejects.toThrow(StrategyNotFoundError);
  });
});

// -----------------------------------------------------------------
// Entitlement gate -- §1 "the entire strategy module is Pro" / docs/adr/0019
// -----------------------------------------------------------------

describe.skipIf(!env)('createField -- entitlement gate (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-create-entitlement');
    // Deliberately left on the FREE plan (the default).
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('rejects a free-plan user with FieldEntitlementLimitError, writes nothing', async () => {
    await expect(
      createField({ userId: user.id, name: 'Free user field', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null }),
    ).rejects.toThrow(FieldEntitlementLimitError);

    const rows = await db.query(`select count(*)::text as c from retrospeq.fields where user_id = $1 and kind <> 'derived'`, [
      user.id,
    ]);
    expect(rows.rows[0].c).toBe('0');
  });

  it('the entitlement gate runs BEFORE the strategy-ownership check -- a free user gets FieldEntitlementLimitError even with a bogus ownerStrategyId', async () => {
    await expect(
      createField({
        userId: user.id,
        name: 'Free user scoped field',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: '00000000-0000-7000-8000-000000000000',
      }),
    ).rejects.toThrow(FieldEntitlementLimitError);
  });

  it('once upgraded to Pro, the same user can create a real field', async () => {
    await setPlan(db, user.id, 'pro');

    const result = await createField({
      userId: user.id,
      name: 'Now Pro field',
      kind: 'account',
      dataType: 'bool',
      config: {},
      ownerStrategyId: null,
    });
    expect(result.fieldId).toMatch(/^acct\./);
  });
});

// -----------------------------------------------------------------
// RLS cross-user isolation for the NEW write path -- Slice 03a already
// covers RLS/policy shape for `fields` itself
// (`field-registry-schema.rls.test.ts`); this confirms `createField`'s
// OWN write genuinely respects it, not merely assumed.
// -----------------------------------------------------------------

describe.skipIf(!env)('createField -- cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fields-create-isolation-a');
    userB = await createTestAuthUser(env, 'fields-create-isolation-b');
    await setPlan(db, userA.id, 'pro');
    await setPlan(db, userB.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, userA.id);
    await cleanupUser(db, userB.id);
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  it('two different users can each create an identically-named account field -- uniqueness is per-user, not global', async () => {
    const a = await createField({ userId: userA.id, name: 'Shared name', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const b = await createField({ userId: userB.id, name: 'Shared name', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    expect(a.fieldId).not.toBe(b.fieldId);
  });

  it("user B's connection cannot see user A's newly-created field row (RLS, not just application filtering)", async () => {
    const created = await createField({ userId: userA.id, name: 'A-only field', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    // withUserConnection(userB.id, ...) would enforce this at the app
    // layer too, but the real backstop is RLS itself -- probe directly,
    // via this repo's own `asRole` helper (same mechanism PostgREST uses
    // to resolve auth.uid(), one layer lower).
    const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select 1 from retrospeq.fields where id = $1', [created.fieldId]);
      return res.rowCount;
    });
    expect(rowCount).toBe(0);
  });
});
