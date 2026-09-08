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
import { createStrategy } from '../strategy-repository';
import { FieldNotFoundError } from '../strategy-validation';

/**
 * INDEPENDENT VERIFICATION (live DB) — Module 03 Slice 03d, dispatched
 * separately from the coder who built `renameField`/`archiveField`. Fresh
 * fixtures throughout (distinct field/strategy names, distinct derived-field
 * ids, distinct pruning-rule variants) from `fields-repository.lifecycle.
 * live.test.ts`'s own coder-written suite — see this repo's own
 * `createField` independent-verify file for the precedent this matches.
 *
 * Item 1 below (the guarded-UPDATE TOCTOU probe) is the one item in this
 * file that is NOT just "re-derive with fresh fixtures" — it is a genuine
 * attempt to BREAK the archive-side guard under real two-connection
 * concurrency, per this dispatch's own explicit instruction. See that
 * describe block's own header comment for why `waitForBlockedQuery` (this
 * session's usual go-to technique, `strategy-repository.live.test.ts`'s own
 * precedent) does not apply here, and what was used instead, and what it
 * found.
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

// =======================================================================
// Item 1 — genuine two-connection TOCTOU probe against archiveField's
// guarded UPDATE.
// =======================================================================
//
// ORIGINAL FINDING (2026-09-08, this file's own first pass, preserved here
// for context): the guarded UPDATE under test (fields-repository.ts,
// archiveField) —
//
//   update retrospeq.fields f
//      set state = 'archived', archived_at = now()
//    where f.user_id = $1 and f.id = $2 and f.state = 'active'
//      and not exists (
//        select 1 from retrospeq.field_usages fu
//         where fu.user_id = $1 and fu.field_id = $2
//      )
//    returning f.archived_at
//
// — did NOT actually close the race it looked like it closed.
// `field_usages(user_id, field_id) references fields(user_id, id)` makes an
// INSERT into `field_usages` take a `FOR KEY SHARE` tuple lock on the
// referenced `fields` row; the guarded UPDATE above (touching only
// `state`/`archived_at`, neither part of `fields`' own primary key) takes a
// `FOR NO KEY UPDATE` lock — and Postgres's own row-lock conflict matrix
// does NOT consider those two modes to conflict (confirmed against
// Postgres's own documented lock-compatibility table, not assumed). A real
// second connection holding an UNCOMMITTED `field_usages` insert
// referencing the field, run concurrently with a real `archiveField` call,
// empirically proved this: `archiveField` succeeded (its own `not exists`
// subquery could not see the still-uncommitted row), and the DB was left
// with `state = 'archived'` AND a live `field_usages` row at the same time.
//
// FIX (coder follow-up, same day): `archiveField`'s own guarded-UPDATE
// transaction, and `rebuildFieldUsagesForStrategy`
// (`strategy-repository.ts`, the ONLY real code path that ever inserts a
// `field_usages` row), now BOTH take `pg_advisory_xact_lock(hashtext(field
// id))` as their first statement, before either one's real write — see
// `fields-repository.ts`'s own `archiveField` header ("CONCURRENCY FIX")
// and `strategy-repository.ts`'s own `rebuildFieldUsagesForStrategy` header
// for the full mechanism. This turns what was an invisible, un-raceable-by-
// `waitForBlockedQuery` gap into a REAL, observable lock conflict —
// `waitForBlockedQuery` (`strategy-repository.live.test.ts`'s own
// established technique, polling `pg_stat_activity` for a query genuinely
// blocked on a lock, not a fixed-timeout guess) now applies here exactly
// the same way it already does for that file's own two GENUINE races. Both
// directions of the race are proven below: (a) a concurrent field_usages
// insert wins the lock first — archiveField must then correctly see the
// committed usage and reject; (b) archiveField wins the lock first — a
// concurrent field-referencing strategy save must then correctly see the
// committed archive and reject, never silently inserting a field_usages
// row for an archived field.
describe.skipIf(!env)('archiveField — GENUINE two-connection TOCTOU probe against field_usages (live DB, independent verification)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-iv-race');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

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

  it(
    'DIRECTION A — a real second connection wins the per-field lock and holds an UNCOMMITTED field_usages insert; the real archiveField call genuinely blocks, then correctly loses — FieldInUseError, field stays active, usage row survives',
    async () => {
      const field = await createField({
        userId: user.id,
        name: 'TOCTOU race target A',
        kind: 'account',
        dataType: 'bool',
        config: {},
        ownerStrategyId: null,
      });
      const strategy = await createStrategy({ userId: user.id, name: 'Race strategy A (empty)', fields: [], triggers: [] });

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        await raceConn.query('begin');
        // Replays the exact statement sequence `rebuildFieldUsagesForStrategy`
        // issues for this field TODAY (post-fix): the per-field advisory
        // lock first, then the insert — held open, uncommitted.
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [field.fieldId]);
        const inserted = await raceConn.query(
          `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id) values ($1, $2, 'strategy', $3)`,
          [field.fieldId, user.id, strategy.strategyId],
        );
        expect(inserted.rowCount).toBe(1); // real row inserted, UNCOMMITTED

        const archivePromise = archiveField(user.id, field.fieldId);

        // Confirms archiveField's own lock-acquisition statement is
        // GENUINELY blocked (not merely "not yet resolved") — the whole
        // point of this fix: this query, which did not exist before the
        // fix, is now observably contending for the same lock key.
        await waitForBlockedQuery(db, '%select pg_advisory_xact_lock%');

        await raceConn.query('commit'); // the field_usages row is now real and permanent

        await expect(archivePromise).rejects.toThrow(FieldInUseError);
      } finally {
        await raceConn.end();
      }

      const fieldRow = await db.query(`select state, archived_at from retrospeq.fields where user_id = $1 and id = $2`, [
        user.id,
        field.fieldId,
      ]);
      expect(fieldRow.rows[0].state).toBe('active');
      expect(fieldRow.rows[0].archived_at).toBeNull();

      const usageRow = await db.query(
        `select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2 and used_by_id = $3`,
        [user.id, field.fieldId, strategy.strategyId],
      );
      expect(usageRow.rowCount).toBe(1);
    },
    20_000,
  );

  it(
    'DIRECTION B — the real archiveField call wins the per-field lock first; a concurrent field_usages insert genuinely blocks, then correctly loses once it sees the field archived — never a live field_usages row referencing an archived field',
    async () => {
      const field = await createField({
        userId: user.id,
        name: 'TOCTOU race target B',
        kind: 'account',
        dataType: 'bool',
        config: {},
        ownerStrategyId: null,
      });
      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        // A real connection holding archiveField's OWN lock-then-write
        // sequence open, uncommitted — mirroring archiveField's own
        // transaction body exactly (see fields-repository.ts).
        await raceConn.query('begin');
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [field.fieldId]);
        const archived = await raceConn.query(
          `update retrospeq.fields set state = 'archived', archived_at = now()
            where user_id = $1 and id = $2 and state = 'active'
              and not exists (select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2)`,
          [user.id, field.fieldId],
        );
        expect(archived.rowCount).toBe(1);

        // The real field_usages insert path — genuinely concurrent, via
        // the real rebuildFieldUsagesForStrategy helper (through
        // createStrategy, its real caller).
        const createPromise = createStrategy({
          userId: user.id,
          name: 'Race strategy B (referencing target)',
          fields: [{ fieldId: field.fieldId, captureMoment: 'post_close', order: 1 }],
          triggers: [],
        });

        await waitForBlockedQuery(db, '%select pg_advisory_xact_lock%');

        await raceConn.query('commit'); // the archive is now real and permanent

        await expect(createPromise).rejects.toThrow(FieldNotFoundError);
      } finally {
        await raceConn.end();
      }

      const fieldRow = await db.query(`select state, archived_at from retrospeq.fields where user_id = $1 and id = $2`, [
        user.id,
        field.fieldId,
      ]);
      expect(fieldRow.rows[0].state).toBe('archived');
      expect(fieldRow.rows[0].archived_at).not.toBeNull();

      const usageRow = await db.query(
        `select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2`,
        [user.id, field.fieldId],
      );
      expect(usageRow.rowCount).toBe(0); // never a live usage row referencing an archived field
    },
    20_000,
  );

  it(
    'NO NEW DEADLOCK — two concurrent multi-field strategy saves referencing the SAME two fields in OPPOSITE order both complete (serialized, never deadlocked)',
    async () => {
      const fieldX = await createField({ userId: user.id, name: 'Deadlock-order field X', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
      const fieldY = await createField({ userId: user.id, name: 'Deadlock-order field Y', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

      // Call A references [X, Y]; call B references [Y, X] — the exact
      // shape that would deadlock two concurrent multi-lock acquisitions
      // using CALLER-SUPPLIED order instead of a consistent sorted order
      // (see rebuildFieldUsagesForStrategy's own "DEADLOCK AVOIDANCE"
      // header). Both must resolve (one may legitimately wait briefly on
      // the other, but neither call may hang/deadlock) within the test's
      // own timeout.
      const [resultA, resultB] = await Promise.all([
        createStrategy({
          userId: user.id,
          name: 'Deadlock-order strategy A',
          fields: [
            { fieldId: fieldX.fieldId, captureMoment: 'post_close', order: 1 },
            { fieldId: fieldY.fieldId, captureMoment: 'post_close', order: 2 },
          ],
          triggers: [],
        }),
        createStrategy({
          userId: user.id,
          name: 'Deadlock-order strategy B',
          fields: [
            { fieldId: fieldY.fieldId, captureMoment: 'post_close', order: 1 },
            { fieldId: fieldX.fieldId, captureMoment: 'post_close', order: 2 },
          ],
          triggers: [],
        }),
      ]);

      expect(resultA.strategyId).toBeTruthy();
      expect(resultB.strategyId).toBeTruthy();

      const usages = await db.query(
        `select used_by_id from retrospeq.field_usages where user_id = $1 and field_id = any($2::text[])`,
        [user.id, [fieldX.fieldId, fieldY.fieldId]],
      );
      // Both strategies' own field_usages rows (2 fields each) present —
      // neither call's rebuild was lost or partially applied.
      expect(usages.rowCount).toBe(4);
    },
    20_000,
  );
});

// =======================================================================
// Item 2 — derived-field block re-derived with fresh fixtures, both
// operations, both the authenticated repository path AND a raw service_role
// SQL attempt bypassing the repository entirely.
// =======================================================================

describe.skipIf(!env)('renameField / archiveField — derived-field block re-derived (fresh fixtures, independent verification)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-iv-derived');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  // Deliberately different derived ids than the coder's own test (which
  // used drv.session/drv.direction) — drv.risk_pct and drv.hold_seconds.
  it('renameField on drv.risk_pct: clean FieldDerivedImmutableError, no raw trigger text, row untouched', async () => {
    let caught: unknown;
    try {
      await renameField(user.id, 'drv.risk_pct', 'My risk pct');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldDerivedImmutableError);
    const message = (caught as Error).message;
    expect(message).not.toMatch(/fields_forbid_derived_update/i);
    expect(message).not.toMatch(/raise exception/i);
    expect(message).not.toMatch(/23514/);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.risk_pct']);
    expect(row.rows[0].name).toBe('Risk %');
  });

  it('archiveField on drv.hold_seconds: clean FieldDerivedImmutableError, no raw trigger text, row untouched', async () => {
    let caught: unknown;
    try {
      await archiveField(user.id, 'drv.hold_seconds');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldDerivedImmutableError);
    const message = (caught as Error).message;
    expect(message).not.toMatch(/fields_forbid_derived_delete/i);
    expect(message).not.toMatch(/raise exception/i);
    expect(message).not.toMatch(/23514/);

    const row = await db.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.hold_seconds']);
    expect(row.rows[0].state).toBe('active');
  });

  // Bypassing the repository entirely — a raw UPDATE issued under
  // service_role (RLS-bypassing), matching `fields_forbid_derived_update`'s
  // own migration-header instruction to test "adversarially under BOTH
  // authenticated and service_role". The trigger has NO role check in its
  // own body (read directly above before writing this test) — it must
  // reject this exactly as it rejects an ordinary authenticated attempt.
  it('a raw UPDATE on a derived field under service_role (bypassing the repository AND RLS) still hits the trigger and is rejected', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        await c.query(`update retrospeq.fields set name = 'Hijacked via service_role' where user_id = $1 and id = $2`, [
          user.id,
          'drv.instrument',
        ]);
      }),
    ).rejects.toThrow(/never.*edited|never editable/i);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.instrument']);
    expect(row.rows[0].name).toBe('Instrument');
  });

  it('a raw DELETE on a derived field under service_role (outside erasure) still hits the trigger and is rejected', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        await c.query(`delete from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.news_nearby']);
      }),
    ).rejects.toThrow(/never.*deleted|never deletable/i);

    const row = await db.query(`select 1 from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.news_nearby']);
    expect(row.rowCount).toBe(1);
  });
});

// =======================================================================
// Item 3 — pruning-rule-on-rename re-derived with the SPECIFIC
// reordering/pluralization-class variants Slice 03c's own tester found a
// real gap on ("Days of week", "Type of order") — confirming the FIX
// (`normalizeForMatch` in field-validation.ts) genuinely reaches the
// RENAME path, not just the original create path it was found and fixed
// against.
// =======================================================================

describe.skipIf(!env)('renameField — §4.1 pruning rule, reordering/pluralization-class variants (fresh fixtures, independent verification)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-iv-pruning');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('rejects renaming TO "Days of week" (plural of canonical "Day of week") — the exact gap class Slice 03c\'s tester found', async () => {
    const created = await createField({ userId: user.id, name: 'Pruning-rename target 1', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(renameField(user.id, created.fieldId, 'Days of week')).rejects.toThrow(FieldDuplicatesDerivedError);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
    expect(row.rows[0].name).toBe('Pruning-rename target 1');
  });

  it('rejects renaming TO "Type of order" (word-order swap of canonical "Order type") — the exact gap class Slice 03c\'s tester found', async () => {
    const created = await createField({ userId: user.id, name: 'Pruning-rename target 2', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(renameField(user.id, created.fieldId, 'Type of order')).rejects.toThrow(FieldDuplicatesDerivedError);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
    expect(row.rows[0].name).toBe('Pruning-rename target 2');
  });

  it('rejects renaming TO "Instruments" (plural of canonical "Instrument")', async () => {
    const created = await createField({ userId: user.id, name: 'Pruning-rename target 3', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(renameField(user.id, created.fieldId, 'Instruments')).rejects.toThrow(FieldDuplicatesDerivedError);
  });

  it('still allows renaming to a genuinely unrelated name (control — the rename path is not over-blocking)', async () => {
    const created = await createField({ userId: user.id, name: 'Pruning-rename target 4', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const renamed = await renameField(user.id, created.fieldId, 'Setup quality');
    expect(renamed.name).toBe('Setup quality');
  });
});

// =======================================================================
// Item 4 — idempotent double-archive: no timestamp drift on the SECOND
// call, a real elapsed-time gap so a bug that DID re-set archived_at would
// be caught (a re-run within the same millisecond could otherwise mask it).
// =======================================================================

describe.skipIf(!env)('archiveField — double-archive timestamp integrity (fresh fixture, independent verification)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-iv-double-archive');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'archiving an already-archived field a second time, after a real elapsed gap, returns the IDENTICAL archivedAt — never a newer one, never an error',
    async () => {
      const created = await createField({ userId: user.id, name: 'Double-archive timestamp fixture', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

      const first = await archiveField(user.id, created.fieldId);
      expect(first.archivedAt).toBeTruthy();

      // A real 1.5s gap — long enough that a bug re-setting archived_at to
      // `now()` a second time would produce a DIFFERENT, strictly LATER
      // timestamp, not something that could be masked by two calls landing
      // in the same DB-clock millisecond.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const second = await archiveField(user.id, created.fieldId);
      expect(second.archivedAt).toBe(first.archivedAt);

      // Confirm directly against the row too, not just the function's own
      // return value (in case the function ever started returning a cached/
      // computed value instead of re-reading the row).
      const row = await db.query(`select archived_at from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
      expect(new Date(row.rows[0].archived_at).toISOString()).toBe(new Date(first.archivedAt).toISOString());
    },
    10_000,
  );
});

// =======================================================================
// Item 5 — fresh cross-user adversarial fixtures for both write paths
// (distinct from the coder's own cross-user describe blocks — different
// field names/shapes, and additionally probes a raw-RLS read to confirm
// the isolation is enforced at the DB layer, not merely the repository's
// own application-level `user_id = $1` predicate).
// =======================================================================

describe.skipIf(!env)('renameField / archiveField — fresh cross-user adversarial fixtures (independent verification)', () => {
  let db: Client;
  let owner: TestAuthUser;
  let attacker: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    owner = await createTestAuthUser(env, 'fields-iv-x-owner');
    attacker = await createTestAuthUser(env, 'fields-iv-x-attacker');
    await setPlan(db, owner.id, 'pro');
    await setPlan(db, attacker.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, owner.id);
    await cleanupUser(db, attacker.id);
    await deleteTestAuthUser(env, owner.id).catch(() => {});
    await deleteTestAuthUser(env, attacker.id).catch(() => {});
    await db.end();
  });

  it('attacker cannot rename the owner\'s field (app layer), and cannot even SELECT the row under RLS', async () => {
    const field = await createField({ userId: owner.id, name: 'Owner-only field (iv)', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    await expect(renameField(attacker.id, field.fieldId, 'Renamed by attacker')).rejects.toThrow(FieldRecordNotFoundError);

    const rlsCount = await asRole(db, 'authenticated', attacker.id, async (c) => {
      const res = await c.query('select 1 from retrospeq.fields where id = $1', [field.fieldId]);
      return res.rowCount;
    });
    expect(rlsCount).toBe(0);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [owner.id, field.fieldId]);
    expect(row.rows[0].name).toBe('Owner-only field (iv)');
  });

  it("attacker cannot archive the owner's field (app layer), and a raw attacker-role UPDATE targeting it affects zero rows", async () => {
    const field = await createField({ userId: owner.id, name: 'Owner-only archive target (iv)', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    await expect(archiveField(attacker.id, field.fieldId)).rejects.toThrow(FieldRecordNotFoundError);

    // A raw attempt, AS the attacker's own authenticated role, to archive
    // it directly — RLS's own `fields_owner_select`/`_update` predicate
    // (`user_id = auth.uid()`) must make this affect zero rows, not just
    // the repository's own application-level filter.
    const affected = await asRole(db, 'authenticated', attacker.id, async (c) => {
      const res = await c.query(`update retrospeq.fields set state = 'archived', archived_at = now() where id = $1`, [field.fieldId]);
      return res.rowCount;
    });
    expect(affected).toBe(0);

    const row = await db.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [owner.id, field.fieldId]);
    expect(row.rows[0].state).toBe('active');
  });
});

// =======================================================================
// Item 6 — renameField collision reuses FieldNameConflictError (not a new,
// differently-shaped error), fresh collision fixture.
// =======================================================================

describe.skipIf(!env)('renameField — collision error shape (fresh fixture, independent verification)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-iv-collision');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('renaming field X to a name colliding with active field Y throws the SAME FieldNameConflictError shape createField throws, with the right (name, ownerStrategyId)', async () => {
    await createField({ userId: user.id, name: 'Alpha Prime', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const other = await createField({ userId: user.id, name: 'Beta Prime', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    let caught: unknown;
    try {
      await renameField(user.id, other.fieldId, 'Alpha Prime');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldNameConflictError);
    const conflictError = caught as FieldNameConflictError;
    expect(conflictError.code).toBe('FIELD_NAME_CONFLICT');
    expect(conflictError.ownerStrategyId).toBeNull();
    expect(conflictError.message).toContain('Alpha Prime');
    expect(conflictError.message).not.toMatch(/duplicate key value|unique constraint|23505/i);

    // REAL FINDING (see this file's own decision-log entry / final report):
    // `FieldNameConflictError`'s constructor signature is
    // `constructor(readonly name: string, readonly ownerStrategyId: ...)`,
    // clearly INTENDED (matching every sibling error class in this same
    // file -- `FieldKindScopeMismatchError.kind`, `FieldRecordNotFoundError.
    // fieldId`) to expose the colliding field's own name as a typed data
    // field. It does not: the very next line in the constructor body,
    // `this.name = 'FieldNameConflictError'` (the ordinary "tag the error
    // class for stack traces" convention every class in this file uses),
    // unconditionally clobbers the parameter-property assignment, because
    // both target the SAME property -- `Error.prototype.name` and the
    // constructor's own `name` parameter collide. `.message` still carries
    // the real field name correctly (it was already baked into the string
    // passed to `super()` before this collision happens), but `.name` can
    // never be read as data -- confirmed empirically here, not assumed.
    // Pre-existing since Slice 03c's own `createField` (this class predates
    // Slice 03d), never caught before because no prior test ever asserted
    // on `.name`, only `instanceof`/`.message`. No current caller in this
    // repo consumes `.name` as data (grepped `app/` before writing this
    // comment), so this has no live production impact TODAY, but it is a
    // real, reproducible latent defect for whichever future API-route
    // slice reaches for `err.name` expecting the field name rather than
    // parsing `.message`.
    expect(conflictError.name).toBe('FieldNameConflictError'); // NOT 'Alpha Prime' -- this is the bug, documented not silently worked around

    // FIX CONFIRMED (2026-09-08, coder follow-up to this file's own
    // finding): the colliding field's name is now readable as data via
    // `.conflictingFieldName` (a differently-named property, per this
    // file's own recommendation above), while `.name` stays the ordinary
    // Error-class-name tag every class in this file uses.
    expect(conflictError.conflictingFieldName).toBe('Alpha Prime');

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, other.fieldId]);
    expect(row.rows[0].name).toBe('Beta Prime');
  });

  it('renaming a strategy-scoped field to a name colliding with another field in the SAME strategy also throws FieldNameConflictError, with ownerStrategyId populated', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Collision-scope strategy (iv)', fields: [], triggers: [] });
    await createField({ userId: user.id, name: 'Scoped Alpha', kind: 'strategy_var', dataType: 'bool', config: {}, ownerStrategyId: strategy.strategyId });
    const scopedOther = await createField({ userId: user.id, name: 'Scoped Beta', kind: 'strategy_var', dataType: 'bool', config: {}, ownerStrategyId: strategy.strategyId });

    let caught: unknown;
    try {
      await renameField(user.id, scopedOther.fieldId, 'Scoped Alpha');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldNameConflictError);
    expect((caught as FieldNameConflictError).ownerStrategyId).toBe(strategy.strategyId);
  });
});
