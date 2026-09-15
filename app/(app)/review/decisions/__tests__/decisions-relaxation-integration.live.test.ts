import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

/**
 * Module 06 (Review & Graduation) Slice 7 — `retrospeq-tester` gate,
 * 2026-09-13. LIVE-DB integration coverage of `app/(app)/review/decisions/
 * actions.ts`'s `recommitRelaxationDecision`/`adjustRelaxationDecision` and
 * `fetchNextDecision`'s cross-kind dispatch, against the real shared dev/test
 * Supabase project — real writes, real RLS, no mock standing in for Postgres.
 * Mirrors `decisions-integration.live.test.ts`'s own established mocking
 * posture (only `@/lib/supabase/server`, `@/lib/rate-limit/http`,
 * `@/lib/rate-limit/limiter`, `next/cache` are mocked — everything else,
 * including the REAL `editRule` Server Action this file's own `docs/adr/0041`
 * decision 2 says is reused unmodified, runs for real against the live DB).
 *
 * This file exists because NEITHER `decisions-integration.live.test.ts` (Slice
 * 6, graduation only) NOR the mocked `actions.test.ts` (which mocks
 * `fetchLiveRelaxationFacts`/`editRule` themselves) exercises the real
 * `percentile_cont(0.5)` query, the real `rule_versions` write, or real RLS
 * for the relaxation half of this screen — the coder's own dispatch entry
 * (PROGRESS.md, 2026-09-13) explicitly flagged this file's read-path sibling
 * as "not independently re-verified live by this coder session."
 *
 * Covers, per this slice's own tester dispatch:
 *   1. RECOMMIT touches `review_prompts` ONLY — zero writes to
 *      `rules`/`rule_versions`, verified directly against Postgres, plus the
 *      ADR's own "Consequences" claim that recommitting does NOT suppress
 *      future relaxation eligibility.
 *   2. ADJUST derives its threshold from a REAL `percentile_cont(0.5)`
 *      median (independently hand-computed here, not copied from the
 *      coder's own worked example), calls the real `editRule`, and produces
 *      a genuine `rule_versions` supersede-and-insert pair (the "annotates
 *      the adherence timeline" claim, checked directly).
 *   3. HARD-severity rule scope — confirmed, not just re-read from the ADR.
 *   4. The undecidable-median anomaly (eligible + adjustable operand, but no
 *      numeric `observed` rows) is handled gracefully, matching the
 *      runbook's own documented entry.
 *   5. Cross-kind dispatch: relaxation (rank 1) is served before graduation
 *      (rank 2) in the same review, and per-prompt entitlement gating holds.
 *   6. Cross-user isolation on both actions.
 */
const env = readRlsTestEnv();

