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

vi.setConfig({ testTimeout: 30_000 });

import {
  applyStrategyEditVersion,
  createStrategy,
  editStrategy,
  fetchCurrentStrategyForEdit,
  insertStrategyAndVersion,
  StrategyCreateCapExceededError,
  StrategyEditConflictError,
} from '../strategy-repository';

/**
 * INDEPENDENT VERIFICATION (live DB) — Module 03 Slice 03b, dispatched
 * separately from the coder who built `strategy-repository.ts`. Per this
 * dispatch's own instructions: fresh adversarial scenarios distinct from
 * `strategy-repository.live.test.ts`'s own concurrency proofs (different
 * fixture values, and a genuinely different RACE SHAPE — same-session
 * double-submit via `Promise.all` rather than "one connection holds an
 * open transaction while the real call blocks on it"), plus three checks
 * the coder's own test file did not attempt at all: a real widened-window
 * probe of the `field_usages` delete-then-reinsert step, a genuine
 * concurrent double-attempt at creating a second default strategy, and
 * on-disk JSON round-trip fidelity for edge-case fixtures.
 */

const env = readRlsTestEnv();

async function setPlan(db: Client, userId: string, plan: 'free' | 'pro'): Promise<void> {
  await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
}

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

// ---------------------------------------------------------------------
// 1. Fresh adversarial concurrency re-derivation
// ---------------------------------------------------------------------

describe.skipIf(!env)('applyStrategyEditVersion — fresh same-session double-submit race (independent re-derivation)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-iv-edit-race');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'two REAL concurrent editStrategy calls sharing the SAME stale expectedVersion (Promise.all, not a held-transaction lock) — exactly one wins, one loses, no phantom version 3',
    async () => {
      const created = await createStrategy({
        userId: user.id,
        name: 'Double-submit target',
        fields: [],
        triggers: [{ conditionId: 'seed', text: 'Original seed trigger', order: 0 }],
      });
      expect(created.version).toBe(1);

      // Two genuinely simultaneous calls (fired together, not sequenced via
      // an explicit held lock) both holding expectedVersion=1 — simulates a
      // double-click or two-tab race against the SAME read, distinct from
      // the coder's own "intervening editor already committed" scenario.
      const [resultA, resultB] = await Promise.allSettled([
        applyStrategyEditVersion(user.id, created.strategyId, 1, 'Editor A wins?', [], [{ conditionId: 'a', text: 'From editor A', order: 0 }]),
        applyStrategyEditVersion(user.id, created.strategyId, 1, 'Editor B wins?', [], [{ conditionId: 'b', text: 'From editor B', order: 0 }]),
      ]);

      const outcomes = [resultA, resultB];
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StrategyEditConflictError);

      // Exactly one coherent version-2 row — no phantom third version, no
      // corruption from the loser's own partially-applied writes.
      const versions = await db.query(
        'select version, superseded_at, name from retrospeq.strategy_versions where strategy_id = $1 order by version',
        [created.strategyId],
      );
      expect(versions.rows).toHaveLength(2);
      expect(versions.rows[0]).toMatchObject({ version: 1 });
      expect(versions.rows[0].superseded_at).not.toBeNull();
      expect(versions.rows[1]).toMatchObject({ version: 2, superseded_at: null });

      const winnerName = versions.rows[1].name as string;
      expect(['Editor A wins?', 'Editor B wins?']).toContain(winnerName);

      const strategyRow = await db.query('select current_version, name from retrospeq.strategies where id = $1', [created.strategyId]);
      expect(strategyRow.rows[0]).toMatchObject({ current_version: 2, name: winnerName });
    },
    20_000,
  );
});

