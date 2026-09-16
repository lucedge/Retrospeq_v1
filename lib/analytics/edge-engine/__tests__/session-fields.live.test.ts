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
 * End-to-end proof for the owner's 2026-09-15 session decision
 * (`retrospeq-design-decisions.md` §17): `drv.session` and the composite
 * `drv.day_session` are real, computed fields the edge engine segments
 * over — not just a classifier with unit tests and a migration.
 *
 * Why this test exists at all: before the session slice, `drv.session`
 * had a vocabulary-less registry row and NO extractor, so every trade
 * resolved `null` and the engine wrote ZERO `findings` rows for it,
 * forever (live-proven 2026-09-15, `default-strategy-edge-integration.
 * live.test.ts`). That is exactly the regression this file guards: it
 * asserts real rows exist for both fields, with the session labels the
 * decision names, and that segment membership follows the market-clock
 * rule rather than UTC hour buckets.
 *
 * Deliberately small (the DB is remote, ~112ms per round trip): one
 * strategy, one account, trades placed at two unambiguous instants — a
 * London-session morning and a New York-session afternoon, both on a
 * Wednesday in January (both zones on standard time, so no DST subtlety
 * is load-bearing here; the DST-mismatch weeks are covered exhaustively
 * by `session-classifier.test.ts`'s own property tests).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('drv.session / drv.day_session — edge engine end-to-end (live DB)', () => {
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
      await db.query('delete from retrospeq.shadow_runs where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 120_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  /** A forex (mt5) account — crypto would be suppressed by §4.12, which
   *  is a different test's subject. */
  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Session Live Test Account', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedStrategy(userId: string): Promise<string> {
    await db.query('select retrospeq.seed_derived_fields_for_user($1)', [userId]);
    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Session Live Test Strategy', 1, false, 'active')
       returning id`,
      [userId],
    );
    const strategyId = strategyRes.rows[0].id;
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Session Live Test Strategy', $3::jsonb, '[]'::jsonb)`,
      [
        strategyId,
        userId,
        JSON.stringify([
          { field_id: 'drv.session', capture_moment: 'pre_entry', order: 1 },
          { field_id: 'drv.day_session', capture_moment: 'pre_entry', order: 2 },
        ]),
      ],
    );
    return strategyId;
  }

  /** Bulk seed: two statements total, not two per trade. The DB is remote
   *  (~112ms per round trip) and a per-trade loop of 44 trades cost ~20
   *  minutes, blowing both the test and cleanup timeouts (2026-09-16).
   *  `generate_series` builds the same rows server-side.
   *
   *  `opened_at` is the market-clock instant the session derives from;
   *  `server_day` is the trading day (rollover 00:00 UTC here, so the two
   *  agree — their independence is unit-tested, not re-proven here). */
  async function seedTrades(
    userId: string,
    accountId: string,
    strategyId: string,
    weeks: number,
  ): Promise<void> {
    await db.query(
      `with spec as (
         select timestamptz '2026-01-07 00:00:00+00'
                  + (w * interval '7 days') + (h * interval '1 hour') as opened_at
           from generate_series(0, $4::int - 1) as w,
                (values (10), (18)) as hours(h)
       ),
       ins_blocks as (
         insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         select $1, $2, 'EURUSD', opened_at, opened_at, opened_at::date from spec
         returning id, opened_at
       )
       insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          confirmed_at, confirmed_by, outcome, r_multiple, not_a_decision, strategy_id, strategy_version)
       select $1, $2, b.id, 'EURUSD', 'long', b.opened_at, b.opened_at, b.opened_at::date, 'confirmed',
              '1.20000000', '1.20500000', '100000.00000000', 'USD', 'confident_single',
              b.opened_at, 'user',
              -- London wins 4 of 5, New York 1 of 2: two genuinely
              -- different segments, so the engine has something to say.
              case when extract(hour from b.opened_at at time zone 'UTC') = 10
                   then case when (row_number() over (order by b.opened_at)) % 5 = 0 then 'loss' else 'win' end
                   else case when (row_number() over (order by b.opened_at)) % 2 = 0 then 'loss' else 'win' end
              end,
              case when extract(hour from b.opened_at at time zone 'UTC') = 10
                   then case when (row_number() over (order by b.opened_at)) % 5 = 0 then -1.0000 else 1.5000 end
                   else case when (row_number() over (order by b.opened_at)) % 2 = 0 then -1.0000 else 1.5000 end
              end,
              false, $3, 1
         from ins_blocks b`,
      [userId, accountId, strategyId, weeks],
    );
  }

  it(
    'computes real segments for both session fields, with the decision\'s own labels',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'session-fields');
      cleanupUserIds.push(userId);
      const accountId = await seedAccount(userId);
      const strategyId = await seedStrategy(userId);

      // Wednesdays from 2026-01-07 (both zones on standard time).
      // 10:00 UTC -> London (London 08:00 -> New York 08:00 = 08:00-13:00
      // UTC in winter); 18:00 UTC -> New York (London 17:00 -> New York
      // 17:00 = 17:00-22:00 UTC). 22 weeks clears the n>=20 per-segment
      // gate on both sessions.
      await seedTrades(userId, accountId, strategyId, 22);

      const { recomputeEdgeFindingsForUser } = await import('../repository');
      await recomputeEdgeFindingsForUser(userId);

      // `findings.segment` is jsonb: {op, value} — the engine's own
      // segment predicate, not a bare label.
      const rows = await db.query<{ field_id: string; segment: { op: string; value: string } }>(
        `select field_id, segment from retrospeq.findings
          where user_id = $1 and field_id in ('drv.session', 'drv.day_session')`,
        [userId],
      );

      const sessions = rows.rows.filter((r) => r.field_id === 'drv.session').map((r) => r.segment.value);
      const daySessions = rows.rows.filter((r) => r.field_id === 'drv.day_session').map((r) => r.segment.value);

      // Both fields produced real rows — the regression this guards is
      // zero rows, forever, for a field with no extractor.
      expect(sessions.length).toBeGreaterThan(0);
      expect(daySessions.length).toBeGreaterThan(0);

      // Market-clock membership, not UTC-hour buckets: 10:00 UTC in
      // January is London, 18:00 UTC is New York.
      expect(new Set(sessions)).toEqual(new Set(['London', 'New York']));

      // The composite carries both parts, and only Wednesdays were seeded.
      for (const value of daySessions) {
        expect(value).toMatch(/^Wed · (London|New York)$/);
      }
      expect(new Set(daySessions)).toEqual(new Set(['Wed · London', 'Wed · New York']));
    },
    180_000,
  );
});
