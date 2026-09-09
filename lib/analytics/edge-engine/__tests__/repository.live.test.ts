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
 * Module 05 (Analytics & Findings) §4.2/§4.13 — live-DB proof for
 * `lib/analytics/edge-engine/repository.ts`: real `strategies`/
 * `strategy_versions`/`fields`/`trades`/`trade_captures` reads under
 * `withServiceRoleConnection`, a real `findings` write, and the
 * supersession write semantics this slice's own report documents
 * (`docs/adr/0024`). Seeding conventions mirror
 * `lib/rules/__tests__/distributions-repository.live.test.ts` exactly —
 * real auth users via the GoTrue admin API, direct SQL seeding of every
 * table this test needs rather than driving everything through the real
 * authoring/ingestion pipelines (out of scope for this test's own
 * purpose).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/analytics/edge-engine/repository.ts (live DB)', () => {
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
       values ($1, 'Edge Engine Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedStrategy(userId: string, fieldId: string): Promise<{ strategyId: string }> {
    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Edge Engine Live Test Strategy', 1, false, 'active')
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
       values ($1, 1, $2, 'Edge Engine Live Test Strategy', $3::jsonb, '[]'::jsonb)`,
      [strategyId, userId, JSON.stringify([{ field_id: fieldId, capture_moment: 'pre_entry', order: 1 }])],
    );

    return { strategyId };
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    strategyId: string,
    fieldId: string,
    flagValue: boolean,
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
      `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment)
       values ($1, $2, $3, $4::jsonb, 'pre_entry')`,
      [tradeId, userId, fieldId, JSON.stringify(flagValue)],
    );
    return tradeId;
  }

  it(
    'computes a real finding for an engineered win-rate effect and writes it to findings',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'edge-engine');
      cleanupUserIds.push(userId);
      const accountId = await seedAccount(userId);
      const fieldId = 'conviction_flag';
      const { strategyId } = await seedStrategy(userId, fieldId);

      // 25 trades with flag=true, winning 21/25 (84%).
      // 25 trades with flag=false, winning 10/25 (40%).
      // A 44pp effect — should clear every gate at n=25 (>=20, <40 -> provisional).
      let idx = 0;
      for (let i = 0; i < 25; i++) {
        await seedTrade(userId, accountId, strategyId, fieldId, true, i < 21 ? 'win' : 'loss', idx++);
      }
      for (let i = 0; i < 25; i++) {
        await seedTrade(userId, accountId, strategyId, fieldId, false, i < 10 ? 'win' : 'loss', idx++);
      }

      const { recomputeEdgeFindingsForUser } = await import('../repository');
      const result = await recomputeEdgeFindingsForUser(userId);
      expect(result.strategiesComputed).toBe(1);
      expect(result.findingsWritten).toBeGreaterThan(0);

      const findingsRes = await db.query<{
        analytic_id: string;
        field_id: string;
        segment: { op: string; value: unknown };
        n: number;
        confidence: string;
        state: string;
        win_rate: string;
        baseline_win_rate: string;
      }>(`select analytic_id, field_id, segment, n, confidence, state, win_rate, baseline_win_rate from retrospeq.findings where user_id = $1`, [
        userId,
      ]);
      expect(findingsRes.rows.length).toBeGreaterThan(0);

      const trueSegment = findingsRes.rows.find((r) => r.field_id === fieldId && r.segment.value === true);
      expect(trueSegment).toBeDefined();
      expect(trueSegment!.analytic_id).toBe('find.toggle');
      expect(trueSegment!.n).toBe(25);
      expect(trueSegment!.state).toBe('active');
      expect(['confident', 'provisional']).toContain(trueSegment!.confidence);
      expect(Number(trueSegment!.win_rate)).toBeCloseTo(0.84, 2);
      expect(Number(trueSegment!.baseline_win_rate)).toBeCloseTo(0.4, 2);

      // ---- Re-run: supersession semantics ----
      const firstRunId = await db.query<{ id: string }>(
        `select id from retrospeq.findings where user_id = $1 and field_id = $2 and segment = $3::jsonb and state = 'active'`,
        [userId, fieldId, JSON.stringify({ op: 'eq', value: true })],
      );
      expect(firstRunId.rows).toHaveLength(1);
      const firstId = firstRunId.rows[0].id;

      await recomputeEdgeFindingsForUser(userId);

      const afterSecondRun = await db.query<{ id: string; state: string; superseded_by: string | null }>(
        `select id, state, superseded_by from retrospeq.findings
          where user_id = $1 and field_id = $2 and segment = $3::jsonb
          order by computed_at asc`,
        [userId, fieldId, JSON.stringify({ op: 'eq', value: true })],
      );
      expect(afterSecondRun.rows).toHaveLength(2);
      const oldRow = afterSecondRun.rows.find((r) => r.id === firstId)!;
      const newRow = afterSecondRun.rows.find((r) => r.id !== firstId)!;
      expect(oldRow.state).toBe('superseded');
      expect(oldRow.superseded_by).toBe(newRow.id);
      expect(newRow.state).toBe('active');
    },
    60_000,
  );
});