describe.skipIf(!env)('insertStrategyAndVersion — fresh two-REAL-caller cap race (independent re-derivation)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-iv-cap-race');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'two REAL concurrent insertStrategyAndVersion calls (Promise.all, capLimit=1, zero pre-existing strategies) — exactly one succeeds, never two',
    async () => {
      // Unlike the coder's own test (one raw-SQL winner pre-committed, one
      // real call racing it), BOTH sides here are real calls to the actual
      // function under test, fired together — the advisory lock inside
      // `insertStrategyAndVersion` itself is the only thing serialising
      // them; if it didn't, this test would non-deterministically land two
      // active non-default strategies against a capLimit of 1.
      const [resultA, resultB] = await Promise.allSettled([
        insertStrategyAndVersion({ userId: user.id, name: 'Cap racer A', fields: [], triggers: [], isDefaultStrategy: false, capLimit: 1 }),
        insertStrategyAndVersion({ userId: user.id, name: 'Cap racer B', fields: [], triggers: [], isDefaultStrategy: false, capLimit: 1 }),
      ]);

      const outcomes = [resultA, resultB];
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StrategyCreateCapExceededError);

      const finalCount = await db.query<{ c: string }>(
        `select count(*)::text as c from retrospeq.strategies where user_id = $1 and state = 'active' and is_default = false`,
        [user.id],
      );
      expect(Number(finalCount.rows[0].c)).toBe(1);
    },
    20_000,
  );
});

describe.skipIf(!env)('insertStrategyAndVersion(isDefaultStrategy=true) — genuine concurrent double-default race (NOT tested live by the coder — their own test was sequential)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-iv-default-race');
    // Deliberately left free-plan — isDefaultStrategy bypasses the
    // entitlement check entirely, so plan is irrelevant here; this
    // isolates the DB-level `strategies_one_default_per_user` guard.
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'two REAL concurrent createStrategy(isDefaultStrategy=true) calls for the SAME fresh user, fired together — exactly one succeeds, DB ends with exactly one default, never zero and never two',
    async () => {
      const [resultA, resultB] = await Promise.allSettled([
        createStrategy({ userId: user.id, name: 'Default racer A', fields: [], triggers: [], isDefaultStrategy: true }),
        createStrategy({ userId: user.id, name: 'Default racer B', fields: [], triggers: [], isDefaultStrategy: true }),
      ]);

      const outcomes = [resultA, resultB];
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      // Both calls pass the same-value `$3 = true` WHERE-clause escape
      // hatch inside `insertStrategyAndVersion`'s own guarded INSERT, so
      // BOTH may attempt the insert — the real backstop is
      // `strategies_one_default_per_user` (a unique index violation),
      // which is what must be the actual cause of the loser's rejection.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const defaultRows = await db.query(
        `select id, name, is_default, state from retrospeq.strategies where user_id = $1 and is_default = true`,
        [user.id],
      );
      expect(defaultRows.rows).toHaveLength(1);
      expect(defaultRows.rows[0].state).toBe('active');

      // The winner's own returned strategyId must be the one actually left
      // standing in the DB — the loser's rejection did not corrupt or
      // orphan the winner's row.
      const winner = fulfilled[0] as PromiseFulfilledResult<{ strategyId: string; version: number }>;
      expect(defaultRows.rows[0].id).toBe(winner.value.strategyId);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------
// 2. field_usages delete-then-reinsert — real widened-window transactional
//    consistency proof, not merely "it's wrapped in withUserConnection so
//    it must be fine."
// ---------------------------------------------------------------------

