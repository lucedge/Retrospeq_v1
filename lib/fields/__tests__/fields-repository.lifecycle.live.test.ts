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

// Real network/DB round trips — matches `fields-repository.live.test.ts`'s
// own per-file timeout override and reasoning exactly.
vi.setConfig({ testTimeout: 20_000 });

import {
  archiveField,
  createField,
  FieldDerivedImmutableError,
  FieldInUseError,
  FieldNameConflictError,
  FieldNameInvalidError,
  FieldRecordNotFoundError,
  renameField,
} from '../fields-repository';
import { FieldDuplicatesDerivedError } from '../field-validation';
import { createStrategy, editStrategy, fetchCurrentStrategyForEdit } from '../strategy-repository';

/**
 * Module 03 (Field Registry & Strategy) Slice 03d — live-DB proof for
 * `lib/fields/fields-repository.ts`'s `renameField`/`archiveField` (§4.5's
 * field lifecycle): the pruning-rule/uniqueness checks on rename, the
 * derived-field block on both operations (surfacing a clean, typed error —
 * never the raw `fields_forbid_derived_update`/`_delete` trigger text), the
 * real `field_usages`-backed dependency block on archive (naming the actual
 * dependent strategy, seeded via Slice 03b's own real `createStrategy`),
 * and cross-user adversarial isolation for both operations. Matches
 * `fields-repository.live.test.ts`'s own structure/conventions exactly.
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

describe.skipIf(!env)('renameField (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-rename');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('renames an account field, id stays stable', async () => {
    const created = await createField({ userId: user.id, name: 'Conviction v1', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    const renamed = await renameField(user.id, created.fieldId, 'Conviction');
    expect(renamed.fieldId).toBe(created.fieldId);
    expect(renamed.name).toBe('Conviction');

    const row = await db.query(`select id, name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
    expect(row.rows[0]).toMatchObject({ id: created.fieldId, name: 'Conviction' });
  });

  it('trims whitespace on rename', async () => {
    const created = await createField({ userId: user.id, name: 'Trim target', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const renamed = await renameField(user.id, created.fieldId, '  Trimmed name  ');
    expect(renamed.name).toBe('Trimmed name');
  });

  it('rejects an empty new name, writes nothing', async () => {
    const created = await createField({ userId: user.id, name: 'Empty rename target', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(renameField(user.id, created.fieldId, '   ')).rejects.toThrow(FieldNameInvalidError);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
    expect(row.rows[0].name).toBe('Empty rename target');
  });

  it('rejects a new name over 40 characters', async () => {
    const created = await createField({ userId: user.id, name: 'Long rename target', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(renameField(user.id, created.fieldId, 'x'.repeat(41))).rejects.toThrow(FieldNameInvalidError);
  });

  // -----------------------------------------------------------------
  // §4.1 pruning rule applied to rename — a real, live end-to-end proof,
  // not just the pure checkPruningRule unit tests in field-validation.test.ts.
  // -----------------------------------------------------------------

  it('rejects renaming TO a name that duplicates a derived field (§4.1), no write happens', async () => {
    const created = await createField({ userId: user.id, name: 'Pruning rename target', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    await expect(renameField(user.id, created.fieldId, 'Session')).rejects.toThrow(FieldDuplicatesDerivedError);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
    expect(row.rows[0].name).toBe('Pruning rename target');
  });

  it('rejects renaming to a known pruning-rule VARIANT ("day" for "Day of week"), not just an exact match', async () => {
    const created = await createField({ userId: user.id, name: 'Weekday-ish', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await expect(renameField(user.id, created.fieldId, 'day')).rejects.toThrow(FieldDuplicatesDerivedError);
  });

  // -----------------------------------------------------------------
  // Real (user_id, name, owner_strategy_id) collision on rename -> clean
  // FieldNameConflictError, not a raw Postgres error.
  // -----------------------------------------------------------------

  it('rejects renaming to a name that collides with another active field in the same scope', async () => {
    await createField({ userId: user.id, name: 'Taken name', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const other = await createField({ userId: user.id, name: 'Free to rename', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    await expect(renameField(user.id, other.fieldId, 'Taken name')).rejects.toThrow(FieldNameConflictError);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, other.fieldId]);
    expect(row.rows[0].name).toBe('Free to rename');
  });

  it('renaming a field to its OWN current name is a harmless no-op (self-collision does not trip the unique index)', async () => {
    const created = await createField({ userId: user.id, name: 'Self rename', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const renamed = await renameField(user.id, created.fieldId, 'Self rename');
    expect(renamed.name).toBe('Self rename');
  });

  it('an archived field can be renamed to a name matching an ACTIVE field (archived rows are excluded from the unique index)', async () => {
    const active = await createField({ userId: user.id, name: 'Shared with archived', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const toArchive = await createField({ userId: user.id, name: 'Will be archived then renamed', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    await archiveField(user.id, toArchive.fieldId);

    const renamed = await renameField(user.id, toArchive.fieldId, active.name);
    expect(renamed.name).toBe(active.name);
  });

  // -----------------------------------------------------------------
  // Derived-field block — a clean, typed error, never the raw trigger
  // exception text (`fields_forbid_derived_update`).
  // -----------------------------------------------------------------

  it('rejects renaming a derived field with a clean FieldDerivedImmutableError, no raw trigger text', async () => {
    let caught: unknown;
    try {
      await renameField(user.id, 'drv.session', 'My Session');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldDerivedImmutableError);
    const message = (caught as Error).message;
    expect(message).not.toMatch(/fields_forbid_derived_update/i);
    expect(message).not.toMatch(/raise exception/i);
    expect(message).toMatch(/derived field/i);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.session']);
    expect(row.rows[0].name).toBe('Session'); // untouched
  });

  // -----------------------------------------------------------------
  // Not found / cross-user
  // -----------------------------------------------------------------

  it('rejects a nonexistent field id with FieldRecordNotFoundError', async () => {
    await expect(renameField(user.id, 'acct.00000000-0000-7000-8000-000000000000', 'Nobody home')).rejects.toThrow(FieldRecordNotFoundError);
  });
});

describe.skipIf(!env)('renameField — cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fields-rename-a');
    userB = await createTestAuthUser(env, 'fields-rename-b');
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

  it("user B renaming user A's field is rejected with FieldRecordNotFoundError, no row changed", async () => {
    const created = await createField({ userId: userA.id, name: "A's own field", kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    await expect(renameField(userB.id, created.fieldId, 'Hijacked name')).rejects.toThrow(FieldRecordNotFoundError);

    const row = await db.query(`select name from retrospeq.fields where user_id = $1 and id = $2`, [userA.id, created.fieldId]);
    expect(row.rows[0].name).toBe("A's own field");
  });

  it("user B's connection cannot see user A's field row at all (RLS, not just application filtering)", async () => {
    const created = await createField({ userId: userA.id, name: "A's isolation field", kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select 1 from retrospeq.fields where id = $1', [created.fieldId]);
      return res.rowCount;
    });
    expect(rowCount).toBe(0);
  });
});

describe.skipIf(!env)('archiveField (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-archive');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('archives a field with no dependents — state=archived, archived_at set, row retained (not deleted)', async () => {
    const created = await createField({ userId: user.id, name: 'No dependents', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    const archived = await archiveField(user.id, created.fieldId);
    expect(archived.fieldId).toBe(created.fieldId);
    expect(archived.archivedAt).toBeTruthy();

    const row = await db.query(`select state, archived_at from retrospeq.fields where user_id = $1 and id = $2`, [user.id, created.fieldId]);
    expect(row.rows[0].state).toBe('archived');
    expect(row.rows[0].archived_at).toBeTruthy();
  });

  it('archiving an already-archived field is an idempotent no-op, returns the SAME archivedAt', async () => {
    const created = await createField({ userId: user.id, name: 'Double archive', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const first = await archiveField(user.id, created.fieldId);
    const second = await archiveField(user.id, created.fieldId);
    expect(second.archivedAt).toBe(first.archivedAt);
  });

  it('rejects archiving a derived field with a clean FieldDerivedImmutableError, no raw trigger text, row untouched', async () => {
    let caught: unknown;
    try {
      await archiveField(user.id, 'drv.direction');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldDerivedImmutableError);
    const message = (caught as Error).message;
    expect(message).not.toMatch(/fields_forbid_derived_delete/i);
    expect(message).not.toMatch(/raise exception/i);

    const row = await db.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [user.id, 'drv.direction']);
    expect(row.rows[0].state).toBe('active');
  });

  it('rejects archiving a nonexistent field id with FieldRecordNotFoundError', async () => {
    await expect(archiveField(user.id, 'acct.00000000-0000-7000-8000-000000000001')).rejects.toThrow(FieldRecordNotFoundError);
  });

  // -----------------------------------------------------------------
  // §4.5 / §9 FIELD_IN_USE — blocked when a REAL strategy dependency
  // exists, seeded via Slice 03b's own real createStrategy (not a fake
  // stand-in row) — and correctly UNBLOCKS once the dependency is removed.
  // -----------------------------------------------------------------

  it('blocks archiving a field referenced by a real strategy, naming that strategy — then succeeds once the reference is removed', async () => {
    const field = await createField({ userId: user.id, name: 'Strategy-referenced field', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    const strategy = await createStrategy({
      userId: user.id,
      name: 'Strategy that uses the field',
      fields: [{ fieldId: field.fieldId, captureMoment: 'post_close', order: 1 }],
      triggers: [],
    });

    // Confirm the real dependency row exists before asserting the block —
    // not just trusting the rejection, seeing the actual field_usages row.
    const usageRow = await db.query(
      `select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2 and used_by = 'strategy' and used_by_id = $3`,
      [user.id, field.fieldId, strategy.strategyId],
    );
    expect(usageRow.rowCount).toBe(1);

    let caught: unknown;
    try {
      await archiveField(user.id, field.fieldId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FieldInUseError);
    const fieldInUseError = caught as FieldInUseError;
    expect(fieldInUseError.dependents).toHaveLength(1);
    expect(fieldInUseError.dependents[0]).toMatchObject({ usedBy: 'strategy', usedById: strategy.strategyId, label: 'Strategy that uses the field' });
    expect(fieldInUseError.message).toContain('Strategy that uses the field');

    // Field itself untouched.
    const fieldRow = await db.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [user.id, field.fieldId]);
    expect(fieldRow.rows[0].state).toBe('active');

    // Remove the dependency (edit the strategy to no longer reference the
    // field — §4.6's own "rebuild field_usages for this strategy" rebuild)
    // and confirm archive now succeeds.
    const current = await fetchCurrentStrategyForEdit(user.id, strategy.strategyId);
    await editStrategy({
      userId: user.id,
      strategyId: strategy.strategyId,
      expectedVersion: current!.currentVersion,
      name: current!.name,
      fields: [],
      triggers: [],
    });

    const usageRowAfter = await db.query(`select 1 from retrospeq.field_usages where user_id = $1 and field_id = $2`, [user.id, field.fieldId]);
    expect(usageRowAfter.rowCount).toBe(0);

    const archived = await archiveField(user.id, field.fieldId);
    expect(archived.archivedAt).toBeTruthy();
  }, 20_000);
});

describe.skipIf(!env)('archiveField — cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fields-archive-a');
    userB = await createTestAuthUser(env, 'fields-archive-b');
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

  it("user B archiving user A's field is rejected with FieldRecordNotFoundError, no state change", async () => {
    const created = await createField({ userId: userA.id, name: "A's field to protect", kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    await expect(archiveField(userB.id, created.fieldId)).rejects.toThrow(FieldRecordNotFoundError);

    const row = await db.query(`select state from retrospeq.fields where user_id = $1 and id = $2`, [userA.id, created.fieldId]);
    expect(row.rows[0].state).toBe('active');
  });
});
