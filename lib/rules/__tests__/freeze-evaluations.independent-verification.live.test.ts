import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { withServiceRoleConnection } from '@/lib/supabase/direct';

vi.mock('server-only', () => ({}));

/**
 * Independent tester-authored verification of Module 04 Slice 5
 * (`lib/rules/freeze-evaluations.ts`), written from scratch against the
 * dispatch's own adversarial scenarios rather than reusing the coder's
 * fixtures verbatim (`freeze-evaluations.live.test.ts` already covers
 * overlapping ground; this file exists specifically to NOT trust that
 * file's own framing and construct independent cases for the items the
 * dispatch called out as easiest to get backwards):
 *
 *   2. Forward-only application, a fresh case: several trades already
 *      exist BEFORE a rule is created; confirm them; assert zero
 *      rule_evaluations rows for that rule on those trades.
 *   3. "Version live at entry", adversarial: a trade opens, THEN the rule
 *      is edited TWICE (v1 -> v2 -> v3) before the trade is ever
 *      confirmed. Assert the frozen evaluation uses v1, not v3.
 *   5. Idempotent re-confirm / double-invocation safety: call
 *      evaluateAndFreezeTradeRules TWICE directly for the same
 *      already-frozen trade inside one transaction and assert the second
 *      call is a safe no-op (no duplicate/conflicting row), independent
 *      of confirm.ts's own outer guard.
 *   6. A second, independently-constructed corrupted-rule scenario: a
 *      malformed op/value combination (not the unknown-operand-id case
 *      the coder's own file already covers) still resolves to a loud,
 *      logged anomaly, never blocks the trade's other evaluations.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 04 Slice 5 — independent verification (live DB)', () => {
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

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier)
       values ($1, 'Independent Verify', 'mt5', 'USD', '00:00:00 UTC', 't0')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  interface SeedTradeOverrides {
    instrument?: string;
    status?: 'open' | 'closed' | 'confirmed';
    serverDay?: string;
    openedAt: Date | string;
    closedAt?: Date | null;
    initialRiskPct?: string | null;
    riskPct?: string | null;
  }

  async function seedTrade(userId: string, accountId: string, overrides: SeedTradeOverrides): Promise<string> {
    const instrument = overrides.instrument ?? 'EURUSD';
    const status = overrides.status ?? 'closed';
    const openedAtParam = overrides.openedAt instanceof Date ? overrides.openedAt.toISOString() : overrides.openedAt;
    const closedAt = overrides.closedAt === undefined ? new Date('2026-08-10T11:00:00Z') : overrides.closedAt;
    const serverDay = overrides.serverDay ?? '2026-08-10';
    const initialRiskPct = overrides.initialRiskPct === undefined ? '1.500000' : overrides.initialRiskPct;
    const riskPct = overrides.riskPct === undefined ? initialRiskPct : overrides.riskPct;

    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4::timestamptz, $5, $4::date)
       returning id`,
      [userId, accountId, instrument, openedAtParam, closedAt ? closedAt.toISOString() : null],
    );
    const blockId = blockRes.rows[0].id;

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
          grouping_confidence)
       values ($1, $2, $3, $4, 'long', $5::timestamptz, $6, $7, $8,
               '1.10000000', '1.10500000', '100000.00000000', '1.09000000', $9, $10, 'USD',
               'confident_single')
       returning id`,
      [
        userId,
        accountId,
        blockId,
        instrument,
        openedAtParam,
        closedAt ? closedAt.toISOString() : null,
        serverDay,
        status,
        initialRiskPct,
        riskPct,
      ],
    );
    return tradeRes.rows[0].id;
  }

  async function seedGlobalRule(
    userId: string,
    operandId: string,
    op: string,
    value: unknown,
    createdAt: Date | string,
    overrides: { severity?: 'soft' | 'hard'; state?: 'active' | 'retired' | 'deactivated_by_plan' } = {},
  ): Promise<string> {
    const createdAtParam = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state, created_at)
       values ($1, 1, 'global', $2, 'authored', 'pre_entry', $3, $4::timestamptz)
       returning id`,
      [userId, overrides.severity ?? 'soft', overrides.state ?? 'active', createdAtParam],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered, created_at)
       values ($1, 1, $2, $3, $4, $5::jsonb, 'test rule', $6::timestamptz)`,
      [ruleId, userId, operandId, op, JSON.stringify(value), createdAtParam],
    );
    return ruleId;
  }

  it(
    '[independent, item 2] forward-only: THREE trades already exist (opened before the rule), rule is created AFTER, THEN the trades are confirmed -- zero rule_evaluations rows for that rule on any of them',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'iv-forward-only');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // Three trades opened and closed on three different days, all
      // strictly before the rule will be created -- left UNCONFIRMED for
      // now, so the eligibility predicate genuinely has a rule to check
      // against once confirmDay runs (not merely "no rule existed yet").
      const tradeIds: string[] = [];
      for (const day of ['2026-07-01', '2026-07-02', '2026-07-03']) {
        const tradeId = await seedTrade(user.id, accountId, {
          openedAt: new Date(`${day}T09:00:00Z`),
          closedAt: new Date(`${day}T11:00:00Z`),
          serverDay: day,
        });
        tradeIds.push(tradeId);
      }

      // Rule created AFTER all three trades were opened, but BEFORE they
      // are confirmed -- this is the case that actually exercises
      // eligible()'s `trade.opened_at >= rule.created_at` predicate: the
      // rule genuinely exists and is 'active' at confirm time, so a bug
      // that dropped the forward-only clause would show up here as three
      // unwanted rows, not merely "no rule to evaluate against."
      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-07-10T00:00:00Z'));

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      for (const day of ['2026-07-01', '2026-07-02', '2026-07-03']) {
        const result = await confirmDay(accountId, day, { now: () => new Date('2026-07-20T00:00:00Z') });
        expect(result.confirmed).toBe(true);
      }

      // Directly assert zero evaluations exist for this rule against any
      // of the three trades, even though the rule is active and the
      // trades are now confirmed.
      const rows = await db.query(
        `select 1 from retrospeq.rule_evaluations where rule_id = $1 and trade_id = any($2::uuid[])`,
        [ruleId, tradeIds],
      );
      expect(rows.rows).toHaveLength(0);
    },
    30_000,
  );

  it(
    '[independent, item 3] adversarial version-at-entry: trade opens, THEN rule is edited TWICE (v1->v2->v3) before confirmation -- frozen evaluation uses v1, not v3',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'iv-version-double-edit');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // v1: risk_pct lte 5 (loose) -- trade risk of 1.5 follows v1, v2, AND v3
      // (all three thresholds admit 1.5), so a naive "wrong version" bug
      // would be invisible via result alone -- this test instead asserts
      // directly on rule_version and the exact threshold value each
      // version carries, which cannot be faked by an accidental "followed"
      // match at any version.
      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 5, new Date('2026-08-01T00:00:00Z'));

      // Trade opens while v1 is live.
      const tradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-05T09:00:00Z'),
        closedAt: new Date('2026-08-05T11:00:00Z'),
        serverDay: '2026-08-05',
        initialRiskPct: '1.500000',
      });

      const { applyRuleEdit } = await import('@/lib/rules/rules-repository');
      // v1 -> v2 (still admits 1.5, threshold tightened to 3).
      await applyRuleEdit(user.id, ruleId, 1, 'risk_pct', 'lte', 3, 'edit 1');
      // v2 -> v3 (tightened again, threshold 0.5 -- would BREAK if this
      // version were incorrectly applied to the trade above).
      await applyRuleEdit(user.id, ruleId, 2, 'risk_pct', 'lte', 0.5, 'edit 2');

      const versionsRes = await db.query<{ version: number }>(
        `select version from retrospeq.rule_versions where rule_id = $1 order by version`,
        [ruleId],
      );
      expect(versionsRes.rows.map((r) => r.version)).toEqual([1, 2, 3]);

      // Confirmation (and therefore evaluation) happens AFTER both edits.
      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const result = await confirmDay(accountId, '2026-08-05', { now: () => new Date('2026-08-06T00:00:00Z') });
      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');

      const evalRows = await db.query<{ rule_version: number; result: string; observed: number }>(
        `select rule_version, result, observed from retrospeq.rule_evaluations where trade_id = $1`,
        [tradeId],
      );
      expect(evalRows.rows).toHaveLength(1);
      // The version LIVE AT trade.opened_at is v1 (lte 5) -- NOT v3
      // (current, lte 0.5), and NOT v2 either.
      expect(evalRows.rows[0].rule_version).toBe(1);
      expect(evalRows.rows[0].result).toBe('followed');
      expect(evalRows.rows[0].observed).toBe(1.5);

      // Direct cross-check: fetch v1's own stored value from rule_versions
      // and confirm it really is 5, so this assertion isn't trusting a
      // fixture constant alone.
      const v1Row = await db.query<{ value: number }>(
        `select value from retrospeq.rule_versions where rule_id = $1 and version = 1`,
        [ruleId],
      );
      expect(v1Row.rows[0].value).toBe(5);
    },
    30_000,
  );

  it(
    '[independent, item 5] idempotent re-confirm safety: calling evaluateAndFreezeTradeRules TWICE directly for the same trade never produces a duplicate/conflicting row',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'iv-double-invoke');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'));
      const tradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        initialRiskPct: '1.500000',
      });

      const { evaluateAndFreezeTradeRules } = await import('@/lib/rules/freeze-evaluations');

      const frozenAt = new Date('2026-08-11T00:00:00Z');
      // Call it TWICE inside the SAME transaction, directly, bypassing
      // confirm.ts's own outer "and confirmed_at is null" guard entirely
      // -- proving the safety comes from unique(trade_id, rule_id) + ON
      // CONFLICT DO NOTHING at THIS layer, not merely from the caller
      // never re-entering in practice.
      const [firstResult, secondResult] = await withServiceRoleConnection(async (client) => {
        const first = await evaluateAndFreezeTradeRules(client, tradeId, { frozenAt });
        const second = await evaluateAndFreezeTradeRules(client, tradeId, {
          frozenAt: new Date('2026-08-12T00:00:00Z'), // deliberately different frozenAt
        });
        return [first, second];
      });

      expect(firstResult.evaluationsWritten).toBe(1);
      expect(firstResult.anomalies).toEqual([]);
      // Second call must not throw, and must not report writing a second
      // conflicting row.
      expect(secondResult.anomalies).toEqual([]);

      const rows = await db.query(
        `select rule_id, frozen_at from retrospeq.rule_evaluations where trade_id = $1`,
        [tradeId],
      );
      // Exactly ONE row, ever -- unique(trade_id, rule_id) + ON CONFLICT
      // DO NOTHING means the second call's attempted insert is silently
      // absorbed, never a second row and never an error.
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].rule_id).toBe(ruleId);
      // The row's frozen_at is the FIRST call's timestamp, never
      // overwritten by the second call's different frozenAt -- proves the
      // second call did not silently update the existing row either (ON
      // CONFLICT DO NOTHING, not DO UPDATE).
      expect(new Date(rows.rows[0].frozen_at).toISOString()).toBe(frozenAt.toISOString());
    },
    30_000,
  );

  it(
    '[independent, item 6] a second, independently-constructed corrupted-rule scenario: a malformed op for the operand type (not the unknown-operand-id case) resolves to a loud anomaly, never blocks the trade\'s other rule',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'iv-malformed-op');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // risk_pct is type "number" -- "is_true" is only valid for a "bool"
      // operand. Seeded directly via SQL (bypasses the authoring
      // pipeline's own validation, simulating corrupted/legacy data),
      // independent of the coder's own "this_operand_does_not_exist" case.
      const corruptRuleId = await seedGlobalRule(user.id, 'risk_pct', 'is_true', true, new Date('2026-08-01T00:00:00Z'));
      const goodRuleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'));

      const tradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        initialRiskPct: '1.500000',
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { confirmDay } = await import('@/lib/ingestion/confirm');
        const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });

        expect(result.confirmed).toBe(true);
        if (!result.confirmed) throw new Error('unreachable -- a malformed rule must never block confirmation');
        expect(result.tradesConfirmed).toEqual([tradeId]);
        expect(result.ruleEvaluationAnomalies).toEqual([
          expect.objectContaining({ tradeId, ruleId: corruptRuleId, code: 'INVALID_OP_FOR_TYPE' }),
        ]);
        expect(consoleErrorSpy).toHaveBeenCalled();

        const rows = await db.query('select rule_id, result from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0].rule_id).toBe(goodRuleId);
        expect(rows.rows[0].result).toBe('followed');

        // Trade itself really is confirmed, not left in limbo.
        const tradeRow = await db.query<{ status: string; confirmed_at: string | null }>(
          'select status, confirmed_at from retrospeq.trades where id = $1',
          [tradeId],
        );
        expect(tradeRow.rows[0].status).toBe('confirmed');
        expect(tradeRow.rows[0].confirmed_at).not.toBeNull();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    },
    30_000,
  );

  it(
    '[independent, item 4c] raw SQL DELETE against a frozen rule_evaluations row is rejected by the immutability trigger, even attempted directly, outside erasure',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'iv-delete-blocked');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'));
      const tradeId = await seedTrade(user.id, accountId, { openedAt: new Date('2026-08-10T09:00:00Z') });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });
      expect(result.confirmed).toBe(true);

      const before = await db.query('select 1 from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
      expect(before.rows).toHaveLength(1);

      await expect(
        db.query('delete from retrospeq.rule_evaluations where trade_id = $1', [tradeId]),
      ).rejects.toThrow(/cannot delete a frozen evaluation/);

      const after = await db.query('select 1 from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
      expect(after.rows).toHaveLength(1);
    },
    30_000,
  );
});
