import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { computeAndWriteReviewPrompts } from '../review-prompts';
import { writeReviewPrompts } from '../review-prompts-repository';
import { findingSubjectId, detectionSubjectId } from '../prompt-candidates/stable-subject-id';
import { _clearAnalyticConfigCacheForTests } from '@/lib/analytics/config-cache';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000 });

/**
 * Module 06 (Review & Graduation) Slice 4 — `retrospeq-tester` dispatch,
 * 2026-09-12. Live-DB, end-to-end coverage of `computeAndWriteReviewPrompts`
 * (`review-prompts.ts`) and `writeReviewPrompts` (`review-prompts-repository
 * .ts`) — the full §4.3/§4.4/§4.5 pipeline landing a real `review_prompts`
 * write, against the real shared dev/test Supabase project, not a mock.
 *
 * Pure ranking/dormancy logic is already exhaustively covered without a DB
 * in `ranking.test.ts` / `prompt-history-repository.test.ts` (extended this
 * same dispatch). This file's job is everything those two files structurally
 * cannot prove: real `canRender` wiring (plan-gating AND a real
 * `analytic_config` kill switch), a real multi-kind candidate set actually
 * competing for 3 real `review_prompts` rows, real `prompt_history`
 * dormancy state read from Postgres, and the write function's own
 * idempotent-replace/never-clobber-a-decision behaviour.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/review-prompts.ts + review-prompts-repository.ts (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];
  const customAnalyticConfigIds: string[] = [];

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 30_000);

  beforeEach(() => {
    if (env) _clearAnalyticConfigCacheForTests();
  });

  afterEach(async () => {
    if (!env) return;
    for (const analyticId of customAnalyticConfigIds.splice(0)) {
      await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [analyticId]);
    }
    for (const userId of cleanupUserIds.splice(0)) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
      await db.query('delete from retrospeq.review_prompts where user_id = $1', [userId]);
      await db.query('delete from retrospeq.prompt_history where user_id = $1', [userId]);
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]);
      await db.query('delete from retrospeq.analytic_user_suppression where user_id = $1', [userId]);
      await db.query('delete from retrospeq.user_cohorts where user_id = $1', [userId]);
      await db.query('delete from retrospeq.finding_rule_links where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.detections where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trigger_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.field_usages where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]);
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 60_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  // ---------------------------------------------------------------------
  // Shared seeding helpers (mirrors lib/review/prompt-candidates/__tests__/
  // eligibility.live.test.ts's own established conventions).
  // ---------------------------------------------------------------------

  let seq = 0;
  function nextId(label: string): string {
    seq += 1;
    return `rp_${label}_${seq}`;
  }

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Review Prompts Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedStrategy(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Review Prompts Live Test Strategy', 1, false, 'active') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedBoolField(userId: string, strategyId: string, fieldId: string): Promise<void> {
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, $3, 'strategy_var', 'bool', 'captured', $4, '{}'::jsonb)`,
      [fieldId, userId, `Test Flag ${fieldId}`, strategyId],
    );
  }

  async function insertFinding(
    userId: string,
    strategyId: string,
    fieldId: string,
    opts: { analyticId?: string; n: number; deltaWinRate: number; confidence?: 'confident' | 'insufficient' },
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          p_value, p_adjusted, confidence, gate_failures, state)
       values ($1,$2,$3,$4,$5::jsonb,$6,0.7,null,20,0.4,null,$7,null,0.001,0.001,$8,'{}','active')
       returning id`,
      [
        userId,
        opts.analyticId ?? 'find.toggle',
        strategyId,
        fieldId,
        JSON.stringify({ op: 'eq', value: true }),
        opts.n,
        opts.deltaWinRate.toFixed(4),
        opts.confidence ?? 'confident',
      ],
    );
    return res.rows[0].id;
  }

  /**
   * Every ad-hoc `analytic_id` this file invents for a detection fixture
   * needs its OWN `analytic_config` row -- `getAnalyticConfig` resolves a
   * missing row to `not_found`, which `canRender` treats fail-closed (no
   * config -> nothing renders, ever). Unlike the 5 real `seq.*`/`risk.*`
   * ids the detection engine seeds at migration time (`20260909030000`,
   * all free/no-cohort), a brand-new made-up id has no such row, so this
   * seeds one automatically (enabled/free/no-cohort/t0 -- the permissive
   * default every OTHER kind's real fixtures assume) unless the caller is
   * deliberately testing a NON-default config itself (the kill-switch
   * test below, which creates its own `enabled = false` row explicitly).
   */
  async function seedAnalyticConfig(
    analyticId: string,
    opts: { enabled?: boolean; minPlan?: 'free' | 'pro'; cohortOnly?: boolean; minAccountTier?: 't0' | 't1' | 't2' } = {},
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
       values ($1, $2, $3, $4, $5)
       on conflict (analytic_id) do nothing`,
      [analyticId, opts.enabled ?? true, opts.minPlan ?? 'free', opts.cohortOnly ?? false, opts.minAccountTier ?? 't0'],
    );
    customAnalyticConfigIds.push(analyticId);
  }

  async function insertDetection(
    userId: string,
    analyticId: string,
    occurrences: number,
    opts: {
      outcomeAvgR?: number | null;
      outcomeBaselineAvgR?: number | null;
      ruleProposable?: boolean;
      tier?: 'count' | 'count_outcome';
      classification?: 'pattern' | 'incident';
      seedConfig?: boolean;
    } = {},
  ): Promise<string> {
    if (opts.seedConfig !== false) {
      await seedAnalyticConfig(analyticId);
    }
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.detections
         (user_id, analytic_id, occurrences, window_from, window_to, distinct_days, base_rate,
          outcome_avg_r, outcome_baseline_avg_r, tier, classification, rule_proposable, direction, state)
       values ($1,$2,$3,'2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',5,0.1,$4,$5,$6,$7,$8,'active','active')
       returning id`,
      [
        userId,
        analyticId,
        occurrences,
        opts.outcomeAvgR ?? -0.5,
        opts.outcomeBaselineAvgR ?? 0.1,
        opts.tier ?? 'count_outcome',
        opts.classification ?? 'pattern',
        opts.ruleProposable ?? true,
      ],
    );
    return res.rows[0].id;
  }

  async function seedBareTrade(userId: string, accountId: string, serverDay: string, idx: number): Promise<string> {
    const openedAt = new Date(`${serverDay}T00:00:00Z`).getTime() + idx * 60_000;
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $4::date)
       returning id`,
      [userId, accountId, new Date(openedAt).toISOString(), serverDay],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence)
       values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$4::timestamptz,$5::date,'closed',
               '1.10000000','1.10500000','100000.00000000','USD','confident_single')
       returning id`,
      [userId, accountId, blockRes.rows[0].id, new Date(openedAt).toISOString(), serverDay],
    );
    return tradeRes.rows[0].id;
  }

  async function insertRule(
    userId: string,
    opts: { severity?: 'soft' | 'hard'; state?: 'active' | 'retired'; createdAt: Date; rendered?: string },
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, severity, origin, evaluation, state, created_at)
       values ($1, $2, 'authored', 'pre_entry', $3, $4::timestamptz) returning id`,
      [userId, opts.severity ?? 'soft', opts.state ?? 'active', opts.createdAt.toISOString()],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, 'risk_pct', 'lte', '1'::jsonb, $3)`,
      [ruleId, userId, opts.rendered ?? 'Risk stays under 1%.'],
    );
    return ruleId;
  }

  async function insertRuleEvaluation(
    userId: string,
    tradeId: string,
    ruleId: string,
    result: 'followed' | 'broken',
    serverDay: string,
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.rule_evaluations (user_id, trade_id, rule_id, rule_version, severity, result, server_day)
       values ($1, $2, $3, 1, 'soft', $4, $5::date)`,
      [userId, tradeId, ruleId, result, serverDay],
    );
  }

  function daysAgo(now: Date, n: number): string {
    return new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  async function insertCondition(userId: string, strategyId: string, text: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trigger_conditions (user_id, strategy_id, text, sort_order) values ($1, $2, $3, 1) returning id`,
      [userId, strategyId, text],
    );
    return res.rows[0].id;
  }

  async function insertTriggerEval(userId: string, tradeId: string, conditionId: string, result: 'met' | 'unmet'): Promise<void> {
    await db.query(
      `insert into retrospeq.trigger_evaluations (user_id, trade_id, condition_id, result) values ($1, $2, $3, $4)`,
      [userId, tradeId, conditionId, result],
    );
  }

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

  async function addToCohort(userId: string): Promise<void> {
    await db.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'beta_traders')`, [userId]);
  }

  async function insertReview(userId: string, periodStart: string, periodEnd: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2::date, $3::date, 1, '{}'::jsonb) returning id`,
      [userId, periodStart, periodEnd],
    );
    return res.rows[0].id;
  }

  async function insertPromptHistory(
    userId: string,
    subjectType: string,
    subjectId: string,
    kind: string,
    opts: { declineCount?: number; occurrencesAtLastDecline?: number | null; muted?: boolean },
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.prompt_history (user_id, subject_type, subject_id, kind, decline_count, occurrences_at_last_decline, muted)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, subjectType, subjectId, kind, opts.declineCount ?? 0, opts.occurrencesAtLastDecline ?? null, opts.muted ?? false],
    );
  }

  // =====================================================================
  // ITEM 3 — the canRender gate closure. The single most important thing
  // to verify: a graduation/detection candidate that would otherwise be
  // eligible is EXCLUDED once it's plan-gated or kill-switched, proven live.
  // =====================================================================

  it('CANRENDER GATE (plan): a free-plan, non-cohort user\'s otherwise-eligible graduation candidate never reaches review_prompts; the identical fixture for a pro+cohort user DOES', async () => {
    if (!env) return;
    const freeUser = await createTestAuthUser(envBundle, 'canrender-grad-free');
    const proUser = await createTestAuthUser(envBundle, 'canrender-grad-pro');
    cleanupUserIds.push(freeUser.id, proUser.id);

    async function seedGraduationFixture(userId: string): Promise<string> {
      const strategyId = await seedStrategy(userId);
      const fieldId = nextId('grad_gate');
      await seedBoolField(userId, strategyId, fieldId);
      await insertFinding(userId, strategyId, fieldId, { n: 45, deltaWinRate: 0.3 });
      return findingSubjectId(strategyId, fieldId);
    }

    const freeSubjectId = await seedGraduationFixture(freeUser.id);
    const proSubjectId = await seedGraduationFixture(proUser.id);
    await setPlan(proUser.id, 'pro');
    await addToCohort(proUser.id);

    const freeReviewId = await insertReview(freeUser.id, '2026-08-31', '2026-09-06');
    const proReviewId = await insertReview(proUser.id, '2026-08-31', '2026-09-06');

    const freeWritten = await computeAndWriteReviewPrompts(freeUser.id, freeReviewId, new Date('2026-09-07T00:00:00Z'));
    const proWritten = await computeAndWriteReviewPrompts(proUser.id, proReviewId, new Date('2026-09-07T00:00:00Z'));

    // Free/no-cohort: min_plan='pro', cohort_only=true on find.toggle
    // (20260911010000 seed) -- both gates fail this user. Excluded.
    expect(freeWritten.find((p) => p.subjectId === freeSubjectId)).toBeUndefined();
    expect(freeWritten).toEqual([]);

    // Same fixture shape, pro + cohort -- passes canRender, survives ranking
    // (only candidate), gets written for real.
    const proMatch = proWritten.find((p) => p.subjectId === proSubjectId);
    expect(proMatch).toBeDefined();
    expect(proMatch!.kind).toBe('graduation');
    expect(proMatch!.rank).toBe(1);

    const dbRows = await db.query(`select subject_id, kind from retrospeq.review_prompts where user_id = $1`, [freeUser.id]);
    expect(dbRows.rows).toHaveLength(0);
  });

  it('CANRENDER GATE (kill switch, analytic_config.enabled=false): an otherwise-qualifying detection candidate is excluded while disabled, and appears once re-enabled -- proven live against the real analytic_config table', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'canrender-detection-killswitch');
    cleanupUserIds.push(user.id);

    const customAnalyticId = `test.review-prompts.killswitch.${Date.now()}`;
    customAnalyticConfigIds.push(customAnalyticId);
    await db.query(
      `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
       values ($1, false, 'free', false, 't0')`,
      [customAnalyticId],
    );
    await insertDetection(user.id, customAnalyticId, 20, { seedConfig: false });
    const expectedSubjectId = detectionSubjectId(customAnalyticId);

    const reviewId = await insertReview(user.id, '2026-08-31', '2026-09-06');
    const writtenWhileDisabled = await computeAndWriteReviewPrompts(user.id, reviewId, new Date('2026-09-07T00:00:00Z'));
    expect(writtenWhileDisabled.find((p) => p.subjectId === expectedSubjectId)).toBeUndefined();
    expect(writtenWhileDisabled).toEqual([]);

    // Flip the kill switch live and clear the cache -- the real wired path
    // must see the change on the very next call.
    await db.query(`update retrospeq.analytic_config set enabled = true where analytic_id = $1`, [customAnalyticId]);
    _clearAnalyticConfigCacheForTests();

    const writtenWhileEnabled = await computeAndWriteReviewPrompts(user.id, reviewId, new Date('2026-09-07T00:00:00Z'));
    const match = writtenWhileEnabled.find((p) => p.subjectId === expectedSubjectId);
    expect(match).toBeDefined();
    expect(match!.kind).toBe('detection');
  });

  // =====================================================================
  // ITEM 2 — the 3-per-week cap combined with kind-priority ordering,
  // spanning all 5 kinds, live, with REAL rank assignment written to
  // review_prompts.
  // =====================================================================

  it('ADVERSARIAL, ALL 5 KINDS: the final review_prompts rows are exactly the top-3 by kind-priority-then-magnitude, ranks 1/2/3, the rest correctly dropped', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'multikind-cap');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const now = new Date('2026-09-11T12:00:00Z');
    const createdAt = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days -- clears every kind's 42-day floor
    const accountId = await seedAccount(user.id);
    const strategyId = await seedStrategy(user.id);

    // --- Relaxation (kind priority 1): 20 window evals, 8 broken (40%).
    const relaxRuleId = await insertRule(user.id, { createdAt, rendered: 'Relaxation candidate rule' });
    for (let i = 0; i < 20; i++) {
      const tradeId = await seedBareTrade(user.id, accountId, daysAgo(now, 5), i);
      await insertRuleEvaluation(user.id, tradeId, relaxRuleId, i < 8 ? 'broken' : 'followed', daysAgo(now, 5));
    }

    // --- Graduation (kind priority 2): confident, n=45 (deliberately the
    // ONLY graduation candidate, so kind priority -- not within-kind
    // magnitude -- is what this fixture isolates for graduation's slot).
    const gradFieldId = nextId('multikind_grad');
    await seedBoolField(user.id, strategyId, gradFieldId);
    const gradSubjectId = await insertFinding(user.id, strategyId, gradFieldId, { n: 45, deltaWinRate: 0.3 }).then(() =>
      findingSubjectId(strategyId, gradFieldId),
    );

    // --- Detection (kind priority 3): two candidates, only the higher-
    // occurrence one may survive the single-detection cap AND the combined
    // cap's 3rd slot.
    const detLowId = `seq.multikind_low_${Date.now()}`;
    const detHighId = `seq.multikind_high_${Date.now()}`;
    await insertDetection(user.id, detLowId, 8);
    await insertDetection(user.id, detHighId, 40);
    // Both must actually canRender -- use real seeded free/no-cohort ids
    // (seq.* are seeded free, cohort_only=false, 20260909030000) so a
    // pro+cohort user trivially passes; no custom analytic_config needed.
    const detHighSubjectId = detectionSubjectId(detHighId);
    const detLowSubjectId = detectionSubjectId(detLowId);

    // --- Promotion (kind priority 4): would otherwise qualify, must be
    // dropped once the cap is full.
    const promoRuleId = await insertRule(user.id, { createdAt, severity: 'soft', rendered: 'Promotion candidate rule' });
    for (let i = 0; i < 20; i++) {
      const tradeId = await seedBareTrade(user.id, accountId, daysAgo(now, 30), 100 + i);
      await insertRuleEvaluation(user.id, tradeId, promoRuleId, 'followed', daysAgo(now, 30));
    }

    // --- Retirement (kind priority 5, condition sub-kind): 31 met, must
    // also be dropped.
    const conditionId = await insertCondition(user.id, strategyId, 'Checked the calendar');
    for (let i = 0; i < 31; i++) {
      const tradeId = await seedBareTrade(user.id, accountId, '2026-08-01', 500 + i);
      await insertTriggerEval(user.id, tradeId, conditionId, 'met');
    }

    const reviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const written = await computeAndWriteReviewPrompts(user.id, reviewId, now);

    expect(written).toHaveLength(3);
    const byRank = [...written].sort((a, b) => a.rank - b.rank);
    expect(byRank.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(byRank[0]).toMatchObject({ kind: 'relaxation', subjectId: relaxRuleId, rank: 1 });
    expect(byRank[1]).toMatchObject({ kind: 'graduation', subjectId: gradSubjectId, rank: 2 });
    expect(byRank[2]).toMatchObject({ kind: 'detection', subjectId: detHighSubjectId, rank: 3 });

    const writtenIds = written.map((p) => p.subjectId);
    expect(writtenIds).not.toContain(detLowSubjectId);
    expect(writtenIds).not.toContain(promoRuleId);
    expect(writtenIds).not.toContain(conditionId);

    // Confirm directly against the table too -- not just the function's
    // own return value.
    const dbRows = await db.query<{ rank: number; kind: string; subject_id: string; review_id: string }>(
      `select rank, kind, subject_id, review_id from retrospeq.review_prompts where user_id = $1 order by rank`,
      [user.id],
    );
    expect(dbRows.rows).toHaveLength(3);
    expect(dbRows.rows.every((r) => r.review_id === reviewId)).toBe(true);
  }, 180_000);

  // =====================================================================
  // ITEM 1 (live confirmation) — the single-detection cap, adversarially,
  // through the REAL pipeline and a real review_prompts write.
  // =====================================================================

  it('SINGLE-DETECTION CAP, LIVE: 3 real qualifying detections, deliberately inserted out of winner order -- exactly one review_prompts row of kind=detection is written', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'single-detection-cap-live');
    cleanupUserIds.push(user.id);

    const suffix = Date.now();
    const midId = `seq.cap_mid_${suffix}`;
    const lowId = `seq.cap_low_${suffix}`;
    const highId = `seq.cap_high_${suffix}`;
    await insertDetection(user.id, midId, 15);
    await insertDetection(user.id, lowId, 8);
    await insertDetection(user.id, highId, 40);
    const expectedSubjectId = detectionSubjectId(highId);

    const reviewId = await insertReview(user.id, '2026-08-24', '2026-08-30');
    const written = await computeAndWriteReviewPrompts(user.id, reviewId);

    const detectionRows = written.filter((p) => p.kind === 'detection');
    expect(detectionRows).toHaveLength(1);
    expect(detectionRows[0].subjectId).toBe(expectedSubjectId);

    const dbCount = await db.query(`select count(*)::int as count from retrospeq.review_prompts where user_id = $1 and kind = 'detection'`, [user.id]);
    expect(dbCount.rows[0].count).toBe(1);
  });

  // =====================================================================
  // ITEM 4 — dormancy re-raise: doubling, non-doubling, and the
  // null-snapshot default, all against real prompt_history rows.
  // =====================================================================

  it('DORMANCY: not-doubled stays excluded, exactly-doubled re-appears, and a null occurrences_at_last_decline snapshot stays excluded (fail-closed) -- all in one real pipeline run', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'dormancy-live');
    cleanupUserIds.push(user.id);

    const suffix = Date.now();
    const notDoubledId = `seq.dormant_not_doubled_${suffix}`;
    const doubledId = `seq.dormant_doubled_${suffix}`;
    const nullSnapshotId = `seq.dormant_null_snapshot_${suffix}`;

    // Not doubled: declined at 10, currently 15 (1.5x).
    await insertDetection(user.id, notDoubledId, 15);
    await insertPromptHistory(user.id, 'detection', detectionSubjectId(notDoubledId), 'detection', { declineCount: 1, occurrencesAtLastDecline: 10 });

    // Exactly doubled: declined at 10, currently 20 (2x) -- re-appears.
    await insertDetection(user.id, doubledId, 20);
    await insertPromptHistory(user.id, 'detection', detectionSubjectId(doubledId), 'detection', { declineCount: 1, occurrencesAtLastDecline: 10 });

    // Null snapshot on an already-declined subject -- fail-closed, stays
    // excluded no matter how large the current count is.
    await insertDetection(user.id, nullSnapshotId, 100_000);
    await insertPromptHistory(user.id, 'detection', detectionSubjectId(nullSnapshotId), 'detection', { declineCount: 1, occurrencesAtLastDecline: null });

    const reviewId = await insertReview(user.id, '2026-08-17', '2026-08-23');
    const written = await computeAndWriteReviewPrompts(user.id, reviewId);

    const writtenSubjectIds = written.map((p) => p.subjectId);
    expect(writtenSubjectIds).not.toContain(detectionSubjectId(notDoubledId));
    expect(writtenSubjectIds).not.toContain(detectionSubjectId(nullSnapshotId));
    // The single-detection cap means only ONE detection can win regardless
    // -- the doubled one is the only eligible detection candidate at all
    // (the other two are dormancy-excluded before ranking ever runs), so
    // it must be the one written.
    expect(writtenSubjectIds).toContain(detectionSubjectId(doubledId));
    expect(written.filter((p) => p.kind === 'detection')).toHaveLength(1);
  });

  // =====================================================================
  // ITEM 5 — muted exclusion still holds even after ranking/capping is
  // layered on top; deliberately gives the MUTED candidate the winning
  // magnitude so a ranking-order bug would otherwise let it through.
  // =====================================================================

  it('MUTE STILL HOLDS UNDER RANKING: a muted detection with a HIGHER occurrence count than the sole remaining candidate is still excluded -- the surviving row is the unmuted one, not an arbitrary one', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'mute-under-ranking-live');
    cleanupUserIds.push(user.id);

    const suffix = Date.now();
    const mutedId = `seq.muted_winner_${suffix}`;
    const unmutedId = `seq.unmuted_loser_${suffix}`;
    await insertDetection(user.id, mutedId, 999); // would win the single-detection cap on magnitude alone
    await insertDetection(user.id, unmutedId, 10);
    await insertPromptHistory(user.id, 'detection', detectionSubjectId(mutedId), 'detection', { muted: true });

    const reviewId = await insertReview(user.id, '2026-08-10', '2026-08-16');
    const written = await computeAndWriteReviewPrompts(user.id, reviewId);

    const detectionRows = written.filter((p) => p.kind === 'detection');
    expect(detectionRows).toHaveLength(1);
    expect(detectionRows[0].subjectId).toBe(detectionSubjectId(unmutedId));
    expect(detectionRows[0].subjectId).not.toBe(detectionSubjectId(mutedId));
  });

  // =====================================================================
  // ITEM 6 — write correctness (review_id linkage) and idempotency
  // (delete-pending-then-insert; a real accepted decision is never
  // clobbered by a re-run).
  // =====================================================================

  it('WRITE CORRECTNESS: rows are correctly linked to their parent review via review_id, with the right rank/kind/subject_type', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'write-correctness-live');
    cleanupUserIds.push(user.id);
    const analyticId = `seq.write_correctness_${Date.now()}`;
    await insertDetection(user.id, analyticId, 12);

    const reviewId = await insertReview(user.id, '2026-08-03', '2026-08-09');
    const written = await computeAndWriteReviewPrompts(user.id, reviewId);
    expect(written).toHaveLength(1);
    expect(written[0].reviewId).toBe(reviewId);

    const row = await db.query<{ review_id: string; subject_type: string; kind: string; rank: number; state: string }>(
      `select review_id, subject_type, kind, rank, state from retrospeq.review_prompts where id = $1`,
      [written[0].id],
    );
    expect(row.rows[0]).toEqual({
      review_id: reviewId,
      subject_type: 'detection',
      kind: 'detection',
      rank: 1,
      state: 'pending',
    });
  });

  it('IDEMPOTENCY: re-running for the same review with a DIFFERENT candidate set leaves exactly the second call\'s own rows -- no duplicates, no orphans', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'idempotency-live');
    cleanupUserIds.push(user.id);
    const suffix = Date.now();
    const firstId = `seq.idempotent_first_${suffix}`;
    const secondId = `seq.idempotent_second_${suffix}`;
    await insertDetection(user.id, firstId, 12);

    const reviewId = await insertReview(user.id, '2026-07-27', '2026-08-02');
    const firstRun = await computeAndWriteReviewPrompts(user.id, reviewId);
    expect(firstRun).toHaveLength(1);
    expect(firstRun[0].subjectId).toBe(detectionSubjectId(firstId));

    // Simulate the underlying candidate set changing between runs: the
    // first detection is superseded away, a different one appears.
    await db.query(`update retrospeq.detections set state = 'superseded' where user_id = $1 and analytic_id = $2`, [user.id, firstId]);
    await insertDetection(user.id, secondId, 12);

    const secondRun = await computeAndWriteReviewPrompts(user.id, reviewId);
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0].subjectId).toBe(detectionSubjectId(secondId));

    const allRows = await db.query(`select subject_id from retrospeq.review_prompts where user_id = $1 and review_id = $2`, [user.id, reviewId]);
    expect(allRows.rows).toHaveLength(1);
    expect(allRows.rows[0].subject_id).toBe(detectionSubjectId(secondId));
  });

  it('NEVER CLOBBERS A DECISION: a pre-existing state=accepted row for this review survives a re-materialisation untouched, while pending rows are freshly written alongside it', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'never-clobber-live');
    cleanupUserIds.push(user.id);
    const reviewId = await insertReview(user.id, '2026-07-20', '2026-07-26');

    const acceptedSubjectId = detectionSubjectId(`seq.already-accepted-${Date.now()}`);
    const acceptedRes = await db.query<{ id: string; decided_at: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state, decided_at)
       values ($1, $2, 'detection', 1, 'detection', $3, '{}'::jsonb, 'accepted', now())
       returning id, decided_at::text as decided_at`,
      [user.id, reviewId, acceptedSubjectId],
    );
    const acceptedId = acceptedRes.rows[0].id;
    const acceptedDecidedAt = acceptedRes.rows[0].decided_at;

    // A fresh, real pending candidate for the same review.
    const freshAnalyticId = `seq.never_clobber_fresh_${Date.now()}`;
    await insertDetection(user.id, freshAnalyticId, 12);

    await writeReviewPrompts(user.id, reviewId, [
      {
        subjectType: 'detection',
        subjectId: detectionSubjectId(freshAnalyticId),
        kind: 'detection',
        evidence: { analyticId: freshAnalyticId, occurrences: 12 },
        rank: 1,
      },
    ]);

    const acceptedAfter = await db.query<{ id: string; state: string; decided_at: string }>(
      `select id, state, decided_at::text as decided_at from retrospeq.review_prompts where id = $1`,
      [acceptedId],
    );
    expect(acceptedAfter.rows[0]).toEqual({ id: acceptedId, state: 'accepted', decided_at: acceptedDecidedAt });

    const pendingRows = await db.query<{ subject_id: string; state: string }>(
      `select subject_id, state from retrospeq.review_prompts where user_id = $1 and review_id = $2 and state = 'pending'`,
      [user.id, reviewId],
    );
    expect(pendingRows.rows).toHaveLength(1);
    expect(pendingRows.rows[0].subject_id).toBe(detectionSubjectId(freshAnalyticId));

    const totalRows = await db.query(`select count(*)::int as count from retrospeq.review_prompts where user_id = $1 and review_id = $2`, [user.id, reviewId]);
    expect(totalRows.rows[0].count).toBe(2);
  });

  // =====================================================================
  // ITEM 7 — cross-user isolation, application-level (service-role query
  // scoping), not just the RLS policy (already covered at the schema level
  // by review-graduation-schema.rls.test.ts).
  // =====================================================================

  it('CROSS-USER ISOLATION: computing/writing for user A never reads or writes user B\'s candidates or review_prompts rows', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'isoA-review-prompts');
    const userB = await createTestAuthUser(envBundle, 'isoB-review-prompts');
    cleanupUserIds.push(userA.id, userB.id);

    const suffix = Date.now();
    const analyticA = `seq.iso_a_${suffix}`;
    const analyticB = `seq.iso_b_${suffix}`;
    await insertDetection(userA.id, analyticA, 12);
    await insertDetection(userB.id, analyticB, 12);

    const reviewA = await insertReview(userA.id, '2026-07-13', '2026-07-19');
    const reviewB = await insertReview(userB.id, '2026-07-13', '2026-07-19');

    const writtenA = await computeAndWriteReviewPrompts(userA.id, reviewA);
    const writtenB = await computeAndWriteReviewPrompts(userB.id, reviewB);

    expect(writtenA).toHaveLength(1);
    expect(writtenA[0].subjectId).toBe(detectionSubjectId(analyticA));
    expect(writtenB).toHaveLength(1);
    expect(writtenB[0].subjectId).toBe(detectionSubjectId(analyticB));

    const rowsA = await db.query(`select subject_id from retrospeq.review_prompts where user_id = $1`, [userA.id]);
    const rowsB = await db.query(`select subject_id from retrospeq.review_prompts where user_id = $1`, [userB.id]);
    expect(rowsA.rows.map((r) => r.subject_id)).toEqual([detectionSubjectId(analyticA)]);
    expect(rowsB.rows.map((r) => r.subject_id)).toEqual([detectionSubjectId(analyticB)]);
    expect(JSON.stringify(rowsA.rows)).not.toContain(detectionSubjectId(analyticB));
    expect(JSON.stringify(rowsB.rows)).not.toContain(detectionSubjectId(analyticA));
  });
});
