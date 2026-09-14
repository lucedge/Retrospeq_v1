import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { addDaysToServerDay, weekStartForServerDay } from '@/lib/rules/week-boundary';

/**
 * Module 06 (Review & Graduation) Slice 8 (promotion/retirement, frames
 * 4.8/4.9) — `retrospeq-tester`-shaped live-DB coverage of
 * `acceptPromotionDecision`/`declinePromotionDecision`/
 * `swapAndPromoteDecision`/`acceptRetirementDecision`/
 * `keepRetirementDecision`, against the real shared dev/test Supabase
 * project — real writes, real RLS. Mirrors `decisions-relaxation-
 * integration.live.test.ts`'s own established mocking posture: only
 * `@/lib/supabase/server`, `@/lib/rate-limit/http`, `@/lib/rate-limit/
 * limiter`, `next/cache` are mocked; every domain write
 * (`promoteRule`/`demoteRule`/`retireRule` from Module 04,
 * `retireTriggerConditionState`, every `prompts-repository.ts` function)
 * runs for real.
 */
const env = readRlsTestEnv();

const { getUserMock, createClientMock, getClientIpMock, enforceRateLimitMock, revalidatePathMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.99'),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  revalidatePathMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/rate-limit/http', () => ({ getClientIp: getClientIpMock }));
vi.mock('@/lib/rate-limit/limiter', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));
vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!env)('review/decisions/actions.ts — promotion + retirement (live DB)', () => {
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
      await db.query('delete from retrospeq.prompt_history where user_id = $1', [userId]);
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]);
      await db.query('delete from retrospeq.finding_rule_links where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trigger_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 60_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  function mockSession(userId: string): void {
    createClientMock.mockResolvedValue({ auth: { getUser: getUserMock } });
    getUserMock.mockResolvedValue({ data: { user: { id: userId } } });
  }

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Promo/Retire Live Test', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedStrategy(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Promo/Retire Live Test Strategy', 1, false, 'active') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(userId: string, accountId: string, serverDay: string): Promise<string> {
    const openedAt = new Date(`${serverDay}T10:00:00Z`);
    const closedAt = new Date(`${serverDay}T11:00:00Z`);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date) returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    const blockId = blockRes.rows[0].id;
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6::date, 'closed',
               '1.10000000', '1.10500000', '100000.00000000', 'USD', 'confident_single')
       returning id`,
      [userId, accountId, blockId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    return tradeRes.rows[0].id;
  }

  async function insertRule(userId: string, opts: { severity?: 'soft' | 'hard'; createdAt: Date; rendered?: string }): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, severity, origin, evaluation, state, scope, created_at)
       values ($1, $2, 'authored', 'pre_entry', 'active', 'global', $3::timestamptz) returning id`,
      [userId, opts.severity ?? 'soft', opts.createdAt.toISOString()],
    );
    const ruleId = ruleRes.rows[0].id;
    // `risk_pct` is a real, catalogued operand (`lib/rules/operand-
    // catalogue.ts`) — `buildRetirementDecayPromptDetail` calls the real
    // `renderSentence` against this row's own `operandId`/`op`/`value`,
    // which throws for a made-up operand id.
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, 'risk_pct', 'lte', '1.0'::jsonb, $3)`,
      [ruleId, userId, opts.rendered ?? 'Never risk more than 1% per trade.'],
    );
    return ruleId;
  }

  /** A rule genuinely eligible for §5.7 promotion — 50 days old, 20
   *  followed (never broken) evaluations spread over the last 20 days. */
  async function seedPromotionEligibleRule(userId: string, accountId: string, rendered?: string): Promise<string> {
    const ruleId = await insertRule(userId, { severity: 'soft', createdAt: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000), rendered });
    for (let i = 1; i <= 20; i++) {
      const serverDay = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const tradeId = await seedTrade(userId, accountId, serverDay);
      await db.query(
        `insert into retrospeq.rule_evaluations (user_id, trade_id, rule_id, rule_version, severity, result, server_day)
         values ($1, $2, $3, 1, 'soft', 'followed', $4::date)`,
        [userId, tradeId, ruleId, serverDay],
      );
    }
    return ruleId;
  }

let reviewPeriodCounter = 0;

  async function insertReview(userId: string): Promise<string> {
    // Distinct `period_start` per call within a test — `reviews` has a
    // real `unique (user_id, period_kind, period_start)` constraint, and
    // some tests (e.g. the decline-twice-mutes case) legitimately insert
    // more than one review for the SAME user to model a re-raised prompt
    // in a later week.
    const periodStart = new Date(Date.UTC(2026, 8, 7) - reviewPeriodCounter * 7 * 24 * 60 * 60 * 1000);
    const periodEnd = new Date(periodStart.getTime() + 6 * 24 * 60 * 60 * 1000);
    reviewPeriodCounter += 1;
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2::date, $3::date, 1, '{}'::jsonb) returning id`,
      [userId, periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10)],
    );
    return res.rows[0].id;
  }

  /** For a fresh test user (no prior completed review), `determineCurrentWeeklyReviewPeriod`
   *  (`lib/review/current-period.ts`) resolves the current period to the
   *  most recently ENDED ISO week — reproduced here so `fetchNextDecision`
   *  (which calls that same function) actually finds the review this
   *  helper inserts, unlike the counter-based `insertReview` above (fine
   *  for tests that only look up a prompt by id directly, never by
   *  period). */
  async function insertReviewForCurrentPeriod(userId: string): Promise<string> {
    const todayServerDay = new Date().toISOString().slice(0, 10);
    const currentWeekStart = weekStartForServerDay(todayServerDay);
    const periodStart = addDaysToServerDay(currentWeekStart, -7);
    const periodEnd = addDaysToServerDay(periodStart, 6);
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2::date, $3::date, 1, '{}'::jsonb) returning id`,
      [userId, periodStart, periodEnd],
    );
    return res.rows[0].id;
  }

  async function insertPromotionPrompt(
    userId: string,
    reviewId: string,
    ruleId: string,
    evidence: Record<string, unknown>,
    opts: { state?: string } = {},
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'promotion', 1, 'rule', $3, $4::jsonb, $5)
       returning id`,
      [userId, reviewId, ruleId, JSON.stringify(evidence), opts.state ?? 'pending'],
    );
    return res.rows[0].id;
  }

  /** Seeds a decayed rule/finding tuple: an ORIGINAL finding (superseded,
   *  71% win rate) linked via `finding_rule_links` to a rule, plus a
   *  CURRENT finding for the SAME `(strategy_id, field_id, segment)`
   *  tuple, `state = 'decayed'`, 48% win rate — exactly what
   *  `fetchLiveDecayTuple` (`retirement-evidence-detail.ts`) re-derives. */
  async function seedDecayedRuleAndFinding(
    userId: string,
    strategyId: string,
  ): Promise<{ ruleId: string; decayedFindingId: string }> {
    const ruleId = await insertRule(userId, { severity: 'soft', createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) });
    const fieldId = 'drv.risk_pct';
    const segment = JSON.stringify({ op: 'gte', value: 4 });

    const origRes = await db.query<{ id: string }>(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, baseline_n, baseline_win_rate,
          delta_win_rate, confidence, state)
       values ($1, 'find.promo-retire', $2, $3, $4::jsonb, 25, 0.71, 20, 0.42, 0.29, 'confident', 'superseded')
       returning id`,
      [userId, strategyId, fieldId, segment],
    );
    const origId = origRes.rows[0].id;

    const currentRes = await db.query<{ id: string }>(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, baseline_n, baseline_win_rate,
          delta_win_rate, confidence, state)
       values ($1, 'find.promo-retire', $2, $3, $4::jsonb, 40, 0.48, 20, 0.46, 0.02, 'confident', 'decayed')
       returning id`,
      [userId, strategyId, fieldId, segment],
    );
    const currentId = currentRes.rows[0].id;

    await db.query(
      `insert into retrospeq.finding_rule_links (finding_id, rule_id, user_id, delta_at_graduation, trades_at_graduation, consecutive_decay_checks)
       values ($1, $2, $3, 0.29, 25, 2)`,
      [origId, ruleId, userId],
    );

    return { ruleId, decayedFindingId: currentId };
  }

  async function insertRetirementDecayPrompt(userId: string, reviewId: string, ruleId: string, decayedFindingId: string, strategyId: string): Promise<string> {
    const evidence = {
      ruleId,
      decayedFindingId,
      strategyId,
      fieldId: 'drv.risk_pct',
      n: 40,
      currentDeltaWinRate: 0.02,
      deltaAtGraduation: 0.29,
      tradesAtGraduation: 25,
      consecutiveDecayChecks: 2,
    };
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'retirement', 1, 'rule', $3, $4::jsonb, 'pending')
       returning id`,
      [userId, reviewId, ruleId, JSON.stringify(evidence)],
    );
    return res.rows[0].id;
  }

  async function seedConditionEligibleForRetirement(userId: string, strategyId: string): Promise<string> {
    const conditionRes = await db.query<{ id: string }>(
      `insert into retrospeq.trigger_conditions (user_id, strategy_id, text, sort_order, state)
       values ($1, $2, 'Price above the daily VWAP', 0, 'active') returning id`,
      [userId, strategyId],
    );
    const conditionId = conditionRes.rows[0].id;
    const accountId = await seedAccount(userId);
    for (let i = 1; i <= 30; i++) {
      const serverDay = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const tradeId = await seedTrade(userId, accountId, serverDay);
      await db.query(
        `insert into retrospeq.trigger_evaluations (user_id, trade_id, condition_id, result)
         values ($1, $2, $3, 'met')`,
        [userId, tradeId, conditionId],
      );
    }
    return conditionId;
  }

  async function insertRetirementConditionPrompt(userId: string, reviewId: string, conditionId: string, strategyId: string): Promise<string> {
    const evidence = { conditionId, strategyId, text: 'Price above the daily VWAP', recordedEvaluations: 30 };
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'retirement', 1, 'trigger_condition', $3, $4::jsonb, 'pending')
       returning id`,
      [userId, reviewId, conditionId, JSON.stringify(evidence)],
    );
    return res.rows[0].id;
  }

  // -----------------------------------------------------------------
  // Promotion — accept ("Make it hard")
  // -----------------------------------------------------------------

  it('acceptPromotionDecision: promotes the rule to hard, marks the prompt accepted with resolution=made_hard', async () => {
    if (!env) return;
    const { acceptPromotionDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'promo-accept');
    cleanupUserIds.push(user.id);
    mockSession(user.id);
    await setPlan(user.id, 'pro'); // `rules.hard` is Pro-only (§5.7) — real accept needs real Pro room.

    const accountId = await seedAccount(user.id);
    const ruleId = await seedPromotionEligibleRule(user.id, accountId, '"Only take conviction 4 or higher" example');
    const reviewId = await insertReview(user.id);
    const promptId = await insertPromotionPrompt(user.id, reviewId, ruleId, {
      ruleId,
      rendered: 'Only take conviction 4 or higher.',
      ageDays: 50,
      applicableEvaluations: 20,
      followedEvaluations: 20,
      complianceRatio: 1,
    });

    const result = await acceptPromotionDecision(promptId);
    expect(result.success).toBe(true);
    expect(result.ruleId).toBe(ruleId);

    const ruleRow = await db.query('select severity from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].severity).toBe('hard');

    const promptRow = await db.query('select state, payload from retrospeq.review_prompts where id = $1', [promptId]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].payload.resolution).toBe('made_hard');
  });

  it('declinePromotionDecision: leaves the rule soft, records a decline in prompt_history (decline_count=1, not muted)', async () => {
    if (!env) return;
    const { declinePromotionDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'promo-decline');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const accountId = await seedAccount(user.id);
    const ruleId = await seedPromotionEligibleRule(user.id, accountId);
    const reviewId = await insertReview(user.id);
    const promptId = await insertPromotionPrompt(user.id, reviewId, ruleId, {
      ruleId,
      rendered: 'Only take conviction 4 or higher.',
      ageDays: 50,
      applicableEvaluations: 20,
      followedEvaluations: 20,
      complianceRatio: 1,
    });

    const result = await declinePromotionDecision(promptId);
    expect(result.success).toBe(true);

    const ruleRow = await db.query('select severity from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].severity).toBe('soft');

    const promptRow = await db.query('select state, payload from retrospeq.review_prompts where id = $1', [promptId]);
    expect(promptRow.rows[0].state).toBe('declined');
    expect(promptRow.rows[0].payload.resolution).toBe('kept_soft');

    const historyRow = await db.query(
      `select decline_count, muted, occurrences_at_last_decline from retrospeq.prompt_history
        where user_id = $1 and subject_type = 'rule' and subject_id = $2 and kind = 'promotion'`,
      [user.id, ruleId],
    );
    expect(historyRow.rows[0]).toEqual({ decline_count: 1, muted: false, occurrences_at_last_decline: 20 });
  });

  it('declining the SAME subject twice mutes it permanently (§4.5)', async () => {
    if (!env) return;
    const { declinePromotionDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'promo-decline-twice');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const accountId = await seedAccount(user.id);
    const ruleId = await seedPromotionEligibleRule(user.id, accountId);
    const reviewId = await insertReview(user.id);
    const evidence = { ruleId, rendered: 'Only take conviction 4 or higher.', ageDays: 50, applicableEvaluations: 20, followedEvaluations: 20, complianceRatio: 1 };

    const firstPromptId = await insertPromotionPrompt(user.id, reviewId, ruleId, evidence);
    await declinePromotionDecision(firstPromptId);

    // A second, later review's own prompt for the SAME subject — mirrors
    // a re-raised prompt next review.
    const secondReviewId = await insertReview(user.id);
    const secondPromptId = await insertPromotionPrompt(user.id, secondReviewId, ruleId, evidence);
    await declinePromotionDecision(secondPromptId);

    const historyRow = await db.query(
      `select decline_count, muted from retrospeq.prompt_history
        where user_id = $1 and subject_type = 'rule' and subject_id = $2 and kind = 'promotion'`,
      [user.id, ruleId],
    );
    expect(historyRow.rows[0]).toEqual({ decline_count: 2, muted: true });
  });

  it('ALREADY DECIDED: a second accept on the same (now-declined) prompt replays honestly, does not re-decide', async () => {
    if (!env) return;
    const { acceptPromotionDecision, declinePromotionDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'promo-already-decided');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const accountId = await seedAccount(user.id);
    const ruleId = await seedPromotionEligibleRule(user.id, accountId);
    const reviewId = await insertReview(user.id);
    const promptId = await insertPromotionPrompt(user.id, reviewId, ruleId, {
      ruleId,
      rendered: 'Only take conviction 4 or higher.',
      ageDays: 50,
      applicableEvaluations: 20,
      followedEvaluations: 20,
      complianceRatio: 1,
    });

    const declined = await declinePromotionDecision(promptId);
    expect(declined.success).toBe(true);

    const secondAccept = await acceptPromotionDecision(promptId);
    // Replays the winning (decline) outcome rather than promoting late.
    expect(secondAccept.success).toBe(true);
    const ruleRow = await db.query('select severity from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].severity).toBe('soft');
  });

  it('CROSS-USER ISOLATION: user B cannot accept or decline user A\'s promotion prompt', async () => {
    if (!env) return;
    const { acceptPromotionDecision, declinePromotionDecision } = await import('../actions');
    const userA = await createTestAuthUser(envBundle, 'promo-owner-a');
    const userB = await createTestAuthUser(envBundle, 'promo-owner-b');
    cleanupUserIds.push(userA.id, userB.id);

    const accountId = await seedAccount(userA.id);
    const ruleId = await seedPromotionEligibleRule(userA.id, accountId);
    const reviewId = await insertReview(userA.id);
    const promptId = await insertPromotionPrompt(userA.id, reviewId, ruleId, {
      ruleId,
      rendered: 'Only take conviction 4 or higher.',
      ageDays: 50,
      applicableEvaluations: 20,
      followedEvaluations: 20,
      complianceRatio: 1,
    });

    mockSession(userB.id);
    const acceptedByB = await acceptPromotionDecision(promptId);
    expect(acceptedByB.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');
    const declinedByB = await declinePromotionDecision(promptId);
    expect(declinedByB.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');

    const ruleRow = await db.query('select severity from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].severity).toBe('soft');
  });

  // -----------------------------------------------------------------
  // Retirement — decay sub-kind
  // -----------------------------------------------------------------

  it('acceptRetirementDecision (decay): retires the rule, marks the prompt accepted with resolution=retire', async () => {
    if (!env) return;
    const { acceptRetirementDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'retire-decay-accept');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const strategyId = await seedStrategy(user.id);
    const { ruleId, decayedFindingId } = await seedDecayedRuleAndFinding(user.id, strategyId);
    const reviewId = await insertReview(user.id);
    const promptId = await insertRetirementDecayPrompt(user.id, reviewId, ruleId, decayedFindingId, strategyId);

    const result = await acceptRetirementDecision(promptId);
    expect(result.success).toBe(true);
    expect(result.subjectType).toBe('rule');

    const ruleRow = await db.query('select state from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].state).toBe('retired');

    const promptRow = await db.query('select state, payload from retrospeq.review_prompts where id = $1', [promptId]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].payload.resolution).toBe('retire');
  });

  it('keepRetirementDecision (decay): rule stays active, prompt records resolution=keep — no decline/dormancy tracking', async () => {
    if (!env) return;
    const { keepRetirementDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'retire-decay-keep');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const strategyId = await seedStrategy(user.id);
    const { ruleId, decayedFindingId } = await seedDecayedRuleAndFinding(user.id, strategyId);
    const reviewId = await insertReview(user.id);
    const promptId = await insertRetirementDecayPrompt(user.id, reviewId, ruleId, decayedFindingId, strategyId);

    const result = await keepRetirementDecision(promptId);
    expect(result.success).toBe(true);

    const ruleRow = await db.query('select state from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].state).toBe('active');

    const promptRow = await db.query('select state, payload from retrospeq.review_prompts where id = $1', [promptId]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].payload.resolution).toBe('keep');

    const historyRows = await db.query(`select 1 from retrospeq.prompt_history where user_id = $1 and subject_id = $2`, [user.id, ruleId]);
    expect(historyRows.rowCount).toBe(0);
  });

  it('ALREADY DECIDED (decay): a second "retire" after "keep" replays keep honestly, rule stays active', async () => {
    if (!env) return;
    const { acceptRetirementDecision, keepRetirementDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'retire-decay-already-decided');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const strategyId = await seedStrategy(user.id);
    const { ruleId, decayedFindingId } = await seedDecayedRuleAndFinding(user.id, strategyId);
    const reviewId = await insertReview(user.id);
    const promptId = await insertRetirementDecayPrompt(user.id, reviewId, ruleId, decayedFindingId, strategyId);

    const kept = await keepRetirementDecision(promptId);
    expect(kept.success).toBe(true);

    const secondRetire = await acceptRetirementDecision(promptId);
    expect(secondRetire.success).toBe(true);

    const ruleRow = await db.query('select state from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].state).toBe('active');
  });

  it('CROSS-USER ISOLATION (decay): user B cannot retire or keep user A\'s retirement prompt', async () => {
    if (!env) return;
    const { acceptRetirementDecision, keepRetirementDecision } = await import('../actions');
    const userA = await createTestAuthUser(envBundle, 'retire-owner-a');
    const userB = await createTestAuthUser(envBundle, 'retire-owner-b');
    cleanupUserIds.push(userA.id, userB.id);

    const strategyId = await seedStrategy(userA.id);
    const { ruleId, decayedFindingId } = await seedDecayedRuleAndFinding(userA.id, strategyId);
    const reviewId = await insertReview(userA.id);
    const promptId = await insertRetirementDecayPrompt(userA.id, reviewId, ruleId, decayedFindingId, strategyId);

    mockSession(userB.id);
    const retiredByB = await acceptRetirementDecision(promptId);
    expect(retiredByB.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');
    const keptByB = await keepRetirementDecision(promptId);
    expect(keptByB.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');

    const ruleRow = await db.query('select state from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].state).toBe('active');
  });

  // -----------------------------------------------------------------
  // Retirement — condition sub-kind
  // -----------------------------------------------------------------

  it('acceptRetirementDecision (condition): retires the trigger condition, marks the prompt accepted', async () => {
    if (!env) return;
    const { acceptRetirementDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'retire-condition-accept');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const strategyId = await seedStrategy(user.id);
    const conditionId = await seedConditionEligibleForRetirement(user.id, strategyId);
    const reviewId = await insertReview(user.id);
    const promptId = await insertRetirementConditionPrompt(user.id, reviewId, conditionId, strategyId);

    const result = await acceptRetirementDecision(promptId);
    expect(result.success).toBe(true);
    expect(result.subjectType).toBe('trigger_condition');

    const conditionRow = await db.query('select state from retrospeq.trigger_conditions where id = $1', [conditionId]);
    expect(conditionRow.rows[0].state).toBe('retired');
  });

  // -----------------------------------------------------------------
  // fetchNextDecision dispatch — exercises buildPromotionPromptDetail /
  // buildRetirementDecayPromptDetail / buildRetirementConditionPromptDetail
  // for real (not just the accept/decline write paths above).
  // -----------------------------------------------------------------

  it('fetchNextDecision: renders a promotion prompt (frame 4.8 evidence/dots/cost) for a Pro user; plan_required for a free one', async () => {
    if (!env) return;
    const { fetchNextDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'promo-fetch-next');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const accountId = await seedAccount(user.id);
    const ruleId = await seedPromotionEligibleRule(user.id, accountId, 'Only take conviction 4 or higher.');
    const reviewId = await insertReviewForCurrentPeriod(user.id);
    await insertPromotionPrompt(user.id, reviewId, ruleId, {
      ruleId,
      rendered: 'Only take conviction 4 or higher.',
      ageDays: 50,
      applicableEvaluations: 20,
      followedEvaluations: 20,
      complianceRatio: 1,
    });

    const freeResult = await fetchNextDecision();
    expect(freeResult).toEqual({ success: true, status: 'plan_required', kind: 'promotion' });

    await setPlan(user.id, 'pro');
    const proResult = await fetchNextDecision();
    expect(proResult.success).toBe(true);
    if (proResult.success && proResult.status === 'ready' && proResult.kind === 'promotion') {
      expect(proResult.detail.statement).toContain('Only take conviction 4 or higher.');
      expect(proResult.detail.dots).toEqual({ total: 20, filled: 20 });
      expect(proResult.detail.costLine.length).toBeGreaterThan(0);
      expect(proResult.detail.canAccept).toBe(true);
    } else {
      throw new Error(`expected a ready promotion decision, got ${JSON.stringify(proResult)}`);
    }
  });

  it('fetchNextDecision: renders a retirement (decay) prompt with a real rq-cmp before/after pair', async () => {
    if (!env) return;
    const { fetchNextDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'retire-decay-fetch-next');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const strategyId = await seedStrategy(user.id);
    const { ruleId, decayedFindingId } = await seedDecayedRuleAndFinding(user.id, strategyId);
    const reviewId = await insertReviewForCurrentPeriod(user.id);
    await insertRetirementDecayPrompt(user.id, reviewId, ruleId, decayedFindingId, strategyId);

    const result = await fetchNextDecision();
    expect(result.success).toBe(true);
    if (result.success && result.status === 'ready' && result.kind === 'retirement') {
      expect(result.detail.subjectType).toBe('rule');
      expect(result.detail.cmp).toEqual({ beforeLabel: 'Before', beforePct: 71, afterLabel: 'Last 40', afterPct: 48 });
      expect(result.detail.canDecide).toBe(true);
    } else {
      throw new Error(`expected a ready retirement decision, got ${JSON.stringify(result)}`);
    }
  });

  it('fetchNextDecision: renders a retirement (condition) prompt honestly, no rq-cmp (no "before" state to compare)', async () => {
    if (!env) return;
    const { fetchNextDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'retire-condition-fetch-next');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const strategyId = await seedStrategy(user.id);
    const conditionId = await seedConditionEligibleForRetirement(user.id, strategyId);
    const reviewId = await insertReviewForCurrentPeriod(user.id);
    await insertRetirementConditionPrompt(user.id, reviewId, conditionId, strategyId);

    const result = await fetchNextDecision();
    expect(result.success).toBe(true);
    if (result.success && result.status === 'ready' && result.kind === 'retirement') {
      expect(result.detail.subjectType).toBe('trigger_condition');
      expect(result.detail.cmp).toBeNull();
      expect(result.detail.canDecide).toBe(true);
      expect(result.detail.statement).toContain('Price above the daily VWAP');
    } else {
      throw new Error(`expected a ready retirement decision, got ${JSON.stringify(result)}`);
    }
  });

  it('fetchNextDecision: an edge that has since RECOVERED (current finding no longer decayed) is skipped, not offered as a stale decision', async () => {
    if (!env) return;
    const { fetchNextDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'retire-decay-recovered');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    const strategyId = await seedStrategy(user.id);
    const { ruleId, decayedFindingId } = await seedDecayedRuleAndFinding(user.id, strategyId);
    // The edge recovered since materialisation -- flip the current finding
    // back to 'active' (the honest "this has changed" case).
    await db.query(`update retrospeq.findings set state = 'active' where id = $1`, [decayedFindingId]);
    const reviewId = await insertReviewForCurrentPeriod(user.id);
    await insertRetirementDecayPrompt(user.id, reviewId, ruleId, decayedFindingId, strategyId);

    const result = await fetchNextDecision();
    expect(result).toEqual({ success: true, status: 'none_pending' });
  });
});
