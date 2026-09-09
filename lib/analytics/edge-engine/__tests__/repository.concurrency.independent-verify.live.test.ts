import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { connectAsOwner, createTestAuthUser, deleteTestAuthUser, readRlsTestEnv, type EnvBundle, type TestAuthUser } from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

vi.setConfig({ testTimeout: 30_000 });

import { writeFindingsForStrategy } from '../repository';
import type { SegmentComputationResult } from '../gates';

/**
 * INDEPENDENT VERIFICATION (live DB) — Module 05 (Analytics & Findings),
 * concurrency fix for `findings` supersession
 * (docs/adr/0024-findings-supersession-write-semantics.md's Consequences
 * section, `writeFindingsForStrategy`'s own header in `repository.ts`).
 *
 * This is the PERMANENT, rerunnable form of the ad-hoc scratch probe an
 * earlier tester dispatch wrote (`tmp/edge-engine-concurrency-probe.mjs`,
 * confirmed live via genuine `pg_stat_activity` lock-wait polling — NOT a
 * timing guess) that found two genuinely concurrent
 * `writeFindingsForStrategy`-shaped writes for the SAME
 * `(user_id, strategy_id, field_id, segment)` tuple could both commit a
 * fresh `active` row. Matches this repo's own established
 * `*.independent-verify.live.test.ts` convention for exactly this class of
 * finding (see `lib/fields/__tests__/fields-repository.promotion.
 * independent-verify.live.test.ts`, `lib/rules/__tests__/
 * severity-lifecycle.independent-verification.live.test.ts`) —
 * deterministic via a manually-held advisory lock forcing genuine overlap,
 * confirmed via `pg_stat_activity`, not relying on `Promise.all` scheduling
 * luck.
 *
 * Scenario: a pre-existing SEED `active` finding exists for
 * `segment={op:'eq',value:true}`. A "race connection" manually acquires the
 * EXACT SAME `pg_advisory_xact_lock(hashtext(...))` key
 * `writeFindingsForStrategy` computes for that tuple (see this test's own
 * `lockKeyForTuple` helper, kept byte-for-byte in sync with the production
 * formula) and holds it open — deterministically forcing whatever comes
 * next to genuinely contend for the SAME lock, not merely resemble
 * contention. While holding the lock, the race connection performs a REAL
 * competing write for the SAME tuple using the identical three-statement
 * sequence `writeFindingsForStrategy` itself now uses (copied verbatim,
 * matching this repo's own "copy the real SQL, don't approximate it"
 * convention for these probes). Only THEN does it commit (releasing the
 * lock), at which point the REAL, already-blocked `writeFindingsForStrategy`
 * call proceeds and must correctly supersede the race connection's own
 * freshly-committed row — never conflict, never silently duplicate.
 */

const env = readRlsTestEnv();

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

/** Byte-for-byte the SAME formula `writeFindingsForStrategy` uses
 *  (`repository.ts`) — deliberately duplicated here (not imported) so this
 *  test proves the REAL production key format, not a stand-in; if the two
 *  ever drift apart, this test's own deterministic blocking assertion
 *  (`waitForBlockedQuery`) would fail loudly, not silently pass. */
function lockKeyForTuple(userId: string, strategyId: string, fieldId: string, segment: unknown): string {
  return `findings:${userId}:${strategyId}:${fieldId}:${JSON.stringify(segment)}`;
}

const TRUE_SEGMENT = { op: 'eq' as const, value: true };
const FALSE_SEGMENT = { op: 'eq' as const, value: false };

