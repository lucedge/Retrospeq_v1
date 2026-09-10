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

/**
 * INDEPENDENT VERIFICATION (2026-09-10) of Module 03 §4.8's field-cap
 * warning — dispatched specifically to close the gap the 2026-09-10
 * "CODER (picked up, not redone)" PROGRESS.md entry explicitly flagged it
 * could not itself re-verify (a lost throwaway screenshot spec) PLUS to
 * run fresh, adversarial fixtures against `fetchStrategiesForUser`'s
 * `capturedFieldCount` column that neither the original coder's tests nor
 * `strategy-repository.live.test.ts`'s own §4.8 block already covers:
 *
 *   1. An orphaned/malformed field-snapshot entry (a `strategy_versions.
 *      fields[]` entry naming a field id with NO resolvable
 *      `retrospeq.fields` row at all) — the column's own doc comment
 *      claims this is deliberately still COUNTED (over-count-never-hide),
 *      never silently dropped. Verified here directly against a raw,
 *      hand-crafted snapshot, not trusted from the comment alone.
 *   2. The bigint-vs-string cast fix — proven by asserting
 *      `typeof capturedFieldCount === 'number'` (a raw, uncast
 *      `count(*)` would round-trip through `pg` as a STRING, which
 *      would still often "work" under `toBe(7)` in JS's loose paths but
 *      would NOT satisfy a strict `typeof` check) AND by actually
 *      crossing BOTH named thresholds (5 and 7) in one strategy each,
 *      confirming `fieldCapWarningMessage` picks the correct row of
 *      §4.8's table for each, not merely that the query resolves without
 *      throwing.
 *   3. Cross-user isolation on the new `left join retrospeq.fields`
 *      inside `fetchStrategiesForUser`'s own subquery — since
 *      `retrospeq.fields`' real primary key is `(user_id, id)`, not a
 *      globally unique `id` alone (`20260902010000_field_registry_schema
 *      .sql`), two DIFFERENT users can genuinely own a field row with the
 *      SAME id string. This test creates exactly that collision (same id,
 *      opposite §4.8 captured-vs-free classification on each side) and
 *      proves user A's own count reflects ONLY user A's own field row,
 *      never user B's.
 *
 * Every fixture here is fresh and independently constructed — none reused
 * from `strategy-repository.live.test.ts`'s own `describe` blocks, per
 * this dispatch's own "do not just trust the claim" instruction.
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

/**
 * Hand-crafts a strategy + version 1 row via RAW SQL (bypassing
 * `createStrategy`'s own validation pipeline entirely, on purpose) so the
 * `fields[]` snapshot can name field ids that were never validated to
 * exist — the exact "orphaned/malformed entry" shape §4.8's over-count
 * doc comment describes. `createStrategy` itself can never produce this
 * shape (it always validates every field id first); this helper exists
 * specifically to construct the state that validation is meant to
 * prevent, so the READ side's own defensive behavior can be checked
 * independently of whether the WRITE side does its job.
 */
async function insertRawStrategyWithFieldSnapshot(
  db: Client,
  userId: string,
  name: string,
  fieldIds: string[],
): Promise<string> {
  const strategyRes = await db.query<{ id: string }>(
    `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
     values ($1, $2, 1, false, 'active')
     returning id`,
    [userId, name],
  );
  const strategyId = strategyRes.rows[0].id;
  const fields = fieldIds.map((field_id, i) => ({ field_id, capture_moment: 'post_close', order: i }));
  await db.query(
    `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
     values ($1, 1, $2, $3, $4::jsonb, '[]'::jsonb)`,
    [strategyId, userId, name, JSON.stringify(fields)],
  );
  return strategyId;
}

async function cleanupUser(db: Client, userId: string): Promise<void> {
  await db.query('begin');
  await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
  await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
  await db.query('delete from retrospeq.fields where user_id = $1 and kind <> $2', [userId, 'derived']);
  await db.query('commit');
}

