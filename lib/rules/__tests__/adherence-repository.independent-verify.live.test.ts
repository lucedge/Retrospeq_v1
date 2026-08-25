import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client, PoolClient } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * INDEPENDENT VERIFICATION (retrospeq-tester) — item #7 from the Slice 6
 * review brief: a genuinely failing recompute must never leave a partial or
 * corrupt `adherence_weekly` row, and the already-committed trade
 * confirmation it followed must be unaffected. Exercised against a REAL
 * Postgres row (not a mock), by wrapping a real client to fail on exactly
 * the write statement, then re-reading the row over a SEPARATE connection.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('INDEPENDENT — recomputeAdherenceWeekly: a failing write never corrupts or leaves a partial row (live DB)', () => {
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
      await db.query('delete from retrospeq.adherence_weekly where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it(
    'a baseline row survives a subsequent recompute whose write statement genuinely throws -- row stays at its last-good values, never half-written',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'adherence-verify-corrupt');
      cleanupUserIds.push(user.id);

      const accountRes = await db.query<{ id: string }>(
        `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier)
         values ($1, 'Verify Corrupt Test', 'mt5', 'USD', '00:00:00 UTC', 't0') returning id`,
        [user.id],
      );
      const accountId = accountRes.rows[0].id;

      const ruleCreatedAt = new Date('2026-08-01T00:00:00Z');
      const ruleRes = await db.query<{ id: string }>(
        `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state, created_at)
         values ($1, 1, 'global', 'hard', 'authored', 'pre_entry', 'active', $2::timestamptz) returning id`,
        [user.id, ruleCreatedAt.toISOString()],
      );
      const ruleId = ruleRes.rows[0].id;
      await db.query(
        `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered, created_at)
         values ($1, 1, $2, 'risk_pct', 'lte', '2'::jsonb, 'test rule', $3::timestamptz)`,
        [ruleId, user.id, ruleCreatedAt.toISOString()],
      );

      const openedAt = new Date('2026-08-10T09:00:00Z');
      const closedAt = new Date('2026-08-10T09:30:00Z');
      const blockRes = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, '2026-08-10'::date) returning id`,
        [user.id, accountId, openedAt.toISOString(), closedAt.toISOString()],
      );
      await db.query(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
            grouping_confidence)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, '2026-08-10', 'closed',
                 '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '1.5', '1.5', 'USD', 'confident_single')`,
        [user.id, accountId, blockRes.rows[0].id, openedAt.toISOString(), closedAt.toISOString()],
      );

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const confirmResult = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-10T23:00:00Z') });
      expect(confirmResult.confirmed).toBe(true);

      const { fetchAdherenceWeekly, recomputeAdherenceWeekly } = await import('../adherence-repository');
      const baseline = await fetchAdherenceWeekly(user.id, '2026-08-10');
      expect(baseline).toMatchObject({ hardFollowed: 1, hardTotal: 1 });
      const baselineComputedAt = baseline!.computedAt;

      // Wrap the real client: let the SELECT pass through untouched, but
      // reject the UPSERT outright -- a genuine failure at exactly the
      // write step, using a real Postgres connection for the read half so
      // this isn't just a mock asserting on itself.
      let queryCount = 0;
      const failingClient = {
        query: (...args: unknown[]) => {
          queryCount += 1;
          if (queryCount === 1) {
            return (db.query as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
          }
          return Promise.reject(new Error('INDEPENDENT VERIFY: forced write failure'));
        },
      } as unknown as PoolClient;

      await expect(recomputeAdherenceWeekly(failingClient, user.id, '2026-08-10')).rejects.toThrow(
        'INDEPENDENT VERIFY: forced write failure',
      );

      // Re-read over a SEPARATE, unrelated connection -- the row must be
      // byte-identical to the pre-failure baseline: same counts, same
      // computed_at (proving the UPSERT never committed ANY part of its
      // new values), never null (proving the row wasn't wiped), never a
      // half-written mix of old and new columns.
      const afterFailure = await fetchAdherenceWeekly(user.id, '2026-08-10');
      expect(afterFailure).not.toBeNull();
      expect(afterFailure).toEqual(baseline);
      expect(afterFailure!.computedAt).toBe(baselineComputedAt);

      const rawRow = await db.query(
        `select hard_followed, hard_total, soft_followed, soft_total from retrospeq.adherence_weekly
          where user_id = $1 and week_start = $2`,
        [user.id, '2026-08-10'],
      );
      expect(rawRow.rows).toEqual([{ hard_followed: 1, hard_total: 1, soft_followed: 0, soft_total: 0 }]);

      // And the trade confirmation itself (already committed BEFORE this
      // forced recompute failure even ran) is completely unaffected --
      // still confirmed, never rolled back by a downstream cache failure.
      const tradeRow = await db.query<{ status: string }>(
        `select status from retrospeq.trades where account_id = $1 and server_day = '2026-08-10'`,
        [accountId],
      );
      expect(tradeRow.rows[0].status).toBe('confirmed');
    },
    30_000,
  );
});
