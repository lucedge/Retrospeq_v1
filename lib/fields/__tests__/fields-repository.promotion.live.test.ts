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

// Real network/DB round trips — matches `fields-repository.lifecycle.live.test.ts`'s
// own per-file timeout override and reasoning exactly.
vi.setConfig({ testTimeout: 20_000 });

import {
  archiveField,
  createField,
  FieldDerivedImmutableError,
  FieldNameConflictError,
  FieldRecordNotFoundError,
  findPromotionCandidates,
  promoteField,
} from '../fields-repository';
import { createStrategy, editStrategy, fetchCurrentStrategyForEdit } from '../strategy-repository';
import { writeTradeCapture } from '@/lib/ingestion/trade-captures';

/**
 * Module 03 (Field Registry & Strategy) Slice 03e — live-DB proof for
 * `lib/fields/fields-repository.ts`'s `promoteField`/`findPromotionCandidates`
 * (§4.5's "Promote strategy_var -> account" row + §4.5's own "offer it
 * proactively" prose / §6.1's flow diagram).
 *
 * **Why this file has no pure/DB-free sibling
 * (`fields-repository.promotion.test.ts`), matching this repo's own
 * established precedent for this file exactly:** `fields-repository.ts` has
 * zero pure/DB-free tests anywhere — `createField`/`renameField`/
 * `archiveField` all needed a real DB round trip for every one of their own
 * decisions (existence, ownership, entitlement, uniqueness), so all of
 * Slice 03c/03d's own test coverage lives in `fields-repository.live.test.ts`/
 * `fields-repository.lifecycle.live.test.ts`. `promoteField` and
 * `findPromotionCandidates` are no different — every branch either reads or
 * writes `retrospeq.fields` for real. The one piece of this slice's own
 * logic that IS pure (the name-similarity matching `findPromotionCandidates`
 * reuses from `checkPruningRule`'s own `normalizeForMatch`) already has its
 * own dedicated, DB-free unit coverage in
 * `field-validation.test.ts`'s "normalizeForMatch — general pairwise
 * similarity (Slice 03e)" block — deliberately not duplicated here.
 */

const env = readRlsTestEnv();

async function setPlan(db: Client, userId: string, plan: 'free' | 'pro'): Promise<void> {
  await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
}

async function cleanupUser(db: Client, userId: string): Promise<void> {
  await db.query('begin');
  await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
  await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
  await db.query('delete from retrospeq.fills where user_id = $1', [userId]);
  await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
  await db.query('delete from retrospeq.fields where user_id = $1 and kind <> $2', [userId, 'derived']);
  await db.query('commit');
}

/** Minimal real trade + fill fixture, mirroring
 *  `trades-repository.live.test.ts`'s own `seedTradeWithFill` — needed so
 *  the §7.1 "Promotion preserves ... all trade_captures rows" test writes a
 *  GENUINE `trade_captures` row against a real `trades.id` FK, not a fake
 *  stand-in. */
async function seedTrade(db: Client, userId: string): Promise<string> {
  const instrument = 'EURUSD';
  const openedAt = new Date('2026-07-05T09:00:00Z');
  const closedAt = new Date('2026-07-05T11:00:00Z');

  const accountRes = await db.query<{ id: string }>(
    `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
     values ($1, 'Promotion Live Test', 'mt5', 'USD', '00:00:00 UTC')
     returning id`,
    [userId],
  );
  const accountId = accountRes.rows[0].id;

  const blockRes = await db.query<{ id: string }>(
    `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $4::date)
     returning id`,
    [userId, accountId, instrument, openedAt.toISOString(), closedAt.toISOString()],
  );
  const blockId = blockRes.rows[0].id;

  const tradeRes = await db.query<{ id: string }>(
    `insert into retrospeq.trades
       (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
        currency, grouping_confidence)
     values ($1, $2, $3, $4, 'long', $5::timestamptz, $6::timestamptz, $5::date, 'closed', 'USD', 'confident_single')
     returning id`,
    [userId, accountId, blockId, instrument, openedAt.toISOString(), closedAt.toISOString()],
  );
  return tradeRes.rows[0].id;
}