function makeResult(fieldId: string, segment: { op: 'eq'; value: boolean }, n: number, winRate: number): SegmentComputationResult {
  return {
    fieldId,
    analyticId: 'find.toggle',
    segment,
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

describe.skipIf(!env)('writeFindingsForStrategy — GENUINE concurrency probe: two concurrent writers for the SAME tuple (live DB, independent verification)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  let user: TestAuthUser;
  let strategyId: string;
  const fieldId = 'race_flag';

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'edge-engine-concurrency-iv');

    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Concurrency Probe Strategy', 1, false, 'active') returning id`,
      [user.id],
    );
    strategyId = strategyRes.rows[0].id;
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, 'Race flag', 'strategy_var', 'bool', 'captured', $3, '{}'::jsonb)`,
      [fieldId, user.id, strategyId],
    );
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
    'FIXED: a race-connection writer holding the advisory lock, racing the REAL writeFindingsForStrategy, resolves to exactly one active row per segment with a correct supersession chain — never two simultaneously active',
    async () => {
      if (!env) return;

      // ---- SEED: one pre-existing active finding per segment, via the REAL function. ----
      await writeFindingsForStrategy(user.id, strategyId, [makeResult(fieldId, TRUE_SEGMENT, 25, 0.84), makeResult(fieldId, FALSE_SEGMENT, 25, 0.16)]);

      const seedRes = await db.query<{ id: string; segment: { value: boolean } }>(
        `select id, segment from retrospeq.findings where user_id = $1 and field_id = $2 and state = 'active'`,
        [user.id, fieldId],
      );
      expect(seedRes.rows).toHaveLength(2);
      const seedTrueId = seedRes.rows.find((r) => r.segment.value === true)!.id;

      // ---- Race connection: acquire the EXACT lock key production code uses for the TRUE tuple, and hold it. ----
      const raceConn = new Client({ connectionString: envBundle.SUPABASE_DB_URL });
      await raceConn.connect();

      try {
        await raceConn.query('begin');
        await raceConn.query('set local role service_role');
        const lockKey = lockKeyForTuple(user.id, strategyId, fieldId, TRUE_SEGMENT);
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [lockKey]);

        // ---- Kick off the REAL writeFindingsForStrategy call — its own FIRST statement for the
        // true-segment tuple is the identical pg_advisory_xact_lock acquisition, so it MUST
        // genuinely block on raceConn's held lock, deterministically (not a timing guess). ----
        const realCallPromise = writeFindingsForStrategy(user.id, strategyId, [
          makeResult(fieldId, TRUE_SEGMENT, 40, 0.9),
          makeResult(fieldId, FALSE_SEGMENT, 40, 0.1),
        ]);

        await waitForBlockedQuery(db, '%select pg_advisory_xact_lock%');

        // ---- While the real call is genuinely blocked, raceConn performs its OWN competing
        // write for the SAME true-segment tuple, using the identical three-statement sequence
        // `writeFindingsForStrategy` itself uses (repository.ts) — a real second writer
        // completing its work while holding the lock, the realistic shape of the race. ----
        const raceSuperseded = await raceConn.query<{ id: string }>(
          `update retrospeq.findings
              set state = 'superseded'
            where user_id = $1 and strategy_id = $2 and field_id = $3 and segment = $4::jsonb and state = 'active'
            returning id`,
          [user.id, strategyId, fieldId, JSON.stringify(TRUE_SEGMENT)],
        );
        expect(raceSuperseded.rows).toHaveLength(1);
        expect(raceSuperseded.rows[0].id).toBe(seedTrueId);

        const raceInserted = await raceConn.query<{ id: string }>(
          `insert into retrospeq.findings
             (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
              baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
              p_value, p_adjusted, confidence, gate_failures, state)
           values ($1,'find.toggle',$2,$3,$4::jsonb,30,'0.8000','0.5000',30,'0.4000','0.4000','0.4000','0.1000','0.0100','0.0100','provisional','{}'::text[],'active')
           returning id`,
          [user.id, strategyId, fieldId, JSON.stringify(TRUE_SEGMENT)],
        );
        const raceNewId = raceInserted.rows[0].id;
        await raceConn.query(`update retrospeq.findings set superseded_by = $1 where id = $2`, [raceNewId, seedTrueId]);

        // ---- Commit the race connection — releases the advisory lock, and the SEED row's
        // successor (raceNewId) is now the committed active row for the true-segment tuple. ----
        await raceConn.query('commit');

        // ---- The real call, having genuinely blocked, now proceeds against the post-race
        // committed state and must resolve cleanly — never throw, never duplicate. ----
        await expect(realCallPromise).resolves.toBeUndefined();
      } finally {
        await raceConn.end();
      }

      // ---- Final state: exactly one active row per segment; the true-segment tuple has a
      // three-row supersession chain (SEED -> race-connection's row -> the real call's row). ----
      const allTrue = await db.query<{ id: string; state: string; superseded_by: string | null; n: number }>(
        `select id, state, superseded_by, n from retrospeq.findings
          where user_id = $1 and field_id = $2 and segment = $3::jsonb
          order by computed_at asc`,
        [user.id, fieldId, JSON.stringify(TRUE_SEGMENT)],
      );
      expect(allTrue.rows).toHaveLength(3);
      const activeTrue = allTrue.rows.filter((r) => r.state === 'active');
      expect(activeTrue).toHaveLength(1);
      const seedRow = allTrue.rows.find((r) => r.id === seedTrueId)!;
      expect(seedRow.state).toBe('superseded');
      const raceRow = allTrue.rows.find((r) => r.id === seedRow.superseded_by)!;
      expect(raceRow).toBeDefined();
      expect(raceRow.state).toBe('superseded');
      const finalActiveRow = allTrue.rows.find((r) => r.id === raceRow.superseded_by)!;
      expect(finalActiveRow).toBeDefined();
      expect(finalActiveRow.state).toBe('active');
      expect(finalActiveRow.n).toBe(40); // the real call's own n=40 for the true segment.

      const allFalse = await db.query<{ state: string }>(
        `select state from retrospeq.findings where user_id = $1 and field_id = $2 and segment = $3::jsonb`,
        [user.id, fieldId, JSON.stringify(FALSE_SEGMENT)],
      );
      // No race connection contention on the FALSE tuple — a normal two-run supersession
      // (SEED, then the real call's own second write), never duplicated.
      expect(allFalse.rows).toHaveLength(2);
      expect(allFalse.rows.filter((r) => r.state === 'active')).toHaveLength(1);
    },
    30_000,
  );
});
