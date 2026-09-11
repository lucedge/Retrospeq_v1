import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { weekStartForServerDay } from '@/lib/rules/week-boundary';

vi.mock('server-only', () => ({}));

/**
 * Module 07 (Engagement) §3.3 — "Auto-confirm does not earn streak", tested
 * ADVERSARIALLY against a real Postgres schema, not trusted to the coder's
 * own "by construction" reasoning (retrospeq-orchestrator dispatch brief,
 * 2026-09-11, item 2). `autoConfirmStaleTrades` (`lib/ingestion/confirm.ts`)
 * sets `trades.confirmed_at` but must NEVER insert a `day_closeouts` row --
 * this file seeds a real stale unconfirmed trade, runs the real sweep, and
 * confirms directly against the database that (a) no `day_closeouts` row
 * exists for that day, and (b) `week_completeness` genuinely does not count
 * that day as closed (days_closed excludes it, complete=false).
 *
 * `engagement_state.streak_weeks` itself is deliberately NOT asserted to an
 * exact number: it depends on how many real calendar weeks separate this
 * test's real wall-clock run time from the seeded stale day (the per-user
 * streak walk uses real `now`, not a test-injected one, for the exact
 * reason documented in `streak-repository.ts`'s own header — a per-user,
 * account-agnostic "current day" concept, deliberately not overridable from
 * this call site). The `week_completeness` row is the deterministic,
 * timing-independent proof this test relies on instead — it is the literal
 * per-week record §5.2 describes, and is exactly what any later streak walk
 * would read for this week regardless of when that walk itself runs.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 07 §3.3 — auto-confirm never earns streak credit (live DB, adversarial)', () => {
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

  it(
    'a stale trade swept by autoConfirmStaleTrades creates NO day_closeouts row, and its week is NOT counted as closed -- proven live, not assumed',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'auto-confirm-no-streak');
      cleanupUserIds.push(user.id);

      const accountRes = await db.query<{ id: string }>(
        `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier)
         values ($1, 'Auto-Confirm Exclusion Test', 'mt5', 'USD', '00:00:00 UTC', 't0')
         returning id`,
        [user.id],
      );
      const accountId = accountRes.rows[0].id;

      const now = new Date();
      const staleServerDay = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const openedAt = new Date(`${staleServerDay}T09:00:00Z`);
      const staleClosedAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

      const blockRes = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
         returning id`,
        [user.id, accountId, openedAt.toISOString(), staleClosedAt.toISOString(), staleServerDay],
      );
      await db.query(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
            grouping_confidence)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, 'closed',
                 '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '1.0', '1.0', 'USD', 'confident_single')`,
        [user.id, accountId, blockRes.rows[0].id, openedAt.toISOString(), staleClosedAt.toISOString(), staleServerDay],
      );

      // Sanity: genuinely unconfirmed before the sweep.
      const before = await db.query<{ confirmed_at: string | null; status: string }>(
        `select confirmed_at, status from retrospeq.trades where account_id = $1 and server_day = $2`,
        [accountId, staleServerDay],
      );
      expect(before.rows[0]).toMatchObject({ confirmed_at: null, status: 'closed' });

      const { autoConfirmStaleTrades } = await import('@/lib/ingestion/confirm');
      // Retry a couple of times in case a concurrent, unrelated sweep from
      // another live test file racing against the same shared dev DB wins
      // this trade first -- same posture as this repo's other auto-confirm
      // live tests (e.g. adherence-repository.live.test.ts).
      let confirmedByThisSweep = false;
      for (let attempt = 0; attempt < 3 && !confirmedByThisSweep; attempt++) {
        const sweepResult = await autoConfirmStaleTrades({ now: () => now });
        confirmedByThisSweep = sweepResult.tradesConfirmed.length > 0;
        if (!confirmedByThisSweep) {
          const check = await db.query<{ confirmed_at: string | null }>(
            `select confirmed_at from retrospeq.trades where account_id = $1 and server_day = $2`,
            [accountId, staleServerDay],
          );
          if (check.rows[0]?.confirmed_at) confirmedByThisSweep = true; // won by a concurrent sweep, equally valid
        }
      }

      // (setUp check) the trade really is now confirmed, confirmed_by = auto_7d.
      const afterTrade = await db.query<{ confirmed_at: string | null; confirmed_by: string | null; status: string }>(
        `select confirmed_at, confirmed_by, status from retrospeq.trades where account_id = $1 and server_day = $2`,
        [accountId, staleServerDay],
      );
      expect(afterTrade.rows[0].confirmed_at).not.toBeNull();
      expect(afterTrade.rows[0].confirmed_by).toBe('auto_7d');
      expect(afterTrade.rows[0].status).toBe('confirmed');

      // (a) NO day_closeouts row was created for that day -- ever. This is
      // the literal §4.6/§3.3 mechanism this test exists to prove, not
      // assume: the ONLY INSERT into day_closeouts in the whole repo is
      // inside confirmDay, and autoConfirmStaleTrades never calls it.
      const closeoutRows = await db.query(
        `select 1 from retrospeq.day_closeouts where account_id = $1 and server_day = $2`,
        [accountId, staleServerDay],
      );
      expect(closeoutRows.rows).toHaveLength(0);

      // (b) week_completeness/engagement_state do NOT count that day as
      // closed -- the post-commit recompute already ran automatically as
      // part of autoConfirmStaleTrades's own wiring (never called directly
      // by this test).
      const weekStart = weekStartForServerDay(staleServerDay);
      const weekRow = await db.query<{ days_traded: number; days_closed: number; complete: boolean }>(
        `select days_traded, days_closed, complete from retrospeq.week_completeness where user_id = $1 and week_start = $2`,
        [user.id, weekStart],
      );
      expect(weekRow.rows).toHaveLength(1);
      expect(weekRow.rows[0].days_traded).toBeGreaterThanOrEqual(1);
      expect(weekRow.rows[0].days_closed).toBe(0); // the day never got a closeout, so it can never be counted as closed
      expect(weekRow.rows[0].complete).toBe(false); // days_closed (0) < days_traded (>=1) -> broken, per §5.2's own formula

      // engagement_state itself was genuinely recomputed as part of this
      // sweep's own post-commit wiring (not left at its signup-default,
      // never-yet-computed state) -- current_week_start is set, and (since
      // the stale day is 8 real days in the past) is never THIS week.
      const stateRow = await db.query<{ current_week_start: string | null }>(
        `select current_week_start::text as current_week_start from retrospeq.engagement_state where user_id = $1`,
        [user.id],
      );
      expect(stateRow.rows[0].current_week_start).not.toBeNull();
      expect(stateRow.rows[0].current_week_start).not.toBe(weekStart);
    },
    30_000,
  );
});