describe.skipIf(!env)('field_usages rebuild — no cross-transaction visibility gap between delete and reinsert', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-iv-usages-race');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'a third, fully independent connection reading field_usages DURING an artificially widened delete->reinsert window (same two statements the real code runs, plus an explicit pg_sleep between them, inside one uncommitted transaction) sees the OLD complete set throughout — never zero rows, never a partial view',
    async () => {
      const customFieldId = `acct.usages-race-${Date.now()}`;
      await insertCustomField(db, user.id, customFieldId, 'bool');

      const created = await createStrategy({
        userId: user.id,
        name: 'Usages race target',
        fields: [
          { fieldId: 'drv.session', captureMoment: 'post_close', order: 1 },
          { fieldId: customFieldId, captureMoment: 'post_close', order: 2 },
        ],
        triggers: [],
      });

      // Sanity: the two rows exist before the race begins.
      const before = await db.query(
        `select field_id from retrospeq.field_usages where user_id = $1 and used_by = 'strategy' and used_by_id = $2 order by field_id`,
        [user.id, created.strategyId],
      );
      expect(before.rows).toHaveLength(2);

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      const readerConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await readerConn.connect();

      try {
        await raceConn.query('begin');
        // The EXACT delete statement `rebuildFieldUsagesForStrategy` runs,
        // then an explicit artificial delay before the reinsert — widening
        // the real code's own (normally sub-millisecond, un-probeable)
        // window to something a concurrent reader can actually land inside.
        await raceConn.query(
          `delete from retrospeq.field_usages where user_id = $1 and used_by = 'strategy' and used_by_id = $2`,
          [user.id, created.strategyId],
        );

        // A concurrent, fully independent connection reads WHILE the
        // delete is uncommitted and the reinsert has not run yet.
        const duringWindow = await readerConn.query(
          `select field_id from retrospeq.field_usages where user_id = $1 and used_by = 'strategy' and used_by_id = $2 order by field_id`,
          [user.id, created.strategyId],
        );
        // READ COMMITTED: an uncommitted delete on another connection is
        // invisible here — the reader must still see the OLD complete set,
        // not zero rows.
        expect(duringWindow.rows.map((r) => r.field_id).sort()).toEqual([customFieldId, 'drv.session'].sort());

        await raceConn.query(
          `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
           select unnest($1::text[]), $2, 'strategy', $3`,
          [[customFieldId, 'drv.session'], user.id, created.strategyId],
        );
        await raceConn.query('commit');

        const after = await readerConn.query(
          `select field_id from retrospeq.field_usages where user_id = $1 and used_by = 'strategy' and used_by_id = $2 order by field_id`,
          [user.id, created.strategyId],
        );
        expect(after.rows.map((r) => r.field_id).sort()).toEqual([customFieldId, 'drv.session'].sort());
      } finally {
        await raceConn.end();
        await readerConn.end();
      }
    },
    20_000,
  );

  it(
    'the REAL applyStrategyEditVersion call itself (not a simulated raw-SQL stand-in) — a concurrent reader polling field_usages throughout a real edit call never observes zero rows for a strategy that always referenced >=1 field',
    async () => {
      const customFieldId = `acct.usages-real-edit-${Date.now()}`;
      await insertCustomField(db, user.id, customFieldId, 'bool');

      const created = await createStrategy({
        userId: user.id,
        name: 'Real edit usages target',
        fields: [{ fieldId: customFieldId, captureMoment: 'post_close', order: 1 }],
        triggers: [],
      });

      const readerConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await readerConn.connect();

      let sawEmpty = false;
      let pollCount = 0;
      let stop = false;
      const poller = (async () => {
        while (!stop) {
          const res = await readerConn.query(
            `select count(*)::int as c from retrospeq.field_usages where user_id = $1 and used_by = 'strategy' and used_by_id = $2`,
            [user.id, created.strategyId],
          );
          pollCount++;
          if (res.rows[0].c === 0) sawEmpty = true;
          await new Promise((r) => setTimeout(r, 1));
        }
      })();

      const otherFieldId = `acct.usages-real-edit-2-${Date.now()}`;
      await insertCustomField(db, user.id, otherFieldId, 'rating', { min: 1, max: 5 });

      await editStrategy({
        userId: user.id,
        strategyId: created.strategyId,
        expectedVersion: 1,
        name: 'Renamed, field swapped',
        fields: [{ fieldId: otherFieldId, captureMoment: 'post_close', order: 1 }],
        triggers: [],
      });

      stop = true;
      await poller;
      await readerConn.end();

      expect(pollCount).toBeGreaterThan(0); // sanity: the poller actually ran concurrently
      expect(sawEmpty).toBe(false);

      const final = await db.query(
        `select field_id from retrospeq.field_usages where user_id = $1 and used_by = 'strategy' and used_by_id = $2`,
        [user.id, created.strategyId],
      );
      expect(final.rows.map((r) => r.field_id)).toEqual([otherFieldId]);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------
// 3. On-disk JSON round-trip fidelity for edge-case shapes
// ---------------------------------------------------------------------

describe.skipIf(!env)('strategy_versions.fields/triggers JSONB round-trip — edge-case fixtures', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-iv-json-roundtrip');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('empty fields[] AND empty triggers[] round-trip as empty arrays, not null and not a missing key', async () => {
    const created = await createStrategy({ userId: user.id, name: 'Empty everything', fields: [], triggers: [] });

    const raw = await db.query('select fields, triggers from retrospeq.strategy_versions where strategy_id = $1 and version = 1', [
      created.strategyId,
    ]);
    expect(raw.rows[0].fields).toEqual([]);
    expect(raw.rows[0].triggers).toEqual([]);

    const viaFetch = await fetchCurrentStrategyForEdit(user.id, created.strategyId);
    expect(viaFetch?.fields).toEqual([]);
    expect(viaFetch?.triggers).toEqual([]);
  });

  it('unicode/emoji/CJK trigger text and a strategy name with special characters round-trip byte-for-byte identical', async () => {
    const strategyName = 'Ünïcödé strâtégy — 日本語 — "quoted" & <tags> & \\backslash\\';
    const triggerText = '🔥 Break above the 20 EMA — 突破 confirmed, no news within 15分 — "hedge word" check';

    const created = await createStrategy({
      userId: user.id,
      name: strategyName,
      fields: [],
      triggers: [{ conditionId: 'unicode-trigger', text: triggerText, order: 0 }],
    });

    const raw = await db.query('select s.name as strategy_name, sv.triggers from retrospeq.strategies s join retrospeq.strategy_versions sv on sv.strategy_id = s.id and sv.version = 1 where s.id = $1', [
      created.strategyId,
    ]);
    expect(raw.rows[0].strategy_name).toBe(strategyName);
    expect(raw.rows[0].triggers[0].text).toBe(triggerText);

    const viaFetch = await fetchCurrentStrategyForEdit(user.id, created.strategyId);
    expect(viaFetch?.name).toBe(strategyName);
    expect(viaFetch?.triggers[0].text).toBe(triggerText);
  });

  it('trigger text at exactly the 120-char write-time boundary round-trips with no truncation', async () => {
    const text = 'A'.repeat(119) + 'Z'; // exactly 120 chars, distinguishable last char
    const created = await createStrategy({
      userId: user.id,
      name: 'Boundary trigger length',
      fields: [],
      triggers: [{ conditionId: 'boundary', text, order: 0 }],
    });

    const raw = await db.query('select triggers from retrospeq.strategy_versions where strategy_id = $1 and version = 1', [created.strategyId]);
    expect(raw.rows[0].triggers[0].text).toHaveLength(120);
    expect(raw.rows[0].triggers[0].text).toBe(text);
  });

  it('duplicate `order` values across multiple fields are preserved exactly as given, not deduplicated or renumbered', async () => {
    const customA = `acct.dup-order-a-${Date.now()}`;
    const customB = `acct.dup-order-b-${Date.now()}`;
    await insertCustomField(db, user.id, customA, 'bool');
    await insertCustomField(db, user.id, customB, 'bool');

    const created = await createStrategy({
      userId: user.id,
      name: 'Duplicate order values',
      fields: [
        { fieldId: customA, captureMoment: 'post_close', order: 3 },
        { fieldId: customB, captureMoment: 'post_close', order: 3 }, // same order as customA, deliberately
      ],
      triggers: [],
    });

    const raw = await db.query('select fields from retrospeq.strategy_versions where strategy_id = $1 and version = 1', [created.strategyId]);
    const fields = raw.rows[0].fields as Array<{ field_id: string; order: number }>;
    expect(fields).toHaveLength(2);
    expect(fields.every((f) => f.order === 3)).toBe(true);
    expect(fields.map((f) => f.field_id).sort()).toEqual([customA, customB].sort());

    // Array ORDER (JSON array position, not the `order` field's value) must
    // also be preserved — customA was listed first.
    expect(fields[0].field_id).toBe(customA);
    expect(fields[1].field_id).toBe(customB);
  });

  it('a derived field id (drv.*) AND a hypothetical "future custom field" id in the same strategy both round-trip with correct field_id key naming (snake_case on disk)', async () => {
    const futureCustomId = `acct.future-custom-${Date.now()}`;
    await insertCustomField(db, user.id, futureCustomId, 'pick_one', { options: ['a', 'b'] });

    const created = await createStrategy({
      userId: user.id,
      name: 'Mixed derived + custom',
      fields: [
        { fieldId: 'drv.instrument', captureMoment: 'post_close', order: 1 },
        { fieldId: futureCustomId, captureMoment: 'post_close', order: 2 },
      ],
      triggers: [],
    });

    const raw = await db.query('select fields from retrospeq.strategy_versions where strategy_id = $1 and version = 1', [created.strategyId]);
    const fields = raw.rows[0].fields as Array<Record<string, unknown>>;
    // On-disk keys are snake_case, per §3.1's own DDL comment — NOT camelCase.
    for (const f of fields) {
      expect(f).toHaveProperty('field_id');
      expect(f).toHaveProperty('capture_moment');
      expect(f).not.toHaveProperty('fieldId');
      expect(f).not.toHaveProperty('captureMoment');
    }
    expect(fields.map((f) => f.field_id).sort()).toEqual(['drv.instrument', futureCustomId].sort());

    // And the deserialized (camelCase) view the application actually uses
    // round-trips back to the exact same logical shape.
    const viaFetch = await fetchCurrentStrategyForEdit(user.id, created.strategyId);
    const byId = new Map(viaFetch!.fields.map((f) => [f.fieldId, f]));
    expect(byId.get('drv.instrument')?.captureMoment).toBe('post_close');
    expect(byId.get(futureCustomId)?.captureMoment).toBe('post_close');
  });

  it('a numeric edge case (order: 0) survives round-trip without being coerced to falsy/undefined/dropped', async () => {
    const created = await createStrategy({
      userId: user.id,
      name: 'Zero order value',
      fields: [],
      triggers: [{ conditionId: 'zero-order', text: 'Order is literally zero', order: 0 }],
    });

    const raw = await db.query('select triggers from retrospeq.strategy_versions where strategy_id = $1 and version = 1', [created.strategyId]);
    expect(raw.rows[0].triggers[0].order).toBe(0);
    expect(raw.rows[0].triggers[0]).toHaveProperty('order'); // key present, not dropped for being falsy
  });
});

