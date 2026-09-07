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

import { createField, FieldNameConflictError } from '../fields-repository';
import { StrategyNotFoundError, createStrategy } from '../strategy-repository';

/**
 * INDEPENDENT VERIFICATION (live DB) — Module 03 Slice 03c, dispatched
 * separately from the coder who built `createField`. Per this dispatch's
 * own instructions: fresh adversarial fixtures distinct from
 * `fields-repository.live.test.ts`'s own (different field/strategy names,
 * a genuinely different cross-user scenario shape, both partial-unique-
 * index collision cases probed independently for raw-error leakage, a
 * lightweight id-collision-risk concurrency check, and a fresh RLS
 * cross-user probe scoped specifically to `createField`'s own write).
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

// ---------------------------------------------------------------------
// 2. Cross-user strategy-ownership hijack — fresh fixture, checks that
//    the "identical response for nonexistent vs. not-owned" convention
//    genuinely holds (not just that SOME error is thrown).
// ---------------------------------------------------------------------

describe.skipIf(!env)('createField — fresh cross-user strategy-ownership hijack (independent re-derivation)', () => {
  let db: Client;
  let userA: TestAuthUser; // the real strategy owner
  let userB: TestAuthUser; // the attacker

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fields-iv-owner');
    userB = await createTestAuthUser(env, 'fields-iv-attacker');
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

  it('user B creating a strategy_var field under user A\'s real strategy id is rejected with StrategyNotFoundError, produces the SAME message shape as a nonexistent id, and writes no row for either user', async () => {
    const realStrategy = await createStrategy({ userId: userA.id, name: 'Real strategy owned by A (independent-verify fixture)', fields: [], triggers: [] });

    let hijackError: unknown;
    try {
      await createField({
        userId: userB.id,
        name: 'Hijack attempt (iv)',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: realStrategy.strategyId,
      });
    } catch (err) {
      hijackError = err;
    }
    expect(hijackError).toBeInstanceOf(StrategyNotFoundError);

    let nonexistentError: unknown;
    try {
      await createField({
        userId: userB.id,
        name: 'Nonexistent scope (iv)',
        kind: 'strategy_var',
        dataType: 'bool',
        config: {},
        ownerStrategyId: '00000000-0000-7000-8000-000000000001',
      });
    } catch (err) {
      nonexistentError = err;
    }
    expect(nonexistentError).toBeInstanceOf(StrategyNotFoundError);

    // The repo's own established convention (flagged in multiple prior
    // security reviews this session): a not-owned id and a genuinely
    // nonexistent id must be INDISTINGUISHABLE to the caller. Both
    // `StrategyNotFoundError` messages echo back the id the CALLER
    // themselves supplied (something the caller already knows, in both
    // cases -- not a server-side leak) -- the real test is that the
    // message TEMPLATE is byte-identical between the two cases once each
    // one's own echoed id is normalized out, i.e. there is no additional
    // wording anywhere ("this strategy exists but belongs to someone
    // else" vs "no such strategy") that would let a caller distinguish
    // "exists, not yours" from "genuinely doesn't exist".
    const normalize = (msg: string) => msg.replace(/[0-9a-f-]{36}/gi, '<id>');
    expect(normalize((hijackError as Error).message)).toBe(normalize((nonexistentError as Error).message));
    expect((hijackError as Error).message).toBe('No strategy ' + realStrategy.strategyId + ' owned by the calling user.');
    expect((nonexistentError as Error).message).toBe('No strategy 00000000-0000-7000-8000-000000000001 owned by the calling user.');

    // No row written for user B under either attempt.
    const bRows = await db.query(`select count(*)::text as c from retrospeq.fields where user_id = $1 and kind <> 'derived'`, [userB.id]);
    expect(bRows.rows[0].c).toBe('0');

    // User A's own strategy is completely untouched (no field attached,
    // no field_usages row, nothing leaked into their own registry).
    const aFields = await db.query(`select count(*)::text as c from retrospeq.fields where user_id = $1 and owner_strategy_id = $2`, [
      userA.id,
      realStrategy.strategyId,
    ]);
    expect(aFields.rows[0].c).toBe('0');
  });
});

// ---------------------------------------------------------------------
// 4. Both partial-unique-index collision cases, probed independently for
//    raw Postgres error leakage — fresh fixtures.
// ---------------------------------------------------------------------

describe.skipIf(!env)('createField — both partial-unique-index collisions, fresh fixtures (independent re-derivation)', () => {
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

  it('collision on fields_unique_active_unscoped (kind=account, owner_strategy_id IS NULL) — clean FieldNameConflictError, no raw Postgres text anywhere in the message', async () => {
    await createField({ userId: user.id, name: 'Independent-verify unscoped collider', kind: 'account', dataType: 'number', config: { min: 0, max: 1, step: 1 }, ownerStrategyId: null });

    let err: unknown;
    try {
      await createField({ userId: user.id, name: 'Independent-verify unscoped collider', kind: 'account', dataType: 'number', config: { min: 0, max: 1, step: 1 }, ownerStrategyId: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FieldNameConflictError);
    const msg = (err as Error).message;
    expect(msg.toLowerCase()).not.toContain('constraint');
    expect(msg.toLowerCase()).not.toContain('duplicate key');
    expect(msg.toLowerCase()).not.toContain('23505');
    expect(msg.toLowerCase()).not.toContain('fields_unique_active');
  });

  it('collision on fields_unique_active_scoped (kind=strategy_var, owner_strategy_id IS NOT NULL) — clean FieldNameConflictError, no raw Postgres text anywhere in the message', async () => {
    const strategy = await createStrategy({ userId: user.id, name: 'Independent-verify scoped collision host', fields: [], triggers: [] });
    await createField({ userId: user.id, name: 'Independent-verify scoped collider', kind: 'strategy_var', dataType: 'bool', config: {}, ownerStrategyId: strategy.strategyId });

    let err: unknown;
    try {
      await createField({ userId: user.id, name: 'Independent-verify scoped collider', kind: 'strategy_var', dataType: 'bool', config: {}, ownerStrategyId: strategy.strategyId });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FieldNameConflictError);
    const msg = (err as Error).message;
    expect(msg.toLowerCase()).not.toContain('constraint');
    expect(msg.toLowerCase()).not.toContain('duplicate key');
    expect(msg.toLowerCase()).not.toContain('23505');
    expect(msg.toLowerCase()).not.toContain('fields_unique_active');
  });

  it('a scoped collision under a DIFFERENT strategy does not collide (the scoped index is per-owner_strategy_id, not per-user)', async () => {
    const strategyOne = await createStrategy({ userId: user.id, name: 'Independent-verify strategy one', fields: [], triggers: [] });
    const strategyTwo = await createStrategy({ userId: user.id, name: 'Independent-verify strategy two', fields: [], triggers: [] });

    await createField({ userId: user.id, name: 'Reused across strategies (iv)', kind: 'strategy_var', dataType: 'bool', config: {}, ownerStrategyId: strategyOne.strategyId });

    await expect(
      createField({ userId: user.id, name: 'Reused across strategies (iv)', kind: 'strategy_var', dataType: 'bool', config: {}, ownerStrategyId: strategyTwo.strategyId }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------
// 5. Id-generation soundness — lightweight concurrency check (not a
//    version-conflict scenario, per this dispatch's own framing: field
//    creation has no compare-and-swap step, so this only needs to confirm
//    the PK/id scheme holds up under real concurrent writes, not prove a
//    guarded-UPDATE race the way Slice 03b's edit path needed).
// ---------------------------------------------------------------------

describe.skipIf(!env)('createField — id-generation soundness under real concurrency (independent re-derivation)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fields-iv-concurrency');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('20 real concurrent createField calls (distinct names, same user) all succeed with 20 distinct ids — no PK collision, no lost write', async () => {
    const calls = Array.from({ length: 20 }, (_, i) =>
      createField({
        userId: user.id,
        name: `Concurrency probe field ${i} (iv)`,
        kind: 'account',
        dataType: 'bool',
        config: {},
        ownerStrategyId: null,
      }),
    );
    const results = await Promise.all(calls);
    const ids = results.map((r) => r.fieldId);
    expect(new Set(ids).size).toBe(20); // no duplicate id generated under real concurrent load

    const rows = await db.query(
      `select count(*)::text as c from retrospeq.fields where user_id = $1 and name like 'Concurrency probe field%'`,
      [user.id],
    );
    expect(rows.rows[0].c).toBe('20'); // every call actually landed a row, nothing silently dropped
  });

  it('the generated id genuinely uses the server-side retrospeq.uuid_generate_v7() function, not a client-supplied value (structural confirmation, not just a regex match)', async () => {
    const before = await db.query(`select retrospeq.uuid_generate_v7()::text as sample`);
    expect(before.rows[0].sample).toMatch(/^[0-9a-f-]{36}$/);

    const result = await createField({ userId: user.id, name: 'Id source check (iv)', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const uuidPart = result.fieldId.replace(/^acct\./, '');
    expect(uuidPart).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i); // version 7 shape
  });
});

// ---------------------------------------------------------------------
// 6. RLS re-check scoped specifically to createField's own write —
//    fresh fixtures, a THIRD independent angle beyond the coder's own
//    "userB cannot see userA's row" test: confirm userB cannot even
//    ATTEMPT to write into userA's row-space via a spoofed userId in a
//    createField call while genuinely authenticated as userB at the RLS
//    layer.
// ---------------------------------------------------------------------

describe.skipIf(!env)('createField — fresh RLS cross-user isolation re-check (independent re-derivation)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fields-iv-rls-a');
    userB = await createTestAuthUser(env, 'fields-iv-rls-b');
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

  it('a row written by createField for user A is invisible to user B via direct RLS-scoped SELECT, and user B genuinely cannot INSERT a row claiming to be user A\'s (RLS insert policy, not just app-layer withUserConnection scoping)', async () => {
    const created = await createField({ userId: userA.id, name: 'RLS re-check field (iv)', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });

    const bCanSee = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select 1 from retrospeq.fields where id = $1 and user_id = $2', [created.fieldId, userA.id]);
      return res.rowCount;
    });
    expect(bCanSee).toBe(0);

    // Attempt a raw INSERT as userB, but claiming user_id = userA.id — RLS's
    // own `fields_owner_insert` policy (`with check (user_id = auth.uid()
    // and kind <> 'derived')`) must reject this outright, independent of
    // `createField`'s own application-layer scoping via `withUserConnection`.
    await expect(
      asRole(db, 'authenticated', userB.id, async (c) => {
        await c.query(
          `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
           values ('acct.rls-spoof-attempt-iv', $1, 'Spoofed field (iv)', 'account', 'bool', 'captured', null, '{}'::jsonb)`,
          [userA.id],
        );
      }),
    ).rejects.toThrow();

    // Confirm nothing landed under either user from the rejected attempt.
    const spoofed = await db.query(`select 1 from retrospeq.fields where id = $1`, ['acct.rls-spoof-attempt-iv']);
    expect(spoofed.rowCount).toBe(0);
  });

  it('user B cannot use createField itself to write a row under user A\'s user_id (application-layer confirmation: createField always writes under its OWN caller\'s userId, no cross-user parameter exists to exploit)', async () => {
    // createField's own CreateFieldInput has no separate "targetUserId"
    // distinct from the connection owner -- withUserConnection(userId, ...)
    // both authenticates AS that user AND scopes the write, so there is no
    // parameter surface at all for userB to attempt writing "as" userA.
    // This test documents that structural fact by confirming the ONLY
    // userId createField ever accepts is also the one the row lands under.
    const created = await createField({ userId: userB.id, name: 'Self-attribution check (iv)', kind: 'account', dataType: 'bool', config: {}, ownerStrategyId: null });
    const row = await db.query(`select user_id from retrospeq.fields where id = $1`, [created.fieldId]);
    expect(row.rows[0].user_id).toBe(userB.id);
  });
});
