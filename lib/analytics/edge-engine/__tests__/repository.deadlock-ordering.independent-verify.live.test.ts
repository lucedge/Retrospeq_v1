import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { connectAsOwner, createTestAuthUser, deleteTestAuthUser, readRlsTestEnv, type EnvBundle, type TestAuthUser } from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

vi.setConfig({ testTimeout: 30_000 });

import { writeFindingsForStrategy } from '../repository';
import type { SegmentComputationResult } from '../gates';

/**
 * INDEPENDENT VERIFICATION (live DB) — security-reviewer finding, 2026-09-09:
 * `writeFindingsForStrategy`'s per-segment advisory-lock loop iterated over
 * whatever order its caller's `results` array happened to list segments in
 * (no `ORDER BY` upstream in `fetchStrategyFieldSpecs`), the exact
 * "single call touches multiple lock keys in caller-supplied order" shape
 * `lib/fields/strategy-repository.ts`'s `rebuildFieldUsagesForStrategy`
 * already solved (its own "DEADLOCK AVOIDANCE" comment) by sorting ids into
 * one consistent order before acquiring any locks. `repository.ts`'s
 * `writeFindingsForStrategy` now does the same: sorts `results` by
 * `fieldId + JSON.stringify(segment)` before its write loop.
 *
 * This test does NOT rely on timing luck / probability to exercise the
 * dangerous interleaving (two concurrent calls to the SAME strategy with
 * the SAME two tuples supplied in OPPOSITE array order — the shape that
 * would deadlock an unsorted implementation: call 1 holds tuple Z's lock
 * wanting A's, call 2 holds A's wanting Z's). Instead it deterministically
 * FORCES the exact moment of contention via a manually-held advisory lock
 * on tuple A (this test's own "blocker" connection, matching this repo's
 * own established `pg_advisory_xact_lock`-probe convention — see
 * `repository.concurrency.independent-verify.live.test.ts`), then directly
 * inspects `pg_locks` (not just the absence of a `40P01` error) to CONFIRM
 * both concurrently-launched real calls attempt tuple A's lock FIRST —
 * genuinely proving the sort took effect, regardless of which order each
 * call's own `results` array listed the two tuples in — rather than merely
 * inferring it from the calls not deadlocking.
 */

const env = readRlsTestEnv();

const TRUE_SEGMENT = { op: 'eq' as const, value: true };

/** Byte-for-byte the SAME formula `writeFindingsForStrategy` uses
 *  (`repository.ts`) — duplicated deliberately (not imported), matching
 *  this repo's own `lockKeyForTuple` convention in the sibling
 *  `repository.concurrency.independent-verify.live.test.ts`, so this test
 *  proves the real production key format rather than a stand-in. */
function lockKeyForTuple(userId: string, strategyId: string, fieldId: string, segment: unknown): string {
  return `findings:${userId}:${strategyId}:${fieldId}:${JSON.stringify(segment)}`;
}

function makeResult(fieldId: string, n: number, winRate: number): SegmentComputationResult {
  return {
    fieldId,
    analyticId: 'find.toggle',
    segment: TRUE_SEGMENT,
    n,
    winRate,
    avgR: 0.5,
    baselineN: n,
    baselineWinRate: 0.4,
    baselineAvgR: 0.4,
    deltaWinRate: winRate - 0.4,
    deltaAvgR: 0.1,
    pValue: 0.01,
    pAdjusted: 0.01,
    confidence: 'provisional',
    gateFailures: [],
  };
}

/** Takes a SESSION-level advisory lock for `key` on a fresh connection and
 *  reads back its own `pg_locks` (classid, objid) fingerprint — the two
 *  columns that jointly identify WHICH 64-bit advisory key a given
 *  `pg_locks` row (granted or waiting) refers to, without needing to
 *  reverse-engineer Postgres's own internal high/low-32-bit encoding by
 *  hand: whatever this connection's own single held lock's (classid,
 *  objid) turns out to be, unambiguously IS `hashtext(key)`'s encoding,
 *  observed directly rather than computed by inference. Session-level
 *  (`pg_advisory_lock`, not `..._xact_lock`) so it survives until this
 *  helper explicitly unlocks it, independent of any transaction. */