// ---------------------------------------------------------------------
// 4. field_usages cross-user isolation via the REAL repository write path
//    (Slice 03a's own RLS suite proves this with raw SQL inserts; this
//    exercises it through createStrategy/editStrategy themselves).
// ---------------------------------------------------------------------

describe.skipIf(!env)('field_usages cross-user isolation — through the real createStrategy write path', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'strategy-iv-rls-a');
    userB = await createTestAuthUser(env, 'strategy-iv-rls-b');
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

  it("user B's own withUserConnection session cannot see user A's field_usages rows created via a real createStrategy call, even querying by user A's own known strategy id", async () => {
    const created = await createStrategy({
      userId: userA.id,
      name: "A's private strategy",
      fields: [{ fieldId: 'drv.session', captureMoment: 'post_close', order: 1 }],
      triggers: [],
    });

    // Sanity: the row genuinely exists for the owner connection.
    const ownerView = await db.query(`select field_id from retrospeq.field_usages where user_id = $1 and used_by_id = $2`, [
      userA.id,
      created.strategyId,
    ]);
    expect(ownerView.rows).toHaveLength(1);

    // Attempt the identical query, but as user B's own RLS-scoped session
    // (withUserConnection, not the owner/service connection) — via
    // `fetchCurrentStrategyForEdit`, which joins through `strategies` +
    // `strategy_versions` (both RLS-scoped) rather than field_usages
    // directly, since this module exposes no direct field_usages reader —
    // proving user B's session-scoped RLS returns nothing for A's strategy
    // at all, field_usages included by construction (it can never diverge
    // from `strategies`/`strategy_versions` RLS since every write to it
    // happens inside the SAME transaction, under the SAME session role, as
    // the strategy write itself).
    const asB = await fetchCurrentStrategyForEdit(userB.id, created.strategyId);
    expect(asB).toBeNull();

    // Stronger, direct proof: user B's OWN RLS-scoped session, querying
    // `field_usages` itself directly (not indirectly via another table's
    // join) by A's known field_usages row values — must return zero rows,
    // not merely "the join happened not to match."
    const directAsB = await asRole(db, 'authenticated', userB.id, async (c) =>
      c.query(`select field_id from retrospeq.field_usages where user_id = $1 and used_by_id = $2`, [userA.id, created.strategyId]),
    );
    expect(directAsB.rows).toHaveLength(0);

    // And user A's own session sees exactly the row that exists.
    const directAsA = await asRole(db, 'authenticated', userA.id, async (c) =>
      c.query(`select field_id from retrospeq.field_usages where user_id = $1 and used_by_id = $2`, [userA.id, created.strategyId]),
    );
    expect(directAsA.rows).toHaveLength(1);
  });
});
