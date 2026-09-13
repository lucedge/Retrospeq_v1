import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import {
  fetchCurrentReviewIdForDecisions,
  fetchPendingDecisionPrompts,
  fetchDecisionCounts,
  fetchPromptById,
} from '../prompts-repository';
import { buildGraduationPromptDetail } from '../graduation-evidence-detail';

/**
 * Module 06 (Review & Graduation) Slice 6 — `retrospeq-tester` gate,
 * 2026-09-13. Live-DB coverage of the READ half of `lib/review/decisions/`
 * not otherwise exercised by `app/(app)/review/decisions/__tests__/
 * decisions-integration.live.test.ts` (which drives accept/defer through
 * the Server Action layer): `fetchCurrentReviewIdForDecisions`,
 * `fetchPendingGraduationPrompts`, `fetchGraduationDecisionCounts`,
 * `fetchPromptById`, and `buildGraduationPromptDetail` (the "Decision N of
 * M" / evidence-cost-hint render payload).
 */
vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 60_000 });

const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/decisions read path (live DB)', () => {
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
      await db.query('delete from retrospeq.review_prompts where user_id = $1', [userId]);
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 60_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedStrategy(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Read Path Live Test Strategy', 1, false, 'active') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function insertFinding(userId: string, strategyId: string, fieldId: string, opts: { confidence?: string } = {}): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          p_value, p_adjusted, confidence, gate_failures, state)
       values ($1,'find.read-path',$2,$3,$4::jsonb,40,0.7,null,20,0.4,null,0.3,null,0.001,0.001,$5,'{}','active')
       returning id`,
      [userId, strategyId, fieldId, JSON.stringify({ op: 'between', value: { min: 0.5, max: 1.0 } }), opts.confidence ?? 'confident'],
    );
    return res.rows[0].id;
  }

  async function insertReview(userId: string, periodStart: string, periodEnd: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2::date, $3::date, 1, '{}'::jsonb) returning id`,
      [userId, periodStart, periodEnd],
    );
    return res.rows[0].id;
  }

  async function insertGraduationPrompt(
    userId: string,
    reviewId: string,
    rank: number,
    fieldId: string,
    strategyId: string,
    opts: { state?: string } = {},
  ): Promise<string> {
    const payload = {
      strategyId,
      fieldId,
      analyticId: 'find.read-path',
      n: 40,
      winRate: 0.7,
      avgR: null,
      baselineN: 20,
      baselineWinRate: 0.4,
      baselineAvgR: null,
      deltaWinRate: 0.3,
      deltaAvgR: null,
    };
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'graduation', $3, 'finding', $4, $5::jsonb, $6)
       returning id`,
      [userId, reviewId, rank, crypto.randomUUID(), JSON.stringify(payload), opts.state ?? 'pending'],
    );
    return res.rows[0].id;
  }

  it('fetchPendingDecisionPrompts + fetchDecisionCounts: returns only PENDING rows in rank order, counts total vs pending correctly across mixed states', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'readpath-counts');
    cleanupUserIds.push(user.id);
    const strategyId = await seedStrategy(user.id);
    const reviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');

    await insertGraduationPrompt(user.id, reviewId, 2, 'drv.hold_seconds', strategyId);
    await insertGraduationPrompt(user.id, reviewId, 1, 'drv.risk_pct', strategyId);
    await insertGraduationPrompt(user.id, reviewId, 3, 'drv.instrument', strategyId, { state: 'accepted' });

    const pending = await fetchPendingDecisionPrompts(user.id, reviewId);
    expect(pending.map((p: { rank: number }) => p.rank)).toEqual([1, 2]); // rank-ordered, accepted row excluded

    const counts = await fetchDecisionCounts(user.id, reviewId);
    expect(counts).toEqual({ total: 3, pending: 2 });
  });

  it('fetchPromptById: null for a nonexistent id, and correctly scoped to the owning user only', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'readpath-owner-a');
    const userB = await createTestAuthUser(envBundle, 'readpath-owner-b');
    cleanupUserIds.push(userA.id, userB.id);
    const strategyId = await seedStrategy(userA.id);
    const reviewId = await insertReview(userA.id, '2026-09-07', '2026-09-13');
    const promptId = await insertGraduationPrompt(userA.id, reviewId, 1, 'drv.risk_pct', strategyId);

    expect(await fetchPromptById(userA.id, promptId)).not.toBeNull();
    expect(await fetchPromptById(userB.id, promptId)).toBeNull();
    expect(await fetchPromptById(userA.id, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('fetchCurrentReviewIdForDecisions: null when no reviews row exists yet for the current period', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'readpath-no-review');
    cleanupUserIds.push(user.id);
    const result = await fetchCurrentReviewIdForDecisions(user.id);
    expect(result).toBeNull();
  });

  it('buildGraduationPromptDetail: renders the real statement/meta/cost/hint from a live finding, canAccept true for a supported field', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'readpath-detail');
    cleanupUserIds.push(user.id);
    const strategyId = await seedStrategy(user.id);
    await insertFinding(user.id, strategyId, 'drv.risk_pct');

    const evidence = {
      strategyId,
      fieldId: 'drv.risk_pct',
      analyticId: 'find.read-path',
      n: 40,
      winRate: 0.7,
      avgR: null,
      baselineN: 20,
      baselineWinRate: 0.4,
      baselineAvgR: null,
      deltaWinRate: 0.3,
      deltaAvgR: null,
    };
    const detail = await buildGraduationPromptDetail(user.id, 'prompt-id-unused-here', 1, evidence);

    expect(detail.canAccept).toBe(true);
    expect(detail.blockedReason).toBeNull();
    expect(detail.fieldName).toBe('Risk %');
    expect(detail.statement.length).toBeGreaterThan(0);
    expect(detail.meta).toContain('40 trades');
    expect(detail.costLine).toContain('Risk %');
    expect(detail.hint).toBe('Starts soft. Promotes to hard after sustained compliance.');
  });

  it('buildGraduationPromptDetail: canAccept false with the honest blocked reason for a custom field, cost line still populated (facts about the finding, independent of rule-engine support)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'readpath-detail-custom');
    cleanupUserIds.push(user.id);
    const strategyId = await seedStrategy(user.id);
    const fieldId = `conviction_${Date.now()}`;
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, 'Conviction', 'strategy_var', 'pick_one', 'captured', $3, '{"options":["low","high"]}'::jsonb)`,
      [fieldId, user.id, strategyId],
    );
    await insertFinding(user.id, strategyId, fieldId);

    const evidence = {
      strategyId,
      fieldId,
      analyticId: 'find.read-path',
      n: 40,
      winRate: 0.7,
      avgR: null,
      baselineN: 20,
      baselineWinRate: 0.4,
      baselineAvgR: null,
      deltaWinRate: 0.3,
      deltaAvgR: null,
    };
    const detail = await buildGraduationPromptDetail(user.id, 'prompt-id-unused-here', 1, evidence);

    expect(detail.canAccept).toBe(false);
    expect(detail.blockedReason).toBe("This kind of finding can't become a rule yet.");
    expect(detail.costLine.length).toBeGreaterThan(0); // the cost line is still shown honestly, per §4.6
  });

  it('buildGraduationPromptDetail: PROMPT_SUBJECT_GONE-shaped honest fallback when the finding no longer exists', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'readpath-detail-gone');
    cleanupUserIds.push(user.id);
    const strategyId = await seedStrategy(user.id);
    // No finding inserted at all -- simulates a superseded/decayed/deleted row.
    const evidence = {
      strategyId,
      fieldId: 'drv.risk_pct',
      analyticId: 'find.read-path',
      n: 14,
      winRate: 0.7,
      avgR: null,
      baselineN: 10,
      baselineWinRate: 0.4,
      baselineAvgR: null,
      deltaWinRate: 0.3,
      deltaAvgR: null,
    };
    const detail = await buildGraduationPromptDetail(user.id, 'prompt-id-unused-here', 1, evidence);

    expect(detail.canAccept).toBe(false);
    expect(detail.statement).toBe('This finding is no longer available.');
    expect(detail.meta).toContain('14 trades');
  });

  it('buildGraduationPromptDetail: a live row that exists but has drifted below the confidence bar since materialisation is treated as honestly changed, not silently accepted', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'readpath-detail-drifted');
    cleanupUserIds.push(user.id);
    const strategyId = await seedStrategy(user.id);
    await insertFinding(user.id, strategyId, 'drv.risk_pct', { confidence: 'insufficient' });

    const evidence = {
      strategyId,
      fieldId: 'drv.risk_pct',
      analyticId: 'find.read-path',
      n: 40,
      winRate: 0.7,
      avgR: null,
      baselineN: 20,
      baselineWinRate: 0.4,
      baselineAvgR: null,
      deltaWinRate: 0.3,
      deltaAvgR: null,
    };
    const detail = await buildGraduationPromptDetail(user.id, 'prompt-id-unused-here', 1, evidence);

    expect(detail.canAccept).toBe(false);
    expect(detail.blockedReason).toBe('This finding has changed since your review was prepared. Defer to see an updated one next review.');
    // Unlike the "gone entirely" case, the REAL statement/cost line are
    // still shown -- the row exists, it just no longer clears the bar.
    expect(detail.statement).not.toBe('This finding is no longer available.');
    expect(detail.costLine).toContain('Risk %');
  });
});