async function fingerprintLockKey(dbUrl: string, key: string): Promise<{ classid: string; objid: string }> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    await c.query('select pg_advisory_lock(hashtext($1::text))', [key]);
    const res = await c.query<{ classid: string; objid: string }>(
      `select classid::text, objid::text from pg_locks where pid = pg_backend_pid() and locktype = 'advisory' and granted = true`,
    );
    if (res.rows.length !== 1) throw new Error(`fingerprintLockKey: expected exactly 1 held advisory lock row, got ${res.rows.length}`);
    return res.rows[0];
  } finally {
    await c.query('select pg_advisory_unlock_all()').catch(() => {});
    await c.end();
  }
}

async function waitForBlockedPids(watchdog: Client, count: number, timeoutMs = 5000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await watchdog.query<{ pid: number }>(
      `select pid from pg_stat_activity where query ilike '%pg_advisory_xact_lock%' and wait_event_type = 'Lock'`,
    );
    if (res.rows.length >= count) return res.rows.map((r) => r.pid);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`waitForBlockedPids: never observed ${count} pids blocked on pg_advisory_xact_lock within ${timeoutMs}ms.`);
}

describe.skipIf(!env)('writeFindingsForStrategy — deadlock-ordering fix (sorted lock acquisition), independent verification (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  let user: TestAuthUser;
  let strategyId: string;
  const fieldA = 'aaa_deadlock_field'; // sorts BEFORE fieldZ, both by plain string compare and by the production sort key.
  const fieldZ = 'zzz_deadlock_field';

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'edge-engine-deadlock-order-iv');

    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Deadlock Ordering Probe Strategy', 1, false, 'active') returning id`,
      [user.id],
    );
    strategyId = strategyRes.rows[0].id;
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, 'Deadlock field A', 'strategy_var', 'bool', 'captured', $3, '{}'::jsonb),
              ($4, $2, 'Deadlock field Z', 'strategy_var', 'bool', 'captured', $3, '{}'::jsonb)`,
      [fieldA, user.id, strategyId, fieldZ],
    );

    // Seed one active row per tuple via the real function, so the real
    // race below exercises a genuine supersession, not just a first-ever
    // insert.
    await writeFindingsForStrategy(user.id, strategyId, [makeResult(fieldA, 25, 0.84), makeResult(fieldZ, 25, 0.84)]);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.findings where user_id = $1', [user.id]);
    await db.query('delete from retrospeq.strategies where user_id = $1', [user.id]);
    await db.query(`delete from retrospeq.fields where user_id = $1 and kind <> 'derived'`, [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(envBundle, user.id).catch(() => {});
    await db.end();
  });

  it(
    'two concurrent real calls, given the SAME two tuples in OPPOSITE array order, both attempt the sorted-first tuple (A) as their FIRST lock — never the opposite-order interleaving that would deadlock — and both resolve cleanly',
    async () => {
      if (!env) return;

      const lockKeyA = lockKeyForTuple(user.id, strategyId, fieldA, TRUE_SEGMENT);
      const lockKeyZ = lockKeyForTuple(user.id, strategyId, fieldZ, TRUE_SEGMENT);

      // ---- Fingerprint each key's (classid, objid) pg_locks encoding up front, from real
      // held locks, not by hand-deriving Postgres's internal hi/lo-32-bit split. ----
      const fpA = await fingerprintLockKey(envBundle.SUPABASE_DB_URL, lockKeyA);
      const fpZ = await fingerprintLockKey(envBundle.SUPABASE_DB_URL, lockKeyZ);
      // Sanity: this test's own premise (that A and Z resolve to distinguishable
      // pg_locks rows) requires no hashtext collision between them.
      expect(`${fpA.classid}:${fpA.objid}`).not.toBe(`${fpZ.classid}:${fpZ.objid}`);

      // ---- Blocker: manually hold tuple A's advisory lock (the sorted-first key),
      // deterministically forcing whatever comes next to genuinely contend for A. ----
      const blockerConn = new Client({ connectionString: envBundle.SUPABASE_DB_URL });
      await blockerConn.connect();

      try {
        await blockerConn.query('select pg_advisory_lock(hashtext($1::text))', [lockKeyA]);

        // ---- Launch BOTH real calls concurrently, with the SAME two tuples supplied in
        // OPPOSITE array order — exactly the input shape that would let an unsorted
        // implementation acquire locks in opposite relative sequence. ----
        const callZThenA = writeFindingsForStrategy(user.id, strategyId, [makeResult(fieldZ, 40, 0.9), makeResult(fieldA, 41, 0.91)]);
        const callAThenZ = writeFindingsForStrategy(user.id, strategyId, [makeResult(fieldA, 42, 0.92), makeResult(fieldZ, 43, 0.93)]);

        // ---- Both calls must genuinely block — confirmed via pg_stat_activity, not a timing
        // guess — since blockerConn holds A and (per the fix) BOTH calls attempt A first,
        // regardless of each call's own array order. ----
        const blockedPids = await waitForBlockedPids(db, 2);
        expect(blockedPids).toHaveLength(2);

        // ---- Direct pg_locks inspection: confirm EVERY blocked pid's WAITING lock request
        // is for tuple A's fingerprint specifically — never Z's. If the sort weren't applied,
        // whichever call listed Z first would instead be seen blocked (or worse, holding a
        // GRANTED lock) on Z's fingerprint at this point, not A's. ----
        const waitingRows = await db.query<{ pid: number; classid: string; objid: string }>(
          `select pid, classid::text, objid::text from pg_locks
            where locktype = 'advisory' and granted = false and pid = any($1::int[])`,
          [blockedPids],
        );
        expect(waitingRows.rows).toHaveLength(2);
        for (const row of waitingRows.rows) {
          expect(`${row.classid}:${row.objid}`).toBe(`${fpA.classid}:${fpA.objid}`);
        }

        // ---- Also confirm neither blocked pid holds a GRANTED lock on Z yet — proving Z's
        // tuple genuinely has not been touched by either call before A's write completes,
        // the actual deadlock-avoidance property (not merely "no lock currently waiting on Z"). ----
        const grantedZRows = await db.query<{ pid: number }>(
          `select pid from pg_locks
            where locktype = 'advisory' and granted = true and pid = any($1::int[])
              and classid::text = $2 and objid::text = $3`,
          [blockedPids, fpZ.classid, fpZ.objid],
        );
        expect(grantedZRows.rows).toHaveLength(0);

        // ---- Release the blocker — both real calls now genuinely race for A (one wins,
        // commits, releases; the other's blocked statement then proceeds against a fresh
        // post-commit snapshot). Both must resolve without throwing — no 40P01 deadlock. ----
        await blockerConn.query('select pg_advisory_unlock_all()');

        await expect(Promise.all([callZThenA, callAThenZ])).resolves.toBeDefined();
      } finally {
        await blockerConn.query('select pg_advisory_unlock_all()').catch(() => {});
        await blockerConn.end();
      }

      // ---- Final state: exactly one active row per tuple, no orphaned/duplicated rows,
      // confirming the writes themselves landed correctly on top of the forced contention. ----
      for (const fieldId of [fieldA, fieldZ]) {
        const rows = await db.query<{ state: string }>(
          `select state from retrospeq.findings where user_id = $1 and field_id = $2 and segment = $3::jsonb`,
          [user.id, fieldId, JSON.stringify(TRUE_SEGMENT)],
        );
        expect(rows.rows.filter((r) => r.state === 'active')).toHaveLength(1);
      }
    },
    30_000,
  );
});
