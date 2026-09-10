import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { fetchActiveFindingsForStrategy } from '../findings-repository';
import { getStrategyFieldFindings } from '../findings-service';

vi.mock('server-only', () => ({}));

/**
 * Module 03 §5.1 / Module 05 §5 — live-DB proof for the strategy-detail
 * screen's read path: `findings-repository.ts`'s real RLS-scoped read,
 * and `findings-service.ts`'s real `canRender` gating (against the real
 * `20260911010000_findings_analytic_config_seed.sql` seed) plus real
 * `analytic_renders` logging. Seeds `findings` rows DIRECTLY via SQL
 * (not by driving the real edge engine / trade pipeline) — that
 * computation is already proven elsewhere (`edge-engine/__tests__/
 * repository.live.test.ts`); this file's own job is the READ +
 * canRender + render-log wiring this slice actually adds.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/analytics/findings-service.ts + findings-repository.ts (live DB)', () => {
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

  async function seedStrategyAndField(userId: string): Promise<{ strategyId: string; fieldId: string }> {
    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Findings Service Live Test Strategy', 1, false, 'active')
       returning id`,
      [userId],
    );
    const strategyId = strategyRes.rows[0].id;
    const fieldId = 'strategy_var.findings_live_test_conviction';

    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, 'Conviction', 'strategy_var', 'rating', 'captured', $3, '{}'::jsonb)`,
      [fieldId, userId, strategyId],
    );
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Findings Service Live Test Strategy', $3::jsonb, '[]'::jsonb)`,
      [strategyId, userId, JSON.stringify([{ field_id: fieldId, capture_moment: 'pre_entry', order: 1 }])],
    );

    return { strategyId, fieldId };
  }

  async function insertFinding(userId: string, strategyId: string, fieldId: string): Promise<void> {
    await db.query(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          confidence, gate_failures, state)
       values ($1, 'find.rating', $2, $3, '{"op":"between","value":{"min":4,"max":5}}'::jsonb,
               40, 0.71, null, 30, 0.42, null, 0.29, null, 'confident', '{}', 'active')`,
      [userId, strategyId, fieldId],
    );
  }

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

  async function addToCohort(userId: string): Promise<void> {
    await db.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'beta_traders')`, [userId]);
  }

  it('fetchActiveFindingsForStrategy returns only this user/strategy\'s active rows, cross-user isolated', async () => {
    if (!env) return;
    const owner = await createTestAuthUser(envBundle, 'findings-repo-owner');
    const other = await createTestAuthUser(envBundle, 'findings-repo-other');
    cleanupUserIds.push(owner.id, other.id);

    const { strategyId, fieldId } = await seedStrategyAndField(owner.id);
    await insertFinding(owner.id, strategyId, fieldId);

    const ownRows = await fetchActiveFindingsForStrategy(owner.id, strategyId);
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]).toMatchObject({ analyticId: 'find.rating', fieldId, n: 40, confidence: 'confident', winRate: 0.71 });

    // Cross-user: `other` has no strategy with this id at all -- RLS
    // (`findings_owner_select`) plus the explicit `user_id` filter both
    // independently prevent leakage; a wrong-user read returns empty,
    // never someone else's row.
    const otherRows = await fetchActiveFindingsForStrategy(other.id, strategyId);
    expect(otherRows).toHaveLength(0);
  }, 30_000);

  it('getStrategyFieldFindings: a Pro user in the beta cohort sees the real computed statement, and a real analytic_renders row is written', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'findings-svc-cohort');
    cleanupUserIds.push(user.id);

    const { strategyId, fieldId } = await seedStrategyAndField(user.id);
    await insertFinding(user.id, strategyId, fieldId);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const results = await getStrategyFieldFindings(user.id, strategyId, [
      { fieldId, name: 'Conviction', dataType: 'rating', config: {} },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].payload.confidence).toBe('confident');
    expect(results[0].payload.statement).toBe('Win rate rises from 42% to 71% when Conviction is 4–5.');
    expect(results[0].payload.analytic_id).toBe('find.rating');

    const renderRows = await db.query(
      `select analytic_id, surface, payload from retrospeq.analytic_renders where user_id = $1`,
      [user.id],
    );
    expect(renderRows.rows).toHaveLength(1);
    expect(renderRows.rows[0].analytic_id).toBe('find.rating');
    expect(renderRows.rows[0].surface).toBe('strategy');
    expect(renderRows.rows[0].payload.statement).toBe('Win rate rises from 42% to 71% when Conviction is 4–5.');
  }, 30_000);

  it('getStrategyFieldFindings: a Pro user OUTSIDE the beta cohort gets the fail-closed "not enough data yet" payload — the real numbers never leak, and nothing is logged to analytic_renders', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'findings-svc-no-cohort');
    cleanupUserIds.push(user.id);

    const { strategyId, fieldId } = await seedStrategyAndField(user.id);
    await insertFinding(user.id, strategyId, fieldId);
    await setPlan(user.id, 'pro');
    // Deliberately NOT added to the cohort.

    const results = await getStrategyFieldFindings(user.id, strategyId, [
      { fieldId, name: 'Conviction', dataType: 'rating', config: {} },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].payload).toEqual({
      analytic_id: 'find.rating',
      confidence: 'insufficient',
      statement: 'Not enough data yet.',
      n: 0,
      remaining: 20,
    });

    const renderRows = await db.query(`select 1 from retrospeq.analytic_renders where user_id = $1`, [user.id]);
    expect(renderRows.rows).toHaveLength(0);
  }, 30_000);

  it('getStrategyFieldFindings: a field with zero findings rows yet gets the same fail-closed payload, no crash', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'findings-svc-no-rows');
    cleanupUserIds.push(user.id);

    const { strategyId, fieldId } = await seedStrategyAndField(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);
    // No `insertFinding` call at all -- zero rows ever computed for this field.

    const results = await getStrategyFieldFindings(user.id, strategyId, [
      { fieldId, name: 'Conviction', dataType: 'rating', config: {} },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].payload).toEqual({
      analytic_id: 'find.rating',
      confidence: 'insufficient',
      statement: 'Not enough data yet.',
      n: 0,
      remaining: 20,
    });
  }, 30_000);

  it('getStrategyFieldFindings: a note-typed field is skipped entirely (never segmented, never a finding)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'findings-svc-note-field');
    cleanupUserIds.push(user.id);

    const { strategyId } = await seedStrategyAndField(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const results = await getStrategyFieldFindings(user.id, strategyId, [
      { fieldId: 'strategy_var.some_note', name: 'Session notes', dataType: 'note', config: {} },
    ]);

    expect(results).toHaveLength(0);
  }, 30_000);
});
