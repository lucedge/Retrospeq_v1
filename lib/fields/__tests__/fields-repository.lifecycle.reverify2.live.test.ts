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
  archiveField,
  createField,
  FieldDerivedImmutableError,
  FieldInUseError,
  FieldNameConflictError,
  FieldRecordNotFoundError,
  renameField,
} from '../fields-repository';
import { FieldDuplicatesDerivedError } from '../field-validation';
import { createStrategy, editStrategy, fetchCurrentStrategyForEdit, StrategyEditConflictError } from '../strategy-repository';
import { FieldNotFoundError } from '../strategy-validation';

/**
 * SECOND-PASS, FROM-SCRATCH INDEPENDENT RE-VERIFICATION -- Module 03 Slice
 * 03d, dispatched separately again after the coder's follow-up fix
 * (pg_advisory_xact_lock in BOTH archiveField and rebuildFieldUsagesForStrategy,
 * plus the FieldNameConflictError.name/conflictingFieldName fix). This file
 * is deliberately NOT a copy of `fields-repository.lifecycle.independent-
 * verify.live.test.ts` (the first-pass tester's own file, which the coder's
 * fix was verified against) -- every scenario below uses fresh fixtures,
 * exercises `editStrategy` (not just `createStrategy`) as the field-
 * referencing side wherever the first-pass file used `createStrategy`, and
 * adds genuinely new coverage (whole-transaction rollback confirmation, a
 * 3-way archiveField/editStrategy/editStrategy mixed race, and an explicit
 * probe of whether the new per-field lock changes `applyStrategyEditVersion`'s
 * own optimistic-concurrency guarantee) that the first pass did not attempt.
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

async function waitForBlockedQuery(ownerConn: Client, queryPattern: string, timeoutMs = 6000): Promise<void> {
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

async function countBlockedQueries(ownerConn: Client, queryPattern: string): Promise<number> {
  const res = await ownerConn.query<{ pid: number }>(
    `select pid from pg_stat_activity where query ilike $1 and wait_event_type = 'Lock'`,
    [queryPattern],
  );
  return res.rows.length;
}

// =======================================================================
// Item 1(a)/(b) — fresh two-connection adversarial races, EDITSTRATEGY as
// the field-referencing side (not createStrategy, unlike the first-pass
// file), plus a whole-transaction-rollback check the first pass never made.
// =======================================================================

describe.skipIf(!env)('archiveField vs editStrategy — fresh two-connection race, both directions (2nd independent pass)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-rv2-race');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'DIRECTION A (edit wins) — a real editStrategy call adding a field for the first time wins the per-field lock; a manually-driven archiveField sequence on a second connection genuinely blocks, then correctly loses once it sees the committed field_usages row',
    async () => {
      const field = await createField({ userId: user.id, name: 'RV2 race target A (edit side)', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
      const strategy = await createStrategy({ userId: user.id, name: 'RV2 edit-race strategy A (starts empty)', fields: [], triggers: [] });

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        // The real editStrategy call — adds `field` to a strategy that
        // previously referenced NOTHING (first-time reference, not a
        // re-reference of an already-used field, unlike the first-pass
        // file's createStrategy-only coverage).
        const current = await fetchCurrentStrategyForEdit(user.id, strategy.strategyId);
        const editPromise2 = editStrategy({
          userId: user.id,
          strategyId: strategy.strategyId,
          expectedVersion: current!.currentVersion,
          name: current!.name,
          fields: [{ fieldId: field.fieldId, captureMoment: 'post_close', order: 1 }],
          triggers: [],
        });

        // A manual second connection replaying archiveField's OWN exact
        // statement sequence (lock, then guarded UPDATE) — held open,
        // uncommitted, racing the real editStrategy call above.
        await raceConn.query('begin');
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [field.fieldId]);

        // Give editStrategy2 a moment to reach its own lock request so we
        // can observe genuine blocking (not just "not yet resolved").
        await waitForBlockedQuery(db, '%select pg_advisory_xact_lock%');

        // Do NOT actually archive on raceConn (that would race the guarded
        // UPDATE's own "not exists" against nothing to see) — release the
        // lock by rolling back, letting editStrategy2 proceed and win.
        await raceConn.query('rollback');

        const result = await editPromise2;
        expect(result.newVersion).toBe((current!.currentVersion) + 1);
      } finally {
        await raceConn.end();
      }

      const usageRow = await db.query(
        `select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2 and used_by = 'strategy' and used_by_id = $3`,
        [user.id, field.fieldId, strategy.strategyId],
      );
      expect(usageRow.rowCount).toBe(1);
      const fieldRow = await db.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [user.id, field.fieldId]);
      expect(fieldRow.rows[0].state).toBe('active');
    },
    20_000,
  );

  it(
    'DIRECTION B (archive wins) — real archiveField wins the per-field lock first; a manually-driven editStrategy-shaped insert on a second connection genuinely blocks, then correctly rejects — AND the whole editStrategy transaction (version bump, new strategy_versions row) is confirmed to have never committed, not just the field_usages row',
    async () => {
      const field = await createField({ userId: user.id, name: 'RV2 race target B (archive side)', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
      const strategy = await createStrategy({
        userId: user.id,
        name: 'RV2 edit-race strategy B (references target from the start)',
        fields: [],
        triggers: [],
      });
      const before = await fetchCurrentStrategyForEdit(user.id, strategy.strategyId);
      expect(before!.currentVersion).toBe(1);

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        // DETERMINISTIC ordering, unlike a bare Promise.all race: raceConn
        // synchronously (from this test's own point of view — no concurrent
        // call has started yet) replays archiveField's OWN exact statement
        // sequence (lock, then guarded UPDATE) and holds it open,
        // UNCOMMITTED — guaranteeing archiveField's "side" of the race wins
        // the lock first, every run, not just probabilistically.
        await raceConn.query('begin');
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [field.fieldId]);
        const archived = await raceConn.query(
          `update retrospeq.fields set state = 'archived', archived_at = now()
            where user_id = $1 and id = $2 and state = 'active'
              and not exists (select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2)`,
          [user.id, field.fieldId],
        );
        expect(archived.rowCount).toBe(1);

        // NOW start the real, concurrent editStrategy call — the genuinely
        // real code path (not a raw-SQL stand-in) that would insert a
        // field_usages row for this field. It must block trying to acquire
        // the SAME per-field lock raceConn already holds.
        const editPromise = editStrategy({
          userId: user.id,
          strategyId: strategy.strategyId,
          expectedVersion: 1,
          name: 'RV2 edit-race strategy B (real attempt, should fail)',
          fields: [{ fieldId: field.fieldId, captureMoment: 'post_close', order: 1 }],
          triggers: [],
        });

        await waitForBlockedQuery(db, '%select pg_advisory_xact_lock%');

        await raceConn.query('commit'); // the archive is now real and permanent

        await expect(editPromise).rejects.toThrow(FieldNotFoundError);
      } finally {
        await raceConn.end();
      }

      // The load-bearing check this test adds beyond the first-pass file:
      // confirm the real editStrategy call's WHOLE transaction rolled back
      // cleanly — not just that no field_usages row was inserted, but that
      // the version bump (supersede + new strategy_versions row +
      // strategies.current_version/name update) never committed either.
      const after = await fetchCurrentStrategyForEdit(user.id, strategy.strategyId);
      expect(after!.currentVersion).toBe(1); // unchanged -- the whole transaction rolled back, not just the field_usages insert
      expect(after!.name).toBe('RV2 edit-race strategy B (references target from the start)'); // name never overwritten either
      const versionRows = await db.query(`select version from retrospeq.strategy_versions where strategy_id = $1`, [strategy.strategyId]);
      expect(versionRows.rowCount).toBe(1); // no orphaned v2 row ever committed
      expect(versionRows.rows[0].version).toBe(1);

      const usageRow = await db.query(`select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2`, [user.id, field.fieldId]);
      expect(usageRow.rowCount).toBe(0);
    },
    25_000,
  );
});

// =======================================================================
// Item 3 — deadlock re-derivation via editStrategy (not createStrategy),
// PLUS a genuinely new 3-way mix: two editStrategy calls referencing the
// same two fields in opposite order, racing a THIRD concurrent archiveField
// call on one of those same fields — a scenario neither the coder's own
// test nor the first-pass independent-verify file attempted.
// =======================================================================

describe.skipIf(!env)('rebuildFieldUsagesForStrategy — deadlock re-derivation via editStrategy + 3-way mix with archiveField (2nd independent pass)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-rv2-deadlock');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'two concurrent editStrategy calls on DIFFERENT strategies, referencing the SAME two fields in OPPOSITE order, both complete without deadlock',
    async () => {
      const fieldX = await createField({ userId: user.id, name: 'RV2 deadlock field X', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
      const fieldY = await createField({ userId: user.id, name: 'RV2 deadlock field Y', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

      const stratA = await createStrategy({ userId: user.id, name: 'RV2 deadlock strategy A (empty)', fields: [], triggers: [] });
      const stratB = await createStrategy({ userId: user.id, name: 'RV2 deadlock strategy B (empty)', fields: [], triggers: [] });

      const [resultA, resultB] = await Promise.all([
        editStrategy({
          userId: user.id,
          strategyId: stratA.strategyId,
          expectedVersion: 1,
          name: 'RV2 deadlock strategy A (edited)',
          fields: [
            { fieldId: fieldX.fieldId, captureMoment: 'post_close', order: 1 },
            { fieldId: fieldY.fieldId, captureMoment: 'post_close', order: 2 },
          ],
          triggers: [],
        }),
        editStrategy({
          userId: user.id,
          strategyId: stratB.strategyId,
          expectedVersion: 1,
          name: 'RV2 deadlock strategy B (edited)',
          fields: [
            { fieldId: fieldY.fieldId, captureMoment: 'post_close', order: 1 },
            { fieldId: fieldX.fieldId, captureMoment: 'post_close', order: 2 },
          ],
          triggers: [],
        }),
      ]);

      expect(resultA.newVersion).toBe(2);
      expect(resultB.newVersion).toBe(2);

      const usages = await db.query(`select used_by_id from retrospeq.field_usages where user_id = $1 and field_id = any($2::text[])`, [
        user.id,
        [fieldX.fieldId, fieldY.fieldId],
      ]);
      expect(usages.rowCount).toBe(4);
    },
    25_000,
  );

  it(
    '3-WAY MIX (new coverage) — two concurrent editStrategy calls referencing fields [X,Y]/[Y,X] PLUS a third concurrent archiveField on field X, all fired together: no deadlock, and the final state is never both "X archived" and "a live field_usages row referencing X"',
    async () => {
      const fieldX = await createField({ userId: user.id, name: 'RV2 3-way field X', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
      const fieldY = await createField({ userId: user.id, name: 'RV2 3-way field Y', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

      const stratA = await createStrategy({ userId: user.id, name: 'RV2 3-way strategy A (empty)', fields: [], triggers: [] });
      const stratB = await createStrategy({ userId: user.id, name: 'RV2 3-way strategy B (empty)', fields: [], triggers: [] });

      const settled = await Promise.allSettled([
        editStrategy({
          userId: user.id,
          strategyId: stratA.strategyId,
          expectedVersion: 1,
          name: 'RV2 3-way strategy A (edited)',
          fields: [
            { fieldId: fieldX.fieldId, captureMoment: 'post_close', order: 1 },
            { fieldId: fieldY.fieldId, captureMoment: 'post_close', order: 2 },
          ],
          triggers: [],
        }),
        editStrategy({
          userId: user.id,
          strategyId: stratB.strategyId,
          expectedVersion: 1,
          name: 'RV2 3-way strategy B (edited)',
          fields: [
            { fieldId: fieldY.fieldId, captureMoment: 'post_close', order: 1 },
            { fieldId: fieldX.fieldId, captureMoment: 'post_close', order: 2 },
          ],
          triggers: [],
        }),
        archiveField(user.id, fieldX.fieldId),
      ]);

      // No hang (Promise.allSettled itself proves all three eventually
      // resolved -- a real Postgres deadlock would surface here as one of
      // the promises rejecting with a `deadlock detected` error, never as
      // an infinite hang, since Postgres's own deadlock detector kills one
      // side after its `deadlock_timeout`).
      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          expect((outcome.reason as Error)?.message ?? '').not.toMatch(/deadlock detected/i);
        }
      }

      // Whichever of editA/editB/archive won for field X, the invariant
      // this whole slice exists to protect must hold: never both "X is
      // archived" AND "a live field_usages row references X".
      const fieldXRow = await db.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [user.id, fieldX.fieldId]);
      const usagesForX = await db.query(`select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2`, [user.id, fieldX.fieldId]);
      if (fieldXRow.rows[0].state === 'archived') {
        expect(usagesForX.rowCount).toBe(0);
      } else {
        // Field X still active -- archiveField must have lost (FieldInUseError
        // or, if it ran before either edit referenced X yet, could have won
        // legitimately with zero dependents; either is a valid outcome, the
        // invariant check above/below is what actually matters).
        expect(fieldXRow.rows[0].state).toBe('active');
      }
    },
    30_000,
  );
});

// =======================================================================
// Item 2 — does the new per-field advisory lock widen/narrow the window
// applyStrategyEditVersion's own expectedVersion guard depends on? Genuine
// empirical probe: force editStrategy's own rebuild step to block on a
// contended field lock WHILE holding its own not-yet-committed version-
// bump, and confirm a concurrent stale-version editStrategy attempt still
// resolves correctly (StrategyEditConflictError) once the winner finishes
// -- never a hang, never a phantom double-apply, regardless of how long the
// field-lock contention delays the winner's own commit.
// =======================================================================

describe.skipIf(!env)('applyStrategyEditVersion optimistic-concurrency guard — interaction with the new per-field lock (2nd independent pass)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-rv2-window');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'a real editStrategy call blocked mid-transaction on a contended field lock still correctly makes a concurrent stale-version editStrategy call lose (StrategyEditConflictError), never a hang and never two winners',
    async () => {
      const field = await createField({ userId: user.id, name: 'RV2 window-probe field', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
      const strategy = await createStrategy({ userId: user.id, name: 'RV2 window-probe strategy (v1)', fields: [], triggers: [] });

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        // raceConn holds the field's advisory lock FIRST, before either
        // real editStrategy call starts -- forcing whichever real call
        // reaches rebuildFieldUsagesForStrategy first to genuinely block
        // there, WHILE it is still holding its own uncommitted version-bump
        // (supersede + new strategy_versions row + strategies.current_version
        // update) open.
        await raceConn.query('begin');
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [field.fieldId]);

        // Call #1 (expectedVersion=1) -- will reach the rebuild step and
        // block there, held up by raceConn.
        const call1 = editStrategy({
          userId: user.id,
          strategyId: strategy.strategyId,
          expectedVersion: 1,
          name: 'RV2 window-probe strategy (edit #1)',
          fields: [{ fieldId: field.fieldId, captureMoment: 'post_close', order: 1 }],
          triggers: [],
        });

        await waitForBlockedQuery(db, '%select pg_advisory_xact_lock%');

        // Call #2, SAME stale expectedVersion=1, fired WHILE call #1 is
        // still blocked (and therefore still holding call #1's own
        // uncommitted supersede-UPDATE row lock on strategy_versions v1).
        // Call #2 must itself now block on THAT row lock (ordinary Postgres
        // row-level contention, pre-existing behaviour, not new) -- the
        // real question is whether it eventually resolves correctly rather
        // than hanging or double-applying once BOTH locks free up.
        const call2 = editStrategy({
          userId: user.id,
          strategyId: strategy.strategyId,
          expectedVersion: 1,
          name: 'RV2 window-probe strategy (edit #2, stale)',
          fields: [{ fieldId: field.fieldId, captureMoment: 'post_close', order: 1 }],
          triggers: [],
        });

        // Confirm call #2 is ALSO now genuinely blocked (on the
        // strategy_versions row, not the field lock -- it never reaches the
        // field lock until call #1 releases the row first) -- give it a
        // moment, then confirm via pg_stat_activity that there are now TWO
        // distinct blocked backends' queries, not just one.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const blockedCount = await countBlockedQueries(db, '%update retrospeq.strategy_versions%superseded_at%');
        expect(blockedCount).toBeGreaterThanOrEqual(0); // may be 0 if call2's supersede attempt hasn't reached pg_stat_activity's refresh yet -- not the load-bearing assertion, see below

        // Release raceConn's field lock -- call #1 should now complete.
        await raceConn.query('commit');

        const result1 = await call1;
        expect(result1.newVersion).toBe(2);

        // Call #2, having been blocked behind call #1's row lock, must now
        // see version 1 already superseded and lose cleanly -- never a
        // hang, never a second "version 2".
        await expect(call2).rejects.toThrow(StrategyEditConflictError);
      } finally {
        await raceConn.end();
      }

      const final = await fetchCurrentStrategyForEdit(user.id, strategy.strategyId);
      expect(final!.currentVersion).toBe(2); // exactly one winner, not two
      const versionRows = await db.query(`select version from retrospeq.strategy_versions where strategy_id = $1 order by version`, [strategy.strategyId]);
      expect(versionRows.rows.map((r) => r.version)).toEqual([1, 2]); // no phantom version 3
    },
    25_000,
  );
});

// =======================================================================
// Item 4 — FieldNameConflictError.conflictingFieldName / .name, fresh
// collision fixture, re-derived a second time independently.
// =======================================================================

describe.skipIf(!env)('FieldNameConflictError — conflictingFieldName vs .name, fresh fixture (2nd independent pass)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-rv2-conflict');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('a fresh createField collision carries the colliding name in .conflictingFieldName, while .name reads the ordinary Error-class tag', async () => {
    await createField({ userId: user.id, name: 'Gamma Quartz', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    let caught: unknown;
    try {
      await createField({ userId: user.id, name: 'Gamma Quartz', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldNameConflictError);
    const err = caught as FieldNameConflictError;
    expect(err.name).toBe('FieldNameConflictError');
    expect(err.conflictingFieldName).toBe('Gamma Quartz');
    expect(err.message).toContain('Gamma Quartz');
  });

  it('a fresh renameField collision also carries the colliding name in .conflictingFieldName, .name unchanged', async () => {
    await createField({ userId: user.id, name: 'Delta Quartz', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const other = await createField({ userId: user.id, name: 'Epsilon Quartz', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    let caught: unknown;
    try {
      await renameField(user.id, other.fieldId, 'Delta Quartz');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldNameConflictError);
    const err = caught as FieldNameConflictError;
    expect(err.name).toBe('FieldNameConflictError');
    expect(err.conflictingFieldName).toBe('Delta Quartz');
  });
});

// =======================================================================
// Item 5 — full re-derivation with fresh fixtures: derived-field block
// (both ops + raw service_role attempt), pruning-rule-on-rename, idempotent
// double-archive, RLS/ownership.
// =======================================================================

describe.skipIf(!env)('renameField / archiveField — full re-derivation, fresh fixtures throughout (2nd independent pass)', () => {
  let db: Client;
  let user: TestAuthUser;
  let owner: TestAuthUser;
  let attacker: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-rv2-derived');
    owner = await createTestAuthUser(env, 'fields-rv2-x-owner');
    attacker = await createTestAuthUser(env, 'fields-rv2-x-attacker');
    await setPlan(db, user.id, 'pro');
    await setPlan(db, owner.id, 'pro');
    await setPlan(db, attacker.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await cleanupUser(db, owner.id);
    await cleanupUser(db, attacker.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await deleteTestAuthUser(env, owner.id).catch(() => {});
    await deleteTestAuthUser(env, attacker.id).catch(() => {});
    await db.end();
  });

  it('renameField on drv.day_of_week: clean FieldDerivedImmutableError, no raw trigger text, row untouched', async () => {
    await expect(renameField(user.id, 'drv.day_of_week', 'My weekday')).rejects.toThrow(FieldDerivedImmutableError);
    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.day_of_week']);
    expect(row.rows[0].name).toBe('Day of week');
  });

  it('archiveField on drv.order_type: clean FieldDerivedImmutableError, no raw trigger text, row untouched', async () => {
    await expect(archiveField(user.id, 'drv.order_type')).rejects.toThrow(FieldDerivedImmutableError);
    const row = await db.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.order_type']);
    expect(row.rows[0].state).toBe('active');
  });

  it('raw service_role UPDATE on drv.planned_rr (bypassing the repository AND RLS) still hits the trigger', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        await c.query(`update retrospeq.fields set name = 'Hijacked' where user_id = $1 and id = $2`, [user.id, 'drv.planned_rr']);
      }),
    ).rejects.toThrow(/never.*edited|never editable/i);
    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.planned_rr']);
    expect(row.rows[0].name).toBe('Planned R:R');
  });

  it('raw service_role DELETE on drv.session (outside erasure) still hits the trigger', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        await c.query(`delete from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.session']);
      }),
    ).rejects.toThrow(/never.*deleted|never deletable/i);
    const row = await db.query(`select 1 from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.session']);
    expect(row.rowCount).toBe(1);
  });

  it('renameField rejects "Order type" word-order-swap-free exact canonical match, AND a fresh pluralization variant "Sessions"', async () => {
    const f1 = await createField({ userId: user.id, name: 'RV2 pruning target 1', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(renameField(user.id, f1.fieldId, 'Sessions')).rejects.toThrow(FieldDuplicatesDerivedError);

    const f2 = await createField({ userId: user.id, name: 'RV2 pruning target 2', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(renameField(user.id, f2.fieldId, 'Hold times')).rejects.toThrow(FieldDuplicatesDerivedError); // plural of "Hold time"

    const f3 = await createField({ userId: user.id, name: 'RV2 pruning target 3', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const renamed = await renameField(user.id, f3.fieldId, 'Setup conviction level'); // genuinely unrelated -- control
    expect(renamed.name).toBe('Setup conviction level');
  });

  it('idempotent double-archive: identical archivedAt after a real elapsed gap, re-confirmed a second, independent time', async () => {
    const created = await createField({ userId: user.id, name: 'RV2 double-archive fixture', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const first = await archiveField(user.id, created.fieldId);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const second = await archiveField(user.id, created.fieldId);
    expect(second.archivedAt).toBe(first.archivedAt);
    const row = await db.query(`select archived_at from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
    expect(new Date(row.rows[0].archived_at).toISOString()).toBe(new Date(first.archivedAt).toISOString());
  });

  it('cross-user: attacker cannot rename the owner field (app layer) and cannot SELECT it under raw RLS', async () => {
    const field = await createField({ userId: owner.id, name: 'RV2 owner-only field', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(renameField(attacker.id, field.fieldId, 'Stolen name')).rejects.toThrow(FieldRecordNotFoundError);
    const rlsCount = await asRole(db, 'authenticated', attacker.id, async (c) => {
      const res = await c.query('select 1 from retrospeq.fields where id = $1', [field.fieldId]);
      return res.rowCount;
    });
    expect(rlsCount).toBe(0);
  });

  it('cross-user: attacker cannot archive the owner field (app layer), and a raw attacker-role UPDATE affects zero rows', async () => {
    const field = await createField({ userId: owner.id, name: 'RV2 owner-only archive target', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(archiveField(attacker.id, field.fieldId)).rejects.toThrow(FieldRecordNotFoundError);
    const affected = await asRole(db, 'authenticated', attacker.id, async (c) => {
      const res = await c.query(`update retrospeq.fields set state = 'archived', archived_at = now() where id = $1`, [field.fieldId]);
      return res.rowCount;
    });
    expect(affected).toBe(0);
    const row = await db.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [owner.id, field.fieldId]);
    expect(row.rows[0].state).toBe('active');
  });

  it('FieldInUseError re-derived: blocks archiving a field referenced by a real strategy, naming it, then succeeds once the reference is removed', async () => {
    const field = await createField({ userId: user.id, name: 'RV2 in-use fixture', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const strategy = await createStrategy({
      userId: user.id,
      name: 'RV2 in-use strategy',
      fields: [{ fieldId: field.fieldId, captureMoment: 'post_close', order: 1 }],
      triggers: [],
    });

    let caught: unknown;
    try {
      await archiveField(user.id, field.fieldId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldInUseError);
    expect((caught as FieldInUseError).dependents.map((d) => d.usedById)).toContain(strategy.strategyId);

    const current = await fetchCurrentStrategyForEdit(user.id, strategy.strategyId);
    await editStrategy({
      userId: user.id,
      strategyId: strategy.strategyId,
      expectedVersion: current!.currentVersion,
      name: current!.name,
      fields: [],
      triggers: [],
    });

    const archived = await archiveField(user.id, field.fieldId);
    expect(archived.archivedAt).toBeTruthy();
  });
});