describe.skipIf(!env)('promoteField (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-promote');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('promotes a strategy_var field to account: same id, kind flips, owner_strategy_id set null', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Promotion source strategy', fields: [], triggers: [] });
    const created = await createField({
      userId: user.id,
      name: 'Conviction (promote me)',
      kind: 'strategy_var',
      dataType: 'rating',
      config: { min: 1, max: 5 },
      ownerStrategyId: strategy.strategyId,
    });

    const promoted = await promoteField(user.id, created.fieldId);
    expect(promoted).toMatchObject({ fieldId: created.fieldId, name: 'Conviction (promote me)', kind: 'account', ownerStrategyId: null });

    const row = await db.query(
      `select id, kind, owner_strategy_id, data_type, config from retrospeq.fields where user_id = $1 and id = $2`,
      [user.id, created.fieldId],
    );
    expect(row.rows[0]).toMatchObject({ id: created.fieldId, kind: 'account', owner_strategy_id: null, data_type: 'rating' });
    // config (min/max) untouched -- a pure metadata flip, not a data migration.
    expect(row.rows[0].config).toMatchObject({ min: 1, max: 5 });
  });

  it('is idempotent: promoting an already-account field is a no-op returning current state (judgment call — see promoteField\'s own header)', async () => {
    const created = await createField({ userId: user.id, name: 'Already account', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    const first = await promoteField(user.id, created.fieldId);
    const second = await promoteField(user.id, created.fieldId);
    expect(first).toEqual(second);
    expect(second).toMatchObject({ fieldId: created.fieldId, kind: 'account', ownerStrategyId: null });
  });

  it('calling promoteField twice on the SAME strategy_var field is idempotent end-to-end', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Double-promote strategy', fields: [], triggers: [] });
    const created = await createField({
      userId: user.id,
      name: 'Double promote target',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });

    const first = await promoteField(user.id, created.fieldId);
    const second = await promoteField(user.id, created.fieldId);
    expect(first).toMatchObject({ fieldId: created.fieldId, kind: 'account', ownerStrategyId: null });
    expect(second).toMatchObject({ fieldId: created.fieldId, kind: 'account', ownerStrategyId: null });
  });

  it('rejects promoting a derived field with a clean FieldDerivedImmutableError, no raw trigger text, row untouched', async () => {
    let caught: unknown;
    try {
      await promoteField(user.id, 'drv.instrument');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldDerivedImmutableError);
    const message = (caught as Error).message;
    expect(message).not.toMatch(/fields_forbid_derived_update/i);
    expect(message).not.toMatch(/raise exception/i);
    expect(message).toMatch(/derived field/i);

    const row = await db.query(`select kind, owner_strategy_id from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.instrument']);
    expect(row.rows[0]).toMatchObject({ kind: 'derived', owner_strategy_id: null });
  });

  it('rejects a nonexistent field id with FieldRecordNotFoundError', async () => {
    await expect(promoteField(user.id, 'str.00000000-0000-7000-8000-000000000099')).rejects.toThrow(FieldRecordNotFoundError);
  });

  it('rejects promotion when it would collide with an existing active account field of the same name (§7.2 property test, real collision)', async () => {
    await createField({ userId: user.id, name: 'Taken account name', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    const strategy = await createStrategy({ userId: user.id, name: 'Collision source strategy', fields: [], triggers: [] });
    const strategyVar = await createField({
      userId: user.id,
      name: 'Taken account name',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });

    await expect(promoteField(user.id, strategyVar.fieldId)).rejects.toThrow(FieldNameConflictError);

    // Untouched — still strategy_var, still scoped to its own strategy.
    const row = await db.query(`select kind, owner_strategy_id from retrospeq.fields where user_id = $1 and id = $2`, [user.id, strategyVar.fieldId]);
    expect(row.rows[0]).toMatchObject({ kind: 'strategy_var', owner_strategy_id: strategy.strategyId });
  });

  it('allows promoting an ARCHIVED strategy_var field (judgment call — see promoteField\'s own header); state/archived_at untouched', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Archived-promote strategy', fields: [], triggers: [] });
    const created = await createField({
      userId: user.id,
      name: 'Archived then promoted',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });
    const archived = await archiveField(user.id, created.fieldId);

    const promoted = await promoteField(user.id, created.fieldId);
    expect(promoted).toMatchObject({ fieldId: created.fieldId, kind: 'account', ownerStrategyId: null });

    const row = await db.query(`select kind, owner_strategy_id, state, archived_at from retrospeq.fields where user_id = $1 and id = $2`, [
      user.id,
      created.fieldId,
    ]);
    expect(row.rows[0].kind).toBe('account');
    expect(row.rows[0].owner_strategy_id).toBeNull();
    expect(row.rows[0].state).toBe('archived'); // untouched
    expect(new Date(row.rows[0].archived_at).toISOString()).toBe(new Date(archived.archivedAt).toISOString()); // untouched
  });

  // -----------------------------------------------------------------
  // §7.1: "Promotion preserves field id and all trade_captures rows."
  // Real strategy, real field, real trade, real captured value.
  // -----------------------------------------------------------------

  it('preserves field id and real trade_captures rows across promotion, byte-for-byte', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Captured-history strategy', fields: [], triggers: [] });
    const field = await createField({
      userId: user.id,
      name: 'Setup quality (captured)',
      kind: 'strategy_var',
      dataType: 'rating',
      config: { min: 1, max: 5 },
      ownerStrategyId: strategy.strategyId,
    });

    // Attach the field to the strategy for real (§4.6's own "rebuild
    // field_usages for this strategy" rebuild) — a field's own
    // `owner_strategy_id` alone does NOT create a `field_usages` row;
    // only saving a strategy WITH that field in its `fields[]` does.
    const currentVersion = await fetchCurrentStrategyForEdit(user.id, strategy.strategyId);
    await editStrategy({
      userId: user.id,
      strategyId: strategy.strategyId,
      expectedVersion: currentVersion!.currentVersion,
      name: currentVersion!.name,
      fields: [{ fieldId: field.fieldId, captureMoment: 'post_close', order: 1 }],
      triggers: [],
    });

    const tradeId = await seedTrade(db, user.id);
    const writeResult = await writeTradeCapture(db, {
      tradeId,
      userId: user.id,
      fieldId: field.fieldId,
      value: 4,
      moment: 'post_close',
    });
    expect(writeResult.applied).toBe(true);

    const before = await db.query(`select trade_id, field_id, value, moment from retrospeq.trade_captures where trade_id = $1 and field_id = $2`, [
      tradeId,
      field.fieldId,
    ]);
    expect(before.rowCount).toBe(1);

    const promoted = await promoteField(user.id, field.fieldId);
    expect(promoted.fieldId).toBe(field.fieldId);

    const after = await db.query(`select trade_id, field_id, value, moment from retrospeq.trade_captures where trade_id = $1 and field_id = $2`, [
      tradeId,
      field.fieldId,
    ]);
    expect(after.rowCount).toBe(1);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0].value).toBe(4);

    // field_usages (the strategy dependency) is also untouched by promotion
    // -- a metadata flip, not a data migration.
    const usage = await db.query(
      `select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2 and used_by = 'strategy' and used_by_id = $3`,
      [user.id, field.fieldId, strategy.strategyId],
    );
    expect(usage.rowCount).toBe(1);
  }, 20_000);
});

describe.skipIf(!env)('promoteField — cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fields-promote-a');
    userB = await createTestAuthUser(env, 'fields-promote-b');
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

  it("user B promoting user A's field is rejected with FieldRecordNotFoundError, no state change", async () => {
    const strategy = await createStrategy({ userId: userA.id, name: "A's strategy", fields: [], triggers: [] });
    const created = await createField({
      userId: userA.id,
      name: "A's own strategy var",
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });

    await expect(promoteField(userB.id, created.fieldId)).rejects.toThrow(FieldRecordNotFoundError);

    const row = await db.query(`select kind, owner_strategy_id from retrospeq.fields where user_id = $1 and id = $2`, [userA.id, created.fieldId]);
    expect(row.rows[0]).toMatchObject({ kind: 'strategy_var', owner_strategy_id: strategy.strategyId });
  });

  it("user B's connection cannot see user A's field row at all (RLS, not just application filtering)", async () => {
    const strategy = await createStrategy({ userId: userA.id, name: "A's isolation strategy", fields: [], triggers: [] });
    const created = await createField({
      userId: userA.id,
      name: "A's isolation strategy var",
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });

    const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select 1 from retrospeq.fields where id = $1', [created.fieldId]);
      return res.rowCount;
    });
    expect(rowCount).toBe(0);
  });
});

describe.skipIf(!env)('findPromotionCandidates (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-promo-candidates');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('finds an existing strategy_var field in ANOTHER strategy as a promotion candidate for a similarly-named proposed field', async () => {
    const strategyA = await createStrategy({ userId: user.id, name: 'Strategy A (has Conviction)', fields: [], triggers: [] });
    const existing = await createField({
      userId: user.id,
      name: 'Conviction',
      kind: 'strategy_var',
      dataType: 'rating',
      config: { min: 1, max: 5 },
      ownerStrategyId: strategyA.strategyId,
    });

    const strategyB = await createStrategy({ userId: user.id, name: 'Strategy B (wants Conviction too)', fields: [], triggers: [] });

    const candidates = await findPromotionCandidates(user.id, strategyB.strategyId, ['Conviction']);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      fieldId: existing.fieldId,
      name: 'Conviction',
      ownerStrategyId: strategyA.strategyId,
      matchedProposedName: 'Conviction',
    });
  });

  it('matches via the SAME similarity normalization as the pruning rule (simple plural + case, matching normalizeForMatch\'s own documented "PD array"/"PD arrays" example)', async () => {
    const strategyA = await createStrategy({ userId: user.id, name: 'Strategy A (PD array)', fields: [], triggers: [] });
    const existing = await createField({
      userId: user.id,
      name: 'PD array',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategyA.strategyId,
    });
    const strategyB = await createStrategy({ userId: user.id, name: 'Strategy B (wants PD arrays)', fields: [], triggers: [] });

    const candidates = await findPromotionCandidates(user.id, strategyB.strategyId, ['PD ARRAYS']);
    expect(candidates.map((c) => c.fieldId)).toContain(existing.fieldId);
  });

  it('excludes a strategy_var field already owned by the SAME strategy being edited', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Self-owned strategy', fields: [], triggers: [] });
    await createField({
      userId: user.id,
      name: 'Self owned field',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });

    const candidates = await findPromotionCandidates(user.id, strategy.strategyId, ['Self owned field']);
    expect(candidates).toHaveLength(0);
  });

  it('with excludeStrategyId = null (brand-new strategy being authored), every matching strategy_var field is a candidate', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Existing strategy for null-exclude test', fields: [], triggers: [] });
    const existing = await createField({
      userId: user.id,
      name: 'Null exclude target',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });

    const candidates = await findPromotionCandidates(user.id, null, ['Null exclude target']);
    expect(candidates.map((c) => c.fieldId)).toContain(existing.fieldId);
  });

  it('never returns an ARCHIVED strategy_var field as a candidate', async () => {
    const strategyA = await createStrategy({ userId: user.id, name: 'Strategy A (archived candidate)', fields: [], triggers: [] });
    const existing = await createField({
      userId: user.id,
      name: 'Archived candidate field',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategyA.strategyId,
    });
    await archiveField(user.id, existing.fieldId);

    const strategyB = await createStrategy({ userId: user.id, name: 'Strategy B (archived candidate check)', fields: [], triggers: [] });
    const candidates = await findPromotionCandidates(user.id, strategyB.strategyId, ['Archived candidate field']);
    expect(candidates.map((c) => c.fieldId)).not.toContain(existing.fieldId);
  });

  it('never returns an ACCOUNT-kind field as a candidate (only strategy_var is eligible for promotion at all)', async () => {
    await createField({ userId: user.id, name: 'Already global field', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const strategyB = await createStrategy({ userId: user.id, name: 'Strategy B (account-kind check)', fields: [], triggers: [] });

    const candidates = await findPromotionCandidates(user.id, strategyB.strategyId, ['Already global field']);
    expect(candidates).toHaveLength(0);
  });

  it('returns [] for unrelated proposed names, and [] for an empty proposedFieldNames array, with no error', async () => {
    const strategyA = await createStrategy({ userId: user.id, name: 'Strategy A (no match)', fields: [], triggers: [] });
    await createField({ userId: user.id, name: 'Totally unrelated', kind: 'strategy_var', dataType: 'bool', config: {}, ownerStrategyId: strategyA.strategyId });
    const strategyB = await createStrategy({ userId: user.id, name: 'Strategy B (no match)', fields: [], triggers: [] });

    await expect(findPromotionCandidates(user.id, strategyB.strategyId, ['Something else entirely'])).resolves.toEqual([]);
    await expect(findPromotionCandidates(user.id, strategyB.strategyId, [])).resolves.toEqual([]);
  });
});

describe.skipIf(!env)('findPromotionCandidates — cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fields-promo-cand-a');
    userB = await createTestAuthUser(env, 'fields-promo-cand-b');
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

  it("user B's candidate search never returns user A's strategy_var fields", async () => {
    const strategyA = await createStrategy({ userId: userA.id, name: "A's strategy (isolation)", fields: [], triggers: [] });
    await createField({
      userId: userA.id,
      name: 'Cross-user candidate probe',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategyA.strategyId,
    });

    const strategyB = await createStrategy({ userId: userB.id, name: "B's strategy (isolation)", fields: [], triggers: [] });
    const candidates = await findPromotionCandidates(userB.id, strategyB.strategyId, ['Cross-user candidate probe']);
    expect(candidates).toHaveLength(0);
  });
});
