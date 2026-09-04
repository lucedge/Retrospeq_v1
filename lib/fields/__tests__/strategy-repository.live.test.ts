import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

// Real network/DB round trips against the shared dev/test Supabase
// Postgres project — several tests in this file run 3-6 sequential
// queries plus a real `createTestAuthUser` GoTrue round trip, comfortably
// exceeding vitest's 5000ms default under normal live-DB latency, same
// reasoning `rules-repository.live.test.ts`'s own per-test timeout
// overrides document. Set once, file-wide, rather than annotating every
// individual `it()` call.
vi.setConfig({ testTimeout: 20_000 });

import {
  applyStrategyEditVersion,
  createStrategy,
  editStrategy,
  fetchCurrentStrategyForEdit,
  fetchFieldDefinitionsByIds,
  insertStrategyAndVersion,
  StrategyCreateCapExceededError,
  StrategyEditConflictError,
  StrategyEntitlementLimitError,
  StrategyNotEditableError,
  StrategyNotFoundError,
} from '../strategy-repository';
import { FieldMomentIncompatibleError } from '../strategy-validation';

/**
 * Module 03 (Field Registry & Strategy) Slice 03b's authoring pipeline —
 * live-DB proof for `lib/fields/strategy-repository.ts`'s
 * `createStrategy`/`editStrategy`/`insertStrategyAndVersion`/
 * `applyStrategyEditVersion` TRANSACTION correctness (not RLS —
 * `lib/supabase/__tests__/field-registry-schema.rls.test.ts` already
 * covers RLS/policy shape for every field-registry table; this file
 * exercises the real, live multi-statement transactions this slice's own
 * repository functions run, matching
 * `lib/rules/__tests__/rules-repository.live.test.ts`'s own structure and
 * conventions exactly, per this slice's own dispatch instruction to
 * replicate that file's concurrency-proof shape).
 *
 * Every user in this file is set to the `pro` plan directly via the owner
 * connection immediately after creation (`strategy.create`'s own cap is
 * `free: 0, pro: null` — a free user can never successfully call
 * `createStrategy`/`editStrategy` for anything OTHER than the
 * `isDefaultStrategy: true` bypass, per docs/adr/0018) UNLESS a test is
 * specifically exercising the free-plan entitlement gate itself.
 */

const env = readRlsTestEnv();

const DRV_SESSION = 'drv.session'; // pick_one, options seeded, safe for pre_entry
const DRV_RISK_PCT = 'drv.risk_pct'; // number, min/max/step all defined -- safe for pre_entry
const DRV_INSTRUMENT = 'drv.instrument'; // pick_one, no options -- safe type-wise, post_close here

async function setPlan(db: Client, userId: string, plan: 'free' | 'pro'): Promise<void> {
  await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
}

/** Inserts a raw, non-derived (`kind = 'account'`) field row directly —
 *  simulating what a future field-creation slice's own INSERT would
 *  produce, since that flow is explicitly out of THIS slice's scope. Used
 *  to prove `field_usages` population for a "custom" (non-derived) field
 *  reference, per this slice's own dispatch: "a live-DB integration test
 *  proving field_usages rows are genuinely created correctly for both
 *  derived and custom field references." */
