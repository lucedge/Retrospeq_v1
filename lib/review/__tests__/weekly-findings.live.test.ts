import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { assembleWeeklyFindings, WEEKLY_FINDINGS_CAP } from '../weekly-findings';

vi.mock('server-only', () => ({}));

/**
 * Module 06 Slice 2 — the genuinely new cross-strategy findings aggregator
 * (docs/adr/0036 decisions #2/#3/#4), end to end against the real
 * `getStrategyFieldFindings` pipeline (`canRender`, `analytic_renders`).
 * `weekly-findings.rank.test.ts` already proves the pure sort in
 * isolation; this file proves the FULL pipeline — real strategies, real
 * fields, real `findings` rows, real plan/cohort gating — produces the
 * same top-3 the ranking rule predicts, and that render logging only
 * happens for the entries that survive the cap (dispatch item 1,
 * adversarially, plus item 5's "not enough data yet" honesty, plus
 * cross-user isolation for item 3).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/weekly-findings.ts (live DB)', () => {
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
      await db.query('delete from retrospeq.analytic_renders where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.user_cohorts where user_id = $1', [userId]);
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

  async function makeStrategy(
    userId: string,
    name: string,
    state: 'active' | 'archived' = 'active',
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, $2, 1, false, $3) returning id`,
      [userId, name, state],
    );
    return res.rows[0].id;
  }

  async function makeField(userId: string, strategyId: string, name: string, suffix: string): Promise<string> {
    const fieldId = `strategy_var.weekly_findings_${suffix}`;
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, $3, 'strategy_var', 'rating', 'captured', $4, '{}'::jsonb)`,
      [fieldId, userId, name, strategyId],
    );
    return fieldId;
  }

  async function makeVersion(userId: string, strategyId: string, name: string, fieldIds: string[]): Promise<void> {
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, $3, $4::jsonb, '[]'::jsonb)`,
      [
        strategyId,
        userId,
        name,
        JSON.stringify(fieldIds.map((fieldId, i) => ({ field_id: fieldId, capture_moment: 'pre_entry', order: i + 1 }))),
      ],
    );
  }

  async function insertFinding(
    userId: string,
    strategyId: string,
    fieldId: string,
    overrides: {
      confidence: 'confident' | 'provisional' | 'null_result' | 'insufficient';
      n: number;
      winRate?: number | null;
      baselineWinRate?: number | null;
      deltaWinRate?: number | null;
    },
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          confidence, gate_failures, state)
       values ($1, 'find.rating', $2, $3, '{"op":"between","value":{"min":4,"max":5}}'::jsonb,
               $4, $5, null, 30, $6, null, $7, null, $8, '{}', 'active')`,
      [
        userId,
        strategyId,
        fieldId,
        overrides.n,
        overrides.winRate ?? null,
        overrides.baselineWinRate ?? null,
        overrides.deltaWinRate ?? null,
        overrides.confidence,
      ],
    );
  }

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

  async function addToCohort(userId: string): Promise<void> {
    await db.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'beta_traders')`, [userId]);
  }

  it('a brand-new user with no strategies at all gets an honest empty list, never a fabricated finding', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-findings-no-strategies');
    cleanupUserIds.push(user.id);

    const result = await assembleWeeklyFindings(user.id);
    expect(result).toEqual([]);
  }, 30_000);

  it('an active strategy with only a note-typed field gets an honest empty list (never segmented, never a finding)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-findings-note-only');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const strategyId = await makeStrategy(user.id, 'Note-only strategy');
    const fieldId = 'strategy_var.weekly_findings_note';
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, 'Session notes', 'strategy_var', 'note', 'captured', $3, '{}'::jsonb)`,
      [fieldId, user.id, strategyId],
    );
    await makeVersion(user.id, strategyId, 'Note-only strategy', [fieldId]);

    const result = await assembleWeeklyFindings(user.id);
    expect(result).toEqual([]);
  }, 30_000);

  it('ADVERSARIAL: 5 qualifying candidates across 3 strategies/all 4 tiers — the real top-3 match the documented ranking rule, capped correctly', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-findings-adversarial');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const strat1 = await makeStrategy(user.id, 'Strategy One');
    const strat2 = await makeStrategy(user.id, 'Strategy Two');
    const strat3 = await makeStrategy(user.id, 'Strategy Three');

    const fieldConfident = await makeField(user.id, strat1, 'Conviction A', 'confident');
    const fieldProvisional = await makeField(user.id, strat1, 'Conviction B', 'provisional');
    const fieldNullResult = await makeField(user.id, strat2, 'Conviction C', 'null_result');
    const fieldInsufficientReal = await makeField(user.id, strat2, 'Conviction D', 'insufficient_real');
    const fieldInsufficientNoData = await makeField(user.id, strat3, 'Conviction E', 'insufficient_no_data');

    await makeVersion(user.id, strat1, 'Strategy One', [fieldConfident, fieldProvisional]);
    await makeVersion(user.id, strat2, 'Strategy Two', [fieldNullResult, fieldInsufficientReal]);
    await makeVersion(user.id, strat3, 'Strategy Three', [fieldInsufficientNoData]);

    await insertFinding(user.id, strat1, fieldConfident, {
      confidence: 'confident',
      n: 40,
      winRate: 0.71,
      baselineWinRate: 0.42,
      deltaWinRate: 0.29,
    });
    await insertFinding(user.id, strat1, fieldProvisional, {
      confidence: 'provisional',
      n: 25,
      winRate: 0.65,
      baselineWinRate: 0.45,
      deltaWinRate: 0.2,
    });
    await insertFinding(user.id, strat2, fieldNullResult, { confidence: 'null_result', n: 30 });
    await insertFinding(user.id, strat2, fieldInsufficientReal, { confidence: 'insufficient', n: 10 });
    // fieldInsufficientNoData deliberately gets NO findings row at all —
    // exercises `buildNoDataFindingPayload`'s path, not `insertFinding`.

    const result = await assembleWeeklyFindings(user.id);

    expect(result).toHaveLength(WEEKLY_FINDINGS_CAP);
    expect(result.map((r) => r.fieldId)).toEqual([fieldConfident, fieldProvisional, fieldNullResult]);
    expect(result.map((r) => r.payload.confidence)).toEqual(['confident', 'provisional', 'null_result']);
    // The two insufficient candidates are real, evaluated (see the
    // render-logging assertion below), but correctly excluded by the cap.
    expect(result.map((r) => r.fieldId)).not.toContain(fieldInsufficientReal);
    expect(result.map((r) => r.fieldId)).not.toContain(fieldInsufficientNoData);

    // Render logging: only the top-3 that were actually SHOWN get a
    // real analytic_renders row (docs/adr/0036 decision #4) — the two
    // insufficient candidates that were evaluated but cut by the cap
    // must NOT be logged.
    const renderRows = await db.query<{ analytic_id: string }>(
      `select analytic_id from retrospeq.analytic_renders where user_id = $1 order by analytic_id`,
      [user.id],
    );
    expect(renderRows.rows).toHaveLength(3);
  }, 45_000);

  it('a user with only insufficient candidates: the top-3 (of more than 3) are chosen by largest n, an honest, non-fabricated selection', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-findings-all-insufficient');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const strat = await makeStrategy(user.id, 'All-insufficient strategy');
    const fieldLow = await makeField(user.id, strat, 'Field Low', 'low_n');
    const fieldMid = await makeField(user.id, strat, 'Field Mid', 'mid_n');
    const fieldHigh = await makeField(user.id, strat, 'Field High', 'high_n');
    const fieldZero = await makeField(user.id, strat, 'Field Zero', 'zero_n');
    await makeVersion(user.id, strat, 'All-insufficient strategy', [fieldLow, fieldMid, fieldHigh, fieldZero]);

    await insertFinding(user.id, strat, fieldLow, { confidence: 'insufficient', n: 5 });
    await insertFinding(user.id, strat, fieldMid, { confidence: 'insufficient', n: 15 });
    await insertFinding(user.id, strat, fieldHigh, { confidence: 'insufficient', n: 18 });
    // fieldZero: no findings row -> n = 0 via buildNoDataFindingPayload.

    const result = await assembleWeeklyFindings(user.id);
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.payload.confidence === 'insufficient')).toBe(true);
    // Largest n first: 18, 15, 5 — field with n=0 (fieldZero) excluded.
    expect(result.map((r) => r.fieldId)).toEqual([fieldHigh, fieldMid, fieldLow]);
  }, 30_000);

  it('an ARCHIVED strategy is excluded entirely — its findings never appear in the weekly review', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-findings-archived-excluded');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const strat = await makeStrategy(user.id, 'Archived strategy', 'archived');
    const fieldId = await makeField(user.id, strat, 'Conviction', 'archived_field');
    await makeVersion(user.id, strat, 'Archived strategy', [fieldId]);
    await insertFinding(user.id, strat, fieldId, {
      confidence: 'confident',
      n: 40,
      winRate: 0.71,
      baselineWinRate: 0.42,
      deltaWinRate: 0.29,
    });

    const result = await assembleWeeklyFindings(user.id);
    expect(result).toEqual([]);
  }, 30_000);

  it('a Pro user outside the beta cohort gets the fail-closed "not enough data yet" candidate — real numbers never leak into a weekly review', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-findings-no-cohort');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    // Deliberately NOT added to the cohort.

    const strat = await makeStrategy(user.id, 'Gated strategy');
    const fieldId = await makeField(user.id, strat, 'Conviction', 'gated_field');
    await makeVersion(user.id, strat, 'Gated strategy', [fieldId]);
    await insertFinding(user.id, strat, fieldId, {
      confidence: 'confident',
      n: 40,
      winRate: 0.71,
      baselineWinRate: 0.42,
      deltaWinRate: 0.29,
    });

    const result = await assembleWeeklyFindings(user.id);
    expect(result).toHaveLength(1);
    expect(result[0].payload).toEqual({
      analytic_id: 'find.rating',
      confidence: 'insufficient',
      statement: 'Not enough data yet.',
      n: 0,
      remaining: 20,
    });

    const renderRows = await db.query(`select 1 from retrospeq.analytic_renders where user_id = $1`, [user.id]);
    expect(renderRows.rows).toHaveLength(0);
  }, 30_000);

  it('cross-user isolation: user B\'s weekly findings never include user A\'s strategies/fields/findings', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'weekly-findings-a');
    const userB = await createTestAuthUser(envBundle, 'weekly-findings-b');
    cleanupUserIds.push(userA.id, userB.id);
    await setPlan(userA.id, 'pro');
    await addToCohort(userA.id);

    const strat = await makeStrategy(userA.id, 'User A strategy');
    const fieldId = await makeField(userA.id, strat, 'Conviction', 'cross-user');
    await makeVersion(userA.id, strat, 'User A strategy', [fieldId]);
    await insertFinding(userA.id, strat, fieldId, {
      confidence: 'confident',
      n: 40,
      winRate: 0.71,
      baselineWinRate: 0.42,
      deltaWinRate: 0.29,
    });

    const resultB = await assembleWeeklyFindings(userB.id);
    expect(resultB).toEqual([]);

    const resultA = await assembleWeeklyFindings(userA.id);
    expect(resultA).toHaveLength(1);
    expect(resultA[0].payload.confidence).toBe('confident');
  }, 30_000);
});
