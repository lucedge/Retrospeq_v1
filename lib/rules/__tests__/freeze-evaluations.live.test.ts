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
 * Module 04 (Rulebook & Evaluation) Slice 5 — the freeze-wiring live-DB
 * proof. Per this slice's own dispatch: "genuinely the most important
 * test in Module 04 so far." Exercises the REAL confirm transaction
 * (`lib/ingestion/confirm.ts`'s `confirmDay`/`autoConfirmStaleTrades`),
 * against a real Postgres schema, proving §8.4's integration sequence as
 * far as this slice's own scope goes (adherence_weekly is Slice 6):
 *
 *   create rule -> log trades -> confirm -> rule_evaluations exist and are
 *   correct -> edit threshold -> confirm past adherence unchanged (the
 *   PAST trade's row is untouched) -> [promotion is Slice 7, not tested
 *   here] -> a state != 'active' rule produces zero new evaluations
 *   (the retire-equivalent this slice CAN test today, since the retire
 *   UI/API doesn't exist yet).
 *
 * Also proves, independently and directly (not just inferred from reading
 * the code): forward-only application (a rule created after a trade's
 * opened_at produces zero evaluations for it, for BOTH confirmDay and
 * autoConfirmStaleTrades), the exact-instant version-boundary resolution,
 * and session-rule attachment (§5.4 — "Max 3 trades per day" breaking on
 * the 4th trade's own row, self-inclusive count, per Slice 4's own already-
 * proven `computeDayWeekCounts` behaviour).
 *
 * Seeding convention matches `lib/ingestion/__tests__/confirm.live.test.ts`
 * (real auth users via the GoTrue admin API, direct SQL seeding of
 * blocks/trades, erasure-escape-hatch cleanup for trades) plus direct SQL
 * seeding of rules/rule_versions (rather than driving every rule through
 * `insertRuleAndVersion`/`applyRuleEdit`) specifically where a test needs
 * to control `created_at`/`superseded_at` precisely (the exact-boundary
 * tests) — `insertRuleAndVersion`/`applyRuleEdit` themselves are Slice 2's
 * own already-tested surface, not what this file is proving.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 04 Slice 5 — freeze-wiring (live DB)', () => {
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

  async function seedAccount(userId: string, syncTier: 't0' | 't1' | 't2' = 't0'): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier)
       values ($1, 'Freeze Live Test', 'mt5', 'USD', '00:00:00 UTC', $2)
       returning id`,
      [userId, syncTier],
    );
    return res.rows[0].id;
  }

  interface SeedTradeOverrides {
    instrument?: string;
    direction?: 'long' | 'short';
    status?: 'open' | 'closed' | 'confirmed';
    serverDay?: string;
    openedAt: Date | string;
    closedAt?: Date | null;
    initialRiskPct?: string | null;
    riskPct?: string | null;
    strategyId?: string | null;
  }

  /** Seeds a block + trade with sane defaults for a `risk_pct`-evaluable
   *  trade. `openedAt` may be a raw text string (already-captured
   *  microsecond-precision timestamptz text, for the exact-boundary
   *  tests) or a `Date`. */
  async function seedTrade(
    userId: string,
    accountId: string,
    overrides: SeedTradeOverrides,
  ): Promise<string> {
    const instrument = overrides.instrument ?? 'EURUSD';
    const direction = overrides.direction ?? 'long';
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
          grouping_confidence, strategy_id)
       values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9,
               '1.10000000', '1.10500000', '100000.00000000', '1.09000000', $10, $11, 'USD',
               'confident_single', $12)
       returning id`,
      [
        userId,
        accountId,
        blockId,
        instrument,
        direction,
        openedAtParam,
        closedAt ? closedAt.toISOString() : null,
        serverDay,
        status,
        initialRiskPct,
        riskPct,
        overrides.strategyId ?? null,
      ],
    );
    return tradeRes.rows[0].id;
  }

  /** Direct SQL rule + rule_version(1) seed -- lets a test set an exact
   *  `created_at`, which `insertRuleAndVersion` (Slice 2) does not expose
   *  (it always uses the DB's own `now()`). */
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
    'end-to-end: create rule -> confirm trade -> rule_evaluations row exists, correctly shaped and frozen',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-e2e');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const ruleCreatedAt = new Date('2026-08-01T00:00:00Z');
      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, ruleCreatedAt);

      const tradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        initialRiskPct: '1.500000',
      });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const now = new Date('2026-08-11T00:00:00Z');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => now });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([tradeId]);
      expect(result.ruleEvaluationAnomalies).toEqual([]);

      const evalRows = await db.query(
        `select user_id, rule_id, rule_version, severity, result, reason, observed, server_day::text as server_day, frozen_at
           from retrospeq.rule_evaluations where trade_id = $1`,
        [tradeId],
      );
      expect(evalRows.rows).toHaveLength(1);
      const row = evalRows.rows[0];
      expect(row.user_id).toBe(user.id);
      expect(row.rule_id).toBe(ruleId);
      expect(row.rule_version).toBe(1);
      expect(row.severity).toBe('soft');
      expect(row.result).toBe('followed');
      expect(row.reason).toBeNull();
      expect(row.observed).toBe(1.5);
      expect(row.server_day).toBe('2026-08-10');
      expect(new Date(row.frozen_at).toISOString()).toBe(now.toISOString());
    },
    20_000,
  );

  it(
    'forward-only (§8.2 property): a rule created AFTER a trade\'s opened_at produces ZERO evaluations for that trade -- confirmDay path',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-forward-only-confirmday');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const tradeOpenedAt = new Date('2026-08-10T09:00:00Z');
      const tradeId = await seedTrade(user.id, accountId, { openedAt: tradeOpenedAt });

      // Rule created AFTER the trade opened.
      await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-10T10:00:00Z'));

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([tradeId]);

      const evalRows = await db.query('select 1 from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
      expect(evalRows.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'forward-only (§8.2 property): same guarantee via the autoConfirmStaleTrades path',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-forward-only-auto');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const now = new Date('2026-08-20T00:00:00Z');
      const staleOpenedAt = new Date('2026-08-01T09:00:00Z');
      const staleClosedAt = new Date('2026-08-01T11:00:00Z');
      const tradeId = await seedTrade(user.id, accountId, {
        openedAt: staleOpenedAt,
        closedAt: staleClosedAt,
        serverDay: '2026-08-01',
      });

      // Rule created after the (long-since-opened) trade.
      await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-05T00:00:00Z'));

      const { autoConfirmStaleTrades } = await import('@/lib/ingestion/confirm');
      const result = await autoConfirmStaleTrades({ now: () => now });

      expect(result.tradesConfirmed).toContain(tradeId);
      expect(result.ruleEvaluationAnomalies).toEqual([]);

      const evalRows = await db.query('select 1 from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
      expect(evalRows.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'a rule created at the EXACT same instant a trade opened is eligible (inclusive forward-only boundary, trade.opened_at >= rule.created_at)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-boundary-created-at-equal');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const instant = new Date('2026-08-10T09:00:00.123456Z'); // JS Date truncates to ms, fine here -- see below
      // Seed the rule first, capture its own stored created_at as TEXT
      // (full precision, thanks to lib/supabase/pg-type-parsers.ts's
      // global timestamptz-as-text override) so the trade's opened_at can
      // be set to the EXACT same instant without any JS Date rounding.
      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, instant);
      const createdAtRow = await db.query<{ created_at: string }>(
        `select created_at from retrospeq.rules where id = $1`,
        [ruleId],
      );
      const exactCreatedAt = createdAtRow.rows[0].created_at;

      const tradeId = await seedTrade(user.id, accountId, { openedAt: exactCreatedAt });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });
      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');

      const evalRows = await db.query('select rule_id from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
      expect(evalRows.rows).toHaveLength(1);
      expect(evalRows.rows[0].rule_id).toBe(ruleId);
    },
    20_000,
  );

  it(
    'exact-instant supersession boundary: a trade opened at the EXACT instant a rule was edited resolves to the NEW version, not the old one (half-open [created_at, superseded_at) interval)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-boundary-superseded-equal');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'));

      // Edit via the real authoring-pipeline repository function (Slice 2)
      // -- both the supersede UPDATE and the new INSERT run inside ONE
      // transaction, so Postgres's own now() is identical for both writes.
      const { applyRuleEdit } = await import('@/lib/rules/rules-repository');
      await applyRuleEdit(user.id, ruleId, 1, 'risk_pct', 'lte', 1, 'test rule v2');

      const boundaryRow = await db.query<{ created_at: string }>(
        `select created_at from retrospeq.rule_versions where rule_id = $1 and version = 2`,
        [ruleId],
      );
      const exactBoundary = boundaryRow.rows[0].created_at;

      // Sanity: the old version's superseded_at is the SAME instant.
      const oldRow = await db.query<{ superseded_at: string }>(
        `select superseded_at from retrospeq.rule_versions where rule_id = $1 and version = 1`,
        [ruleId],
      );
      expect(oldRow.rows[0].superseded_at).toBe(exactBoundary);

      // Trade risk = 1.5: FOLLOWS v1 (lte 2), BREAKS v2 (lte 1) -- observed
      // result directly proves which version actually got applied.
      const tradeId = await seedTrade(user.id, accountId, { openedAt: exactBoundary, initialRiskPct: '1.500000' });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });
      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');

      const evalRows = await db.query(
        `select rule_version, result from retrospeq.rule_evaluations where trade_id = $1`,
        [tradeId],
      );
      expect(evalRows.rows).toHaveLength(1);
      expect(evalRows.rows[0].rule_version).toBe(2);
      expect(evalRows.rows[0].result).toBe('broken'); // v2's lte 1, not v1's lte 2
    },
    20_000,
  );

  it(
    'the version LIVE AT ENTRY applies, not the current version -- a trade opened before an edit is confirmed (and evaluated) after it',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-version-at-entry');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'));

      // Trade opens under v1 (lte 2), risk 1.5 -- would FOLLOW v1.
      const tradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-05T09:00:00Z'),
        closedAt: new Date('2026-08-05T11:00:00Z'),
        serverDay: '2026-08-05',
        initialRiskPct: '1.500000',
      });

      // THEN the rule is tightened to v2 (lte 1) -- would BREAK if
      // (incorrectly) applied to the already-opened trade above.
      const { applyRuleEdit } = await import('@/lib/rules/rules-repository');
      await applyRuleEdit(user.id, ruleId, 1, 'risk_pct', 'lte', 1, 'tightened');

      // Confirmation (and therefore evaluation) happens AFTER the edit.
      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const result = await confirmDay(accountId, '2026-08-05', { now: () => new Date('2026-08-06T00:00:00Z') });
      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');

      const evalRows = await db.query(
        `select rule_version, result, observed from retrospeq.rule_evaluations where trade_id = $1`,
        [tradeId],
      );
      expect(evalRows.rows).toHaveLength(1);
      // The version LIVE AT trade.opened_at (v1) applies, not current (v2).
      expect(evalRows.rows[0].rule_version).toBe(1);
      expect(evalRows.rows[0].result).toBe('followed');
      expect(evalRows.rows[0].observed).toBe(1.5);
      expect(ruleId).toBeTruthy();
    },
    20_000,
  );

  it(
    'frozen means frozen: editing a rule after a past trade is confirmed leaves that trade\'s already-written rule_evaluations row byte-for-byte unchanged',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-immutable-after-edit');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'));
      const tradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        initialRiskPct: '1.500000',
      });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const now = new Date('2026-08-11T00:00:00Z');
      const firstResult = await confirmDay(accountId, '2026-08-10', { now: () => now });
      expect(firstResult.confirmed).toBe(true);

      const before = await db.query(
        `select id, rule_id, rule_version, severity, result, reason, observed, server_day, frozen_at
           from retrospeq.rule_evaluations where trade_id = $1`,
        [tradeId],
      );
      expect(before.rows).toHaveLength(1);

      // Edit the rule's threshold (new version) AFTER the trade was
      // already confirmed and evaluated.
      const { applyRuleEdit } = await import('@/lib/rules/rules-repository');
      await applyRuleEdit(user.id, ruleId, 1, 'risk_pct', 'lte', 1, 'tightened after confirm');

      // Also promote the rule's severity -- §5.6: "Promoting a rule from
      // soft to hard must not retroactively reclassify last month's
      // breaks." This slice does not build promotion (Slice 7), but the
      // mutable `rules.severity` column already exists and is exactly
      // what a future promotion writes to -- simulate it directly and
      // prove THIS slice's own already-written row is unaffected.
      await db.query(`update retrospeq.rules set severity = 'hard', promoted_at = now() where id = $1`, [ruleId]);

      const after = await db.query(
        `select id, rule_id, rule_version, severity, result, reason, observed, server_day, frozen_at
           from retrospeq.rule_evaluations where trade_id = $1`,
        [tradeId],
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toEqual(before.rows[0]);
      // Explicitly re-assert severity stayed 'soft' on the FROZEN row even
      // though the live rule is now 'hard' -- the single most important
      // assertion this test makes.
      expect(after.rows[0].severity).toBe('soft');

      // And directly confirm no UPDATE to rule_evaluations is even
      // possible at the DB layer (the immutability trigger, Slice 1) --
      // belt-and-suspenders proof this isn't merely "nothing in this
      // slice happens to call UPDATE."
      await expect(
        db.query(`update retrospeq.rule_evaluations set result = 'broken' where trade_id = $1`, [tradeId]),
      ).rejects.toThrow(/frozen at write, never updated/);
    },
    20_000,
  );

  it(
    'frozen means frozen under SEVERITY PROMOTION ALONE (§5.6): a soft-severity frozen evaluation keeps severity=\'soft\' after the rule is later promoted to \'hard\', with no other mutation (threshold untouched) muddying the attribution',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-immutable-promotion-only');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // Deliberately `severity: 'soft'` explicit (matches the default, but
      // stated for clarity -- this test's whole point is what happens to a
      // SOFT frozen row once the rule becomes HARD).
      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'), {
        severity: 'soft',
      });
      const tradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        initialRiskPct: '1.500000',
      });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const now = new Date('2026-08-11T00:00:00Z');
      const firstResult = await confirmDay(accountId, '2026-08-10', { now: () => now });
      expect(firstResult.confirmed).toBe(true);

      const before = await db.query(
        `select id, rule_id, rule_version, severity, result, reason, observed, server_day, frozen_at
           from retrospeq.rule_evaluations where trade_id = $1`,
        [tradeId],
      );
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0].severity).toBe('soft');

      // Promote the RULE's current severity to 'hard' -- and ONLY that.
      // No threshold edit, no new rule_version -- isolating the promotion
      // guarantee from the separate "frozen means frozen under a threshold
      // edit" test above, per this slice's own review dispatch: this
      // guarantee deserves its own direct test, not just inference from a
      // test that also happens to edit the threshold at the same time.
      // Slice 7 hasn't built the promotion UI/API yet, so simulate the
      // exact write a future promotion flow will perform: a direct UPDATE
      // to `rules.severity` (the same mutable column §5.7's promotion
      // transition targets).
      await db.query(`update retrospeq.rules set severity = 'hard', promoted_at = now() where id = $1`, [ruleId]);

      const ruleAfterPromotion = await db.query<{ severity: string }>(
        `select severity from retrospeq.rules where id = $1`,
        [ruleId],
      );
      expect(ruleAfterPromotion.rows[0].severity).toBe('hard');

      const after = await db.query(
        `select id, rule_id, rule_version, severity, result, reason, observed, server_day, frozen_at
           from retrospeq.rule_evaluations where trade_id = $1`,
        [tradeId],
      );
      expect(after.rows).toHaveLength(1);
      // The frozen row is byte-for-byte identical to before promotion --
      // including `severity`, which stays 'soft' even though the LIVE rule
      // is now 'hard'. This is §5.6's exact guarantee: "Promoting a rule
      // from soft to hard must not retroactively reclassify last month's
      // breaks."
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect(after.rows[0].severity).toBe('soft');
    },
    20_000,
  );

  it(
    'a rule with state != \'active\' (the retire-equivalent this slice can test without Slice 7\'s UI) produces zero evaluations',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-retired-rule');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'), { state: 'retired' });
      const tradeId = await seedTrade(user.id, accountId, { openedAt: new Date('2026-08-10T09:00:00Z') });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });
      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');

      const evalRows = await db.query('select 1 from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
      expect(evalRows.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'session-rule attachment (§5.4): "max 3 trades/day" breaks on the 4th trade\'s own row, self-inclusive count (Slice 4\'s own established computeDayWeekCounts semantics) -- no separate session-violation object',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-session-rule');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      await seedGlobalRule(user.id, 'trades_today', 'lte', 3, new Date('2026-08-01T00:00:00Z'));

      const tradeIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const hour = String(9 + i).padStart(2, '0');
        const openedAt = new Date(`2026-08-10T${hour}:00:00Z`);
        const closedAt = new Date(`2026-08-10T${hour}:30:00Z`);
        const tradeId = await seedTrade(user.id, accountId, {
          instrument: i % 2 === 0 ? 'EURUSD' : 'GBPUSD',
          openedAt,
          closedAt,
        });
        tradeIds.push(tradeId);
      }

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });
      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toHaveLength(4);

      const rows = await db.query<{ trade_id: string; result: string; observed: number }>(
        `select trade_id, result, observed from retrospeq.rule_evaluations where trade_id = any($1::uuid[]) order by trade_id`,
        [tradeIds],
      );
      expect(rows.rows).toHaveLength(4);

      const byTradeId = new Map(rows.rows.map((r) => [r.trade_id, r]));
      // First 3 trades: trades_today observed as 1, 2, 3 respectively (this
      // repo's own established self-inclusive counting,
      // cross-trade-operand-values.ts's computeDayWeekCounts) -- all follow
      // lte 3.
      expect(byTradeId.get(tradeIds[0])!.observed).toBe(1);
      expect(byTradeId.get(tradeIds[0])!.result).toBe('followed');
      expect(byTradeId.get(tradeIds[1])!.observed).toBe(2);
      expect(byTradeId.get(tradeIds[1])!.result).toBe('followed');
      expect(byTradeId.get(tradeIds[2])!.observed).toBe(3);
      expect(byTradeId.get(tradeIds[2])!.result).toBe('followed');
      // The 4th trade: trades_today = 4 (self-inclusive), breaks lte 3 --
      // the break attaches to THIS trade's own row, no separate object.
      expect(byTradeId.get(tradeIds[3])!.observed).toBe(4);
      expect(byTradeId.get(tradeIds[3])!.result).toBe('broken');
    },
    20_000,
  );

  it(
    'both confirmDay and autoConfirmStaleTrades share the SAME evaluation logic (identical rule_evaluations row for an otherwise-identical trade, differing only in which path confirmed it)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-shared-logic');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'));

      // Trade A: confirmed via confirmDay (fresh, closed today).
      const tradeAId = await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        closedAt: new Date('2026-08-10T11:00:00Z'),
        serverDay: '2026-08-10',
        initialRiskPct: '1.500000',
      });

      // Trade B: confirmed via autoConfirmStaleTrades (closed 8 days ago).
      // Deliberately off-round-number timestamps (not a bare midnight on a
      // round date) -- `autoConfirmStaleTrades` scans EVERY account/user in
      // one call, by design (no per-test scoping is possible, or should
      // be -- it is a genuine global background sweep), so other live test
      // files running in parallel against the same shared dev DB (e.g.
      // confirm.live.test.ts's own "7-day threshold" test) can race THIS
      // test's own call and legitimately win the confirmation first if the
      // cutoffs collide on a common round date. The assertion below checks
      // final DB state (was trade B actually auto-confirmed with correct
      // evaluations by *a* sweep), not which specific invocation's return
      // array happened to list it -- the thing this test is actually
      // proving (shared evaluation logic) holds either way.
      const now = new Date('2026-08-19T13:37:00Z');
      const staleOpenedAt = new Date('2026-08-11T09:00:00Z');
      const staleClosedAt = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
      const tradeBId = await seedTrade(user.id, accountId, {
        openedAt: staleOpenedAt,
        closedAt: staleClosedAt,
        serverDay: '2026-08-11',
        initialRiskPct: '1.500000',
      });

      const { confirmDay, autoConfirmStaleTrades } = await import('@/lib/ingestion/confirm');
      const dayResult = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-10T23:00:00Z') });
      expect(dayResult.confirmed).toBe(true);
      if (!dayResult.confirmed) throw new Error('unreachable');
      expect(dayResult.tradesConfirmed).toEqual([tradeAId]);

      // Retry the sweep a couple of times in case a concurrent, unrelated
      // sweep from another test file wins the race on this exact trade
      // between our own SELECT and UPDATE -- see comment above. Each call
      // is itself idempotent/safe (confirm.ts's own atomic guards).
      for (let attempt = 0; attempt < 3; attempt++) {
        await autoConfirmStaleTrades({ now: () => now });
        const check = await db.query<{ confirmed_by: string | null }>('select confirmed_by from retrospeq.trades where id = $1', [
          tradeBId,
        ]);
        if (check.rows[0]?.confirmed_by === 'auto_7d') break;
      }
      const tradeBRow = await db.query<{ status: string; confirmed_by: string | null }>(
        'select status, confirmed_by from retrospeq.trades where id = $1',
        [tradeBId],
      );
      expect(tradeBRow.rows[0].status).toBe('confirmed');
      expect(tradeBRow.rows[0].confirmed_by).toBe('auto_7d');

      const rows = await db.query<{ trade_id: string; result: string; severity: string; observed: number; reason: string | null }>(
        `select trade_id, result, severity, observed, reason from retrospeq.rule_evaluations where trade_id = any($1::uuid[]) order by trade_id`,
        [[tradeAId, tradeBId]],
      );
      expect(rows.rows).toHaveLength(2);
      const [rowA, rowB] = [tradeAId, tradeBId].map((id) => rows.rows.find((r) => r.trade_id === id)!);
      expect(rowA.result).toBe(rowB.result);
      expect(rowA.severity).toBe(rowB.severity);
      expect(rowA.observed).toBe(rowB.observed);
      expect(rowA.reason).toBe(rowB.reason);
      expect(rowA.result).toBe('followed');
    },
    20_000,
  );

  it(
    'a genuinely malformed rule_versions row (operand_id not in the catalogue) is skipped with an anomaly, never blocks confirmation of the day or the trade\'s other evaluations',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-corrupted-operand');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // Corrupted rule: bypasses the application-layer catalogue check
      // entirely (direct SQL, same as a hypothetical future catalogue
      // edit that drops an operand id still referenced by old data).
      const corruptRuleId = await seedGlobalRule(user.id, 'this_operand_does_not_exist', 'lte', 1, new Date('2026-08-01T00:00:00Z'));
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
          expect.objectContaining({ tradeId, ruleId: corruptRuleId, code: 'UNKNOWN_OPERAND' }),
        ]);
        expect(consoleErrorSpy).toHaveBeenCalled();

        const rows = await db.query('select rule_id, result from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0].rule_id).toBe(goodRuleId);
        expect(rows.rows[0].result).toBe('followed');
      } finally {
        consoleErrorSpy.mockRestore();
      }
    },
    20_000,
  );

  it(
    'RLS: the confirming trader can SELECT their own frozen rule_evaluations rows; a second user sees none of them',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-rls-owner');
      const otherUser = await createTestAuthUser(env, 'freeze-rls-other');
      cleanupUserIds.push(user.id, otherUser.id);
      const accountId = await seedAccount(user.id);

      await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'));
      const tradeId = await seedTrade(user.id, accountId, { openedAt: new Date('2026-08-10T09:00:00Z') });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });

      const { asRole } = await import('@/lib/supabase/__tests__/rls-test-helpers');
      const ownerVisible = await asRole(db, 'authenticated', user.id, async (client) => {
        const res = await client.query('select 1 from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
        return res.rows.length;
      });
      const otherVisible = await asRole(db, 'authenticated', otherUser.id, async (client) => {
        const res = await client.query('select 1 from retrospeq.rule_evaluations where trade_id = $1', [tradeId]);
        return res.rows.length;
      });
      expect(ownerVisible).toBe(1);
      expect(otherVisible).toBe(0);
    },
    20_000,
  );
});
