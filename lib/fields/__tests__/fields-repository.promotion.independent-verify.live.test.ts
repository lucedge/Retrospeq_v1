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

import { archiveField, createField, promoteField, renameField } from '../fields-repository';
import { createStrategy, editStrategy, fetchCurrentStrategyForEdit } from '../strategy-repository';

/**
 * INDEPENDENT VERIFICATION (live DB) — Module 03 Slice 03e, dispatched
 * separately from the coder who built `promoteField`/`findPromotionCandidates`.
 *
 * This file exists SPECIFICALLY to stress-test the one claim in that slice
 * needing the most scrutiny: `promoteField`'s own header argues no
 * `pg_advisory_xact_lock` is needed (unlike `archiveField`'s own Slice 03d
 * fix) because `promoteField` only touches `retrospeq.fields` itself, where
 * ordinary row locking plus the unique index already correctly arbitrate
 * every race. That reasoning is tested here against a REAL Postgres
 * instance, with REAL concurrent connections and REAL `Promise.all`/manual
 * two-connection races — not re-read and nodded at.
 *
 * Four scenarios, matching the dispatch's own four bullets exactly:
 *   1. Two concurrent `promoteField` calls on the SAME field.
 *   2. `promoteField` racing a concurrent `renameField` on the SAME field.
 *   3. `promoteField` racing a concurrent `archiveField` on the SAME field,
 *      BOTH directions, with genuine two-connection lock-hold control.
 *   4. `promoteField` racing a concurrent `rebuildFieldUsagesForStrategy`
 *      (via `editStrategy`) referencing the SAME field — the scenario
 *      closest to the ORIGINAL bug class Slice 03d's own tester found
 *      (`field_usages` INSERT's `FOR KEY SHARE` lock vs. an UPDATE's `FOR
 *      NO KEY UPDATE` lock on non-key columns not conflicting under
 *      Postgres's own lock-compatibility matrix).
 *
 * VERDICT (recorded here and in PROGRESS.md): scenarios 1-3 are provably
 * safe via ordinary Postgres row-level locking, confirmed empirically below
 * — `kind`/`owner_strategy_id`/`state`/`name` are ALL non-key columns on
 * `retrospeq.fields`, so any two of `promoteField`/`renameField`/
 * `archiveField` targeting the SAME row take the SAME `FOR NO KEY UPDATE`
 * lock and genuinely serialize against each other with no advisory lock
 * needed — this is NOT the same lock class as the `field_usages` FK check.
 * Scenario 4 DOES reproduce a real, empirically-observed lock-compatibility
 * gap structurally identical to the one Slice 03d's own tester found and a
 * coder then fixed with a lock — `promoteField`'s own UPDATE (bare, no
 * advisory lock) is confirmed below to proceed WITHOUT blocking against a
 * concurrent, still-uncommitted `field_usages` insert holding the per-field
 * advisory lock `rebuildFieldUsagesForStrategy`/`archiveField` both already
 * take. Unlike Slice 03d's own finding, this gap does NOT corrupt any
 * invariant this repo currently enforces — `kind`/`owner_strategy_id` gate
 * nothing that `rebuildFieldUsagesForStrategy`'s own state re-check (or any
 * other guard in this file) depends on, and a promoted field remaining
 * referenced by `field_usages` is a legitimate, intended end state (§4.2:
 * account fields are usable across strategies) — so the end state is always
 * coherent in every run below, never corrupted. See the scenario-4 describe
 * block's own header for the full reasoning and what WOULD need to change
 * for this to matter (see PROGRESS.md's decision-log entry for this date).
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

// =======================================================================
// Scenario 1 — two concurrent promoteField calls, SAME field id.
// =======================================================================
describe.skipIf(!env)('promoteField — GENUINE concurrency probe: two concurrent promotions of the SAME field (live DB, independent verification)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-promo-iv-a');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('two real, concurrently-fired promoteField calls both resolve without error, and the field ends up promoted EXACTLY once (no corrupted/partial state)', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Concurrent-promote strategy', fields: [], triggers: [] });
    const created = await createField({
      userId: user.id,
      name: 'Concurrent promote target',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });

    const [a, b] = await Promise.all([promoteField(user.id, created.fieldId), promoteField(user.id, created.fieldId)]);

    // Both calls resolve successfully (no thrown error from either side) --
    // one performs the real write, the other loses the row-lock race and
    // correctly falls into promoteField's own "re-derive current state"
    // branch (see its own header) rather than throwing or silently
    // double-writing.
    expect(a).toMatchObject({ fieldId: created.fieldId, kind: 'account', ownerStrategyId: null });
    expect(b).toMatchObject({ fieldId: created.fieldId, kind: 'account', ownerStrategyId: null });

    const row = await db.query(`select kind, owner_strategy_id from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
    expect(row.rowCount).toBe(1); // exactly one row -- no duplication
    expect(row.rows[0]).toMatchObject({ kind: 'account', owner_strategy_id: null });
  });
});

// =======================================================================
// Scenario 2 — promoteField racing renameField on the SAME field.
// =======================================================================
describe.skipIf(!env)('promoteField — GENUINE concurrency probe: racing a concurrent renameField on the SAME field (live DB, independent verification)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-promo-iv-b');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('promoteField and renameField fired concurrently on the same field both apply -- final row has BOTH effects, never a lost update', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Promote-vs-rename strategy', fields: [], triggers: [] });
    const created = await createField({
      userId: user.id,
      name: 'Promote-rename race target',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategy.strategyId,
    });

    const [promoteResult, renameResult] = await Promise.all([
      promoteField(user.id, created.fieldId),
      renameField(user.id, created.fieldId, 'Renamed mid-promotion'),
    ]);

    expect(promoteResult.fieldId).toBe(created.fieldId);
    expect(renameResult.fieldId).toBe(created.fieldId);

    const row = await db.query(`select kind, owner_strategy_id, name from retrospeq.fields where user_id = $1 and id = $2`, [
      user.id,
      created.fieldId,
    ]);
    // Both mutations landed -- kind flipped AND the new name persisted.
    // Ordinary row locking on the SAME row (both UPDATEs touch only
    // non-key columns -- kind/owner_strategy_id vs. name -- so both take
    // the SAME `FOR NO KEY UPDATE` lock and genuinely serialize) means
    // whichever runs second sees the first's already-committed write and
    // applies its own change on top, never overwriting it wholesale (each
    // UPDATE's own SET clause only ever names its own columns).
    expect(row.rows[0]).toMatchObject({ kind: 'account', owner_strategy_id: null, name: 'Renamed mid-promotion' });
  });
});

// =======================================================================
// Scenario 3 — promoteField racing archiveField, BOTH directions, with
// genuine two-connection lock-hold control (not just Promise.all) so the
// serialization claim is observed directly via pg_stat_activity, not
// inferred from the end state alone.
// =======================================================================
describe.skipIf(!env)('promoteField — GENUINE concurrency probe: racing archiveField on the SAME field, both directions (live DB, independent verification)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-promo-iv-c');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'DIRECTION A — archiveField wins the row lock first (held open, uncommitted); a concurrent real promoteField call genuinely BLOCKS on ordinary row locking (no advisory lock involved), then correctly applies once unblocked -- end state: kind=account, state=archived',
    async () => {
      const strategy = await createStrategy({ userId: user.id, name: 'Promote-vs-archive A strategy', fields: [], triggers: [] });
      const created = await createField({
        userId: user.id,
        name: 'Promote-vs-archive A target',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: strategy.strategyId,
      });

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        // Replays archiveField's own exact statement sequence (advisory
        // lock, then the guarded UPDATE) -- held open, uncommitted.
        await raceConn.query('begin');
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [created.fieldId]);
        const archived = await raceConn.query(
          `update retrospeq.fields f
              set state = 'archived', archived_at = now()
            where f.user_id = $1 and f.id = $2 and f.state = 'active'
              and not exists (select 1 from retrospeq.field_usages fu where fu.user_id = $1 and fu.field_id = $2)
            returning f.archived_at`,
          [user.id, created.fieldId],
        );
        expect(archived.rowCount).toBe(1); // real, UNCOMMITTED archive

        const promotePromise = promoteField(user.id, created.fieldId);

        // promoteField's own UPDATE targets the SAME row -- confirm it is
        // GENUINELY blocked on ordinary row locking (FOR NO KEY UPDATE vs
        // FOR NO KEY UPDATE, both non-key-column UPDATEs), not merely slow.
        await waitForBlockedQuery(db, "%set kind = 'account'%");

        await raceConn.query('commit'); // the archive is now real and permanent

        const promoted = await promotePromise;
        expect(promoted).toMatchObject({ fieldId: created.fieldId, kind: 'account', ownerStrategyId: null });
      } finally {
        await raceConn.end();
      }

      const row = await db.query(`select kind, owner_strategy_id, state, archived_at from retrospeq.fields where user_id = $1 and id = $2`, [
        user.id,
        created.fieldId,
      ]);
      expect(row.rows[0]).toMatchObject({ kind: 'account', owner_strategy_id: null, state: 'archived' });
      expect(row.rows[0].archived_at).not.toBeNull();
    },
    20_000,
  );

  it(
    "DIRECTION B — promoteField wins the row lock first (held open, uncommitted); a concurrent real archiveField call genuinely BLOCKS on the SAME ordinary row lock, then correctly applies once unblocked -- end state coherent, no corruption",
    async () => {
      const strategy = await createStrategy({ userId: user.id, name: 'Promote-vs-archive B strategy', fields: [], triggers: [] });
      const created = await createField({
        userId: user.id,
        name: 'Promote-vs-archive B target',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: strategy.strategyId,
      });

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        // Replays promoteField's own exact write statement -- no advisory
        // lock (matching the function under test exactly) -- held open,
        // uncommitted.
        await raceConn.query('begin');
        const promoted = await raceConn.query(
          `update retrospeq.fields
              set kind = 'account', owner_strategy_id = null
            where user_id = $1 and id = $2 and kind = 'strategy_var'
            returning name`,
          [user.id, created.fieldId],
        );
        expect(promoted.rowCount).toBe(1); // real, UNCOMMITTED promotion

        const archivePromise = archiveField(user.id, created.fieldId);

        // archiveField's OWN advisory-lock statement does not block here
        // (nothing else holds that lock) -- it's the SUBSEQUENT guarded
        // UPDATE, targeting the SAME row promoteField's manual UPDATE is
        // holding, that must genuinely block.
        await waitForBlockedQuery(db, "%set state = 'archived'%");

        await raceConn.query('commit'); // the promotion is now real and permanent

        const archived = await archivePromise;
        expect(archived.fieldId).toBe(created.fieldId);
      } finally {
        await raceConn.end();
      }

      const row = await db.query(`select kind, owner_strategy_id, state, archived_at from retrospeq.fields where user_id = $1 and id = $2`, [
        user.id,
        created.fieldId,
      ]);
      expect(row.rows[0]).toMatchObject({ kind: 'account', owner_strategy_id: null, state: 'archived' });
      expect(row.rows[0].archived_at).not.toBeNull();
    },
    20_000,
  );
});

// =======================================================================
// Scenario 4 — promoteField racing rebuildFieldUsagesForStrategy (via
// editStrategy) on the SAME field. This is the scenario structurally
// closest to the ORIGINAL bug class Slice 03d's own tester found: a
// `field_usages` INSERT takes a `FOR KEY SHARE` lock on the referenced
// `fields` row (an FK check against `(user_id, id)`, the ONLY columns any
// FK references on this table), and an UPDATE touching non-key columns
// (kind/owner_strategy_id, exactly what promoteField's own UPDATE touches)
// takes `FOR NO KEY UPDATE` -- and Postgres's own row-lock conflict matrix
// does NOT consider `FOR KEY SHARE` and `FOR NO KEY UPDATE` to conflict.
// `archiveField`/`rebuildFieldUsagesForStrategy` both now take a shared
// per-field `pg_advisory_xact_lock` to close THEIR OWN version of this gap
// (`state` vs. `field_usages` existence). `promoteField` takes NO such
// lock -- so if `rebuildFieldUsagesForStrategy`'s own advisory lock +
// INSERT is held open uncommitted, does a concurrent, UNLOCKED
// `promoteField` genuinely slip through without waiting? Tested directly
// below, not inferred.
// =======================================================================
describe.skipIf(!env)('promoteField — GENUINE concurrency probe: racing rebuildFieldUsagesForStrategy (editStrategy) on the SAME field (live DB, independent verification)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-promo-iv-d');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'a manually-held, UNCOMMITTED field_usages insert (replaying rebuildFieldUsagesForStrategy\'s own lock+insert sequence exactly), raced against a concurrent real promoteField call -- resolved via pg_stat_activity lock-wait detection (network-latency-independent), NOT a fixed timer. Whichever way it resolves, the end state must be coherent (never corrupted).',
    async () => {
      const strategy = await createStrategy({ userId: user.id, name: 'Promote-vs-rebuild strategy', fields: [], triggers: [] });
      const created = await createField({
        userId: user.id,
        name: 'Promote-vs-rebuild target',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: strategy.strategyId,
      });

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      let genuinelyBlocked: boolean;
      try {
        // Replays rebuildFieldUsagesForStrategy's own exact statement
        // sequence for this ONE field: per-field advisory lock, a plain
        // (non-locking) state re-check SELECT, then the field_usages
        // INSERT -- held open, uncommitted.
        await raceConn.query('begin');
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [created.fieldId]);
        const stateCheck = await raceConn.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
        expect(stateCheck.rows[0].state).toBe('active');
        const inserted = await raceConn.query(
          `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id) values ($1, $2, 'strategy', $3)`,
          [created.fieldId, user.id, strategy.strategyId],
        );
        expect(inserted.rowCount).toBe(1); // real, UNCOMMITTED field_usages row

        const promotePromise = promoteField(user.id, created.fieldId);

        // NOTE: a fixed-timer version of this check (this file's own first
        // pass) produced a false positive here -- this DB is a remote
        // Supabase instance, and a single promoteField call's own two round
        // trips (fetchFieldForLifecycleOp's read, then the guarded UPDATE,
        // each preceded by a fresh pool connection's own SET LOCAL ROLE)
        // routinely take multiple seconds on their own, UNBLOCKED, as every
        // other test in this file's own timings show (6-14s per test,
        // network latency, not lock contention). A short fixed timeout
        // cannot distinguish "genuinely waiting on a lock" from "just
        // network-slow" -- only a real signal can: whether the UPDATE shows
        // up in pg_stat_activity with wait_event_type = 'Lock' while
        // raceConn's transaction is still open. This is the SAME technique
        // `fields-repository.lifecycle.independent-verify.live.test.ts`'s
        // own Direction A/B probes use, for the same reason.
        try {
          await waitForBlockedQuery(db, "%set kind = 'account'%", 6000);
          genuinelyBlocked = true;
        } catch {
          genuinelyBlocked = false;
        }

        await raceConn.query('commit'); // the field_usages row is now real and permanent

        const promoted = await promotePromise;
        expect(promoted).toMatchObject({ fieldId: created.fieldId, kind: 'account', ownerStrategyId: null });
      } finally {
        await raceConn.end();
      }

      // RECORDED FINDING (see this file's own top-of-file header and
      // PROGRESS.md's decision-log entry for this date for the full
      // writeup): whichever way `genuinelyBlocked` came out, log it plainly
      // here rather than asserting one specific direction blind -- this
      // block exists to OBSERVE the real behaviour, not to enforce an
      // assumed one.
      console.log(
        `[independent-verify] promoteField vs. concurrent uncommitted field_usages insert (same field): genuinely blocked on ordinary row locking = ${genuinelyBlocked}`,
      );

      // Post-commit: both effects landed, and the end state is coherent --
      // a promoted (account-kind) field referenced by field_usages is a
      // legitimate, intended state (§4.2: account fields ARE usable across
      // strategies), not a corruption, REGARDLESS of whether promoteField
      // waited for the lock or slipped through unblocked.
      const fieldRow = await db.query(`select kind, owner_strategy_id, state from retrospeq.fields where user_id = $1 and id = $2`, [
        user.id,
        created.fieldId,
      ]);
      expect(fieldRow.rows[0]).toMatchObject({ kind: 'account', owner_strategy_id: null, state: 'active' });

      const usageRow = await db.query(
        `select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2 and used_by = 'strategy' and used_by_id = $3`,
        [user.id, created.fieldId, strategy.strategyId],
      );
      expect(usageRow.rowCount).toBe(1);
    },
    20_000,
  );

  it(
    'REVERSE DIRECTION, real end-to-end (not manual replay): promoteField and a real editStrategy call referencing this field fired concurrently via Promise.all both resolve without error, no deadlock/hang, end state coherent',
    async () => {
      const strategy = await createStrategy({ userId: user.id, name: 'Promote-vs-editStrategy strategy', fields: [], triggers: [] });
      const created = await createField({
        userId: user.id,
        name: 'Promote-vs-editStrategy target',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: strategy.strategyId,
      });
      const currentVersion = await fetchCurrentStrategyForEdit(user.id, strategy.strategyId);

      const [promoted, edited] = await Promise.all([
        promoteField(user.id, created.fieldId),
        editStrategy({
          userId: user.id,
          strategyId: strategy.strategyId,
          expectedVersion: currentVersion!.currentVersion,
          name: currentVersion!.name,
          fields: [{ fieldId: created.fieldId, captureMoment: 'post_close', order: 1 }],
          triggers: [],
        }),
      ]);

      expect(promoted).toMatchObject({ fieldId: created.fieldId, kind: 'account', ownerStrategyId: null });
      expect(edited.newVersion).toBe(2);

      const fieldRow = await db.query(`select kind, owner_strategy_id, state from retrospeq.fields where user_id = $1 and id = $2`, [
        user.id,
        created.fieldId,
      ]);
      expect(fieldRow.rows[0]).toMatchObject({ kind: 'account', owner_strategy_id: null, state: 'active' });

      const usageRow = await db.query(
        `select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2 and used_by = 'strategy' and used_by_id = $3`,
        [user.id, created.fieldId, strategy.strategyId],
      );
      expect(usageRow.rowCount).toBe(1);
    },
    20_000,
  );
});

// =======================================================================
// Fresh §7.1 trade_captures/field_usages preservation proof -- an
// INDEPENDENT fixture, not a re-run of the coder's own test in
// fields-repository.promotion.live.test.ts.
// =======================================================================
describe.skipIf(!env)('promoteField — §7.1 preservation proof, FRESH independent fixture (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-promo-iv-preserve');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('promotion changes ONLY kind/owner_strategy_id -- id, name, data_type, config, min_tier, created_at, and a real field_usages row are all byte-for-byte unchanged', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'IV preservation strategy', fields: [], triggers: [] });
    const created = await createField({
      userId: user.id,
      name: 'IV preservation field',
      kind: 'strategy_var',
      dataType: 'pick_one',
      config: { options: ['Trend', 'Range', 'Breakout'] },
      ownerStrategyId: strategy.strategyId,
    });

    const currentVersion = await fetchCurrentStrategyForEdit(user.id, strategy.strategyId);
    await editStrategy({
      userId: user.id,
      strategyId: strategy.strategyId,
      expectedVersion: currentVersion!.currentVersion,
      name: currentVersion!.name,
      fields: [{ fieldId: created.fieldId, captureMoment: 'post_close', order: 1 }],
      triggers: [],
    });

    const before = await db.query(
      `select id, name, data_type, config, min_tier, created_at from retrospeq.fields where user_id = $1 and id = $2`,
      [user.id, created.fieldId],
    );
    expect(before.rowCount).toBe(1);
    const beforeUsage = await db.query(
      `select field_id, user_id, used_by, used_by_id from retrospeq.field_usages where user_id = $1 and field_id = $2`,
      [user.id, created.fieldId],
    );
    expect(beforeUsage.rowCount).toBe(1);

    const promoted = await promoteField(user.id, created.fieldId);
    expect(promoted.fieldId).toBe(created.fieldId);

    const after = await db.query(
      `select id, name, data_type, config, min_tier, created_at, kind, owner_strategy_id from retrospeq.fields where user_id = $1 and id = $2`,
      [user.id, created.fieldId],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].id).toBe(before.rows[0].id);
    expect(after.rows[0].name).toBe(before.rows[0].name);
    expect(after.rows[0].data_type).toBe(before.rows[0].data_type);
    expect(after.rows[0].config).toEqual(before.rows[0].config);
    expect(after.rows[0].min_tier).toBe(before.rows[0].min_tier);
    expect(new Date(after.rows[0].created_at).toISOString()).toBe(new Date(before.rows[0].created_at).toISOString());
    // ONLY these two changed:
    expect(after.rows[0].kind).toBe('account');
    expect(after.rows[0].owner_strategy_id).toBeNull();

    const afterUsage = await db.query(
      `select field_id, user_id, used_by, used_by_id from retrospeq.field_usages where user_id = $1 and field_id = $2`,
      [user.id, created.fieldId],
    );
    expect(afterUsage.rows).toEqual(beforeUsage.rows); // untouched, byte-for-byte
  });
});

// =======================================================================
// Fresh cross-user leak probe for findPromotionCandidates -- an
// INDEPENDENT fixture (identical field names, both users, adversarially
// chosen) beyond the coder's own cross-user describe block.
// =======================================================================
describe.skipIf(!env)('findPromotionCandidates — fresh cross-user adversarial fixture, IDENTICAL field names (live DB, independent verification)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fields-promo-iv-leak-a');
    userB = await createTestAuthUser(env, 'fields-promo-iv-leak-b');
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

  it("neither user's candidate search ever returns, references, or is influenced by count for the OTHER user's IDENTICALLY-named strategy_var field", async () => {
    const { findPromotionCandidates } = await import('../fields-repository');

    const strategyA = await createStrategy({ userId: userA.id, name: "A's leak-probe strategy", fields: [], triggers: [] });
    const fieldA = await createField({
      userId: userA.id,
      name: 'Shared Name Probe',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategyA.strategyId,
    });

    const strategyB = await createStrategy({ userId: userB.id, name: "B's leak-probe strategy", fields: [], triggers: [] });
    const fieldB = await createField({
      userId: userB.id,
      name: 'Shared Name Probe', // IDENTICAL name, different user
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategyB.strategyId,
    });

    // A second strategy per user, to search FROM, so each candidate list is
    // non-trivially populated (excludeStrategyId != the owning strategy).
    const strategyA2 = await createStrategy({ userId: userA.id, name: "A's second strategy", fields: [], triggers: [] });
    const strategyB2 = await createStrategy({ userId: userB.id, name: "B's second strategy", fields: [], triggers: [] });

    const candidatesForA = await findPromotionCandidates(userA.id, strategyA2.strategyId, ['Shared Name Probe']);
    const candidatesForB = await findPromotionCandidates(userB.id, strategyB2.strategyId, ['Shared Name Probe']);

    // Each user sees EXACTLY their own field, never the other's, never both.
    expect(candidatesForA).toHaveLength(1);
    expect(candidatesForA[0].fieldId).toBe(fieldA.fieldId);
    expect(candidatesForA[0].ownerStrategyId).toBe(strategyA.strategyId);
    expect(candidatesForA.map((c) => c.fieldId)).not.toContain(fieldB.fieldId);

    expect(candidatesForB).toHaveLength(1);
    expect(candidatesForB[0].fieldId).toBe(fieldB.fieldId);
    expect(candidatesForB[0].ownerStrategyId).toBe(strategyB.strategyId);
    expect(candidatesForB.map((c) => c.fieldId)).not.toContain(fieldA.fieldId);

    // Not even an indirect leak via count -- each user's own list has
    // exactly ONE entry, not two (which would imply visibility into the
    // other user's row without necessarily exposing its id).
  });

  it("a raw RLS probe confirms user B's authenticated connection cannot even SELECT user A's strategy_var field row directly (the layer findPromotionCandidates' own query ultimately relies on)", async () => {
    const strategyA = await createStrategy({ userId: userA.id, name: "A's RLS leak-probe strategy", fields: [], triggers: [] });
    const fieldA = await createField({
      userId: userA.id,
      name: 'RLS leak probe field',
      kind: 'strategy_var',
      dataType: 'bool',
      config: {},
      ownerStrategyId: strategyA.strategyId,
    });

    const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select 1 from retrospeq.fields where id = $1', [fieldA.fieldId]);
      return res.rowCount;
    });
    expect(rowCount).toBe(0);
  });
});
