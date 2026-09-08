import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Independent-verify (retrospeq-qa, Module 03 Slice 03f review) —
 * `executeErasure` against a real, frozen `retrospeq.trigger_evaluations`
 * row. `erasure.live.test.ts` (Module 01) does not seed one, and neither
 * `trigger-conditions-repository.live.test.ts` nor
 * `freeze-trigger-evaluations.live.test.ts` (both Module 03/04, this same
 * slice) exercises `executeErasure` at all — this is the first live test
 * proving the two paths compose.
 *
 * Why this is exactly the bug class `docs/adr/0010`'s 2026-09-02 addendum
 * (`fields`) and `deleteAllRulesForUser`'s own header (`rules`/
 * `rule_evaluations`) already found TWICE in this build: `trigger_evaluations`
 * has its own `BEFORE DELETE` trigger
 * (`trigger_evaluations_forbid_delete`, `20260909010000_trigger_evaluations_
 * schema.sql`) that rejects any delete unless `retrospeq.erasure_in_progress`
 * reads `'true'` on the SAME connection/transaction — and, unlike `fields`/
 * `rule_evaluations`, NOTHING in `lib/privacy/erasure.ts`'s explicit
 * step-3b delete list (`deleteAllRecoveryCodes`, `deleteAllTradingAccountsForUser`,
 * `deleteAllRulesForUser`, `deleteAllFieldsForUser`, `deleteSubscriptionForUser`)
 * mentions `trigger_evaluations` by name — confirmed by reading
 * `lib/privacy/erasure.ts` directly: no reference to
 * `trigger_evaluations`/`trigger_conditions` anywhere in that file.
 *
 * Whether this is a live regression or a structurally-safe reliance on an
 * EXISTING cascade is exactly what this test proves, live, rather than
 * assumed from reading code: `trigger_evaluations.trade_id references
 * trades(id) on delete cascade`, and `deleteAllTradingAccountsForUser`
 * (`lib/broker/accounts-repository.ts`) already explicitly deletes
 * `trading_accounts` (which cascades `trades`) with
 * `retrospeq.erasure_in_progress` set LOCAL to that same transaction —
 * `withRole`'s own `begin ... commit` wrapper (`lib/supabase/direct.ts`)
 * means that LOCAL flag stays visible for every cascade-originated delete
 * within that one transaction, including a trades -> trigger_evaluations
 * cascade two levels deep. If that reasoning holds, this test passes
 * cleanly; if it does not (e.g. because `trigger_conditions` -- deleted
 * later, via a DIFFERENT connection, GoTrue's own final
 * `auth.admin.deleteUser` cascade from `profiles` -- still holds a
 * `trigger_evaluations` row this account's own `deleteAllTradingAccountsForUser`
 * pass never reached), this test fails with the exact predicted trigger
 * error surfacing from inside `executeErasure`, per this review's own
 * dispatch instruction.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('executeErasure with a real frozen trigger_evaluations row (independent-verify, live DB)', () => {
  let db: Client;
  let originalDevFlag: string | undefined;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  beforeEach(() => {
    originalDevFlag = process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS;
    process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS = 'true';
  });

  afterAll(async () => {
    if (!env) return;
    if (originalDevFlag === undefined) delete process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS;
    else process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS = originalDevFlag;
    await db.end();
  });

  it(
    'succeeds for a user with a real frozen trigger_evaluations row, and the row is genuinely gone afterward',
    async () => {
      if (!env) return;
      const { requestErasure, executeErasure } = await import('../erasure');

      const user = await createTestAuthUser(env, 'erasure-trigger-eval');

      const accountRes = await db.query(
        `insert into retrospeq.trading_accounts
           (user_id, label, platform, base_currency, day_rollover)
         values ($1, 'Erasure Trigger-Eval Test Account', 'mt5', 'USD', '00:00:00 UTC')
         returning id`,
        [user.id],
      );
      const accountId = accountRes.rows[0].id;

      const blockRes = await db.query(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', now() - interval '2 hours', now() - interval '1 hour', current_date)
         returning id`,
        [user.id, accountId],
      );
      const blockId = blockRes.rows[0].id;

      const tradeRes = await db.query(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            currency, grouping_confidence)
         values ($1, $2, $3, 'EURUSD', 'long', now() - interval '2 hours', now() - interval '1 hour',
                 current_date, 'confirmed', 'USD', 'confident_single')
         returning id`,
        [user.id, accountId, blockId],
      );
      const tradeId = tradeRes.rows[0].id;

      const strategyRes = await db.query(
        `insert into retrospeq.strategies (user_id, name, current_version, state)
         values ($1, 'Erasure Trigger-Eval Test Strategy', 1, 'active') returning id`,
        [user.id],
      );
      const strategyId = strategyRes.rows[0].id;

      const conditionRes = await db.query(
        `insert into retrospeq.trigger_conditions (user_id, strategy_id, text)
         values ($1, $2, 'Price above the 20 EMA on the 5-minute') returning id`,
        [user.id, strategyId],
      );
      const conditionId = conditionRes.rows[0].id;

      const evalRes = await db.query(
        `insert into retrospeq.trigger_evaluations (user_id, trade_id, condition_id, result)
         values ($1, $2, $3, 'met') returning id`,
        [user.id, tradeId, conditionId],
      );
      const evaluationId = evalRes.rows[0].id;

      // Sanity check on the seed itself, mirroring
      // `erasure.live.test.ts`'s own "prove the hazard is real" pattern for
      // the confirmed-trade and derived-fields regression tests: confirm
      // the trigger genuinely blocks a direct delete outside the erasure
      // escape hatch, so this test proves the real path, not a scenario
      // that was never actually at risk.
      await expect(
        db.query('delete from retrospeq.trigger_evaluations where id = $1', [evaluationId]),
      ).rejects.toThrow(/cannot delete a frozen trigger evaluation/);

      const request = await requestErasure(user.id);
      await executeErasure(request.id, { bypassGracePeriod: true });

      const evalAfter = await db.query('select 1 from retrospeq.trigger_evaluations where id = $1', [
        evaluationId,
      ]);
      expect(evalAfter.rows).toHaveLength(0);

      const tradesAfter = await db.query('select 1 from retrospeq.trades where id = $1', [tradeId]);
      expect(tradesAfter.rows).toHaveLength(0);

      const conditionsAfter = await db.query(
        'select 1 from retrospeq.trigger_conditions where id = $1',
        [conditionId],
      );
      expect(conditionsAfter.rows).toHaveLength(0);

      const profileAfter = await db.query('select 1 from retrospeq.profiles where id = $1', [user.id]);
      expect(profileAfter.rows).toHaveLength(0);

      const { createServiceRoleClient } = await import('@/lib/supabase/service');
      const supabase = createServiceRoleClient();
      const { data, error } = await supabase.auth.admin.getUserById(user.id);
      expect(data.user).toBeNull();
      expect(error).not.toBeNull();

      await db
        .query(
          "delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1",
          [user.id],
        )
        .catch(() => {});
      await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
      await deleteTestAuthUser(env, user.id).catch(() => {});
    },
    30_000,
  );
});