async function insertCustomField(
  db: Client,
  userId: string,
  id: string,
  dataType: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, config)
     values ($1, $2, $3, 'account', $4, 'captured', $5::jsonb)`,
    [id, userId, id, dataType, JSON.stringify(config)],
  );
}

async function cleanupUser(db: Client, userId: string): Promise<void> {
  await db.query('begin');
  await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
  await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
  await db.query('delete from retrospeq.fields where user_id = $1 and kind <> $2', [userId, 'derived']);
  await db.query('commit');
}

describe.skipIf(!env)('strategy-repository — createStrategy/editStrategy transaction correctness (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-repo');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('createStrategy writes strategies + strategy_versions(1) + field_usages atomically, for derived field references', async () => {
    const result = await createStrategy({
      userId: user.id,
      name: 'London breakout',
      fields: [
        { fieldId: DRV_SESSION, captureMoment: 'pre_entry', order: 1 },
        { fieldId: DRV_RISK_PCT, captureMoment: 'pre_entry', order: 2 },
      ],
      triggers: [
        { conditionId: 'c1', text: 'Price above the 20 EMA on the 5-minute', order: 1 },
        { conditionId: 'c2', text: 'Three consecutive higher highs', order: 2 },
      ],
    });

    expect(result.version).toBe(1);
    expect(result.triggerCountWarning).toBe(false);
    expect(result.capturedFieldCount).toBe(0); // both fields referenced are kind='derived' -- free, per §4.8

    const strategyRow = await db.query(
      'select current_version, is_default, state, name from retrospeq.strategies where id = $1',
      [result.strategyId],
    );
    expect(strategyRow.rows[0]).toMatchObject({
      current_version: 1,
      is_default: false,
      state: 'active',
      name: 'London breakout',
    });

    const versionRow = await db.query(
      'select fields, triggers, superseded_at from retrospeq.strategy_versions where strategy_id = $1 and version = 1',
      [result.strategyId],
    );
    expect(versionRow.rows[0].superseded_at).toBeNull();
    expect(versionRow.rows[0].fields).toHaveLength(2);
    expect(versionRow.rows[0].triggers).toHaveLength(2);

    const usageRows = await db.query(
      `select field_id from retrospeq.field_usages where user_id = $1 and used_by = 'strategy' and used_by_id = $2 order by field_id`,
      [user.id, result.strategyId],
    );
    expect(usageRows.rows.map((r) => r.field_id).sort()).toEqual([DRV_RISK_PCT, DRV_SESSION].sort());
  });

  it('field_usages is populated correctly for BOTH a derived field and a custom (kind=account) field reference in the same strategy', async () => {
    const customFieldId = `acct.conviction-${Date.now()}`;
    await insertCustomField(db, user.id, customFieldId, 'rating', { min: 1, max: 5 });

    const result = await createStrategy({
      userId: user.id,
      name: 'PD array setup',
      fields: [
        { fieldId: DRV_INSTRUMENT, captureMoment: 'post_close', order: 1 },
        { fieldId: customFieldId, captureMoment: 'pre_entry', order: 2 },
      ],
      triggers: [],
    });

    expect(result.capturedFieldCount).toBe(1); // only the custom (non-derived, non-note) field counts

    const usageRows = await db.query(
      `select field_id from retrospeq.field_usages where user_id = $1 and used_by = 'strategy' and used_by_id = $2 order by field_id`,
      [user.id, result.strategyId],
    );
    expect(usageRows.rows.map((r) => r.field_id).sort()).toEqual([DRV_INSTRUMENT, customFieldId].sort());
  });

  it('createStrategy rejects a note field or unbounded number as pre_entry — FIELD_MOMENT_INCOMPATIBLE, no strategy row written', async () => {
    const noteFieldId = `acct.notes-${Date.now()}`;
    await insertCustomField(db, user.id, noteFieldId, 'note');

    const before = await db.query('select count(*)::text as c from retrospeq.strategies where user_id = $1', [user.id]);

    await expect(
      createStrategy({
        userId: user.id,
        name: 'Should never be written',
        fields: [{ fieldId: noteFieldId, captureMoment: 'pre_entry', order: 1 }],
        triggers: [],
      }),
    ).rejects.toThrow(FieldMomentIncompatibleError);

    const after = await db.query('select count(*)::text as c from retrospeq.strategies where user_id = $1', [user.id]);
    expect(after.rows[0].c).toBe(before.rows[0].c); // no partial write
  });

  it('createStrategy sets triggerCountWarning=true above 5 conditions, but still succeeds (never blocking)', async () => {
    const result = await createStrategy({
      userId: user.id,
      name: 'Many triggers',
      fields: [],
      triggers: Array.from({ length: 6 }, (_, i) => ({ conditionId: `c${i}`, text: `Condition ${i}`, order: i })),
    });
    expect(result.triggerCountWarning).toBe(true);
  });

  it('fetchFieldDefinitionsByIds returns only active fields for this user, scoped correctly', async () => {
    const map = await fetchFieldDefinitionsByIds(user.id, [DRV_SESSION, 'nonexistent.field']);
    expect(map.has(DRV_SESSION)).toBe(true);
    expect(map.get(DRV_SESSION)?.kind).toBe('derived');
    expect(map.has('nonexistent.field')).toBe(false);
  });

  it('fetchFieldDefinitionsByIds returns an empty map for an empty id list, with no query at all', async () => {
    const map = await fetchFieldDefinitionsByIds(user.id, []);
    expect(map.size).toBe(0);
  });

  // -----------------------------------------------------------------
  // editStrategy / applyStrategyEditVersion
  // -----------------------------------------------------------------

  it('editStrategy supersedes v1, inserts v2, bumps current_version + name, and rebuilds field_usages — all atomically', async () => {
    const created = await createStrategy({
      userId: user.id,
      name: 'Original name',
      fields: [{ fieldId: DRV_SESSION, captureMoment: 'pre_entry', order: 1 }],
      triggers: [],
    });

    const current = await fetchCurrentStrategyForEdit(user.id, created.strategyId);
    expect(current?.currentVersion).toBe(1);
    expect(current?.fields).toHaveLength(1);

    const edited = await editStrategy({
      userId: user.id,
      strategyId: created.strategyId,
      expectedVersion: current!.currentVersion,
      name: 'Renamed strategy',
      fields: [{ fieldId: DRV_RISK_PCT, captureMoment: 'pre_entry', order: 1 }], // swaps the field entirely
      triggers: [{ conditionId: 'c1', text: 'Stop under the swing low', order: 1 }],
    });
    expect(edited.newVersion).toBe(2);

    const v1 = await db.query('select superseded_at from retrospeq.strategy_versions where strategy_id = $1 and version = 1', [
      created.strategyId,
    ]);
    expect(v1.rows[0].superseded_at).not.toBeNull();

    const v2 = await db.query(
      'select fields, triggers, superseded_at from retrospeq.strategy_versions where strategy_id = $1 and version = 2',
      [created.strategyId],
    );
    expect(v2.rows[0].superseded_at).toBeNull();
    expect(v2.rows[0].fields).toHaveLength(1);
    expect(v2.rows[0].fields[0].field_id).toBe(DRV_RISK_PCT);

    const strategyRow = await db.query('select current_version, name from retrospeq.strategies where id = $1', [created.strategyId]);
    expect(strategyRow.rows[0]).toMatchObject({ current_version: 2, name: 'Renamed strategy' });

    // field_usages REBUILT, not merely appended -- the old field
    // (DRV_SESSION) must be gone, only the new one (DRV_RISK_PCT) remains.
    const usageRows = await db.query(
      `select field_id from retrospeq.field_usages where user_id = $1 and used_by = 'strategy' and used_by_id = $2`,
      [user.id, created.strategyId],
    );
    expect(usageRows.rows.map((r) => r.field_id)).toEqual([DRV_RISK_PCT]);
  });

  it('a "concurrent" edit against an already-superseded version is rejected with StrategyEditConflictError, and corrupts nothing', async () => {
    const created = await createStrategy({
      userId: user.id,
      name: 'Conflict test',
      fields: [],
      triggers: [],
    });

    const winner = await applyStrategyEditVersion(user.id, created.strategyId, 1, 'Winner name', [], []);
    expect(winner.newVersion).toBe(2);

    // The "loser" -- a second edit attempt still holding the now-stale
    // expectedVersion=1 (exactly what a genuinely concurrent transaction
    // that read the strategy BEFORE the winner committed would also hold).
    await expect(
      applyStrategyEditVersion(user.id, created.strategyId, 1, 'Loser name', [], []),
    ).rejects.toThrow(StrategyEditConflictError);

    const versions = await db.query(
      'select version, superseded_at from retrospeq.strategy_versions where strategy_id = $1 order by version',
      [created.strategyId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[1]).toMatchObject({ version: 2, superseded_at: null });

    const strategyRow = await db.query('select current_version, name from retrospeq.strategies where id = $1', [created.strategyId]);
    expect(strategyRow.rows[0]).toMatchObject({ current_version: 2, name: 'Winner name' });
  });

  it('editStrategy throws StrategyNotFoundError for a nonexistent strategy id', async () => {
    await expect(
      editStrategy({
        userId: user.id,
        strategyId: '00000000-0000-7000-8000-000000000000',
        expectedVersion: 1,
        name: 'x',
        fields: [],
        triggers: [],
      }),
    ).rejects.toThrow(StrategyNotFoundError);
  });

  it('editStrategy throws StrategyNotEditableError for an archived strategy', async () => {
    const created = await createStrategy({ userId: user.id, name: 'To be archived', fields: [], triggers: [] });
    await db.query(`update retrospeq.strategies set state = 'archived' where id = $1`, [created.strategyId]);

    await expect(
      editStrategy({
        userId: user.id,
        strategyId: created.strategyId,
        expectedVersion: 1,
        name: 'Should not apply',
        fields: [],
        triggers: [],
      }),
    ).rejects.toThrow(StrategyNotEditableError);
  });

  // -----------------------------------------------------------------
  // Cross-user isolation
  // -----------------------------------------------------------------

  it("fetchCurrentStrategyForEdit returns null (never another user's row) for a strategy owned by someone else", async () => {
    const otherUser = await createTestAuthUser(env!, 'strategy-repo-other');
    try {
      await setPlan(db, otherUser.id, 'pro');
      const otherStrategy = await createStrategy({ userId: otherUser.id, name: "Other user's strategy", fields: [], triggers: [] });

      expect(await fetchCurrentStrategyForEdit(user.id, otherStrategy.strategyId)).toBeNull();
    } finally {
      await cleanupUser(db, otherUser.id);
      await deleteTestAuthUser(env!, otherUser.id).catch(() => {});
    }
  }, 15_000);
});

// -----------------------------------------------------------------
// Entitlement gate — §1 "the entire strategy module is Pro" / docs/adr/0018
// -----------------------------------------------------------------

describe.skipIf(!env)('strategy-repository — entitlement gate (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-repo-entitlement');
    // Deliberately left on the FREE plan (the default) -- this whole
    // describe block is about proving the free-plan gate itself.
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('createStrategy rejects a free-plan user with StrategyEntitlementLimitError, writes nothing', async () => {
    await expect(
      createStrategy({ userId: user.id, name: 'Free user strategy', fields: [], triggers: [] }),
    ).rejects.toThrow(StrategyEntitlementLimitError);

    const rows = await db.query('select count(*)::text as c from retrospeq.strategies where user_id = $1', [user.id]);
    expect(rows.rows[0].c).toBe('0');
  });

  it('createStrategy with isDefaultStrategy=true SUCCEEDS for a free-plan user (Module 08\'s own bypass, §1)', async () => {
    const result = await createStrategy({
      userId: user.id,
      name: 'Default strategy',
      fields: [],
      triggers: [],
      isDefaultStrategy: true,
    });

    const row = await db.query('select is_default, state from retrospeq.strategies where id = $1', [result.strategyId]);
    expect(row.rows[0]).toMatchObject({ is_default: true, state: 'active' });
  });

  it('editStrategy on the free-plan default strategy is ALSO rejected — the default stays at "zero captured fields" until upgrade (docs/adr/0018)', async () => {
    const current = await db.query('select id, current_version from retrospeq.strategies where user_id = $1 and is_default = true', [
      user.id,
    ]);
    const strategyId = current.rows[0].id as string;
    const currentVersion = current.rows[0].current_version as number;

    await expect(
      editStrategy({
        userId: user.id,
        strategyId,
        expectedVersion: currentVersion,
        name: 'Trying to rename the default',
        fields: [],
        triggers: [],
      }),
    ).rejects.toThrow(StrategyEntitlementLimitError);

    const row = await db.query('select name, current_version from retrospeq.strategies where id = $1', [strategyId]);
    expect(row.rows[0]).toMatchObject({ name: 'Default strategy', current_version: 1 }); // unchanged
  });

  it('a SECOND isDefaultStrategy=true create for the same user is rejected — strategies_one_default_per_user', async () => {
    await expect(
      createStrategy({ userId: user.id, name: 'Second default attempt', fields: [], triggers: [], isDefaultStrategy: true }),
    ).rejects.toThrow();

    const rows = await db.query('select count(*)::text as c from retrospeq.strategies where user_id = $1 and is_default = true', [
      user.id,
    ]);
    expect(rows.rows[0].c).toBe('1'); // still exactly one default
  });

  it('once upgraded to Pro, the same user can create a real (non-default) strategy and edit their default', async () => {
    await setPlan(db, user.id, 'pro');

    const created = await createStrategy({ userId: user.id, name: 'Now Pro', fields: [], triggers: [] });
    expect(created.version).toBe(1);

    const current = await db.query('select id, current_version from retrospeq.strategies where user_id = $1 and is_default = true', [
      user.id,
    ]);
    const edited = await editStrategy({
      userId: user.id,
      strategyId: current.rows[0].id,
      expectedVersion: current.rows[0].current_version,
      name: 'Default, now editable',
      fields: [],
      triggers: [],
    });
    expect(edited.newVersion).toBe(2);
  });
});

// -----------------------------------------------------------------
// GENUINE two-connection concurrency proofs — matches
// `rules-repository.live.test.ts`'s own gold-standard technique exactly
// (`waitForBlockedQuery` polling `pg_stat_activity`, not a fixed-timeout
// race), per this slice's own explicit dispatch instruction to replicate
// it and to learn from Slice 10f's own lost-race bug.
// -----------------------------------------------------------------

async function waitForBlockedQuery(ownerConn: Client, queryPattern: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ownerConn.query<{ pid: number }>(
      `select pid from pg_stat_activity where query ilike $1 and wait_event_type = 'Lock'`,
      [queryPattern],
    );
    if (res.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitForBlockedQuery: no query matching ${JSON.stringify(queryPattern)} was found blocked on a lock within ${timeoutMs}ms.`);
}