const { getUserMock, createClientMock, getClientIpMock, enforceRateLimitMock, revalidatePathMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.88'),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  revalidatePathMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/rate-limit/http', () => ({ getClientIp: getClientIpMock }));
vi.mock('@/lib/rate-limit/limiter', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));
vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!env)('review/decisions/actions.ts — relaxation (live DB)', () => {
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
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
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
       values ($1, 'Relaxation Live Test', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  /** A real trade, minimal fields only — `rule_evaluations` just needs a
   *  genuine `trade_id` FK to satisfy its own constraint (mirrors
   *  `freeze-trigger-evaluations.live.test.ts`'s own `seedTrade`). */
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

  async function insertRule(
    userId: string,
    opts: { severity?: 'soft' | 'hard'; createdAt: Date; operandId?: string; op?: string; value?: unknown; rendered?: string },
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, severity, origin, evaluation, state, scope, created_at)
       values ($1, $2, 'authored', 'pre_entry', 'active', 'global', $3::timestamptz) returning id`,
      [userId, opts.severity ?? 'soft', opts.createdAt.toISOString()],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, $4, $5::jsonb, $6)`,
      [ruleId, userId, opts.operandId ?? 'risk_pct', opts.op ?? 'lte', JSON.stringify(opts.value ?? 1.0), opts.rendered ?? 'Never risk more than 1% per trade.'],
    );
    return ruleId;
  }

  /** Real `rule_evaluations` rows for the rolling 42-day window, with a
   *  genuine `observed` value on every row unless `noObserved` — real trade
   *  FKs, not fabricated. */
  async function seedRuleEvaluations(
    userId: string,
    accountId: string,
    ruleId: string,
    severity: 'soft' | 'hard',
    observedValues: readonly number[],
    brokenCount: number,
    windowDaysAgoStart: number,
    opts: { noObserved?: boolean } = {},
  ): Promise<void> {
    for (let i = 0; i < observedValues.length; i++) {
      const serverDay = new Date(Date.now() - (windowDaysAgoStart - i) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const tradeId = await seedTrade(userId, accountId, serverDay);
      const result = i < brokenCount ? 'broken' : 'followed';
      const observed = opts.noObserved ? null : observedValues[i];
      await db.query(
        `insert into retrospeq.rule_evaluations (user_id, trade_id, rule_id, rule_version, severity, result, observed, server_day)
         values ($1, $2, $3, 1, $4, $5, $6::jsonb, $7::date)`,
        [userId, tradeId, ruleId, severity, result, observed === null ? 'null' : JSON.stringify(observed), serverDay],
      );
    }
  }

  async function insertReview(userId: string, periodStart: string, periodEnd: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2::date, $3::date, 1, '{}'::jsonb) returning id`,
      [userId, periodStart, periodEnd],
    );
    return res.rows[0].id;
  }

  function relaxationPayload(ruleId: string, ageDays: number, applicable: number, broken: number) {
    return { ruleId, rendered: 'Never risk more than 1% per trade.', ageDays, applicableEvaluations: applicable, brokenEvaluations: broken, breakRate: broken / applicable };
  }

  async function insertPrompt(
    userId: string,
    reviewId: string,
    kind: 'relaxation' | 'graduation',
    rank: number,
    subjectId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending') returning id`,
      [userId, reviewId, kind, rank, kind === 'relaxation' ? 'rule' : 'finding', subjectId, JSON.stringify(payload)],
    );
    return res.rows[0].id;
  }

  // =====================================================================
  // 1. RECOMMIT — touches review_prompts ONLY.
  // =====================================================================

  it('RECOMMIT: marks the prompt accepted, and writes NOTHING to rules/rule_versions — verified directly against Postgres, plus recommit does not suppress future eligibility', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'relax-recommit');
    cleanupUserIds.push(user.id);
    mockSession(user.id);
    const accountId = await seedAccount(user.id);

    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000); // 50 days old, clears 6-week gate
    const ruleId = await insertRule(user.id, { createdAt });
    // 21 evaluations, 11 broken (52.4% break rate) -- clears >=20 applicable, >=40% break rate.
    const observed = [...Array(10).fill(0.8), ...Array(11).fill(2.1)];
    await seedRuleEvaluations(user.id, accountId, ruleId, 'soft', observed, 11, 41);

    const reviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const promptId = await insertPrompt(user.id, reviewId, 'relaxation', 1, ruleId, relaxationPayload(ruleId, 50, 21, 11));

    const versionsBefore = await db.query(`select count(*)::int as c from retrospeq.rule_versions where rule_id = $1`, [ruleId]);
    expect(versionsBefore.rows[0].c).toBe(1);

    const { recommitRelaxationDecision } = await import('../actions');
    const result = await recommitRelaxationDecision(promptId);

    expect(result.success).toBe(true);
    expect(result.ruleId).toBe(ruleId);

    const promptRow = await db.query(`select state, decided_at, payload from retrospeq.review_prompts where id = $1`, [promptId]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].decided_at).not.toBeNull();
    expect(promptRow.rows[0].payload.resolution).toBe('recommit');
    expect(promptRow.rows[0].payload.newValue).toBeUndefined();

    // The one fact this test exists to prove: NO rule write of any kind.
    const ruleRow = await db.query(`select current_version from retrospeq.rules where id = $1`, [ruleId]);
    expect(ruleRow.rows[0].current_version).toBe(1);
    const versionsAfter = await db.query(`select count(*)::int as c from retrospeq.rule_versions where rule_id = $1`, [ruleId]);
    expect(versionsAfter.rows[0].c).toBe(1);

    // ADR 0041 "Consequences": recommit does NOT suppress future eligibility
    // -- the exact same rule is still a live relaxation candidate right
    // after recommitting to it.
    const { findRelaxationCandidates } = await import('@/lib/review/prompt-candidates/relaxation-candidates');
    const candidates = await findRelaxationCandidates(user.id);
    expect(candidates.some((c) => c.subjectId === ruleId)).toBe(true);
  });

  // =====================================================================
  // 2. ADJUST — a real percentile_cont(0.5) median, a real editRule call,
  //    a real rule_versions supersede-and-insert pair.
  // =====================================================================

  it('ADJUST: derives an INDEPENDENTLY-verified live median, writes a real new rule_versions row via the real editRule, and the old version is genuinely superseded', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'relax-adjust');
    cleanupUserIds.push(user.id);
    mockSession(user.id);
    const accountId = await seedAccount(user.id);

    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    const ruleId = await insertRule(user.id, { createdAt, value: 1.0, rendered: 'Never risk more than 1% per trade.' });
    // 21 evaluations (odd count -> unambiguous single-value median, no
    // interpolation needed): 10 x 0.8 (followed), 11 x 2.1 (broken).
    // Sorted: ten 0.8s then eleven 2.1s -- percentile_cont(0.5) over 21
    // values is the 11th (1-indexed) value = 2.1. Hand-computed here, not
    // copied from the coder's own worked example (which used a different,
    // even-count dataset averaging two values).
    const observedValues = [...Array(10).fill(0.8), ...Array(11).fill(2.1)];
    const EXPECTED_MEDIAN = 2.1;
    await seedRuleEvaluations(user.id, accountId, ruleId, 'soft', observedValues, 11, 41);

    const reviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const promptId = await insertPrompt(user.id, reviewId, 'relaxation', 1, ruleId, relaxationPayload(ruleId, 50, 21, 11));

    // Independent cross-check: compute the SQL's own percentile_cont
    // directly, outside the code path under test, to confirm the dataset
    // itself produces the expected median before trusting the action's
    // derived value.
    const medianCheck = await db.query<{ median: string }>(
      `select percentile_cont(0.5) within group (order by (observed::text)::numeric) as median
         from retrospeq.rule_evaluations where rule_id = $1`,
      [ruleId],
    );
    expect(Number(medianCheck.rows[0].median)).toBe(EXPECTED_MEDIAN);

    const { adjustRelaxationDecision } = await import('../actions');
    const result = await adjustRelaxationDecision(promptId);

    expect(result.success).toBe(true);
    expect(result.newValue).toBe(EXPECTED_MEDIAN);
    expect(result.newRendered).toBe('Never risk more than 2.1% per trade.');

    // rules.current_version bumped 1 -> 2.
    const ruleRow = await db.query(`select current_version from retrospeq.rules where id = $1`, [ruleId]);
    expect(ruleRow.rows[0].current_version).toBe(2);

    // §4.7's "annotates the adherence timeline" claim, verified directly:
    // the OLD version is genuinely superseded (not deleted, not mutated in
    // place), and a NEW version row exists carrying the derived value and a
    // real, later created_at -- exactly the data a future timeline UI would
    // read.
    const versions = await db.query<{ version: number; value: string; superseded_at: string | null; created_at: string }>(
      `select version, value::text as value, superseded_at, created_at from retrospeq.rule_versions where rule_id = $1 order by version asc`,
      [ruleId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]).toMatchObject({ version: 1 });
    expect(versions.rows[0].superseded_at).not.toBeNull();
    expect(versions.rows[1]).toMatchObject({ version: 2 });
    expect(versions.rows[1].superseded_at).toBeNull();
    expect(Number(versions.rows[1].value)).toBe(EXPECTED_MEDIAN);
    expect(new Date(versions.rows[1].created_at).getTime()).toBeGreaterThan(new Date(versions.rows[0].created_at).getTime());

    const promptRow = await db.query(`select state, payload from retrospeq.review_prompts where id = $1`, [promptId]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].payload.resolution).toBe('adjust');
    expect(Number(promptRow.rows[0].payload.newValue)).toBe(EXPECTED_MEDIAN);
  });

  // =====================================================================
  // 3. HARD-severity rule scope -- confirmed directly, not re-read from
  //    the ADR's own claim.
  // =====================================================================

  it('HARD rule: relaxation applies identically to a hard-severity rule -- eligible, recommittable, and adjustable exactly like a soft one', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'relax-hard-rule');
    cleanupUserIds.push(user.id);
    mockSession(user.id);
    const accountId = await seedAccount(user.id);

    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    const ruleId = await insertRule(user.id, { severity: 'hard', createdAt, value: 1.0, rendered: 'Never risk more than 1% per trade.' });
    const observedValues = [...Array(10).fill(0.8), ...Array(11).fill(2.1)];
    await seedRuleEvaluations(user.id, accountId, ruleId, 'hard', observedValues, 11, 41);

    // Confirmed via the real, live eligibility function -- a HARD rule is
    // a real relaxation candidate, not filtered out by severity.
    const { findRelaxationCandidates } = await import('@/lib/review/prompt-candidates/relaxation-candidates');
    const candidates = await findRelaxationCandidates(user.id);
    expect(candidates.some((c) => c.subjectId === ruleId)).toBe(true);

    const reviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const promptId = await insertPrompt(user.id, reviewId, 'relaxation', 1, ruleId, relaxationPayload(ruleId, 50, 21, 11));

    const { adjustRelaxationDecision } = await import('../actions');
    const result = await adjustRelaxationDecision(promptId);

    expect(result.success).toBe(true);
    expect(result.newValue).toBe(2.1);

    // The rule's OWN severity is untouched by adjust -- only the threshold
    // changes, never the severity tier.
    const ruleRow = await db.query(`select severity, current_version from retrospeq.rules where id = $1`, [ruleId]);
    expect(ruleRow.rows[0]).toMatchObject({ severity: 'hard', current_version: 2 });
  });

  // =====================================================================
  // 4. The undecidable-median anomaly (docs/runbook.md's own entry) --
  //    eligible AND adjustable, but zero numeric observations.
  // =====================================================================

  it('UNDECIDABLE: an eligible, adjustable rule with NO numeric median is rejected gracefully (RELAXATION_NOT_ADJUSTABLE), never a crash, and writes nothing', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'relax-no-median');
    cleanupUserIds.push(user.id);
    mockSession(user.id);
    const accountId = await seedAccount(user.id);

    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    const ruleId = await insertRule(user.id, { createdAt, value: 1.0 });
    // Same result/count shape as the happy-path fixtures (21 applicable, 11
    // broken -- clears eligibility), but EVERY `observed` value is null --
    // the exact data-shape anomaly docs/runbook.md's new entry names.
    await seedRuleEvaluations(user.id, accountId, ruleId, 'soft', new Array(21).fill(0), 11, 41, { noObserved: true });

    const reviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const promptId = await insertPrompt(user.id, reviewId, 'relaxation', 1, ruleId, relaxationPayload(ruleId, 50, 21, 11));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { adjustRelaxationDecision } = await import('../actions');
    const result = await adjustRelaxationDecision(promptId);

    expect(result.error?.code).toBe('RELAXATION_NOT_ADJUSTABLE');
    expect(result.error?.retryable).toBe(false);
    // The anomaly is logged, per the runbook entry -- not silently dropped.
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();

    // Writes nothing.
    const ruleRow = await db.query(`select current_version from retrospeq.rules where id = $1`, [ruleId]);
    expect(ruleRow.rows[0].current_version).toBe(1);
    const promptRow = await db.query(`select state from retrospeq.review_prompts where id = $1`, [promptId]);
    expect(promptRow.rows[0].state).toBe('pending');
  });

  // =====================================================================
  // 5. Cross-kind dispatch: relaxation (rank 1) before graduation (rank 2)
  //    in the SAME review, and per-prompt entitlement gating.
  // =====================================================================

  it('CROSS-KIND: fetchNextDecision serves the relaxation prompt (rank 1) before the graduation prompt (rank 2), and a free user is blocked ONLY once graduation is next', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'relax-cross-kind');
    cleanupUserIds.push(user.id);
    mockSession(user.id);
    await setPlan(user.id, 'free');
    const accountId = await seedAccount(user.id);

    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    const ruleId = await insertRule(user.id, { createdAt, value: 1.0 });
    const observedValues = [...Array(10).fill(0.8), ...Array(11).fill(2.1)];
    await seedRuleEvaluations(user.id, accountId, ruleId, 'soft', observedValues, 11, 41);

    // fetchNextDecision resolves "the current review" via
    // determineCurrentWeeklyReviewPeriod against the REAL current date, not
    // an arbitrary hardcoded period -- unlike the other tests in this file
    // (which reach the prompt directly by id), this one must seed a review
    // whose period the live period-resolution logic will actually select.
    const { determineCurrentWeeklyReviewPeriod } = await import('@/lib/review/current-period');
    const period = await determineCurrentWeeklyReviewPeriod(user.id, new Date());
    if (period.status !== 'ready') throw new Error(`test setup assumption violated: period status was ${period.status}`);
    const reviewId = await insertReview(user.id, period.periodStart, period.periodEnd);
    const relaxPromptId = await insertPrompt(user.id, reviewId, 'relaxation', 1, ruleId, relaxationPayload(ruleId, 50, 21, 11));
    await insertPrompt(user.id, reviewId, 'graduation', 2, '99999999-9999-4999-8999-999999999999', {
      strategyId: '00000000-0000-4000-8000-000000000000',
      fieldId: 'drv.risk_pct',
      analyticId: 'find.x',
      n: 40,
      winRate: 0.7,
      avgR: null,
      baselineN: 20,
      baselineWinRate: 0.4,
      baselineAvgR: null,
      deltaWinRate: 0.3,
      deltaAvgR: null,
    });

    const { fetchNextDecision, recommitRelaxationDecision } = await import('../actions');

    // 1. Free user, first call: relaxation is served FIRST (rank 1), never
    //    blocked by the graduation entitlement (which it has no relation to).
    const first = await fetchNextDecision();
    expect(first.success).toBe(true);
    if (first.success && first.status === 'ready') {
      expect(first.kind).toBe('relaxation');
      expect(first.index).toBe(1);
      expect(first.total).toBe(2);
    } else {
      throw new Error(`expected ready/relaxation, got ${JSON.stringify(first)}`);
    }

    // Resolve it.
    const recommitResult = await recommitRelaxationDecision(relaxPromptId);
    expect(recommitResult.success).toBe(true);

    // 2. Second call: the NEXT prompt is now the graduation one, and this
    //    free user is blocked there -- per-prompt gating, not per-screen.
    const second = await fetchNextDecision();
    expect(second).toEqual({ success: true, status: 'plan_required', kind: 'graduation' });

    // 3. Upgrading resolves the block -- the SAME prompt is now reachable.
    await setPlan(user.id, 'pro');
    const third = await fetchNextDecision();
    expect(third.success).toBe(true);
    if (third.success && third.status === 'ready') {
      expect(third.kind).toBe('graduation');
      expect(third.index).toBe(2);
      expect(third.total).toBe(2);
    } else {
      throw new Error(`expected ready/graduation, got ${JSON.stringify(third)}`);
    }
  });

  // =====================================================================
  // 6. Cross-user isolation.
  // =====================================================================

  it('CROSS-USER ISOLATION: user B cannot recommit or adjust user A\'s relaxation prompt', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'relax-iso-a');
    const userB = await createTestAuthUser(envBundle, 'relax-iso-b');
    cleanupUserIds.push(userA.id, userB.id);
    const accountId = await seedAccount(userA.id);

    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    const ruleId = await insertRule(userA.id, { createdAt, value: 1.0 });
    const observedValues = [...Array(10).fill(0.8), ...Array(11).fill(2.1)];
    await seedRuleEvaluations(userA.id, accountId, ruleId, 'soft', observedValues, 11, 41);

    const reviewId = await insertReview(userA.id, '2026-09-07', '2026-09-13');
    const promptId = await insertPrompt(userA.id, reviewId, 'relaxation', 1, ruleId, relaxationPayload(ruleId, 50, 21, 11));

    mockSession(userB.id);
    const { recommitRelaxationDecision, adjustRelaxationDecision } = await import('../actions');

    const recommitResult = await recommitRelaxationDecision(promptId);
    expect(recommitResult.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');

    const adjustResult = await adjustRelaxationDecision(promptId);
    expect(adjustResult.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');

    // Untouched.
    const promptRow = await db.query(`select state from retrospeq.review_prompts where id = $1`, [promptId]);
    expect(promptRow.rows[0].state).toBe('pending');
    const ruleRow = await db.query(`select current_version from retrospeq.rules where id = $1`, [ruleId]);
    expect(ruleRow.rows[0].current_version).toBe(1);

    // The legitimate owner can still act on it afterward.
    mockSession(userA.id);
    const ownerResult = await recommitRelaxationDecision(promptId);
    expect(ownerResult.success).toBe(true);
  });

  // =====================================================================
  // 7. The silent-skip, end-to-end and live: a real categorical
  //    (day_of_week) relaxation-eligible rule -- structurally un-adjustable
  //    per docs/adr/0041 decision 3 -- is skipped by fetchNextDecision
  //    rather than shown as a dead end.
  // =====================================================================

  it('SILENT SKIP (end-to-end, live): a categorical day_of_week relaxation-eligible rule is skipped by fetchNextDecision, landing on none_pending, not a crash or a dead-end screen', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'relax-skip-categorical');
    cleanupUserIds.push(user.id);
    mockSession(user.id);
    const accountId = await seedAccount(user.id);

    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    // day_of_week is pick_many-typed -- canAdjustRelaxation is FALSE for it
    // regardless of eligibility (docs/adr/0041 decision 3) -- but it is a
    // genuine, real relaxation CANDIDATE per relaxation-candidates.ts's own
    // header (no operand-type restriction on ELIGIBILITY, only on ADJUST).
    const ruleId = await insertRule(user.id, {
      createdAt,
      operandId: 'day_of_week',
      op: 'not_in',
      value: ['sat', 'sun'],
      rendered: 'Never trade on sat, sun.',
    });
    // 21 evaluations, 11 broken -- clears eligibility exactly like the
    // numeric fixtures above; `observed` is irrelevant for a categorical
    // operand (fetchMedianObserved is never even queried for it, per
    // fetchLiveRelaxationFacts's own `canAdjustRelaxation(...) ? ... :
    // Promise.resolve(null)` guard), so this reuses the same seeding helper
    // with `noObserved: true` for realism.
    await seedRuleEvaluations(user.id, accountId, ruleId, 'soft', new Array(21).fill(0), 11, 41, { noObserved: true });

    const { determineCurrentWeeklyReviewPeriod } = await import('@/lib/review/current-period');
    const period = await determineCurrentWeeklyReviewPeriod(user.id, new Date());
    if (period.status !== 'ready') throw new Error(`test setup assumption violated: period status was ${period.status}`);
    const reviewId = await insertReview(user.id, period.periodStart, period.periodEnd);
    await insertPrompt(user.id, reviewId, 'relaxation', 1, ruleId, relaxationPayload(ruleId, 50, 21, 11));

    // Confirmed as a real, live eligible candidate first -- this is not a
    // fixture that was never eligible to begin with.
    const { findRelaxationCandidates } = await import('@/lib/review/prompt-candidates/relaxation-candidates');
    const candidates = await findRelaxationCandidates(user.id);
    expect(candidates.some((c) => c.subjectId === ruleId)).toBe(true);

    const { fetchNextDecision } = await import('../actions');
    const result = await fetchNextDecision();

    // Nothing else was queued -- the skip falls all the way through to
    // none_pending, never a crash, never a partial/blocked render.
    expect(result).toEqual({ success: true, status: 'none_pending' });
  });

  // =====================================================================
  // 8. buildRelaxationPromptDetail's own read-only branches, called
  //    directly (mirrors decisions-read-path.live.test.ts's own
  //    buildGraduationPromptDetail precedent) -- the two honest "gone"
  //    outcomes that fetchNextDecision's skip loop depends on.
  // =====================================================================

  it('buildRelaxationPromptDetail (live): PROMPT_SUBJECT_GONE-shaped honest fallback when the rule has been retired since materialisation', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'relax-detail-retired');
    cleanupUserIds.push(user.id);
    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    const ruleId = await insertRule(user.id, { createdAt, value: 1.0 });
    await db.query(`update retrospeq.rules set state = 'retired', retired_at = now() where id = $1`, [ruleId]);

    const { buildRelaxationPromptDetail } = await import('@/lib/review/decisions/relaxation-evidence-detail');
    const detail = await buildRelaxationPromptDetail(user.id, 'prompt-id-unused-here', 1, relaxationPayload(ruleId, 50, 21, 11));

    expect(detail.canDecide).toBe(false);
    expect(detail.blockedReason).toContain('retired');
    expect(detail.currentLabel).toBeNull();
    expect(detail.newLabel).toBeNull();
  });

  it('buildRelaxationPromptDetail (live): honest "no longer needs a decision" fallback when the live break rate has dropped back below the 40% floor since materialisation', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'relax-detail-resolved');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    const ruleId = await insertRule(user.id, { createdAt, value: 1.0 });
    // Only 2 of 21 broken now (~9.5%) -- the trader has genuinely brought
    // their behaviour back under the cap since this prompt was written.
    const observedValues = new Array(21).fill(0.5);
    await seedRuleEvaluations(user.id, accountId, ruleId, 'soft', observedValues, 2, 41);

    const { buildRelaxationPromptDetail } = await import('@/lib/review/decisions/relaxation-evidence-detail');
    // The STALE payload still claims the old (now-inaccurate) 11/21 count
    // -- buildRelaxationPromptDetail must re-derive live, never trust it.
    const detail = await buildRelaxationPromptDetail(user.id, 'prompt-id-unused-here', 1, relaxationPayload(ruleId, 50, 21, 11));

    expect(detail.canDecide).toBe(false);
    expect(detail.blockedReason).toContain('no longer breaking often enough');
  });

  it('buildRelaxationPromptDetail (live): the honest "can\'t be adjusted through this screen yet" statement/meta for a categorical operand, WITHOUT collapsing the read entirely', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'relax-detail-categorical');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    const ruleId = await insertRule(user.id, { createdAt, operandId: 'day_of_week', op: 'not_in', value: ['sat', 'sun'], rendered: 'Never trade on sat, sun.' });
    await seedRuleEvaluations(user.id, accountId, ruleId, 'soft', new Array(21).fill(0), 11, 41, { noObserved: true });

    const { buildRelaxationPromptDetail } = await import('@/lib/review/decisions/relaxation-evidence-detail');
    const detail = await buildRelaxationPromptDetail(user.id, 'prompt-id-unused-here', 1, relaxationPayload(ruleId, 50, 21, 11));

    expect(detail.canDecide).toBe(false);
    expect(detail.blockedReason).toBe("This kind of rule can't be adjusted through this screen yet.");
    expect(detail.currentLabel).toBeNull();
    expect(detail.newLabel).toBeNull();
    // The read itself is still honest and populated (not a blank "gone"
    // screen) -- the rule's real rendered sentence and real broken/applicable
    // counts are still shown, per this file's own header ("facts about the
    // rule, independent of adjust-support").
    expect(detail.statement).toContain('Never trade on sat, sun.');
    expect(detail.meta).toContain('11 of 21');
  });
});