describe.skipIf(!env)('§4.8 field-cap warning — INDEPENDENT adversarial verification (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'fieldcap-adversarial');
    await setPlan(db, user.id, 'pro');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('an orphaned field-snapshot entry (no resolvable retrospeq.fields row at all) is COUNTED toward capturedFieldCount, never silently dropped', async () => {
    const { fetchStrategiesForUser } = await import('../strategy-repository');

    const strategyId = await insertRawStrategyWithFieldSnapshot(db, user.id, 'Orphaned-entry strategy', [
      'ghost.does-not-exist-1',
      'ghost.does-not-exist-2',
    ]);

    const list = await fetchStrategiesForUser(user.id);
    const row = list.find((s) => s.strategyId === strategyId);
    expect(row).toBeDefined();
    // Both entries are unresolvable -- if the join silently dropped a miss
    // instead of counting it, this would incorrectly read 0.
    expect(row!.fieldCount).toBe(2);
    expect(row!.capturedFieldCount).toBe(2);
  }, 15_000);

  it('a MIX of one real captured field, one real derived field, and one orphaned entry counts exactly the captured one plus the orphan — never the derived one', async () => {
    const { fetchStrategiesForUser } = await import('../strategy-repository');

    await insertCustomField(db, user.id, 'cf.adv.real-captured', 'bool');

    const strategyId = await insertRawStrategyWithFieldSnapshot(db, user.id, 'Mixed-entry strategy', [
      'cf.adv.real-captured', // real, kind=account, data_type=bool -- SHOULD count
      'drv.session', // real, kind=derived -- should NOT count
      'ghost.orphan-3', // unresolvable -- SHOULD count (over-count, never hide)
    ]);

    const list = await fetchStrategiesForUser(user.id);
    const row = list.find((s) => s.strategyId === strategyId);
    expect(row).toBeDefined();
    expect(row!.fieldCount).toBe(3);
    expect(row!.capturedFieldCount).toBe(2); // real captured + orphan, derived excluded
  }, 15_000);

  it('capturedFieldCount is a genuine JS number (bigint::int cast fix), not a string, at both the 5 and 7+ thresholds in the same run', async () => {
    const { fetchStrategiesForUser } = await import('../strategy-repository');
    const { fieldCapWarningMessage } = await import('../strategy-validation');

    const fiveIds = Array.from({ length: 5 }, (_, i) => `cf.adv.five-${i}`);
    for (const id of fiveIds) await insertCustomField(db, user.id, id, 'bool');
    const fiveStrategyId = await insertRawStrategyWithFieldSnapshot(db, user.id, 'Five-field strategy', fiveIds);

    const sevenIds = Array.from({ length: 7 }, (_, i) => `cf.adv.seven-${i}`);
    for (const id of sevenIds) await insertCustomField(db, user.id, id, 'bool');
    const sevenStrategyId = await insertRawStrategyWithFieldSnapshot(db, user.id, 'Seven-field strategy', sevenIds);

    const list = await fetchStrategiesForUser(user.id);
    const fiveRow = list.find((s) => s.strategyId === fiveStrategyId);
    const sevenRow = list.find((s) => s.strategyId === sevenStrategyId);
    expect(fiveRow).toBeDefined();
    expect(sevenRow).toBeDefined();

    // The actual cast-fix assertion: a raw bigint count(*) round-trips
    // through `pg` as a STRING ("5"/"7"), which would fail a strict
    // typeof check even though loose `toBe(5)` often still passes in JS.
    expect(typeof fiveRow!.capturedFieldCount).toBe('number');
    expect(typeof sevenRow!.capturedFieldCount).toBe('number');

    expect(fiveRow!.capturedFieldCount).toBe(5);
    expect(sevenRow!.capturedFieldCount).toBe(7);

    // The comparison itself genuinely fires correctly at each row of
    // §4.8's table -- not merely "the query returns without erroring."
    expect(fieldCapWarningMessage(fiveRow!.capturedFieldCount)).toBe(
      'Each field needs about 20 trades before it tells you anything. You have 5.',
    );
    expect(fieldCapWarningMessage(sevenRow!.capturedFieldCount)).toBe(
      "That's a lot to fill in before every trade. Consider which of these you'd actually change your mind over.",
    );
  }, 20_000);

  it('the exact 4 -> 5 and 6 -> 7 boundary crossings fire correctly end to end against the real query', async () => {
    const { fetchStrategiesForUser } = await import('../strategy-repository');
    const { fieldCapWarningMessage } = await import('../strategy-validation');

    const fourIds = Array.from({ length: 4 }, (_, i) => `cf.adv.four-${i}`);
    for (const id of fourIds) await insertCustomField(db, user.id, id, 'bool');
    const fourStrategyId = await insertRawStrategyWithFieldSnapshot(db, user.id, 'Four-field strategy', fourIds);

    const sixIds = Array.from({ length: 6 }, (_, i) => `cf.adv.six-${i}`);
    for (const id of sixIds) await insertCustomField(db, user.id, id, 'bool');
    const sixStrategyId = await insertRawStrategyWithFieldSnapshot(db, user.id, 'Six-field strategy', sixIds);

    const list = await fetchStrategiesForUser(user.id);
    const fourRow = list.find((s) => s.strategyId === fourStrategyId);
    const sixRow = list.find((s) => s.strategyId === sixStrategyId);

    expect(fourRow!.capturedFieldCount).toBe(4);
    expect(fieldCapWarningMessage(fourRow!.capturedFieldCount)).toBeNull(); // <=4 -- no message, per §4.8's table

    expect(sixRow!.capturedFieldCount).toBe(6);
    expect(fieldCapWarningMessage(sixRow!.capturedFieldCount)).toBe(
      'Each field needs about 20 trades before it tells you anything. You have 6.',
    );
  }, 15_000);
});

