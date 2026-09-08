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
 * Independent-verify (retrospeq-qa, Module 03 Slice 03f review) — item 3's
 * own "force a failure partway through and confirm nothing partial gets
 * committed" instruction, exercised directly rather than only read from
 * `confirm.ts`'s source (which already shows `freezeTriggerEvaluationsForTrade`
 * called with the SAME `client` `evaluateAndFreezeTradeRules` uses, both
 * inside ONE `withServiceRoleConnection` transaction). This test forces a
 * REAL failure inside `freezeTriggerEvaluationsForTrade`'s own INSERT (an
 * FK violation: `strategy_versions.triggers` names a `condition_id` that
 * does not exist in `trigger_conditions` — a real, if adversarial, data
 * shape) and proves the entire `confirmDay` transaction — including the
 * trade's own `confirmed_at`/`status` UPDATE and `evaluateAndFreezeTradeRules`'s
 * `rule_evaluations` writes for the SAME trade, plus `day_closeouts` — rolls
 * back completely, not partially.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('freezeTriggerEvaluationsForTrade atomicity with confirmDay (independent-verify, live DB)', () => {
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
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.arm_events where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query('delete from retrospeq.day_closeouts where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 60_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it(
    'a strategy_versions.triggers snapshot naming a nonexistent condition_id aborts the WHOLE confirmDay transaction -- no partial trade confirmation, no partial rule_evaluations, no day_closeouts row',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'trigger-freeze-atomic');
      cleanupUserIds.push(user.id);

      const accountRes = await db.query<{ id: string }>(
        `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
         values ($1, 'Trigger Freeze Atomicity Test', 'mt5', 'USD', '00:00:00 UTC') returning id`,
        [user.id],
      );
      const accountId = accountRes.rows[0].id;

      const stratRes = await db.query<{ id: string }>(
        `insert into retrospeq.strategies (user_id, name, current_version) values ($1, 'Atomicity Test Strategy', 1) returning id`,
        [user.id],
      );
      const strategyId = stratRes.rows[0].id;

      // Deliberately NOT inserting a real trigger_conditions row for this
      // id -- strategy_versions.triggers is a jsonb snapshot with no FK
      // enforcement of its own contents (§3.1's own [{condition_id, text,
      // order}] shape), so this is a real, reachable data shape (e.g. a
      // condition retired/renumbered between authoring and this version
      // snapshot being read back), not a synthetic impossibility.
      const ghostConditionId = '00000000-0000-0000-0000-0000000000ff';
      await db.query(
        `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
         values ($1, 1, $2, 'Atomicity Test Strategy', '[]'::jsonb, $3::jsonb)`,
        [
          strategyId,
          user.id,
          JSON.stringify([{ condition_id: ghostConditionId, text: 'Ghost condition', order: 1 }]),
        ],
      );

      const openedAt = new Date('2026-09-01T09:00:00Z');
      const closedAt = new Date('2026-09-01T10:00:00Z');
      const blockRes = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, '2026-09-01')
         returning id`,
        [user.id, accountId, openedAt.toISOString(), closedAt.toISOString()],
      );
      const blockId = blockRes.rows[0].id;

      const tradeRes = await db.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence, strategy_id, strategy_version)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, '2026-09-01', 'closed',
                 '1.10000000', '1.10500000', '100000.00000000', 'USD', 'confident_single', $6, 1)
         returning id`,
        [user.id, accountId, blockId, openedAt.toISOString(), closedAt.toISOString(), strategyId],
      );
      const tradeId = tradeRes.rows[0].id;

      // Sanity check: prove the ghost condition_id genuinely produces an
      // FK violation when freezeTriggerEvaluationsForTrade attempts to
      // insert against it directly (isolated from confirmDay), so the
      // rollback assertion below is proven against a real, reproducing
      // failure, not a scenario that was never actually going to throw.
      const { freezeTriggerEvaluationsForTrade } = await import('../freeze-trigger-evaluations');
      await db.query('begin');
      try {
        await expect(
          freezeTriggerEvaluationsForTrade(db as never, tradeId, { frozenAt: new Date() }),
        ).rejects.toThrow(/foreign key|violates/i);
      } finally {
        await db.query('rollback');
      }

      // The real thing under test: confirmDay's own transaction, which
      // calls freezeTriggerEvaluationsForTrade with the exact same
      // ghost-referencing strategy_version snapshot as a side effect of
      // confirming this trade.
      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const now = new Date('2026-09-02T00:00:00Z');
      await expect(confirmDay(accountId, '2026-09-01', { now: () => now })).rejects.toThrow(
        /foreign key|violates/i,
      );

      // --- Nothing partial committed -----------------------------------
      const tradeAfter = await db.query(
        'select status, confirmed_at from retrospeq.trades where id = $1',
        [tradeId],
      );
      expect(tradeAfter.rows[0].status).toBe('closed'); // NOT 'confirmed'
      expect(tradeAfter.rows[0].confirmed_at).toBeNull();

      const ruleEvalsAfter = await db.query(
        'select 1 from retrospeq.rule_evaluations where trade_id = $1',
        [tradeId],
      );
      expect(ruleEvalsAfter.rows).toHaveLength(0);

      const triggerEvalsAfter = await db.query(
        'select 1 from retrospeq.trigger_evaluations where trade_id = $1',
        [tradeId],
      );
      expect(triggerEvalsAfter.rows).toHaveLength(0);

      const closeoutAfter = await db.query(
        'select 1 from retrospeq.day_closeouts where account_id = $1 and server_day = $2',
        [accountId, '2026-09-01'],
      );
      expect(closeoutAfter.rows).toHaveLength(0);
    },
    30_000,
  );
});
