import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { getOperand } from '@/lib/rules/operand-catalogue';
import { detectionSubjectId } from '@/lib/review/prompt-candidates/stable-subject-id';

/**
 * Module 06 (Review & Graduation), frame 4.10 — `retrospeq-tester`-shaped
 * live-DB coverage of `acceptDetectionDecision`/`deferDetectionDecision`,
 * against the real shared dev/test Supabase project. Mirrors `decisions-
 * promotion-retirement-integration.live.test.ts`'s own established mocking
 * posture: only `@/lib/supabase/server`, `@/lib/rate-limit/http`,
 * `@/lib/rate-limit/limiter`, `next/cache` are mocked; every domain write
 * runs for real.
 *
 * `detection-operand-map.ts`'s own header documents that every one of
 * today's five real v1 detection analytics resolves to `null` — the
 * "accept creates a real rule" path is therefore ALSO forced open here via
 * one additional module mock (`resolveDetectionRuleProposal`, real `risk_
 * pct` operand — a real, already-computableToday catalogue entry, not an
 * invented one), so the write path itself gets real coverage rather than
 * being untestable dead code until a future catalogue slice ships. The
 * genuinely-unsupported-today case (`risk.spread`) is tested separately,
 * unmocked, against the REAL map.
 */
const env = readRlsTestEnv();

const { getUserMock, createClientMock, getClientIpMock, enforceRateLimitMock, revalidatePathMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.100'),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  revalidatePathMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/rate-limit/http', () => ({ getClientIp: getClientIpMock }));
vi.mock('@/lib/rate-limit/limiter', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));
vi.mock('server-only', () => ({}));