/**
 * Cross-user isolation on the NEW join `fetchStrategiesForUser`'s own
 * subquery introduces — a genuinely different threat model from the
 * create/edit RLS coverage `strategy-repository.live.test.ts` already
 * has, since `retrospeq.fields`' real primary key is `(user_id, id)`
 * (`20260902010000_field_registry_schema.sql`), NOT a globally unique
 * `id` alone. Two different users can legitimately own a field row with
 * the exact same `id` string. If the join's `f.user_id = s.user_id`
 * condition were ever dropped or RLS ever stopped enforcing
 * `fields_owner_select`, one user's `capturedFieldCount` could silently
 * be computed against ANOTHER user's field row of the same id.
 */
describe.skipIf(!env)('§4.8 field-cap warning — cross-user field-id collision (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fieldcap-collision-a');
    userB = await createTestAuthUser(env, 'fieldcap-collision-b');
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

  it("user A's captured-field count for a field id also owned by user B reflects ONLY A's own field row (kind/data_type), never B's", async () => {
    const { fetchStrategiesForUser } = await import('../strategy-repository');

    const sharedId = `collide.field-${Date.now()}`;

    // User A's own field at this id: kind='account', data_type='rating' --
    // a REAL captured field, should count toward A's own warning.
    await insertCustomField(db, userA.id, sharedId, 'rating', { min: 1, max: 5 });

    // User B's own field at the SAME id string: data_type='note' -- free
    // per §4.8, should NOT count. If the join ever cross-matched onto B's
    // row instead of A's, A's strategy would incorrectly read 0 captured
    // fields instead of 1.
    await insertCustomField(db, userB.id, sharedId, 'note');

    const strategyId = await insertRawStrategyWithFieldSnapshot(db, userA.id, "A's strategy referencing the shared id", [sharedId]);

    const listA = await fetchStrategiesForUser(userA.id);
    const rowA = listA.find((s) => s.strategyId === strategyId);
    expect(rowA).toBeDefined();
    expect(rowA!.fieldCount).toBe(1);
    // Must reflect A's OWN field (rating, captured) -- 1, not B's (note, free) -- 0.
    expect(rowA!.capturedFieldCount).toBe(1);

    // And the reverse check: user B's own strategy list must never surface
    // A's field data at all -- B owns no strategy referencing this id, so
    // B's list is simply unaffected; the real assertion is that A's
    // fetchStrategiesForUser call, run under A's own RLS session
    // (`withUserConnection(userA.id, ...)`), could not have read B's field
    // row to begin with.
    const listB = await fetchStrategiesForUser(userB.id);
    expect(listB.find((s) => s.strategyId === strategyId)).toBeUndefined();
  }, 15_000);

  it("a direct RLS probe: user A's own session cannot select user B's field row at the same id, even via a raw query under A's RLS context", async () => {
    const sharedId = `collide.rls-probe-${Date.now()}`;
    await insertCustomField(db, userB.id, sharedId, 'note');

    const { withUserConnection } = await import('@/lib/supabase/direct');
    const rows = await withUserConnection(userA.id, async (client) => {
      const res = await client.query('select id from retrospeq.fields where id = $1', [sharedId]);
      return res.rows;
    });
    // User A's own field with this id does not exist -- RLS scoped to
    // auth.uid() = A must return zero rows, never B's row, regardless of
    // the query's own WHERE clause naming only `id`.
    expect(rows).toHaveLength(0);
  }, 15_000);
});
