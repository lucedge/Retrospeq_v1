import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { findGraduationCandidates } from '@/lib/review/prompt-candidates/graduation-candidates';
import { findingSubjectId } from '@/lib/review/prompt-candidates/stable-subject-id';
import { computeAndWriteReviewPrompts } from '@/lib/review/review-prompts';

/**
 * Module 06 (Review & Graduation) Slice 6 — `retrospeq-tester` gate,
 * 2026-09-13. LIVE-DB integration coverage of `app/(app)/review/decisions/
 * actions.ts`'s `acceptGraduationDecision`/`deferGraduationDecision`,
 * against the real shared dev/test Supabase project — real writes, real
 * RLS, no mock standing in for Postgres.
 *
 * What's mocked and why (matching `app/(app)/fields/__tests__/
 * lifecycle-actions.live.test.ts`'s established live-Server-Action-test
 * posture): `@/lib/supabase/server`'s `createClient` and `@/lib/rate-limit/
 * http`'s `getClientIp` both need a live Next.js request context this
 * plain `vitest run` process doesn't have; `enforceRateLimit` and
 * `next/cache`'s `revalidatePath` are mocked so this file is never coupled
 * to the rate limiter's own real backing store (that wiring — scope name,
 * call ORDER — is independently proven in the sibling mocked
 * `actions.test.ts`, which asserts `enforceRateLimit('reviewDecision', ...)`
 * is the very first call on every exported action). Every other function
 * this action calls — `createRuleInternal` (`lib/rules/create-rule-
 * internal.ts` — since a 2026-09-13 security-review fix, the function
 * `acceptGraduationDecision` actually calls directly in-process; see
 * `docs/adr/0040` decision 7's resolution note), `insertRuleFieldUsage`,
 * `createFindingRuleLink`, every `prompts-repository.ts` function,
 * `canForUser` — runs FOR REAL against the live DB, through real RLS.
 *
 * Covers, per this slice's own review dispatch:
 *   1. Full accept write path for a supported drv.* field — real rows in
 *      `rules`/`finding_rule_links`/`field_usages`/`review_prompts`.
 *   2. A custom (non-drv.*) field's accept writes NOTHING.
 *   3. THE RE-PROMPT-BUG FIX, cross-slice: `findGraduationCandidates`
 *      (Slice 3) includes the field BEFORE accept, excludes it AFTER.
 *   4. Defer: `state='deferred'`, zero `prompt_history` rows, and the SAME
 *      subject re-surfaces through a full `computeAndWriteReviewPrompts`
 *      re-run (Slice 3/4's real eligibility+ranking pipeline).
 *   5. The free-tier rules.create cap is structurally UNREACHABLE via this
 *      flow today (graduation requires Pro; Pro's rules.create cap is
 *      unlimited) — proven directly, not assumed.
 *   6. Cross-user isolation on accept/defer/prompts-repository reads.
 */
const env = readRlsTestEnv();