describe.skipIf(!env)('applyStrategyEditVersion — GENUINE two-connection concurrency proof (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-repo-edit-race');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'a real second connection holding an UNCOMMITTED supersede write on the exact row applyStrategyEditVersion targets forces the real call to genuinely block, then correctly lose — StrategyEditConflictError, no version 2 row ever inserted, current_version untouched',
    async () => {
      const created = await createStrategy({ userId: user.id, name: 'Race target', fields: [], triggers: [] });

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        await raceConn.query('begin');
        const heldSupersede = await raceConn.query(
          `update retrospeq.strategy_versions set superseded_at = now() where strategy_id = $1 and version = $2 and superseded_at is null`,
          [created.strategyId, 1],
        );
        expect(heldSupersede.rowCount).toBe(1); // lock acquired, held, not yet committed

        const editPromise = applyStrategyEditVersion(user.id, created.strategyId, 1, 'Should lose the race', [], []);

        await waitForBlockedQuery(db, '%set superseded_at = now()%');

        await raceConn.query('commit');

        await expect(editPromise).rejects.toThrow(StrategyEditConflictError);
      } finally {
        await raceConn.end();
      }

      const versions = await db.query(
        'select version, superseded_at from retrospeq.strategy_versions where strategy_id = $1 order by version',
        [created.strategyId],
      );
      expect(versions.rows).toHaveLength(1);
      expect(versions.rows[0]).toMatchObject({ version: 1 });
      expect(versions.rows[0].superseded_at).not.toBeNull();

      const strategyRow = await db.query('select current_version from retrospeq.strategies where id = $1', [created.strategyId]);
      expect(strategyRow.rows[0].current_version).toBe(1);
    },
    15_000,
  );
});

