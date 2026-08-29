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
 * Module 04 (Rulebook & Evaluation) §5.10 / story 1.4, Slice 10a — live-DB
 * proof for `lib/rules/guided-front-door.ts`'s `seedGuidedRuleThresholds`
 * against a REAL `operand_distributions` row (via the real
 * `recomputeOperandDistributionsForUser` pipeline, Slice 3/9 — never
 * hand-inserted rows that could drift from what that pipeline actually
 * writes) and a REAL `rules`/`rule_versions` row for the `alreadyGoverned`
 * check. Same seeding/cleanup conventions as
 * `distributions-repository.live.test.ts`.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/rules/guided-front-door.ts (live DB)', () => {
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
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
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

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Guided Front Door Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedConfirmedTrade(userId: string, accountId: string, initialRiskPct: string, day: string): Promise<void> {
    const openedAt = new Date(`${day}T09:00:00Z`);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, openedAt.toISOString()],
    );
    await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          initial_stop, initial_risk_pct, risk_pct, confirmed_at, confirmed_by)
       values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$4::timestamptz,$5,'confirmed',
               '1.20000000','1.20500000','100000.00000000','USD','confident_single',
               '1.19800000',$6,$6,$4::timestamptz,'user')`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), day, initialRiskPct],
    );
  }

  it(
    'risk_pct seeds from REAL history at the 80th percentile once recomputeOperandDistributionsForUser has run, and falls back to the bounds midpoint for an operand with no seedable history',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'guided-front-door');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // 16 trades at 1.0% risk, 4 at 2.0% -- n=20 (exactly
      // MIN_TRADES_FOR_PREVIEW), 80th percentile (target 16) lands
      // exactly on the first bucket -- 1.0 -- by construction, matching
      // the mocked unit test's own hand-computed scenario, now proven
      // against the real bucketing pipeline instead of a fabricated row.
      let day = 1;
      for (let i = 0; i < 16; i++) {
        await seedConfirmedTrade(user.id, accountId, '1.0', `2026-08-${String((day % 27) + 1).padStart(2, '0')}`);
        day++;
      }
      for (let i = 0; i < 4; i++) {
        await seedConfirmedTrade(user.id, accountId, '2.0', `2026-08-${String((day % 27) + 1).padStart(2, '0')}`);
        day++;
      }

      const { recomputeOperandDistributionsForUser } = await import('../distributions-repository');
      const recompute = await recomputeOperandDistributionsForUser(user.id);
      expect(recompute.tradesScanned).toBe(20);

      const { seedGuidedRuleThresholds } = await import('../guided-front-door');
      const seeds = await seedGuidedRuleThresholds(user.id);

      const riskPct = seeds.find((s) => s.operandId === 'risk_pct')!;
      expect(riskPct.seedBasis).toBe('history');
      expect(riskPct.historyN).toBe(20);
      expect(riskPct.seedValue).toBe(1.0);
      expect(riskPct.alreadyGoverned).toBe(false);

      // daily_loss_pct: this account has no starting_equity configured
      // (docs/adr/0013), so its distribution row is genuinely n=0 —
      // falls back honestly to the bounds midpoint, not a bug.
      const dailyLoss = seeds.find((s) => s.operandId === 'daily_loss_pct')!;
      expect(dailyLoss.seedBasis).toBe('bounds_midpoint');
      expect(dailyLoss.historyN).toBe(0);
      expect(dailyLoss.seedValue).toBe(5.5);
    },
    20_000,
  );

  it('alreadyGoverned is true (with the real rendered sentence) once a real active global rule exists for that operand, and does not affect the other two operands', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'guided-front-door-governed');
    cleanupUserIds.push(user.id);

    const { insertRuleAndVersion } = await import('../rules-repository');
    await insertRuleAndVersion({
      userId: user.id,
      operandId: 'risk_pct',
      op: 'lte',
      value: 1.5,
      scope: 'global',
      scopeId: null,
      evaluation: 'pre_entry',
      rendered: 'Never risk more than 1.5% per trade.',
    });

    const { seedGuidedRuleThresholds } = await import('../guided-front-door');
    const seeds = await seedGuidedRuleThresholds(user.id);

    const riskPct = seeds.find((s) => s.operandId === 'risk_pct')!;
    expect(riskPct.alreadyGoverned).toBe(true);
    expect(riskPct.existingRuleRendered).toBe('Never risk more than 1.5% per trade.');

    const dailyLoss = seeds.find((s) => s.operandId === 'daily_loss_pct')!;
    expect(dailyLoss.alreadyGoverned).toBe(false);
    const consecutiveLosses = seeds.find((s) => s.operandId === 'consecutive_losses')!;
    expect(consecutiveLosses.alreadyGoverned).toBe(false);
  });
});
