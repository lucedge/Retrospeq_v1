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
 * Module 06 (Review & Graduation) Slice 1, story 1.3 —
 * "Late fill allowed, marked `captured_late`, EXCLUDED FROM JUDGMENT
 * FINDINGS." Module 02 §4.5 states the same requirement in its own words:
 * "Any later fill of a pre-entry field is written with `captured_late =
 * true` and excluded from judgment findings by default."
 *
 * This slice's own `writeLateCaptureAction` (`app/(app)/trades/actions.ts`)
 * is the FIRST real, live caller anywhere in this repo that ever sets
 * `captured_late = true` on a real, registry-defined field's capture row —
 * every prior write path either always wrote `false` (`lockPreEntryCaptures`,
 * a fresh on-time match) or wrote the literal built-in trim-reason field,
 * never a real `fields` row a strategy actually segments on. That makes
 * this the first point in the repo's history where the exclusion this
 * spec text promises is actually reachable and checkable end to end.
 *
 * **This test currently FAILS, and that failure is the real, load-bearing
 * finding of this test pass, not a mistake in the test.** `lib/analytics/
 * edge-engine/repository.ts`'s `fetchCapturesForTrades` — the ONE query
 * that feeds every `(trade, field)` value into Module 05's segmentation/
 * finding computation — selects `trade_id, field_id, value` with no
 * `captured_late` column in its SELECT list and no `where captured_late =
 * false` filter at all (confirmed by direct reading, not assumed). A
 * late-filled pre-entry value is therefore indistinguishable, at this
 * query, from a normal on-time capture, and WILL be used to build
 * segments/baselines exactly like any other value — directly
 * contradicting both this story's own acceptance criterion and Module
 * 02's own spec text. `lib/rules/distributions-repository.ts`'s
 * `bool_or(captured_late)` (Module 04's ADHERENCE-fact use of the same
 * column, a genuinely different consumer/question) is not a substitute —
 * it never touches Module 05's judgment-finding pipeline at all.
 *
 * Do not "fix" this test to match current behaviour — the assertions
 * below encode the SPEC's requirement; the fix belongs in
 * `fetchCapturesForTrades` (exclude `captured_late = true` rows, or at
 * minimum surface the flag so `field-values.ts`/`edge-engine.ts` can
 * treat a late-filled value as `null` for segmentation the same way a
 * genuinely uncaptured field already is).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('captured_late exclusion from Module 05 judgment findings (live DB)', () => {
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
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trade_captures where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query('delete from retrospeq.fields where user_id = $1 and kind <> $2', [userId, 'derived']);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Captured-Late Exclusion Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedStrategy(userId: string, fieldId: string): Promise<string> {
    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Captured-Late Exclusion Strategy', 1, false, 'active')
       returning id`,
      [userId],
    );
    const strategyId = strategyRes.rows[0].id;

    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, 'Conviction flag', 'strategy_var', 'bool', 'captured', $3, '{}'::jsonb)`,
      [fieldId, userId, strategyId],
    );

    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Captured-Late Exclusion Strategy', $3::jsonb, '[]'::jsonb)`,
      [strategyId, userId, JSON.stringify([{ field_id: fieldId, capture_moment: 'pre_entry', order: 1 }])],
    );

    return strategyId;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    strategyId: string,
    fieldId: string,
    flagValue: boolean,
    capturedLate: boolean,
    outcome: 'win' | 'loss',
    index: number,
  ): Promise<string> {
    const openedAt = new Date(Date.UTC(2026, 0, 1 + index, 9, 0, 0));
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, openedAt.toISOString()],
    );

    const rMultiple = outcome === 'win' ? '1.5000' : '-1.0000';
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          confirmed_at, confirmed_by, outcome, r_multiple, not_a_decision, strategy_id, strategy_version)
       values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$4::timestamptz,$4::date,'confirmed',
               '1.20000000','1.20500000','100000.00000000','USD','confident_single',
               $4::timestamptz,'user',$5,$6,false,$7,1)
       returning id`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), outcome, rMultiple, strategyId],
    );
    const tradeId = tradeRes.rows[0].id;

    await db.query(
      `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment, captured_late)
       values ($1, $2, $3, $4::jsonb, 'pre_entry', $5)`,
      [tradeId, userId, fieldId, JSON.stringify(flagValue), capturedLate],
    );
    return tradeId;
  }

  it(
    'fetchCapturesForTrades excludes a captured_late=true value from Module 05\'s (trade, field) value feed',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'captured-late-exclusion');
      cleanupUserIds.push(userId);
      const accountId = await seedAccount(userId);
      const fieldId = 'conviction_flag';
      const strategyId = await seedStrategy(userId, fieldId);

      const onTimeTradeId = await seedTrade(userId, accountId, strategyId, fieldId, true, false, 'win', 0);
      const lateTradeId = await seedTrade(userId, accountId, strategyId, fieldId, true, true, 'win', 1);

      const { fetchCapturesForTrades } = await import('../repository');
      const captures = await fetchCapturesForTrades(userId, [onTimeTradeId, lateTradeId], [fieldId]);

      const byTrade = captures.get(fieldId) ?? new Map();
      expect(byTrade.has(onTimeTradeId)).toBe(true);
      // THE REAL BUG: this currently fails — fetchCapturesForTrades returns
      // the late-filled value indistinguishably from the on-time one, so
      // this assertion (the spec's own requirement) is false today.
      expect(byTrade.has(lateTradeId)).toBe(false);
    },
    30_000,
  );

  it(
    'end-to-end: computeEdgeFindingsForStrategyId does not let a captured_late value change a segment\'s win rate',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'captured-late-e2e');
      cleanupUserIds.push(userId);
      const accountId = await seedAccount(userId);
      const fieldId = 'conviction_flag';
      const strategyId = await seedStrategy(userId, fieldId);

      // flag=true segment: 20 ON-TIME trades, all losses (0% win rate).
      let idx = 0;
      for (let i = 0; i < 20; i++) {
        await seedTrade(userId, accountId, strategyId, fieldId, true, false, 'loss', idx++);
      }
      // Plus 5 CAPTURED-LATE flag=true trades, all wins — if these leak
      // into the segment, the win rate stops being 0% (the honest,
      // on-time-only fact) and becomes misleadingly positive.
      for (let i = 0; i < 5; i++) {
        await seedTrade(userId, accountId, strategyId, fieldId, true, true, 'win', idx++);
      }
      // flag=false baseline: 20 trades, 10 wins (50%), all on-time.
      for (let i = 0; i < 20; i++) {
        await seedTrade(userId, accountId, strategyId, fieldId, false, false, i < 10 ? 'win' : 'loss', idx++);
      }

      const { recomputeEdgeFindingsForUser } = await import('../repository');
      await recomputeEdgeFindingsForUser(userId);

      const findingsRes = await db.query<{ n: number; win_rate: string }>(
        `select n, win_rate from retrospeq.findings
          where user_id = $1 and field_id = $2 and segment = $3::jsonb and state = 'active'`,
        [userId, fieldId, JSON.stringify({ op: 'eq', value: true })],
      );
      expect(findingsRes.rows).toHaveLength(1);
      // Spec-correct expectation: only the 20 on-time trades count, n=20, win_rate=0.
      // THE REAL BUG: today this reads n=25, win_rate=0.20 (5 late wins leaked in).
      expect(findingsRes.rows[0].n).toBe(20);
      expect(Number(findingsRes.rows[0].win_rate)).toBeCloseTo(0, 5);
    },
    60_000,
  );
});
