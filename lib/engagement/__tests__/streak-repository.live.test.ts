import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client, PoolClient } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Module 07 (Engagement) Slice 1 — independent live-DB verification of
 * `lib/engagement/streak-repository.ts` / `week-completeness-repository.ts`,
 * dispatched as a full retrospeq-tester pass (retrospeq-orchestrator brief,
 * 2026-09-11) — NOT the coder's own throwaway self-check (which was
 * deleted, never committed, per this repo's convention that a coder's
 * self-check does not stand in for a real test file). Written fresh
 * against the real shared dev Supabase Postgres project, mirroring the
 * established seeding conventions in `adherence-repository.live.test.ts`
 * / `unlock-state-repository.live.test.ts`.
 *
 * Covers, per the dispatch brief: the backward-walk logic (clean run,
 * grace-applied week with the walk continuing past it, grace already
 * spent this rolling window, zero-trade week, in-progress week exclusion),
 * the streak floor at signup week, idempotency (including a real
 * two-write grace-preservation proof), and the non-blocking/best-effort
 * posture of the post-commit recompute. The §3.3 auto-confirm exclusion is
 * covered in its own dedicated file (`confirm.engagement-exclusion.live.test.ts`)
 * since it is squarely about `confirm.ts`'s own two entry points, not this
 * repository's internals.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 07 Slice 1 — streak-repository (live DB, independent verification)', () => {
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
      await db.query('delete from retrospeq.week_completeness where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.day_closeouts where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  // ---------------------------------------------------------------------
  // Seeding helpers
  // ---------------------------------------------------------------------

  async function backdateCreatedAt(userId: string, isoDate: string): Promise<void> {
    await db.query(`update retrospeq.profiles set created_at = $2::timestamptz where id = $1`, [userId, isoDate]);
  }

  async function seedWeekRow(
    userId: string,
    weekStart: string,
    opts: { daysTraded: number; daysClosed: number; complete: boolean; graceApplied?: boolean },
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.week_completeness (user_id, week_start, days_traded, days_closed, complete, grace_applied)
       values ($1, $2, $3, $4, $5, $6)`,
      [userId, weekStart, opts.daysTraded, opts.daysClosed, opts.complete, opts.graceApplied ?? false],
    );
  }

  async function setGraceUsedAt(userId: string, isoDateOrNull: string | null): Promise<void> {
    await db.query(`update retrospeq.engagement_state set grace_used_at = $2::timestamptz where user_id = $1`, [
      userId,
      isoDateOrNull,
    ]);
  }

  async function readEngagementStateRaw(userId: string) {
    const res = await db.query(
      `select streak_weeks, longest_streak_weeks, current_week_start::text as current_week_start,
              current_week_complete, grace_used_at::text as grace_used_at, computed_at::text as computed_at
         from retrospeq.engagement_state where user_id = $1`,
      [userId],
    );
    return res.rows[0];
  }

  async function readWeekRow(userId: string, weekStart: string) {
    const res = await db.query(
      `select days_traded, days_closed, complete, grace_applied, computed_at::text as computed_at
         from retrospeq.week_completeness where user_id = $1 and week_start = $2`,
      [userId, weekStart],
    );
    return res.rows[0];
  }

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier)
       values ($1, 'Engagement Live Test', 'mt5', 'USD', '00:00:00 UTC', 't0')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  /** Seeds a real, already-CONFIRMED trade directly (bypassing confirmDay) —
   *  used only for the in-progress-current-week test, which needs
   *  `days_traded > 0` without a `day_closeouts` row. */
  async function seedConfirmedTradeDirect(userId: string, accountId: string, serverDay: string): Promise<void> {
    const openedAt = new Date(`${serverDay}T09:00:00Z`);
    const closedAt = new Date(`${serverDay}T09:30:00Z`);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
       returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
          grouping_confidence, confirmed_at, confirmed_by)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, 'confirmed',
               '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '1.0', '1.0', 'USD',
               'confident_single', now(), 'user')`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
  }

  // ---------------------------------------------------------------------
  // Backward walk — clean run
  // ---------------------------------------------------------------------

  it(
    'a clean run of consecutive complete weeks walks back to the floor and counts every one',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-clean-run');
      cleanupUserIds.push(user.id);
      // Backdated to exactly the earliest seeded week's own Monday -- the
      // floor rounds DOWN to the Monday of whatever week `created_at`
      // falls in (weekStartForServerDay), so this must land in the SAME
      // week as the earliest seeded row, not merely "before" it, or the
      // walk self-heals every earlier (zero-trade, complete) week too.
      await backdateCreatedAt(user.id, '2026-08-24T00:00:00Z');

      await seedWeekRow(user.id, '2026-09-07', { daysTraded: 3, daysClosed: 3, complete: true });
      await seedWeekRow(user.id, '2026-08-31', { daysTraded: 2, daysClosed: 2, complete: true });
      await seedWeekRow(user.id, '2026-08-24', { daysTraded: 0, daysClosed: 0, complete: true });

      const { recomputeEngagementStateForUser } = await import('../streak-repository');
      const now = () => new Date('2026-09-16T12:00:00Z'); // Wednesday; currentWeekStart 09-14, lastCompleted 09-07
      const result = await recomputeEngagementStateForUser(user.id, { now });

      expect(result.streakWeeks).toBe(3);
      expect(result.longestStreakWeeks).toBe(3);
      expect(result.currentWeekStart).toBe('2026-09-14');
      expect(result.graceUsedAt).toBe(null);

      // Idempotent on a second identical call.
      const second = await recomputeEngagementStateForUser(user.id, { now });
      expect(second.streakWeeks).toBe(3);
      expect(second.longestStreakWeeks).toBe(3);
    },
    30_000,
  );

  // ---------------------------------------------------------------------
  // Backward walk — grace applied to the FIRST broken week only, walk continues
  // ---------------------------------------------------------------------

  it(
    'grace applies to the first broken week, is persisted as grace_applied, and the walk continues counting PAST it',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-grace-continues');
      cleanupUserIds.push(user.id);
      // Backdated to exactly the earliest seeded week (08-17)'s own Monday
      // -- see the "clean run" test's own comment for why this must be the
      // SAME week, not merely "before" it.
      await backdateCreatedAt(user.id, '2026-08-17T00:00:00Z');

      // Walking backwards from 09-07: complete, BROKEN(grace here), complete, BROKEN(stops, grace spent).
      await seedWeekRow(user.id, '2026-09-07', { daysTraded: 3, daysClosed: 3, complete: true });
      await seedWeekRow(user.id, '2026-08-31', { daysTraded: 4, daysClosed: 1, complete: false });
      await seedWeekRow(user.id, '2026-08-24', { daysTraded: 2, daysClosed: 2, complete: true });
      await seedWeekRow(user.id, '2026-08-17', { daysTraded: 3, daysClosed: 0, complete: false });

      const { recomputeEngagementStateForUser } = await import('../streak-repository');
      const now = () => new Date('2026-09-16T12:00:00Z');
      const result = await recomputeEngagementStateForUser(user.id, { now });

      // 09-07 (count) + 08-31 (count_with_grace) + 08-24 (count) = 3, then
      // 08-17 stops the walk (broken, grace already spent this walk).
      expect(result.streakWeeks).toBe(3);
      expect(result.graceUsedAt).not.toBeNull();
      expect(new Date(result.graceUsedAt!).getTime()).toBe(now().getTime());

      const gracedWeek = await readWeekRow(user.id, '2026-08-31');
      expect(gracedWeek.grace_applied).toBe(true);
      expect(gracedWeek.complete).toBe(false); // grace does NOT rewrite `complete` — only lets it count

      const stoppedWeek = await readWeekRow(user.id, '2026-08-17');
      expect(stoppedWeek.grace_applied).toBe(false); // never reached / never graced
    },
    30_000,
  );

  // ---------------------------------------------------------------------
  // Backward walk — grace already used this rolling window: stop, no second grace
  // ---------------------------------------------------------------------

  it(
    'a broken week with grace already used within the rolling 91-day window stops the walk WITHOUT applying a second grace',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-grace-exhausted');
      cleanupUserIds.push(user.id);
      // Backdated to exactly the earliest seeded week (08-24)'s own Monday.
      await backdateCreatedAt(user.id, '2026-08-24T00:00:00Z');

      const now = new Date('2026-09-16T12:00:00Z');
      const graceUsedAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago -- inside the 91-day window
      await setGraceUsedAt(user.id, graceUsedAt.toISOString());

      await seedWeekRow(user.id, '2026-09-07', { daysTraded: 3, daysClosed: 3, complete: true });
      await seedWeekRow(user.id, '2026-08-31', { daysTraded: 4, daysClosed: 1, complete: false });
      // Should never even be reached by the walk.
      await seedWeekRow(user.id, '2026-08-24', { daysTraded: 2, daysClosed: 2, complete: true });

      const { recomputeEngagementStateForUser } = await import('../streak-repository');
      const result = await recomputeEngagementStateForUser(user.id, { now: () => now });

      // 09-07 counts, 08-31 is broken with no grace available -> stop.
      expect(result.streakWeeks).toBe(1);
      // grace_used_at is UNCHANGED -- never clobbered, never re-spent.
      expect(result.graceUsedAt).not.toBeNull();
      expect(new Date(result.graceUsedAt!).getTime()).toBe(graceUsedAt.getTime());

      const brokenWeek = await readWeekRow(user.id, '2026-08-31');
      expect(brokenWeek.grace_applied).toBe(false);
    },
    30_000,
  );

  // ---------------------------------------------------------------------
  // Zero-trade week self-heals to complete via the REAL (empty) trades/day_closeouts tables
  // ---------------------------------------------------------------------

  it(
    'weeks with zero real trades/closeouts self-heal to complete=true via the real §5.2 formula, not a manually-seeded row',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-zero-trade-weeks');
      cleanupUserIds.push(user.id);
      // Floor at 2026-08-24 -- no week_completeness rows seeded at all, no
      // trades/day_closeouts seeded at all. Every week the walk touches
      // must be self-healed live against real, empty source tables.
      await backdateCreatedAt(user.id, '2026-08-24T00:00:00Z');

      const { recomputeEngagementStateForUser } = await import('../streak-repository');
      const now = () => new Date('2026-09-16T12:00:00Z'); // lastCompleted 09-07; floor 08-24 -> 3 weeks: 09-07, 08-31, 08-24
      const result = await recomputeEngagementStateForUser(user.id, { now });

      expect(result.streakWeeks).toBe(3);

      for (const weekStart of ['2026-09-07', '2026-08-31', '2026-08-24']) {
        const row = await readWeekRow(user.id, weekStart);
        expect(row).toMatchObject({ days_traded: 0, days_closed: 0, complete: true });
      }
    },
    30_000,
  );

  // ---------------------------------------------------------------------
  // In-progress current week is excluded from streak_weeks while incomplete
  // ---------------------------------------------------------------------

  it(
    'the in-progress current week never extends or breaks streak_weeks, even when it is itself incomplete',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-in-progress-excluded');
      cleanupUserIds.push(user.id);
      // Backdated to exactly the (only) seeded completed week's own Monday.
      await backdateCreatedAt(user.id, '2026-09-07T00:00:00Z');
      const accountId = await seedAccount(user.id);

      // The last COMPLETED week is genuinely complete.
      await seedWeekRow(user.id, '2026-09-07', { daysTraded: 3, daysClosed: 3, complete: true });

      // The CURRENT week (contains "now" below) has a confirmed trade but
      // NO day_closeouts row -- genuinely incomplete, mirroring exactly
      // what a trader mid-week looks like before they close out today.
      await seedConfirmedTradeDirect(user.id, accountId, '2026-09-15');

      const { recomputeEngagementStateForUser } = await import('../streak-repository');
      const now = () => new Date('2026-09-16T12:00:00Z'); // currentWeekStart 09-14
      const result = await recomputeEngagementStateForUser(user.id, { now });

      expect(result.currentWeekStart).toBe('2026-09-14');
      expect(result.currentWeekComplete).toBe(false); // genuinely incomplete
      // streak_weeks reflects ONLY the last completed week -- the
      // in-progress week's own incompleteness does not zero it out.
      expect(result.streakWeeks).toBe(1);

      const currentWeekRow = await readWeekRow(user.id, '2026-09-14');
      expect(currentWeekRow).toMatchObject({ days_traded: 1, days_closed: 0, complete: false });
    },
    30_000,
  );

  // ---------------------------------------------------------------------
  // Streak floor — bounded at the user's own signup week
  // ---------------------------------------------------------------------

  it(
    'the walk never counts a week before the user\'s own signup week, even if that week is marked complete',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-floor-bound');
      cleanupUserIds.push(user.id);
      // Signup week floor = 2026-08-24 (a Monday).
      await backdateCreatedAt(user.id, '2026-08-26T00:00:00Z'); // mid-week within that same ISO week

      // A week BEFORE signup, marked complete -- must never count.
      await seedWeekRow(user.id, '2026-08-17', { daysTraded: 5, daysClosed: 5, complete: true });
      // The signup week itself -- eligible.
      await seedWeekRow(user.id, '2026-08-24', { daysTraded: 2, daysClosed: 2, complete: true });

      const { recomputeEngagementStateForUser } = await import('../streak-repository');
      // now falls inside the week STARTING 2026-08-31, so lastCompletedWeekStart
      // is exactly 2026-08-24 -- the walk touches exactly one week.
      const now = () => new Date('2026-09-02T12:00:00Z');
      const result = await recomputeEngagementStateForUser(user.id, { now });

      expect(result.streakWeeks).toBe(1); // NOT 2 -- 08-17 is correctly excluded by the floor
    },
    30_000,
  );

  it(
    'a brand-new signup with no backdating at all starts at streak_weeks = 0, never an inherited pre-signup streak',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-brand-new-signup');
      cleanupUserIds.push(user.id);
      // created_at is real "now" (GoTrue's own signup timestamp) -- no backdating.

      const { fetchEngagementSummaryForUser } = await import('../streak-repository');
      const summary = await fetchEngagementSummaryForUser(user.id);
      expect(summary).toMatchObject({ streakWeeks: 0, longestStreakWeeks: 0 });
    },
    30_000,
  );

  // ---------------------------------------------------------------------
  // Idempotency — a real two-write proof that grace_applied is never clobbered
  // ---------------------------------------------------------------------

  it(
    're-running the recompute for the same confirmation does not double-count streak_weeks or reset a persisted grace_applied flag',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-idempotent-grace');
      cleanupUserIds.push(user.id);
      // Backdated to exactly the earliest seeded week (08-24)'s own Monday.
      await backdateCreatedAt(user.id, '2026-08-24T00:00:00Z');

      await seedWeekRow(user.id, '2026-09-07', { daysTraded: 3, daysClosed: 3, complete: true });
      await seedWeekRow(user.id, '2026-08-31', { daysTraded: 4, daysClosed: 1, complete: false });
      await seedWeekRow(user.id, '2026-08-24', { daysTraded: 2, daysClosed: 2, complete: true });

      const { recomputeEngagementStateForUser } = await import('../streak-repository');
      const now = () => new Date('2026-09-16T12:00:00Z');

      const first = await recomputeEngagementStateForUser(user.id, { now });
      expect(first.streakWeeks).toBe(3); // 09-07 count, 08-31 count_with_grace, 08-24 count
      const firstGraceRow = await readWeekRow(user.id, '2026-08-31');
      expect(firstGraceRow.grace_applied).toBe(true);
      const firstGraceRowComputedAt = firstGraceRow.computed_at;
      const firstGraceUsedAt = first.graceUsedAt;

      const second = await recomputeEngagementStateForUser(user.id, { now });
      expect(second.streakWeeks).toBe(3); // unchanged, not doubled
      expect(second.graceUsedAt).toBe(firstGraceUsedAt); // NOT re-spent / bumped to a new timestamp

      const secondGraceRow = await readWeekRow(user.id, '2026-08-31');
      expect(secondGraceRow.grace_applied).toBe(true); // still true
      // Never touched a second time -- the graced week is read-only on this
      // second walk (not in `explicitServerDays`, not the current week), so
      // its own `computed_at` must be byte-identical, proving no write
      // happened to that row at all on the second call.
      expect(secondGraceRow.computed_at).toBe(firstGraceRowComputedAt);

      const engagementRow = await readEngagementStateRaw(user.id);
      expect(engagementRow.grace_used_at).toBe(firstGraceUsedAt);
      expect(engagementRow.longest_streak_weeks).toBe(3);
    },
    30_000,
  );

  // ---------------------------------------------------------------------
  // Non-blocking / best-effort posture
  // ---------------------------------------------------------------------

  it(
    'a forced failure on the write step never corrupts engagement_state/week_completeness and never touches an already-committed confirmation',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-forced-failure');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const openedAt = new Date('2026-09-10T09:00:00Z');
      const closedAt = new Date('2026-09-10T09:30:00Z');
      const blockRes = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, '2026-09-10'::date) returning id`,
        [user.id, accountId, openedAt.toISOString(), closedAt.toISOString()],
      );
      await db.query(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
            grouping_confidence)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, '2026-09-10', 'closed',
                 '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '1.0', '1.0', 'USD', 'confident_single')`,
        [user.id, accountId, blockRes.rows[0].id, openedAt.toISOString(), closedAt.toISOString()],
      );

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const confirmResult = await confirmDay(accountId, '2026-09-10', { now: () => new Date('2026-09-10T23:00:00Z') });
      expect(confirmResult.confirmed).toBe(true);

      // The real, post-commit engagement recompute has already run
      // automatically by this point (confirmDay's own wiring) -- capture
      // that as the baseline.
      const { fetchEngagementSummaryForUser, recomputeEngagementState } = await import('../streak-repository');
      const baseline = await fetchEngagementSummaryForUser(user.id);
      expect(baseline).not.toBeNull();
      const baselineComputedAt = baseline!.computedAt;

      // Wrap a real client: let every read through, but reject on the
      // final engagement_state UPSERT (the write step) -- a genuine
      // Postgres-shaped failure, not a mock replacing the whole function.
      let queryCount = 0;
      const failingClient = {
        query: (...args: unknown[]) => {
          queryCount += 1;
          const text = String(args[0]);
          if (/insert into retrospeq\.engagement_state/i.test(text)) {
            return Promise.reject(new Error('INDEPENDENT VERIFY: forced engagement_state write failure'));
          }
          return (db.query as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
        },
      } as unknown as PoolClient;

      await expect(recomputeEngagementState(failingClient, user.id, { now: () => new Date('2026-09-16T12:00:00Z') })).rejects.toThrow(
        'INDEPENDENT VERIFY: forced engagement_state write failure',
      );
      expect(queryCount).toBeGreaterThan(1); // proves reads really did happen before the forced failure

      // Re-read over a SEPARATE connection -- byte-identical to baseline,
      // never a partial/corrupt row.
      const afterFailure = await fetchEngagementSummaryForUser(user.id);
      expect(afterFailure).toEqual(baseline);
      expect(afterFailure!.computedAt).toBe(baselineComputedAt);

      // And the trade confirmation itself (already committed BEFORE this
      // forced failure even ran) is completely unaffected.
      const tradeRow = await db.query<{ status: string }>(
        `select status from retrospeq.trades where account_id = $1 and server_day = '2026-09-10'`,
        [accountId],
      );
      expect(tradeRow.rows[0].status).toBe('confirmed');
    },
    30_000,
  );

  it(
    'recomputeEngagementForConfirmations (the exact entry point confirm.ts calls) NEVER throws, even for a target whose own recompute genuinely fails',
    async () => {
      if (!env) return;
      const { recomputeEngagementForConfirmations } = await import('../streak-repository');
      const bogusUserId = '00000000-0000-0000-0000-000000000000'; // syntactically valid UUID, no profiles row -- EngagementProfileNotFoundError, for real, not mocked
      const result = await recomputeEngagementForConfirmations([{ userId: bogusUserId, serverDay: '2026-09-10' }]);
      expect(result.recomputed).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].userId).toBe(bogusUserId);
      expect(String(result.failed[0].error)).toMatch(/no retrospeq\.profiles row/);
    },
    30_000,
  );

  // ---------------------------------------------------------------------
  // RLS sanity re-check from the repository's own read function
  // ---------------------------------------------------------------------

  it(
    'fetchEngagementSummaryForUser is genuinely RLS-scoped -- reading a different user\'s id from inside withUserConnection returns null, not their data',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'streak-summary-rls-owner');
      const otherUser = await createTestAuthUser(env, 'streak-summary-rls-other');
      cleanupUserIds.push(user.id, otherUser.id);

      const { fetchEngagementSummaryForUser } = await import('../streak-repository');
      // fetchEngagementSummaryForUser always scopes its OWN connection to
      // `userId` via withUserConnection -- calling it with otherUser.id
      // while asking about user.id's data is not directly expressible
      // through this function's own signature (by design: it takes exactly
      // one userId, used both to open the RLS session AND as the row
      // filter). This proves the only thing that IS expressible: each
      // user's own summary reads their own row and nothing else.
      const ownSummary = await fetchEngagementSummaryForUser(user.id);
      expect(ownSummary).toMatchObject({ streakWeeks: 0 });

      const rows = await asRole(db, 'authenticated', otherUser.id, async (c) => {
        const res = await c.query('select 1 from retrospeq.engagement_state where user_id = $1', [user.id]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    },
    30_000,
  );
});
