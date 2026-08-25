import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

// Hoisted to file scope deliberately (not inside the nested `describe`
// below) — Vitest's `vi.mock` hoisting transform handles nested calls too,
// but every OTHER live test file in this repo declares its Server-Action
// mocks at file scope (see `confirm-day-action.live.test.ts`), so this
// matches that established convention rather than relying on the nested
// case.
const { getUserMock, createClientMock, getClientIpMock, enforceRateLimitMock, revalidatePathMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  revalidatePathMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/rate-limit/http', () => ({ getClientIp: getClientIpMock }));
vi.mock('@/lib/rate-limit/limiter', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));

function sessionAs(userId: string, email: string) {
  createClientMock.mockResolvedValue({
    auth: { getUser: getUserMock.mockResolvedValue({ data: { user: { id: userId, email } }, error: null }) },
  });
}

/**
 * Module 04 (Rulebook & Evaluation) §5.7 — INDEPENDENT tester verification
 * pass over Slice 7 (severity lifecycle), dispatched specifically to
 * re-derive the coder's own concurrency claims rather than trust them.
 *
 * Two things this file exists to check that `severity-lifecycle.live.test.ts`
 * (the coder's own live suite) does NOT:
 *
 * 1. The coder's "atomic hard-cap enforcement, proven live" claim used only
 *    a SEQUENTIAL deterministic-replay technique (promote once for real,
 *    then promote again against the now-stale row) — that proves the
 *    guard rejects a SECOND call against the SAME already-promoted row. It
 *    does NOT exercise the actual concurrency hazard §8.2 names: two
 *    DIFFERENT soft rules promoted at the same moment, each satisfying the
 *    correlated subquery's `< $3` check against the SAME pre-commit
 *    snapshot. This file constructs that scenario with two real,
 *    independently-controlled connections.
 *
 * 2. `demoteRuleSeverity`/`retireRuleState` had NO genuine two-connection
 *    concurrency test at all in the coder's own suite (only single-caller
 *    sequential tests). Unlike the hard-cap case, these two are single-row
 *    guarded UPDATEs with no cross-row correlated subquery, so the SAME
 *    row IS the lock boundary — this file proves that boundary genuinely
 *    serializes two real concurrent callers, using the `waitForBlockedQuery`
 *    technique already established by `rules-repository.live.test.ts` /
 *    `lib/ingestion/__tests__/split-join.live.test.ts`.
 *
 * RESULT (test 1 below): a REAL, REPRODUCIBLE bug, originally found here.
 * Postgres's UPDATE ... WHERE (correlated subquery) does NOT lock the rows
 * the subquery scans — only the row being written. Under READ COMMITTED
 * (this pool's default, unchanged anywhere in this codebase), two
 * concurrent transactions targeting two DIFFERENT rows each take their own
 * per-statement snapshot; neither sees the other's still-uncommitted
 * write, so both subqueries read the same pre-race count and both pass
 * `< 6`. A user at exactly 5 active hard rules who fires two concurrent
 * promotions (two different soft rules) could land at 7, violating §8.2's
 * own named invariant ("Hard rule count never exceeds 6") and Module 04
 * §2.3 ("Cap 6").
 *
 * FIX (2026-08-25, coder pass following this finding):
 * `promoteRuleSeverity` (`lib/rules/severity-lifecycle-repository.ts`) now
 * takes `pg_advisory_xact_lock(hashtext(user_id))` as the first statement
 * in its transaction, before the guarded UPDATE runs — this forces a
 * second concurrent promotion for the SAME user to block until the first
 * transaction commits, at which point its own correlated subquery
 * correctly observes the just-committed count. This test was originally
 * written with `it.fails` deliberately (not `it.skip`) as a trip wire —
 * now that the fix makes the invariant genuinely hold, it has been
 * converted to a normal `it(...)` asserting the invariant directly, per
 * that trip wire's own documented purpose.
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

describe.skipIf(!env)('Module 04 Slice 7 — INDEPENDENT concurrency verification (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 30_000);

  afterEach(async () => {
    if (!env) return;
    for (const userId of cleanupUserIds.splice(0)) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedGlobalRule(
    userId: string,
    createdAt: Date,
    overrides: { severity?: 'soft' | 'hard'; state?: 'active' | 'retired' } = {},
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state, created_at)
       values ($1, 1, 'global', $2, 'authored', 'pre_entry', $3, $4::timestamptz)
       returning id`,
      [userId, overrides.severity ?? 'soft', overrides.state ?? 'active', createdAt.toISOString()],
    );
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered, created_at)
       values ($1, 1, $2, 'risk_pct', 'lte', '2'::jsonb, 'test rule', $3::timestamptz)`,
      [ruleRes.rows[0].id, userId, createdAt.toISOString()],
    );
    return ruleRes.rows[0].id;
  }

  /** Mimics `withUserConnection`'s exact role/claims setup so this file's
   *  raw connections are genuinely RLS-scoped the same way the real
   *  repository functions are — not a shortcut around it. */
  async function beginAsAuthenticated(conn: Client, userId: string): Promise<void> {
    await conn.query('begin');
    await conn.query('set local role authenticated');
    await conn.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
  }

  const PROMOTE_SQL = `
    update retrospeq.rules
       set severity = 'hard', promoted_at = now()
     where id = $1
       and user_id = $2
       and severity = 'soft'
       and state = 'active'
       and (
         select count(*)
           from retrospeq.rules r2
          where r2.user_id = $2
            and r2.state = 'active'
            and r2.severity = 'hard'
       ) < $3
     returning promoted_at::text as promoted_at`;

  it(
    'FIXED: two GENUINE concurrent promotions for two DIFFERENT soft rules, same user at exactly 5 active hard rules — pg_advisory_xact_lock(hashtext(user_id)) genuinely serializes the two real promoteRuleSeverity calls, so the second one blocks until the first commits and then correctly loses against the post-commit count; the invariant (hard count never exceeds 6) holds, never both succeeding',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'severity-hardcap-race-fixed');
      cleanupUserIds.push(user.id);
      const oldEnough = new Date('2026-01-01T00:00:00Z');

      for (let i = 0; i < 5; i++) {
        await seedGlobalRule(user.id, oldEnough, { severity: 'hard' });
      }
      const ruleA = await seedGlobalRule(user.id, oldEnough, { severity: 'soft' });
      const ruleB = await seedGlobalRule(user.id, oldEnough, { severity: 'soft' });

      const raceConn = new Client({ connectionString: envBundle.SUPABASE_DB_URL });
      await raceConn.connect();

      try {
        // raceConn deliberately reproduces the EXACT interleaving that
        // used to break the invariant: it holds the advisory lock keyed
        // on `user.id` (the same `pg_advisory_xact_lock(hashtext(...))`
        // call `promoteRuleSeverity` now issues as its own first
        // statement) plus an uncommitted promotion of `ruleA`, forcing
        // the real `promoteRuleSeverity(user.id, ruleB, ...)` call below
        // to genuinely contend for the same lock — not a sequential
        // replay, a real second connection racing a real first one.
        await beginAsAuthenticated(raceConn, user.id);
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [user.id]);
        await raceConn.query(PROMOTE_SQL, [ruleA, user.id, 6]);

        const { promoteRuleSeverity, RuleLifecycleConflictError } = await import('../severity-lifecycle-repository');
        const promotePromise = promoteRuleSeverity(user.id, ruleB, 6);

        // Confirm the real call is genuinely BLOCKED on Postgres's own
        // lock queue (not merely slow) before releasing raceConn --
        // this is what makes the test deterministic rather than
        // timing-luck: without this wait, there would be no proof the
        // two calls ever actually overlapped.
        await waitForBlockedQuery(db, '%select pg_advisory_xact_lock%');

        // Release the race connection's promotion for real -- it lands
        // the user at exactly 6 active hard rules, committed.
        await raceConn.query('commit');

        // The real call, having genuinely blocked on the advisory lock
        // and only now proceeding, evaluates its own correlated
        // count(*) subquery against the COMMITTED post-race count (6)
        // and correctly loses -- rowCount 0, the same named conflict
        // error every other lost-race path in this file uses, never a
        // silent no-op and never a second success.
        await expect(promotePromise).rejects.toBeInstanceOf(RuleLifecycleConflictError);

        const finalCount = await db.query<{ c: string }>(
          `select count(*)::text as c from retrospeq.rules where user_id = $1 and state = 'active' and severity = 'hard'`,
          [user.id],
        );
        // Exactly 6, not merely "<= 6" -- ruleA's promotion (the race
        // connection's own committed write) is the one real success;
        // ruleB never got written at all.
        expect(Number(finalCount.rows[0].c)).toBe(6);

        const ruleBRow = await db.query<{ severity: string; promoted_at: string | null }>(
          `select severity, promoted_at::text as promoted_at from retrospeq.rules where id = $1`,
          [ruleB],
        );
        expect(ruleBRow.rows[0].severity).toBe('soft');
        expect(ruleBRow.rows[0].promoted_at).toBeNull();
      } finally {
        await raceConn.end();
      }
    },
    30_000,
  );

  it(
    'demoteRuleSeverity: two GENUINE concurrent connections targeting the SAME hard rule — the row lock (not the subquery pattern above) correctly serializes them; exactly one succeeds, the other gets rowCount 0, never both, never a crash',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'severity-demote-race');
      cleanupUserIds.push(user.id);
      const oldEnough = new Date('2026-01-01T00:00:00Z');
      const ruleId = await seedGlobalRule(user.id, oldEnough, { severity: 'hard' });

      const raceConn = new Client({ connectionString: envBundle.SUPABASE_DB_URL });
      await raceConn.connect();
      const DEMOTE_SQL = `
        update retrospeq.rules
           set severity = 'soft'
         where id = $1 and user_id = $2 and severity = 'hard' and state = 'active'`;

      try {
        // raceConn holds an UNCOMMITTED demote on the row, deliberately
        // not yet committed, so the real `demoteRuleSeverity` call below
        // is forced to genuinely block on Postgres's own row lock.
        await beginAsAuthenticated(raceConn, user.id);
        await raceConn.query(DEMOTE_SQL, [ruleId, user.id]);

        const { demoteRuleSeverity, RuleLifecycleConflictError } = await import('../severity-lifecycle-repository');
        const demotePromise = demoteRuleSeverity(user.id, ruleId);

        await waitForBlockedQuery(db, "%update retrospeq.rules%set severity = 'soft'%");

        // Release the race connection's write for real.
        await raceConn.query('commit');

        // The real call, having been genuinely blocked on the row lock,
        // now re-evaluates against the COMMITTED post-race row (severity
        // already 'soft') and correctly loses — rowCount 0, a named
        // conflict error, never a silent no-op, never a crash, never a
        // double-demote.
        await expect(demotePromise).rejects.toBeInstanceOf(RuleLifecycleConflictError);

        const finalRow = await db.query(`select severity from retrospeq.rules where id = $1`, [ruleId]);
        expect(finalRow.rows[0].severity).toBe('soft'); // demoted exactly once, by the race connection
      } finally {
        await raceConn.end();
      }
    },
    30_000,
  );

  it(
    'retireRuleState: two GENUINE concurrent connections retiring the SAME rule — one wins (row lock serializes), the other gets a clean RuleLifecycleConflictError (RULE_RETIRE_CONFLICT), not a crash and not a second retired_at write',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'severity-retire-race');
      cleanupUserIds.push(user.id);
      const oldEnough = new Date('2026-01-01T00:00:00Z');
      const ruleId = await seedGlobalRule(user.id, oldEnough, { severity: 'soft' });

      const raceConn = new Client({ connectionString: envBundle.SUPABASE_DB_URL });
      await raceConn.connect();
      const RETIRE_SQL = `
        update retrospeq.rules
           set state = 'retired', retired_at = now()
         where id = $1 and user_id = $2 and state = 'active'
         returning retired_at::text as retired_at`;

      try {
        await beginAsAuthenticated(raceConn, user.id);
        const raceResult = await raceConn.query<{ retired_at: string }>(RETIRE_SQL, [ruleId, user.id]);
        const raceRetiredAt = raceResult.rows[0].retired_at;

        const { retireRuleState, RuleLifecycleConflictError } = await import('../severity-lifecycle-repository');
        const retirePromise = retireRuleState(user.id, ruleId);

        await waitForBlockedQuery(db, "%update retrospeq.rules%set state = 'retired'%");

        await raceConn.query('commit');

        await expect(retirePromise).rejects.toBeInstanceOf(RuleLifecycleConflictError);

        const finalRow = await db.query(`select state, retired_at::text as retired_at from retrospeq.rules where id = $1`, [ruleId]);
        expect(finalRow.rows[0].state).toBe('retired');
        // The SAME retired_at the race connection wrote — the real call's
        // own attempt never touched the row (rowCount 0), so there is no
        // second, later retired_at anywhere to have "won" instead.
        expect(finalRow.rows[0].retired_at).toBe(raceRetiredAt);
      } finally {
        await raceConn.end();
      }
    },
    30_000,
  );

  /**
   * Dispatch item 4's own explicit wording: "a rule retired through the
   * REAL `retireRule` action produces zero new evaluations ... this is
   * the first time this gets tested through the real retire path rather
   * than Slice 5's test-only direct state seeding." The coder's own
   * `severity-lifecycle.live.test.ts` "full §8.4 sequence" test already
   * proves this through `retireRuleState` (the REPOSITORY function) —
   * genuinely real, not seeded, but one layer below the Server Action
   * `retireRule` dispatch names specifically. This test closes that exact
   * gap: goes through `app/(app)/rules/actions.ts`'s `retireRule` Server
   * Action itself (session/rate-limit mocked for the same structural
   * reason as the free-tier test below; everything else real).
   */
  describe('retireRule Server Action — real retire path, zero new evaluations after', () => {
    async function seedAccount(userId: string): Promise<string> {
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier)
         values ($1, 'Retire Action Live Test', 'mt5', 'USD', '00:00:00 UTC', 't0')
         returning id`,
        [userId],
      );
      return res.rows[0].id;
    }

    async function seedTrade(userId: string, accountId: string, serverDay: string): Promise<string> {
      const openedAt = new Date(`${serverDay}T09:00:00Z`);
      const closedAt = new Date(openedAt.getTime() + 30 * 60 * 1000);
      const blockRes = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
         returning id`,
        [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
      );
      const tradeRes = await db.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
            grouping_confidence)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, 'closed',
                 '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '1.000000', '1.000000', 'USD',
                 'confident_single')
         returning id`,
        [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), closedAt.toISOString(), serverDay],
      );
      return tradeRes.rows[0].id;
    }

    it(
      'a rule retired through the REAL retireRule Server Action stops producing evaluations for a subsequently-confirmed trade',
      async () => {
        if (!env) return;
        const user = await createTestAuthUser(env, 'severity-retire-action');
        cleanupUserIds.push(user.id);
        const accountId = await seedAccount(user.id);

        const ruleId = await seedGlobalRule(user.id, new Date('2026-01-01T00:00:00Z'), { severity: 'soft' });

        const { confirmDay } = await import('@/lib/ingestion/confirm');
        const preRetireDay = '2026-01-10';
        await seedTrade(user.id, accountId, preRetireDay);
        const preConfirm = await confirmDay(accountId, preRetireDay, { now: () => new Date(`${preRetireDay}T23:00:00Z`) });
        expect(preConfirm.confirmed).toBe(true);
        const preEval = await db.query(`select 1 from retrospeq.rule_evaluations where trade_id is not null and rule_id = $1`, [ruleId]);
        expect(preEval.rows.length).toBeGreaterThan(0); // sanity: the rule DOES evaluate before retirement

        sessionAs(user.id, user.email);
        const { retireRule } = await import('@/app/(app)/rules/actions');
        const result = await retireRule(ruleId);
        expect(result.success).toBe(true);
        expect(result.state).toBe('retired');

        const ruleRow = await db.query(`select state from retrospeq.rules where id = $1`, [ruleId]);
        expect(ruleRow.rows[0].state).toBe('retired');

        const postRetireDay = '2026-01-11';
        const postRetireTradeId = await seedTrade(user.id, accountId, postRetireDay);
        const postConfirm = await confirmDay(accountId, postRetireDay, { now: () => new Date(`${postRetireDay}T23:00:00Z`) });
        expect(postConfirm.confirmed).toBe(true);

        const postEval = await db.query(`select * from retrospeq.rule_evaluations where trade_id = $1 and rule_id = $2`, [
          postRetireTradeId,
          ruleId,
        ]);
        expect(postEval.rows).toHaveLength(0);
      },
      60_000,
    );
  });

  /**
   * Dispatch item 3: the free-tier promotion block, end-to-end, through
   * the REAL `promoteRule` Server Action — not `resolve.ts`'s capability
   * resolution mocked in isolation (which is all `app/(app)/rules/__tests__/
   * actions.test.ts` exercises, since that file mocks `canForUser`
   * entirely). This test mocks ONLY the two structural things every
   * Server Action test in this repo mocks for the same reason
   * (`confirm-day-action.live.test.ts`'s own header: `cookies()`/`headers()`
   * need a real Next.js request context `vitest run` does not provide) —
   * everything else, including `canForUser` -> `can()` ->
   * `getUserPlan`/`countActiveHardRules`, runs for REAL against the live
   * DB. A freshly created auth user with no `subscriptions` row defaults
   * to `'free'` (`getUserPlan`'s own documented fallback), so this is a
   * genuine, real free-tier account, not a stand-in.
   */
  describe('promoteRule Server Action — REAL free-tier block (not mocked canForUser)', () => {
    async function seedAccount(userId: string): Promise<string> {
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier)
         values ($1, 'Free Tier Block Live Test', 'mt5', 'USD', '00:00:00 UTC', 't0')
         returning id`,
        [userId],
      );
      return res.rows[0].id;
    }

    async function seedTrade(userId: string, accountId: string, serverDay: string): Promise<string> {
      const openedAt = new Date(`${serverDay}T09:00:00Z`);
      const closedAt = new Date(openedAt.getTime() + 30 * 60 * 1000);
      const blockRes = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
         returning id`,
        [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
      );
      const tradeRes = await db.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
            grouping_confidence)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, 'closed',
                 '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '1.000000', '1.000000', 'USD',
                 'confident_single')
         returning id`,
        [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), closedAt.toISOString(), serverDay],
      );
      return tradeRes.rows[0].id;
    }

    it(
      'a real free-tier user (no subscription upgrade ever applied), FULLY eligible on every §5.7 gate (25 real confirmed followed evaluations, 6+ weeks old, zero recent breaks), is STILL rejected by the REAL promoteRule action with ENTITLEMENT_LIMIT, and the DB write never happens',
      async () => {
        if (!env) return;
        const user = await createTestAuthUser(env, 'severity-free-tier-block');
        cleanupUserIds.push(user.id);
        const accountId = await seedAccount(user.id);

        const ruleCreatedAt = new Date('2026-01-01T00:00:00Z');
        const ruleId = await seedGlobalRule(user.id, ruleCreatedAt, { severity: 'soft' });

        // 25 confirmed, all-followed evaluations spread across 25 distinct
        // days, well past the 6-week age requirement and the 3-week
        // recent-break window as of the `now` this test checks against —
        // the SAME structural shape `severity-lifecycle.live.test.ts`'s own
        // "full §8.4 sequence" test uses to prove genuine eligibility,
        // reused here so the entitlement rejection below cannot be
        // dismissed as "well it wasn't eligible anyway."
        const { confirmDay } = await import('@/lib/ingestion/confirm');
        for (let i = 0; i < 25; i++) {
          const day = new Date(Date.UTC(2026, 0, 5 + i));
          const serverDay = day.toISOString().slice(0, 10);
          await seedTrade(user.id, accountId, serverDay);
          const result = await confirmDay(accountId, serverDay, { now: () => new Date(`${serverDay}T23:00:00Z`) });
          expect(result.confirmed).toBe(true);
        }

        // Confirm the real precondition for this test rather than assuming
        // it: `handle_new_user` (20260821020000_subscriptions.sql) inserts
        // a `subscriptions` row with `plan` defaulting to 'free' in the
        // SAME transaction as every new auth.users row, and this test never
        // calls `setUserPlan`/upgrades it — so this is a genuine, real
        // free-tier account, not a stand-in.
        const subRow = await db.query<{ plan: string }>('select plan from retrospeq.subscriptions where user_id = $1', [user.id]);
        expect(subRow.rows).toHaveLength(1);
        expect(subRow.rows[0].plan).toBe('free');

        // Confirm eligibility independently first — if this rule were NOT
        // actually eligible, the ENTITLEMENT_LIMIT rejection below would
        // prove nothing (promoteRule's own documented order runs the
        // eligibility gate BEFORE the plan check, so an ineligible rule
        // would be rejected with RULE_PROMOTION_NOT_ELIGIBLE regardless of
        // plan, masking the very thing this test exists to verify).
        const { checkPromotionEligibilityForUser } = await import('../promotion-eligibility');
        const eligibility = await checkPromotionEligibilityForUser(user.id, ruleId, new Date('2026-03-01T00:00:00Z'));
        expect(eligibility.eligible).toBe(true);
        expect(eligibility.reasons).toEqual([]);

        sessionAs(user.id, user.email);

        const { promoteRule } = await import('@/app/(app)/rules/actions');
        const result = await promoteRule(ruleId);

        expect(result.success).toBeUndefined();
        expect(result.error?.code).toBe('ENTITLEMENT_LIMIT');
        expect(result.error?.retryable).toBe(false);

        // No DB write happened: severity is still 'soft', promoted_at
        // still null.
        const row = await db.query(`select severity, promoted_at from retrospeq.rules where id = $1`, [ruleId]);
        expect(row.rows[0].severity).toBe('soft');
        expect(row.rows[0].promoted_at).toBeNull();
      },
      150_000,
    );
  });
});
