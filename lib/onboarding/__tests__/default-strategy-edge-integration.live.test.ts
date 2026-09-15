import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

vi.setConfig({ testTimeout: 30_000 });

import { ensureDefaultStrategyForUser } from '../default-strategy';
import { recomputeEdgeFindingsForUser } from '@/lib/analytics/edge-engine/repository';
import { getStrategyFieldFindings } from '@/lib/analytics/findings-service';

/**
 * Module 08 §5.4/§5.5 reachability fix — the end-to-end live proof
 * `docs/infra-gaps.md`'s own closed entry names: a genuinely stock,
 * silently-created default strategy (never touched by the trader) must
 * actually be able to produce a real derived finding, because the edge
 * engine (`lib/analytics/edge-engine/repository.ts`'s
 * `fetchStrategyFieldSpecs`) only ever computes over a strategy's OWN
 * chosen field list — before this slice that list was permanently `[]`.
 *
 * Seeding conventions mirror
 * `lib/analytics/edge-engine/__tests__/repository.live.test.ts`'s own
 * `seedTrade` helper (direct SQL, `drv.direction` needs no
 * `trade_captures` row at all -- `field-values.ts`'s
 * `DERIVED_FROM_TRADE_COLUMNS` reads it straight off `trades.direction`).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('default strategy -> edge engine (live DB, end-to-end)', () => {
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
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
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
       values ($1, 'Default Strategy Edge Integration', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    strategyId: string,
    direction: 'long' | 'short',
    outcome: 'win' | 'loss',
    index: number,
  ): Promise<void> {
    const openedAt = new Date(Date.UTC(2026, 0, 1 + index, 9, 0, 0));
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, openedAt.toISOString()],
    );
    const rMultiple = outcome === 'win' ? '1.5000' : '-1.0000';
    await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          confirmed_at, confirmed_by, outcome, r_multiple, not_a_decision, strategy_id, strategy_version)
       values ($1,$2,$3,'EURUSD',$5,$4::timestamptz,$4::timestamptz,$4::date,'confirmed',
               '1.20000000','1.20500000','100000.00000000','USD','confident_single',
               $4::timestamptz,'user',$6,$7,false,$8,1)`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), direction, outcome, rMultiple, strategyId],
    );
  }

  it('computes at least one real derived finding for a stock default strategy once enough confirmed trades exist', async () => {
    const user = await createTestAuthUser(env!, 'default-strategy-edge');
    cleanupUserIds.push(user.id);

    await ensureDefaultStrategyForUser(user.id, 'mt5');
    const strategyRow = await db.query<{ id: string }>(
      `select id from retrospeq.strategies where user_id = $1 and is_default = true`,
      [user.id],
    );
    const strategyId = strategyRow.rows[0].id;
    const accountId = await seedAccount(user.id);

    // Same engineered win-rate effect shape `repository.live.test.ts`
    // already proves clears every gate at n=25 (>=20, <40 -> provisional):
    // 25 long trades winning 21/25 (84%), 25 short trades winning 10/25
    // (40%) -- a 44pp effect on `drv.direction`, which this default
    // strategy's version-1 field list now actually includes.
    let idx = 0;
    for (let i = 0; i < 25; i++) {
      await seedTrade(user.id, accountId, strategyId, 'long', i < 21 ? 'win' : 'loss', idx++);
    }
    for (let i = 0; i < 25; i++) {
      await seedTrade(user.id, accountId, strategyId, 'short', i < 10 ? 'win' : 'loss', idx++);
    }

    const result = await recomputeEdgeFindingsForUser(user.id);
    expect(result.findingsWritten).toBeGreaterThan(0);

    // `findings` gets a row for every computed segment regardless of
    // confidence (`writeFindingsForStrategy`/`computeFamilyFindings`,
    // `gates.ts`) -- 'insufficient'/'null_result' are "computed but never
    // shown" (this file's own `wouldRenderByStatisticalGatesAlone`,
    // `weekday-canary.ts`'s own comment). The real "§5.5's own eligibility
    // condition is now reachable" proof is that at least one row for this
    // strategy actually clears the render gate.
    const findingRows = await db.query<{ field_id: string; confidence: string }>(
      `select field_id, confidence from retrospeq.findings
        where user_id = $1 and strategy_id = $2 and field_id = 'drv.direction' and state = 'active'`,
      [user.id, strategyId],
    );
    expect(findingRows.rows.length).toBeGreaterThan(0);
    expect(findingRows.rows.some((r) => r.confidence === 'confident' || r.confidence === 'provisional')).toBe(true);
  });

  it('"Not enough data yet" still holds: below the sample-size gate, every computed segment for the same default strategy stays insufficient, never shown', async () => {
    const user = await createTestAuthUser(env!, 'default-strategy-edge-insufficient');
    cleanupUserIds.push(user.id);

    await ensureDefaultStrategyForUser(user.id, 'mt5');
    const strategyRow = await db.query<{ id: string }>(
      `select id from retrospeq.strategies where user_id = $1 and is_default = true`,
      [user.id],
    );
    const strategyId = strategyRow.rows[0].id;
    const accountId = await seedAccount(user.id);

    // 6 long (all wins) + 5 short (all losses) = 11 total, well under
    // `SAMPLE_MIN_SEGMENT_N`/`SAMPLE_MIN_BASELINE_N` (20/12,
    // `edge-engine/gates.ts`) even with a maximal effect size -- proves
    // this slice does NOT lower any threshold to make the default
    // strategy "work": better to say nothing than a finding on 11 trades
    // (Module 05 §6).
    let idx = 0;
    for (let i = 0; i < 6; i++) {
      await seedTrade(user.id, accountId, strategyId, 'long', 'win', idx++);
    }
    for (let i = 0; i < 5; i++) {
      await seedTrade(user.id, accountId, strategyId, 'short', 'loss', idx++);
    }

    await recomputeEdgeFindingsForUser(user.id);

    const findingRows = await db.query<{ confidence: string }>(
      `select confidence from retrospeq.findings where user_id = $1 and strategy_id = $2 and state = 'active'`,
      [user.id, strategyId],
    );
    // Every computed segment exists (the strategy DOES have fields now,
    // this slice's whole point) but NONE clears the render gate — never a
    // fabricated finding on 11 trades, no threshold lowered to make this
    // "work."
    expect(findingRows.rows.length).toBeGreaterThan(0);
    expect(findingRows.rows.every((r) => r.confidence === 'insufficient' || r.confidence === 'null_result')).toBe(true);
  });

  it('2026-09-15 QA FAIL fix, end-to-end: a FREE-plan trader on the stock default strategy never sees a Pro-gated field rendered as "not enough data yet" — it is omitted; and drv.session (the one free-tier derived analytic id, find.session) computes zero rows for anyone today because no session vocabulary/data source exists anywhere in this repo (a genuine, separate, pre-existing gap — field-values.ts\'s own header, NOT introduced or fixed by this slice)', async () => {
    const user = await createTestAuthUser(env!, 'default-strategy-plan-honesty');
    cleanupUserIds.push(user.id);
    // Deliberately left on the default 'free' plan (`retrospeq.subscriptions`'s
    // own default) -- this is exactly the population §5.4's silent default
    // strategy exists for.

    await ensureDefaultStrategyForUser(user.id, 'mt5');
    const strategyRow = await db.query<{ id: string }>(
      `select id from retrospeq.strategies where user_id = $1 and is_default = true`,
      [user.id],
    );
    const strategyId = strategyRow.rows[0].id;
    const accountId = await seedAccount(user.id);

    // Same engineered 44pp effect as the first test in this file -- a real,
    // gate-clearing `confident` finding on `drv.direction` (resolves to
    // `find.pickone`, min_plan='pro' per `analytics-registry.md` §7).
    let idx = 0;
    for (let i = 0; i < 25; i++) {
      await seedTrade(user.id, accountId, strategyId, 'long', i < 21 ? 'win' : 'loss', idx++);
    }
    for (let i = 0; i < 25; i++) {
      await seedTrade(user.id, accountId, strategyId, 'short', i < 10 ? 'win' : 'loss', idx++);
    }
    await recomputeEdgeFindingsForUser(user.id);

    // Confirm the premise: a real, gate-cleared row genuinely exists for
    // this free-plan user's own drv.direction, pro-gated, before checking
    // what the read layer does with it.
    const directionRows = await db.query<{ confidence: string }>(
      `select confidence from retrospeq.findings where user_id = $1 and strategy_id = $2 and field_id = 'drv.direction' and state = 'active'`,
      [user.id, strategyId],
    );
    expect(directionRows.rows.some((r) => r.confidence === 'confident' || r.confidence === 'provisional')).toBe(true);

    // Every derived field this default strategy seeded (§5.4) -- the exact
    // roster the real strategy-detail screen (`/strategies/[id]`) reads.
    const fieldRows = await db.query<{ id: string; name: string; data_type: string }>(
      `select id, name, data_type from retrospeq.fields where user_id = $1 and kind = 'derived' and id <> 'drv.order_type'`,
      [user.id],
    );
    // `drv.order_type` excluded here the same way `drv.session` is
    // included -- both have no data source, but this test only needs ONE
    // no-data-source control case (`drv.session`, the free-tier id) to
    // prove the honest "no vocabulary yet" behaviour without duplicating it.
    expect(fieldRows.rows.length).toBeGreaterThan(0);

    const fieldSpecs = fieldRows.rows.map((r) => ({
      fieldId: r.id,
      name: r.name,
      dataType: r.data_type as 'pick_one' | 'pick_many' | 'bool' | 'rating' | 'number' | 'note',
      config: {},
    }));

    const results = await getStrategyFieldFindings(user.id, strategyId, fieldSpecs);

    // THE FIX: drv.direction (real data, real confident finding, Pro-gated)
    // is OMITTED entirely for this free-plan user -- never present in the
    // array at all, and specifically never disguised as "not enough data
    // yet" the way it was before this fix (PROGRESS.md 2026-09-15 QA FAIL).
    expect(results.find((r) => r.fieldId === 'drv.direction')).toBeUndefined();

    // No result carries REAL computed data (n > 0) under a Pro-gated
    // analytic id -- e.g. drv.day_of_week genuinely gets a real (if
    // 'insufficient'-confidence, n>0) `findings` row from these 50 trades
    // spread across weekdays, and it must be omitted the same way
    // drv.direction is, not shown with its real n. (A field this test's
    // own seeded trades never populate at all -- e.g. drv.hold_seconds,
    // whose `trades.hold_seconds` column this helper never sets -- has NO
    // representative row to gate in the first place, so it legitimately
    // reaches the pre-existing, unrelated "!representative" branch as
    // `n: 0`/`insufficient` regardless of plan; that is not this fix's
    // concern and is asserted narrowly by `n > 0` below, not blanket.)
    for (const r of results) {
      if (r.payload.n > 0) {
        expect(['find.pickone', 'find.number', 'find.toggle']).not.toContain(r.payload.analytic_id);
      }
    }

    // drv.session (find.session, the one min_plan='free' derived analytic
    // in the whole registry) still renders -- but only ever as "not enough
    // data yet," because NO trade has ever produced a value for it: the
    // field-registry migration seeded it with an empty options vocabulary
    // and `field-values.ts` has no extractor for it at all (documented
    // there as a genuine, pre-existing, unresolved product-decision gap --
    // session-boundary definitions, e.g. what UTC hours mean "London" --
    // this dispatch does not invent one). This is NOT the plan-gate bug;
    // it is honest ("we have never computed anything for this field"), but
    // it does mean the free tier's own "derived findings" promise
    // (design-decisions §15) has no LIVE example today even where the
    // analytic id itself is free.
    const sessionResult = results.find((r) => r.fieldId === 'drv.session');
    expect(sessionResult?.payload.confidence).toBe('insufficient');
    expect(sessionResult?.payload.n).toBe(0);

    const sessionFindingRows = await db.query(
      `select 1 from retrospeq.findings where user_id = $1 and strategy_id = $2 and field_id = 'drv.session'`,
      [user.id, strategyId],
    );
    expect(sessionFindingRows.rows).toHaveLength(0); // zero rows ever written -- confirms the gap live, not asserted from reading code alone.
  });
});