describe.skipIf(!env)('insertStrategyAndVersion — GENUINE two-connection cap-race proof (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-repo-create-cap-race');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  /**
   * `strategy.create`'s own real product cap is either 0 (free -- never
   * reaches this guarded INSERT at all) or null (Pro -- unlimited, no cap
   * to race against), per `lib/entitlements/capability-table.ts` — so
   * there is no PRODUCT scenario with a real finite `capLimit` today.
   * This test exercises `insertStrategyAndVersion`'s own guarded-INSERT
   * MECHANISM directly with a synthetic finite `capLimit`, proving the
   * cap-check-and-write really is atomic under a genuine live
   * interleaving — the same defensive posture `docs/adr/0018`'s own "if
   * this cap ever becomes a real finite nonzero number in the future"
   * scenario anticipates. Matches
   * `rules-repository.live.test.ts`'s own `insertRuleAndVersion` cap-race
   * test technique exactly (advisory-lock contention, not a row lock).
   */
  it(
    'GENUINE concurrency at a synthetic cap: a real second connection holding the SAME advisory lock plus an uncommitted extra non-default strategy (landing the user at capLimit=1) forces the real insertStrategyAndVersion call to genuinely block, then correctly lose — StrategyCreateCapExceededError, never a 2nd active non-default strategy',
    async () => {
      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        await raceConn.query('begin');
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [user.id]);
        await raceConn.query(
          `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
           values ($1, 'Race winner (raw)', 1, false, 'active')`,
          [user.id],
        );

        const createPromise = insertStrategyAndVersion({
          userId: user.id,
          name: 'Race attempt (should be rejected)',
          fields: [],
          triggers: [],
          isDefaultStrategy: false,
          capLimit: 1,
        });

        await waitForBlockedQuery(db, '%select pg_advisory_xact_lock%');

        await raceConn.query('commit');

        await expect(createPromise).rejects.toThrow(StrategyCreateCapExceededError);
      } finally {
        await raceConn.end();
      }

      const finalCount = await db.query<{ c: string }>(
        `select count(*)::text as c from retrospeq.strategies where user_id = $1 and state = 'active' and is_default = false`,
        [user.id],
      );
      expect(Number(finalCount.rows[0].c)).toBe(1); // exactly the raw connection's winner, never 2
    },
    30_000,
  );
});