// Forces the ONE analytic id this test suite uses for the "accept creates a
// real rule" path onto a real, already-computableToday operand
// (`risk_pct`) — every other analytic id falls through to the real map
// (`risk.spread` stays genuinely unsupported, tested below).
vi.mock('@/lib/review/decisions/detection-operand-map', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/review/decisions/detection-operand-map')>();
  return {
    ...actual,
    resolveDetectionRuleProposal: (analyticId: string) => {
      if (analyticId === 'seq.reentry_after_loss') {
        return { operand: getOperand('risk_pct')!, op: 'lte' as const, value: 1.5 };
      }
      return actual.resolveDetectionRuleProposal(analyticId);
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!env)('review/decisions/actions.ts — detection (frame 4.10, live DB)', () => {
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
      await db.query('delete from retrospeq.detections where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
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

  async function seedDetection(userId: string, analyticId: string, occurrences = 11): Promise<void> {
    const now = new Date();
    const windowFrom = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    await db.query(
      `insert into retrospeq.detections
         (user_id, analytic_id, occurrences, window_from, window_to, distinct_days, base_rate,
          outcome_avg_r, outcome_baseline_avg_r, tier, classification, rule_proposable, direction, state)
       values ($1, $2, $3, $4, $5, $6, 0.2, -0.6, 0.3, 'count_outcome', 'pattern', true, 'active', 'active')`,
      [userId, analyticId, occurrences, windowFrom.toISOString(), now.toISOString(), 6],
    );
  }

  let reviewPeriodCounter = 0;

  async function insertReview(userId: string): Promise<string> {
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

  async function insertDetectionPrompt(userId: string, reviewId: string, analyticId: string, evidence: Record<string, unknown>): Promise<string> {
    const subjectId = detectionSubjectId(analyticId);
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'detection', 1, 'detection', $3, $4::jsonb, 'pending')
       returning id`,
      [userId, reviewId, subjectId, JSON.stringify(evidence)],
    );
    return res.rows[0].id;
  }

  const baseEvidence = (analyticId: string, occurrences = 11) => ({
    analyticId,
    occurrences,
    tier: 'count_outcome',
    classification: 'pattern',
    outcomeAvgR: -0.6,
    outcomeBaselineAvgR: 0.3,
    direction: 'active',
  });

  it('acceptDetectionDecision: creates a soft, global, origin=detected rule and marks the prompt accepted (resolution=added)', async () => {
    if (!env) return;
    const { acceptDetectionDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'detect-accept');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    await seedDetection(user.id, 'seq.reentry_after_loss');
    const reviewId = await insertReview(user.id);
    const promptId = await insertDetectionPrompt(user.id, reviewId, 'seq.reentry_after_loss', baseEvidence('seq.reentry_after_loss'));

    const result = await acceptDetectionDecision(promptId);
    expect(result.success).toBe(true);
    expect(result.ruleId).toBeDefined();

    const ruleRow = await db.query('select severity, origin, scope, state from retrospeq.rules where id = $1', [result.ruleId]);
    expect(ruleRow.rows[0]).toMatchObject({ severity: 'soft', origin: 'detected', scope: 'global', state: 'active' });

    const promptRow = await db.query('select state, payload from retrospeq.review_prompts where id = $1', [promptId]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].payload.resolution).toBe('added');
    expect(promptRow.rows[0].payload.ruleId).toBe(result.ruleId);
  });

  it('deferDetectionDecision: "Not yet" leaves the prompt deferred, writes NO prompt_history row (a defer, not a decline)', async () => {
    if (!env) return;
    const { deferDetectionDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'detect-defer');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    await seedDetection(user.id, 'seq.reentry_after_loss');
    const reviewId = await insertReview(user.id);
    const promptId = await insertDetectionPrompt(user.id, reviewId, 'seq.reentry_after_loss', baseEvidence('seq.reentry_after_loss'));

    const result = await deferDetectionDecision(promptId);
    expect(result.success).toBe(true);

    const promptRow = await db.query('select state, decided_at from retrospeq.review_prompts where id = $1', [promptId]);
    expect(promptRow.rows[0].state).toBe('deferred');
    expect(promptRow.rows[0].decided_at).toBeNull();

    const historyRow = await db.query('select 1 from retrospeq.prompt_history where user_id = $1', [user.id]);
    expect(historyRow.rowCount).toBe(0);
  });

  it('UNSUPPORTED ANALYTIC: acceptDetectionDecision on a pattern with no honest operand mapping (risk.spread, the real map) fails DETECTION_PATTERN_UNSUPPORTED and creates no rule', async () => {
    if (!env) return;
    const { acceptDetectionDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'detect-unsupported');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    await seedDetection(user.id, 'risk.spread');
    const reviewId = await insertReview(user.id);
    const promptId = await insertDetectionPrompt(user.id, reviewId, 'risk.spread', baseEvidence('risk.spread', 5));

    const result = await acceptDetectionDecision(promptId);
    expect(result.success).toBeFalsy();
    expect(result.error?.code).toBe('DETECTION_PATTERN_UNSUPPORTED');

    const ruleCount = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
    expect(ruleCount.rows[0].n).toBe(0);
    const promptRow = await db.query('select state from retrospeq.review_prompts where id = $1', [promptId]);
    expect(promptRow.rows[0].state).toBe('pending');
  });

  it('ALREADY DECIDED: a second accept on an already-deferred-then-accepted prompt replays the winning outcome, does not create a second rule', async () => {
    if (!env) return;
    const { acceptDetectionDecision } = await import('../actions');
    const user = await createTestAuthUser(envBundle, 'detect-replay');
    cleanupUserIds.push(user.id);
    mockSession(user.id);

    await seedDetection(user.id, 'seq.reentry_after_loss');
    const reviewId = await insertReview(user.id);
    const promptId = await insertDetectionPrompt(user.id, reviewId, 'seq.reentry_after_loss', baseEvidence('seq.reentry_after_loss'));

    const first = await acceptDetectionDecision(promptId);
    expect(first.success).toBe(true);

    const second = await acceptDetectionDecision(promptId);
    expect(second.success).toBe(true);
    expect(second.ruleId).toBe(first.ruleId);

    const ruleCount = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
    expect(ruleCount.rows[0].n).toBe(1);
  });

  it('CROSS-USER ISOLATION: user B cannot accept or defer user A\'s detection prompt', async () => {
    if (!env) return;
    const { acceptDetectionDecision, deferDetectionDecision } = await import('../actions');
    const userA = await createTestAuthUser(envBundle, 'detect-owner-a');
    const userB = await createTestAuthUser(envBundle, 'detect-owner-b');
    cleanupUserIds.push(userA.id, userB.id);

    await seedDetection(userA.id, 'seq.reentry_after_loss');
    const reviewId = await insertReview(userA.id);
    const promptId = await insertDetectionPrompt(userA.id, reviewId, 'seq.reentry_after_loss', baseEvidence('seq.reentry_after_loss'));

    mockSession(userB.id);
    const acceptedByB = await acceptDetectionDecision(promptId);
    expect(acceptedByB.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');
    const deferredByB = await deferDetectionDecision(promptId);
    expect(deferredByB.error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');

    const ruleCount = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [userB.id]);
    expect(ruleCount.rows[0].n).toBe(0);
    const promptRow = await db.query('select state from retrospeq.review_prompts where id = $1', [promptId]);
    expect(promptRow.rows[0].state).toBe('pending');
  });
});
