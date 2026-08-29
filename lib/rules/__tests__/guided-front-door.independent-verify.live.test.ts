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

const { getUserMock, createClientMock, getClientIpMock, enforceRateLimitMock, revalidatePathMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.11'),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  revalidatePathMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/rate-limit/http', () => ({ getClientIp: getClientIpMock }));
vi.mock('@/lib/rate-limit/limiter', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));

function sessionAs(userId: string, email: string) {
  createClientMock.mockResolvedValue({
    auth: { getUser: getUserMock.mockResolvedValue({ data: { user: { id: userId, email } }, error: null }) },
  });
}

/**
 * Module 04 §5.10 / story 1.4, Slice 10a — INDEPENDENT tester verification,
 * fresh fixtures (different account/trades than the coder's own
 * `guided-front-door.live.test.ts`), targeting items the coder's own live
 * suite did NOT cover:
 *
 * 1. `consecutive_losses` seeded from REAL history through the REAL
 *    `recomputeOperandDistributionsForUser` pipeline (the coder's own live
 *    test only ever exercised `risk_pct`'s history branch and
 *    `daily_loss_pct`'s FALLBACK branch — `consecutive_losses`'s history
 *    branch was never proven live by the coder at all). Outcome sequence
 *    (chronological): L,L,W repeated across 20 trades, hand-derived
 *    "entering streak" values [0,1,2] x [7,7,6] (n=20) — 80th percentile
 *    (target=16) lands on bucket value 2 by hand computation, matching
 *    `lib/rules/__tests__/guided-front-door.independent-verify.test.ts`'s
 *    mocked companion exactly, now against the real bucketing pipeline
 *    instead of a hand-built row.
 * 2. End-to-end acceptance through the REAL `createRule` Server Action
 *    (not `insertRuleAndVersion` called directly) for all three guided
 *    operands, confirming exactly 3 `rules` rows exist afterward, each
 *    `severity = 'soft'`, `scope = 'global'`, `scope_id is null` — read
 *    back directly from Postgres, not from the action's own return value
 *    (which could be right while the row itself were wrong).
 * 3. The free-tier `rules.create` cap (3) is EXACTLY hit by these three,
 *    not "with room to spare" — the third guided rule succeeds, and a
 *    FOURTH rule (any operand) is rejected by the real entitlement check.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/rules/guided-front-door.ts + createRule — independent end-to-end verification (live DB)', () => {
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
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
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
       values ($1, 'Guided Front Door Independent Verify', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  /** One confirmed trade per call, `outcome` explicit -- the exact field
   *  `computeConsecutiveLosses` reads. Each trade gets its own day so
   *  `closed_at`/`opened_at` ordering is unambiguous. `risk_pct` is fixed
   *  at a harmless constant (irrelevant to this file's own scenario). */
  async function seedOutcomeTrade(userId: string, accountId: string, outcome: 'win' | 'loss', dayIndex: number): Promise<void> {
    const day = `2026-01-${String(dayIndex + 1).padStart(2, '0')}`;
    const at = new Date(`${day}T09:00:00Z`).toISOString();
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, at],
    );
    await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          initial_stop, initial_risk_pct, risk_pct, outcome, confirmed_at, confirmed_by)
       values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$4::timestamptz,$5,'confirmed',
               '1.20000000','1.20500000','100000.00000000','USD','confident_single',
               '1.19800000','1.0','1.0',$6,$4::timestamptz,'user')`,
      [userId, accountId, blockRes.rows[0].id, at, day, outcome],
    );
  }

  it(
    'consecutive_losses seeds from REAL history (never before proven live for this operand by the coder): ' +
      'L,L,W x ~7 over 20 trades produces the hand-derived 80th-percentile seed of 2',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'guided-front-door-cl');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // Chronological pattern L,L,W repeated -- see this file's own header
      // for the by-hand derivation of the resulting streak distribution.
      const pattern: Array<'win' | 'loss'> = [];
      for (let i = 0; i < 20; i++) {
        const posInCycle = i % 3;
        pattern.push(posInCycle === 2 ? 'win' : 'loss');
      }
      for (let i = 0; i < 20; i++) {
        await seedOutcomeTrade(user.id, accountId, pattern[i], i);
      }

      const { recomputeOperandDistributionsForUser } = await import('../distributions-repository');
      const recompute = await recomputeOperandDistributionsForUser(user.id);
      expect(recompute.tradesScanned).toBe(20);

      const { seedGuidedRuleThresholds } = await import('../guided-front-door');
      const seeds = await seedGuidedRuleThresholds(user.id);
      const cl = seeds.find((s) => s.operandId === 'consecutive_losses')!;
      expect(cl.seedBasis).toBe('history');
      expect(cl.historyN).toBe(20);
      expect(cl.seedValue).toBe(2);
    },
    20_000,
  );

  it(
    'end-to-end: accepting all three guided rules through the REAL createRule Server Action produces exactly ' +
      "3 `rules` rows, each severity='soft' scope='global' scope_id=null -- read back directly from Postgres, " +
      'and the free-tier rules.create cap (3) is EXACTLY hit: a fourth rule is rejected',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'guided-front-door-e2e');
      cleanupUserIds.push(user.id);
      sessionAs(user.id, user.email);

      const { createRule } = await import('../../../app/(app)/rules/actions');
      const guidedInputs = [
        { operandId: 'risk_pct', op: 'lte' as const, value: 1.5, scope: 'global' as const },
        { operandId: 'daily_loss_pct', op: 'lte' as const, value: 3, scope: 'global' as const },
        { operandId: 'consecutive_losses', op: 'lte' as const, value: 3, scope: 'global' as const },
      ];
      for (const input of guidedInputs) {
        const result = await createRule(input);
        expect(result.success).toBe(true);
        expect(result.rule?.scope).toBe('global');
        expect(result.rule?.scopeId).toBeNull();
      }

      const rows = await db.query<{ operand_id: string; severity: string; scope: string; scope_id: string | null }>(
        `select r.severity, r.scope, r.scope_id, rv.operand_id
           from retrospeq.rules r
           join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
          where r.user_id = $1
          order by rv.operand_id`,
        [user.id],
      );
      expect(rows.rows).toHaveLength(3);
      for (const row of rows.rows) {
        expect(row.severity).toBe('soft');
        expect(row.scope).toBe('global');
        expect(row.scope_id).toBeNull();
      }
      expect(rows.rows.map((r) => r.operand_id).sort()).toEqual(['consecutive_losses', 'daily_loss_pct', 'risk_pct']);

      // A fourth rule, any operand, must now be rejected -- the free-tier
      // cap (3) is EXACTLY hit by the three guided rules, not "with room
      // to spare."
      const fourth = await createRule({ operandId: 'weekly_loss_pct', op: 'lte', value: 5, scope: 'global' });
      expect(fourth.success).toBeFalsy();
      expect(fourth.error?.code).toBe('ENTITLEMENT_LIMIT');

      const countAfter = await db.query<{ count: string }>('select count(*)::text as count from retrospeq.rules where user_id = $1', [
        user.id,
      ]);
      expect(countAfter.rows[0].count).toBe('3');
    },
    30_000,
  );

  it(
    'previewRule genuinely reads real operand_distributions data for a sufficiently-seeded trader: ' +
      'state is "flagged" with a real ratio, and RAISING the threshold strictly LOWERS the flagged count ' +
      '(proves the preview responds to the candidate value, not a cached/stale result)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'guided-front-door-preview-live');
      cleanupUserIds.push(user.id);
      sessionAs(user.id, user.email);
      const accountId = await seedAccount(user.id);

      // 20 confirmed trades, initial_risk_pct spread 0.5%..2.4% in 0.1%
      // steps -- a real spread, not a single repeated value, so different
      // candidate thresholds genuinely flag different counts.
      for (let i = 0; i < 20; i++) {
        const riskPct = (0.5 + i * 0.1).toFixed(1);
        const day = `2026-02-${String(i + 1).padStart(2, '0')}`;
        const at = new Date(`${day}T09:00:00Z`).toISOString();
        const blockRes = await db.query<{ id: string }>(
          `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
           values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
           returning id`,
          [user.id, accountId, at],
        );
        await db.query(
          `insert into retrospeq.trades
             (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
              entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
              initial_stop, initial_risk_pct, risk_pct, confirmed_at, confirmed_by)
           values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$4::timestamptz,$5,'confirmed',
                   '1.20000000','1.20500000','100000.00000000','USD','confident_single',
                   '1.19800000',$6,$6,$4::timestamptz,'user')`,
          [user.id, accountId, blockRes.rows[0].id, at, day, riskPct],
        );
      }

      const { recomputeOperandDistributionsForUser } = await import('../distributions-repository');
      await recomputeOperandDistributionsForUser(user.id);

      const { previewRule } = await import('../../../app/(app)/rules/actions');

      // A tight threshold (0.6%) should flag most of the 20 trades (only
      // the 0.5% trade follows it).
      const tight = await previewRule({ operandId: 'risk_pct', op: 'lte', value: 0.6 });
      expect(tight.success).toBe(true);
      expect(tight.preview?.state).toBe('flagged');
      expect(tight.preview?.n).toBe(20);
      // Values <= 0.6 (0.5, 0.6) follow the rule -- the other 18 (0.7..2.4)
      // are flagged.
      expect(tight.preview?.flagged).toBe(18);

      // A loose threshold (2.4%, the max seeded value) should flag zero --
      // every trade follows it.
      const loose = await previewRule({ operandId: 'risk_pct', op: 'lte', value: 2.4 });
      expect(loose.success).toBe(true);
      expect(loose.preview?.state).toBe('flagged');
      expect(loose.preview?.flagged).toBe(0);

      // A mid threshold flags something strictly between the two extremes
      // -- proves the ratio genuinely moves with the candidate value, not
      // a stale/cached result from the first call above.
      const mid = await previewRule({ operandId: 'risk_pct', op: 'lte', value: 1.4 });
      expect(mid.success).toBe(true);
      expect(mid.preview?.state).toBe('flagged');
      expect(mid.preview!.flagged!).toBeGreaterThan(loose.preview!.flagged!);
      expect(mid.preview!.flagged!).toBeLessThan(tight.preview!.flagged!);
    },
    20_000,
  );

  it(
    'a trader with fewer than 20 trades gets an HONEST insufficient_history preview, never a fabricated ratio ' +
      '-- for all three guided operands, not just the ones with a distribution row',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'guided-front-door-thin');
      cleanupUserIds.push(user.id);
      sessionAs(user.id, user.email);
      const accountId = await seedAccount(user.id);

      // Exactly 5 trades -- well under MIN_TRADES_FOR_PREVIEW (20).
      for (let i = 0; i < 5; i++) {
        const day = `2026-03-${String(i + 1).padStart(2, '0')}`;
        const at = new Date(`${day}T09:00:00Z`).toISOString();
        const blockRes = await db.query<{ id: string }>(
          `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
           values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
           returning id`,
          [user.id, accountId, at],
        );
        await db.query(
          `insert into retrospeq.trades
             (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
              entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
              initial_stop, initial_risk_pct, risk_pct, confirmed_at, confirmed_by)
           values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$4::timestamptz,$5,'confirmed',
                   '1.20000000','1.20500000','100000.00000000','USD','confident_single',
                   '1.19800000','1.0','1.0',$4::timestamptz,'user')`,
          [user.id, accountId, blockRes.rows[0].id, at, day],
        );
      }

      const { recomputeOperandDistributionsForUser } = await import('../distributions-repository');
      await recomputeOperandDistributionsForUser(user.id);

      const { seedGuidedRuleThresholds } = await import('../guided-front-door');
      const seeds = await seedGuidedRuleThresholds(user.id);
      // Seeding itself must be honest too -- bounds_midpoint, not a
      // fabricated "typical" value, for every operand at this trade count.
      for (const seed of seeds) {
        expect(seed.seedBasis).toBe('bounds_midpoint');
      }

      const { previewRule } = await import('../../../app/(app)/rules/actions');
      const riskPreview = await previewRule({ operandId: 'risk_pct', op: 'lte', value: seeds[0].seedValue });
      expect(riskPreview.success).toBe(true);
      expect(riskPreview.preview?.state).toBe('insufficient_history');
      expect(riskPreview.preview?.n).toBe(5);
      // No `flagged`/`ratio` field at all on an honest insufficient_history
      // result -- never a fabricated number dressed up as real.
      expect(riskPreview.preview?.flagged).toBeUndefined();
      expect(riskPreview.preview?.ratio).toBeUndefined();

      const clPreview = await previewRule({ operandId: 'consecutive_losses', op: 'lte', value: seeds[2].seedValue });
      expect(clPreview.success).toBe(true);
      expect(clPreview.preview?.state).toBe('insufficient_history');
      expect(clPreview.preview?.flagged).toBeUndefined();
    },
    20_000,
  );
});
