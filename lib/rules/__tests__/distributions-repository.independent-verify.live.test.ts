import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * INDEPENDENT VERIFICATION (live DB) — originally written by
 * retrospeq-tester, not the coder who built Slice 9, as a REPORT of a real
 * bug rather than a fix. Re-verifies §5.10's "preview visible on each" of
 * the guided front door's three operands against a REAL, freshly-recomputed
 * `operand_distributions` row for `daily_loss_pct` — the exact end-to-end
 * path a real trader hits when the guided three-rule screen renders a live
 * preview for the daily-loss-cap rule.
 *
 * HISTORY (gap now closed): `preview()` (`lib/rules/preview.ts`) used to
 * gate on `operand.computableToday` BEFORE ever querying
 * `operand_distributions`:
 *
 *   if (!operand.computableToday) return { state: 'operand_not_computable', ... }
 *
 * `computableToday` was defined (Slice 1) to mean "derivable from a single
 * trade row via `extractComputableOperandValues`" — true for the original
 * 8 operands, and explicitly `false` for `daily_loss_pct`/
 * `consecutive_losses` (`operand-catalogue.ts` lines ~175/~258) because,
 * at Slice 1/3 time, no cross-trade fact-assembly code existed yet for
 * them. Slice 4 (`cross-trade-operand-values.ts`) and Slice 9
 * (`distributions-repository.ts`'s `computeCrossTradeDistributionValues`)
 * had since built real, correct, point-in-time cross-trade computation for
 * exactly these two operands — proven correct by this file's sibling,
 * `distributions-repository.independent-verify.test.ts`, and by the
 * coder's own live test — but `operand.computableToday` was never updated
 * to reflect that, and `preview.ts`'s gate kept reading it literally,
 * defeating Slice 9's whole stated purpose.
 *
 * **Fix (this slice, closing out Slice 9):** `preview.ts`'s gate now checks
 * membership in `DISTRIBUTION_OPERAND_IDS`
 * (`lib/rules/distributions-repository.ts`) instead of the blanket
 * `operand.computableToday` flag — the precise set of operands
 * `recomputeOperandDistributionsForUser` actually writes a row for, today,
 * no more and no less. `operand-catalogue.ts`'s `computableToday` values
 * were deliberately left untouched (that flag has other consumers —
 * fact-assembly readiness — unrelated to this preview gate).
 * `preview.test.ts`'s Slice-3-era "operand_not_computable for a
 * computableToday: false operand" test was updated to use
 * `weekly_loss_pct` (still genuinely not distribution-backed) instead of
 * `daily_loss_pct`, and new tests were added proving `daily_loss_pct`/
 * `consecutive_losses` now genuinely proceed past the gate.
 *
 * This test below now encodes ACTUAL behaviour, not desired-but-failing
 * behaviour — converted from `it.fails` to a normal `it` once the fix
 * above made it pass for real against a live DB.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('INDEPENDENT (live DB) — preview() vs. real Slice 9 daily_loss_pct distributions', () => {
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
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.operand_distributions where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedAccount(userId: string, startingEquity: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity)
       values ($1, 'Independent Verify Live', 'mt5', 'USD', '00:00:00 UTC', $2)
       returning id`,
      [userId, startingEquity],
    );
    return res.rows[0].id;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    openedAt: Date,
    serverDay: string,
    realizedPnl: string,
    outcome: 'win' | 'loss',
  ): Promise<string> {
    const closedAt = new Date(openedAt.getTime() + 15 * 60_000);
    const confirmedAt = new Date(openedAt.getTime() + 30 * 60_000);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
       returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          confirmed_at, confirmed_by, realized_pnl, outcome)
       values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$5::timestamptz,$6,'confirmed',
               '1.20000000','1.20500000','100000.00000000','USD','confident_single',
               $7::timestamptz,'user',$8,$9)
       returning id`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), closedAt.toISOString(), serverDay, confirmedAt.toISOString(), realizedPnl, outcome],
    );
    return tradeRes.rows[0].id;
  }

  it(
    'preview("daily_loss_pct") returns a real ratio once >=20 real, freshly-recomputed distribution observations exist (gate fixed post-Slice-9: preview.ts now checks DISTRIBUTION_OPERAND_IDS, not the stale computableToday: false flag)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'dist-preview-gap');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id, '10000');

      // 25 confirmed trades, one per day, alternating a small loss and a
      // small win so daily_loss_pct is computable (known equity) and
      // non-degenerate (not all-zero) for every trade -- comfortably over
      // MIN_TRADES_FOR_PREVIEW (20).
      for (let i = 0; i < 25; i++) {
        const day = 1 + i; // distinct server_day per trade -> distinct ISO weeks/days, avoids incidental cross-trade coupling
        const openedAt = new Date(Date.UTC(2026, 0, day, 9, 0, 0)); // 2026-01-01 .. 2026-01-25
        const serverDay = openedAt.toISOString().slice(0, 10);
        const isLoss = i % 2 === 0;
        await seedTrade(user.id, accountId, openedAt, serverDay, isLoss ? '-100' : '50', isLoss ? 'loss' : 'win');
      }

      const { recomputeOperandDistributionsForUser } = await import('../distributions-repository');
      const recomputeResult = await recomputeOperandDistributionsForUser(user.id);
      expect(recomputeResult.tradesScanned).toBe(25);

      // Sanity, independent of preview.ts: the real DB row genuinely has
      // n >= 20 real observations for daily_loss_pct (proves the DATA side
      // of this slice is fine -- the gap is specifically in preview.ts's
      // gate, not in distribution computation/persistence).
      const row = await db.query<{ n: number }>(
        `select n from retrospeq.operand_distributions where user_id = $1 and operand_id = 'daily_loss_pct'`,
        [user.id],
      );
      expect(row.rows[0]?.n).toBeGreaterThanOrEqual(20);

      const { preview } = await import('../preview');
      const result = await preview(user.id, 'daily_loss_pct', 'lte', 2);

      // A real preview, exactly like risk_pct already gets.
      expect(result.state).toBe('flagged');
      expect(result.n).toBeGreaterThanOrEqual(20);
      expect(typeof result.ratio).toBe('number');
    },
    30_000,
  );
});