const { getUserMock, createClientMock, getClientIpMock, enforceRateLimitMock, revalidatePathMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.77'),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  revalidatePathMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/rate-limit/http', () => ({ getClientIp: getClientIpMock }));
vi.mock('@/lib/rate-limit/limiter', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));
vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!env)('review/decisions/actions.ts (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];
  const customAnalyticConfigIds: string[] = [];

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 30_000);

  /** `find.decisions-live` (this file's own analytic_id) has no
   *  pre-seeded `analytic_config` row — `canRender` (Slice 4's own
   *  wiring, `review-prompts.ts`) fails CLOSED on a missing row, so any
   *  test exercising the FULL `computeAndWriteReviewPrompts` pipeline
   *  (not `findGraduationCandidates` alone, which runs BEFORE that gate)
   *  needs one seeded explicitly — matching `lib/review/__tests__/
   *  review-prompts.live.test.ts`'s own established convention. */
  async function seedAnalyticConfig(analyticId: string): Promise<void> {
    await db.query(
      `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
       values ($1, true, 'free', false, 't0')
       on conflict (analytic_id) do nothing`,
      [analyticId],
    );
    customAnalyticConfigIds.push(analyticId);
  }

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
      await db.query('delete from retrospeq.finding_rule_links where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.field_usages where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
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

  async function seedStrategy(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Decisions Live Test Strategy', 1, false, 'active') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedCustomField(userId: string, strategyId: string, fieldId: string, name: string): Promise<void> {
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, $3, 'strategy_var', 'pick_one', 'captured', $4, '{"options": ["low","high"]}'::jsonb)`,
      [fieldId, userId, name, strategyId],
    );
  }

  async function insertFinding(
    userId: string,
    strategyId: string,
    fieldId: string,
    opts: { segment: unknown; n: number; deltaWinRate: number | null; confidence?: string },
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          p_value, p_adjusted, confidence, gate_failures, state)
       values ($1,$2,$3,$4,$5::jsonb,$6,0.71,null,20,0.42,null,$7,null,0.001,0.001,$8,'{}','active')
       returning id`,
      [
        userId,
        'find.decisions-live',
        strategyId,
        fieldId,
        JSON.stringify(opts.segment),
        opts.n,
        opts.deltaWinRate === null ? null : opts.deltaWinRate.toFixed(4),
        opts.confidence ?? 'confident',
      ],
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
    subjectId: string,
    payload: Record<string, unknown>,
    opts: { state?: string } = {},
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'graduation', 1, 'finding', $3, $4::jsonb, $5)
       returning id`,
      [userId, reviewId, subjectId, JSON.stringify(payload), opts.state ?? 'pending'],
    );
    return res.rows[0].id;
  }

  function evidencePayload(strategyId: string, fieldId: string, n: number, deltaWinRate: number | null) {
    return {
      strategyId,
      fieldId,
      analyticId: 'find.decisions-live',
      n,
      winRate: 0.71,
      avgR: null,
      baselineN: 20,
      baselineWinRate: 0.42,
      baselineAvgR: null,
      deltaWinRate,
      deltaAvgR: null,
    };
  }

  // =====================================================================
  // 1 + 3 — full accept write path, and the re-prompt-bug fix, together
  // (the SAME fixture proves both: eligible before, real writes on accept,
  // ineligible after).
  // =====================================================================

  it('ACCEPT (drv.risk_pct): creates rules/finding_rule_links/field_usages for real, flips the prompt to accepted, and closes the re-prompt-bug — findGraduationCandidates excludes the field afterward, having included it before', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'accept-happy-path');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    mockSession(user.id);

    const strategyId = await seedStrategy(user.id);
    const segment = { op: 'between', value: { min: 0.5, max: 1.0 } };
    const findingId = await insertFinding(user.id, strategyId, 'drv.risk_pct', { segment, n: 40, deltaWinRate: 0.29 });
    const subjectId = findingSubjectId(strategyId, 'drv.risk_pct');

    // BEFORE accept: findGraduationCandidates (Slice 3) includes this field.
    const before = await findGraduationCandidates(user.id);
    expect(before.some((c) => c.subjectId === subjectId)).toBe(true);

    const reviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const promptId = await insertGraduationPrompt(user.id, reviewId, subjectId, evidencePayload(strategyId, 'drv.risk_pct', 40, 0.29));

    const { acceptGraduationDecision } = await import('../actions');
    const result = await acceptGraduationDecision(promptId);

    expect(result.success).toBe(true);
    expect(result.ruleId).toBeTruthy();

    const ruleRow = await db.query(
      `select origin, severity, scope, scope_id, state from retrospeq.rules where id = $1 and user_id = $2`,
      [result.ruleId, user.id],
    );
    expect(ruleRow.rows[0]).toMatchObject({ origin: 'graduated', severity: 'soft', scope: 'strategy', scope_id: strategyId, state: 'active' });

    const linkRow = await db.query(
      `select finding_id, rule_id, delta_at_graduation, trades_at_graduation from retrospeq.finding_rule_links where user_id = $1`,
      [user.id],
    );
    expect(linkRow.rows).toHaveLength(1);
    expect(linkRow.rows[0]).toMatchObject({ finding_id: findingId, rule_id: result.ruleId });
    expect(Number(linkRow.rows[0].delta_at_graduation)).toBeCloseTo(0.29, 3);

    const usageRow = await db.query(
      `select field_id, used_by, used_by_id from retrospeq.field_usages where user_id = $1 and used_by = 'rule'`,
      [user.id],
    );
    expect(usageRow.rows).toHaveLength(1);
    expect(usageRow.rows[0]).toMatchObject({ field_id: 'drv.risk_pct', used_by_id: result.ruleId });

    const promptRow = await db.query(
      `select state, decided_at, payload from retrospeq.review_prompts where id = $1`,
      [promptId],
    );
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].decided_at).not.toBeNull();
    expect(promptRow.rows[0].payload.ruleId).toBe(result.ruleId);

    // AFTER accept: the SAME field is now excluded — the re-prompt-bug fix.
    const after = await findGraduationCandidates(user.id);
    expect(after.some((c) => c.subjectId === subjectId)).toBe(false);
  });

  // =====================================================================
  // 2 — the honesty boundary: a custom field writes NOTHING.
  // =====================================================================

  it('REJECT (custom "conviction" field): GRADUATION_FIELD_UNSUPPORTED, and NOT ONE row is written anywhere — no rule, no link, no field_usages, prompt stays pending untouched', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'reject-custom-field');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    mockSession(user.id);

    const strategyId = await seedStrategy(user.id);
    const fieldId = `conviction_${Date.now()}`;
    await seedCustomField(user.id, strategyId, fieldId, 'Conviction');
    const segment = { op: 'eq', value: 'high' };
    await insertFinding(user.id, strategyId, fieldId, { segment, n: 14, deltaWinRate: 0.29 });

    const reviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const subjectId = findingSubjectId(strategyId, fieldId);
    const payload = evidencePayload(strategyId, fieldId, 14, 0.29);
    const promptId = await insertGraduationPrompt(user.id, reviewId, subjectId, payload);

    const { acceptGraduationDecision } = await import('../actions');
    const result = await acceptGraduationDecision(promptId);

    expect(result.error).toEqual({
      code: 'GRADUATION_FIELD_UNSUPPORTED',
      user_message: "This kind of finding can't become a rule yet.",
      retryable: false,
    });

    const rulesCount = await db.query(`select count(*)::int as c from retrospeq.rules where user_id = $1`, [user.id]);
    expect(rulesCount.rows[0].c).toBe(0);
    const linksCount = await db.query(`select count(*)::int as c from retrospeq.finding_rule_links where user_id = $1`, [user.id]);
    expect(linksCount.rows[0].c).toBe(0);
    const usagesCount = await db.query(`select count(*)::int as c from retrospeq.field_usages where user_id = $1 and used_by = 'rule'`, [user.id]);
    expect(usagesCount.rows[0].c).toBe(0);

    const promptRow = await db.query(`select state, decided_at, payload from retrospeq.review_prompts where id = $1`, [promptId]);
    expect(promptRow.rows[0].state).toBe('pending');
    expect(promptRow.rows[0].decided_at).toBeNull();
    expect(promptRow.rows[0].payload).toEqual(payload);
  });

  // =====================================================================
  // 4 — defer: no prompt_history write, and full re-eligibility through
  // the real Slice 3/4 pipeline.
  // =====================================================================

  it('DEFER: state=deferred, decided_at stays null, zero prompt_history rows, and the SAME subject re-surfaces through a real computeAndWriteReviewPrompts re-run', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'defer-reeligible');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    mockSession(user.id);
    await seedAnalyticConfig('find.decisions-live');

    const strategyId = await seedStrategy(user.id);
    const segment = { op: 'between', value: { min: 60, max: 300 } };
    await insertFinding(user.id, strategyId, 'drv.hold_seconds', { segment, n: 40, deltaWinRate: 0.25 });
    const subjectId = findingSubjectId(strategyId, 'drv.hold_seconds');

    const reviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const promptId = await insertGraduationPrompt(user.id, reviewId, subjectId, evidencePayload(strategyId, 'drv.hold_seconds', 40, 0.25));

    const { deferGraduationDecision } = await import('../actions');
    const result = await deferGraduationDecision(promptId);
    expect(result).toEqual({ success: true });

    const promptRow = await db.query(`select state, decided_at from retrospeq.review_prompts where id = $1`, [promptId]);
    expect(promptRow.rows[0]).toEqual({ state: 'deferred', decided_at: null });

    const historyCount = await db.query(`select count(*)::int as c from retrospeq.prompt_history where user_id = $1`, [user.id]);
    expect(historyCount.rows[0].c).toBe(0);

    // Re-surfacing: a genuinely fresh materialisation (a new review, as a
    // real missed-week/next-week run would produce) must still find this
    // exact candidate eligible and write it again — proving defer carries
    // no residual exclusion anywhere in the real pipeline.
    const reviewId2 = await insertReview(user.id, '2026-09-14', '2026-09-20');
    const written = await computeAndWriteReviewPrompts(user.id, reviewId2, new Date('2026-09-21T00:00:00Z'));
    expect(written.some((p) => p.subjectId === subjectId && p.kind === 'graduation')).toBe(true);
  });

  // =====================================================================
  // 5 — the free-tier rules.create cap is structurally unreachable via
  // this flow today. Proven, not assumed.
  // =====================================================================

  it('STRUCTURAL FINDING: a Pro user (required for graduation) has an UNLIMITED rules.create quota — the free-tier cap rejection can never actually surface through this flow with the entitlement table as it stands today', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'cap-unreachable');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    mockSession(user.id);

    await seedStrategy(user.id); // exercised for realism only, not read below

    // Directly assert the entitlement fact rather than looping createRule
    // several times (which would immediately hit THIS module's own
    // tighten-only/satisfiability checks, unrelated to what this test is
    // proving):
    const { canForUser } = await import('@/lib/entitlements/service');
    const entitlement = await canForUser(user.id, 'rules.create');
    expect(entitlement.allowed).toBe(true);
    expect(entitlement.limit).toBeNull(); // null = unlimited, per capability-table.ts

    const graduationEntitlement = await canForUser(user.id, 'graduation');
    expect(graduationEntitlement.allowed).toBe(true); // Pro-gated, and this user IS pro

    // The converse: a FREE user cannot reach accept at all (blocked at the
    // graduation gate, before createRule is ever called) -- so there is no
    // real plan combination in which this action's createRule call could
    // ever observe RuleCreateCapExceededError. The pass-through logic
    // itself (createRule's rejection surfaced verbatim, no second gate) is
    // still verified at the code level in the mocked `actions.test.ts`.
    await setPlan(user.id, 'free');
    const freeGraduation = await canForUser(user.id, 'graduation');
    expect(freeGraduation.allowed).toBe(false);
  });

  // =====================================================================
  // 6 — cross-user isolation.
  // =====================================================================

  it('CROSS-USER ISOLATION: user B cannot accept, defer, or even resolve user A\'s prompt id', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'iso-decisions-a');
    const userB = await createTestAuthUser(envBundle, 'iso-decisions-b');
    cleanupUserIds.push(userA.id, userB.id);
    await setPlan(userA.id, 'pro');
    await setPlan(userB.id, 'pro');

    const strategyId = await seedStrategy(userA.id);
    const segment = { op: 'between', value: { min: 0.5, max: 1.0 } };
    await insertFinding(userA.id, strategyId, 'drv.risk_pct', { segment, n: 40, deltaWinRate: 0.29 });
    const subjectId = findingSubjectId(strategyId, 'drv.risk_pct');
    const reviewId = await insertReview(userA.id, '2026-09-07', '2026-09-13');
    const promptId = await insertGraduationPrompt(userA.id, reviewId, subjectId, evidencePayload(strategyId, 'drv.risk_pct', 40, 0.29));

    mockSession(userB.id);
    const { acceptGraduationDecision, deferGraduationDecision } = await import('../actions');

    const acceptResult = await acceptGraduationDecision(promptId);
    expect(acceptResult.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');

    const deferResult = await deferGraduationDecision(promptId);
    expect(deferResult.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');

    // The prompt itself is untouched by user B's attempts.
    const promptRow = await db.query(`select state from retrospeq.review_prompts where id = $1`, [promptId]);
    expect(promptRow.rows[0].state).toBe('pending');

    // The legitimate owner can still accept it afterward.
    mockSession(userA.id);
    const ownerResult = await acceptGraduationDecision(promptId);
    expect(ownerResult.success).toBe(true);
  });
});
