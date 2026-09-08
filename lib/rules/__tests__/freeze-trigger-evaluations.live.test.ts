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
 * Module 03 §4.7 / Module 04 §3.1 — the live-DB proof that a real,
 * self-attested trigger-condition answer, captured on a real `arm_events`
 * row, genuinely produces frozen `trigger_evaluations` rows through the
 * REAL confirm transaction (`lib/ingestion/confirm.ts`'s `confirmDay`),
 * exactly mirroring `freeze-evaluations.live.test.ts`'s own precedent for
 * the sibling rule-evaluation freeze path (same seeding conventions: real
 * auth users via the GoTrue admin API, direct SQL seeding of every
 * intermediate row so this test controls the exact shape it needs, rather
 * than driving everything through `createTriggerCondition`/`createStrategy`
 * — those repositories' own live tests already prove THEIR correctness;
 * this file proves the FREEZE wiring end to end).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 04 §3.1/§4.7 — trigger-evaluations freeze-wiring (live DB)', () => {
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
      await db.query('delete from retrospeq.trigger_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.arm_events where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 60_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Trigger Freeze Live Test', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  /** Real `strategies` (v1) + `strategy_versions` row carrying a real
   *  `triggers[]` snapshot pointing at `n` real `trigger_conditions` rows —
   *  returns the strategy id and the ordered condition ids. */
  async function seedStrategyWithTriggers(userId: string, conditionTexts: string[]): Promise<{ strategyId: string; conditionIds: string[] }> {
    const stratRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version) values ($1, 'Freeze Trigger Test Strategy', 1) returning id`,
      [userId],
    );
    const strategyId = stratRes.rows[0].id;

    const conditionIds: string[] = [];
    for (const [i, text] of conditionTexts.entries()) {
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.trigger_conditions (user_id, strategy_id, text, sort_order) values ($1, $2, $3, $4) returning id`,
        [userId, strategyId, text, i + 1],
      );
      conditionIds.push(res.rows[0].id);
    }

    const triggers = conditionIds.map((id, i) => ({ condition_id: id, text: conditionTexts[i], order: i + 1 }));
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Freeze Trigger Test Strategy', '[]'::jsonb, $3::jsonb)`,
      [strategyId, userId, JSON.stringify(triggers)],
    );

    return { strategyId, conditionIds };
  }

  interface SeedTradeParams {
    strategyId?: string | null;
    strategyVersion?: number | null;
    openedAt: Date;
    closedAt?: Date;
    serverDay?: string;
  }

  async function seedTrade(userId: string, accountId: string, params: SeedTradeParams): Promise<string> {
    const closedAt = params.closedAt ?? new Date(params.openedAt.getTime() + 3600_000);
    const serverDay = params.serverDay ?? '2026-09-01';
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5)
       returning id`,
      [userId, accountId, params.openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    const blockId = blockRes.rows[0].id;

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence, strategy_id, strategy_version)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, 'closed',
               '1.10000000', '1.10500000', '100000.00000000', 'USD', 'confident_single', $7, $8)
       returning id`,
      [
        userId,
        accountId,
        blockId,
        params.openedAt.toISOString(),
        closedAt.toISOString(),
        serverDay,
        params.strategyId ?? null,
        params.strategyVersion ?? null,
      ],
    );
    return tradeRes.rows[0].id;
  }

  async function seedArmEvent(
    userId: string,
    accountId: string,
    tradeId: string,
    triggerState: Record<string, boolean>,
    armedAt: Date,
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.arm_events
         (user_id, account_id, instrument, direction, trigger_state, armed_at, matched_trade_id, match_state)
       values ($1, $2, 'EURUSD', 'long', $3::jsonb, $4::timestamptz, $5, 'matched')`,
      [userId, accountId, JSON.stringify(triggerState), armedAt.toISOString(), tradeId],
    );
  }

  it(
    'end-to-end: strategy with 3 triggers -> real arm_events answer -> confirm -> trigger_evaluations rows exist, correctly resolved and frozen',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'trigger-freeze-e2e');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { strategyId, conditionIds } = await seedStrategyWithTriggers(user.id, [
        'Price above the 20 EMA on the 5-minute',
        'Three consecutive higher highs',
        'Stop under the swing low',
      ]);
      const [metId, unmetId, neverAnsweredId] = conditionIds;

      const openedAt = new Date('2026-09-01T09:00:00Z');
      const tradeId = await seedTrade(user.id, accountId, {
        strategyId,
        strategyVersion: 1,
        openedAt,
        serverDay: '2026-09-01',
      });

      await seedArmEvent(
        user.id,
        accountId,
        tradeId,
        { [metId]: true, [unmetId]: false },
        new Date('2026-09-01T08:59:00Z'),
      );

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const now = new Date('2026-09-02T00:00:00Z');
      const result = await confirmDay(accountId, '2026-09-01', { now: () => now });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([tradeId]);

      const rows = await db.query(
        `select condition_id, result, frozen_at from retrospeq.trigger_evaluations where trade_id = $1 order by frozen_at`,
        [tradeId],
      );
      expect(rows.rows).toHaveLength(3);
      const byCondition = new Map(rows.rows.map((r) => [r.condition_id, r.result]));
      expect(byCondition.get(metId)).toBe('met');
      expect(byCondition.get(unmetId)).toBe('unmet');
      expect(byCondition.get(neverAnsweredId)).toBe('unrecorded');
      for (const row of rows.rows) {
        expect(new Date(row.frozen_at).toISOString()).toBe(now.toISOString());
      }
    },
    20_000,
  );

  it(
    'a trade with no strategy binding produces zero trigger_evaluations rows -- correct no-op, not an anomaly',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'trigger-freeze-no-strategy');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const tradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-09-01T09:00:00Z'),
        serverDay: '2026-09-01',
      });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const result = await confirmDay(accountId, '2026-09-01', { now: () => new Date('2026-09-02T00:00:00Z') });
      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([tradeId]);

      const rows = await db.query('select 1 from retrospeq.trigger_evaluations where trade_id = $1', [tradeId]);
      expect(rows.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'a trade whose strategy has NO arm_events row at all (broker-history-only import) freezes every condition as unrecorded',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'trigger-freeze-no-arm-event');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { strategyId, conditionIds } = await seedStrategyWithTriggers(user.id, ['Only condition']);

      const tradeId = await seedTrade(user.id, accountId, {
        strategyId,
        strategyVersion: 1,
        openedAt: new Date('2026-09-01T09:00:00Z'),
        serverDay: '2026-09-01',
      });
      // Deliberately no seedArmEvent call.

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      await confirmDay(accountId, '2026-09-01', { now: () => new Date('2026-09-02T00:00:00Z') });

      const rows = await db.query('select condition_id, result from retrospeq.trigger_evaluations where trade_id = $1', [
        tradeId,
      ]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].condition_id).toBe(conditionIds[0]);
      expect(rows.rows[0].result).toBe('unrecorded');
    },
    20_000,
  );

  it(
    'idempotent: calling the freeze function twice for the same trade never duplicates or errors (the guarantee both of confirm.ts\'s call sites rely on)',
    async () => {
      // NOT exercised via a real `autoConfirmStaleTrades()` sweep here,
      // deliberately -- that function scans EVERY user's stale, unconfirmed
      // trades in the whole shared dev/test Supabase project (this session
      // alone has left 150+ such rows behind across many prior test files'
      // own seeding, confirmed directly against the live DB before writing
      // this note: `select count(*) from trades where status='closed' and
      // confirmed_at is null and closed_at < now() - interval '7 days'` ->
      // 154), and its own per-trade `loadInstrumentBlockState` loop is not
      // parallelised -- empirically, a real call here did not complete
      // within 90s. This is a pre-existing shared-DB data-hygiene
      // condition (an accumulation of orphaned test rows across this
      // session's history), not a defect in this slice's own code, and not
      // fixable by a larger timeout the way `freeze-evaluations.live.
      // test.ts`'s own documented "shared dev DB variable latency" cases
      // were (PROGRESS.md) -- those involved ONE or a few slow round
      // trips, not 150+ sequential ones. `confirm.ts`'s own two call sites
      // for `freezeTriggerEvaluationsForTrade` are textually identical
      // one-line additions (see that file's own two matching comments,
      // "Same trigger-evaluations freeze as confirmDay's own loop above"),
      // and the end-to-end test above already proves the function's real
      // behaviour against a real confirm transaction via `confirmDay`
      // (the FIRST call site) -- what remains genuinely unproven by that
      // test is idempotency (calling the freeze function a SECOND time for
      // an already-frozen trade, which is exactly what would happen if
      // BOTH call sites somehow ran for the same trade, or a retried job),
      // proven directly and cheaply below instead, against a real
      // transaction on a real connection, with no dependency on the
      // cluttered global sweep.
      if (!env) return;
      const user = await createTestAuthUser(env, 'trigger-freeze-idempotent');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { strategyId, conditionIds } = await seedStrategyWithTriggers(user.id, ['Idempotency test condition']);

      const tradeId = await seedTrade(user.id, accountId, {
        strategyId,
        strategyVersion: 1,
        openedAt: new Date('2026-09-01T09:00:00Z'),
        serverDay: '2026-09-01',
      });
      await seedArmEvent(user.id, accountId, tradeId, { [conditionIds[0]]: true }, new Date('2026-09-01T08:59:00Z'));

      const { freezeTriggerEvaluationsForTrade } = await import('../freeze-trigger-evaluations');
      const frozenAt = new Date('2026-09-02T00:00:00Z');

      await db.query('begin');
      try {
        const first = await freezeTriggerEvaluationsForTrade(db as never, tradeId, { frozenAt });
        expect(first.evaluationsWritten).toBe(1);

        // Second call, same trade, same transaction -- exercises the
        // `on conflict (trade_id, condition_id) do nothing` clause for
        // real, against the live unique constraint, not a mock.
        const second = await freezeTriggerEvaluationsForTrade(db as never, tradeId, {
          frozenAt: new Date('2026-09-02T01:00:00Z'),
        });
        expect(second.applicableCount).toBe(1);
        // evaluationsWritten counts INSERT attempts issued, not rows
        // actually persisted (mirrors evaluateAndFreezeTradeRules's own
        // `written` counter) -- the real assertion of "did not duplicate"
        // is the row count and frozen_at check below, not this field.

        const rows = await db.query('select result, frozen_at from retrospeq.trigger_evaluations where trade_id = $1', [
          tradeId,
        ]);
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0].result).toBe('met');
        // frozen_at is from the FIRST call -- the second call's own
        // "on conflict do nothing" never touched the already-frozen row.
        expect(new Date(rows.rows[0].frozen_at).toISOString()).toBe(frozenAt.toISOString());
      } finally {
        await db.query('rollback');
      }
    },
    20_000,
  );
});
