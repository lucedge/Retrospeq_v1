import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { connectAsOwner, createTestAuthUser, deleteTestAuthUser, readRlsTestEnv, type EnvBundle } from '@/lib/supabase/__tests__/rls-test-helpers';
import { computeAndWriteReviewPrompts } from '../review-prompts';
import { detectionSubjectId, findingSubjectId } from '../prompt-candidates/stable-subject-id';
import { fetchDeferredBacklogForUser } from '../decisions/prompts-repository';
import { _clearAnalyticConfigCacheForTests } from '@/lib/analytics/config-cache';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000 });

/**
 * Module 06 (Review & Graduation) §4.8 / frame 4.11 — live-DB coverage for
 * the two behaviours `ranking.test.ts`/`prompt-history-repository.test.ts`
 * cannot prove without a real `reviews`/`review_prompts` join:
 *
 *  1. A prompt deferred in an earlier, still-eligible review is genuinely
 *     re-offered the next time prompts are materialised (§4.5 — no special
 *     code needed, see `prompt-expiry.ts`'s own header, but a real assertion
 *     against the actual pipeline, not just an inference from reading it).
 *  2. `writeReviewPrompts`'s own `expireStalePromptsForUser` sweep: a
 *     `pending`/`deferred` prompt whose OWN review's `period_end` is more
 *     than 4 weeks before `asOfDate` is flipped to `expired` and never
 *     offered again; `accepted`/`declined` rows are never touched; the
 *     sweep is user-scoped, never crossing into another trader's rows.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/prompt-expiry.ts + review-prompts-repository.ts expiry sweep (live DB)', () => {
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
      await db.query('delete from retrospeq.analytic_user_suppression where user_id = $1', [userId]);
      await db.query('delete from retrospeq.user_cohorts where user_id = $1', [userId]);
      await db.query('delete from retrospeq.detections where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 60_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function insertReview(userId: string, periodStart: string, periodEnd: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2::date, $3::date, 1, '{}'::jsonb) returning id`,
      [userId, periodStart, periodEnd],
    );
    return res.rows[0].id;
  }

  async function insertDetection(userId: string, analyticId: string, occurrences: number): Promise<void> {
    await db.query(
      `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
       values ($1, true, 'free', false, 't0') on conflict (analytic_id) do nothing`,
      [analyticId],
    );
    await db.query(
      `insert into retrospeq.detections
         (user_id, analytic_id, occurrences, window_from, window_to, distinct_days, base_rate,
          outcome_avg_r, outcome_baseline_avg_r, tier, classification, rule_proposable, direction, state)
       values ($1,$2,$3,'2026-06-01T00:00:00Z','2026-07-01T00:00:00Z',5,0.1,-0.5,0.1,'count_outcome','pattern',true,'active','active')`,
      [userId, analyticId, occurrences],
    );
  }

  async function seedStrategy(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Prompt Expiry Live Test Strategy', 1, false, 'active') returning id`,
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

  async function insertFinding(userId: string, strategyId: string, fieldId: string): Promise<void> {
    await db.query(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          p_value, p_adjusted, confidence, gate_failures, state)
       values ($1,'find.toggle',$2,$3,$4::jsonb,45,0.71,null,20,0.42,null,0.29,null,0.001,0.001,'confident','{}','active')`,
      [userId, strategyId, fieldId, JSON.stringify({ op: 'eq', value: true })],
    );
  }

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

  async function addToCohort(userId: string): Promise<void> {
    await db.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'beta_traders')`, [userId]);
  }

  async function insertPromptRow(
    userId: string,
    reviewId: string,
    opts: { subjectId: string; state: string },
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state, decided_at)
       values ($1, $2, 'detection', 1, 'detection', $3, '{}'::jsonb, $4,
               case when $4 in ('accepted','declined') then now() else null end)
       returning id`,
      [userId, reviewId, opts.subjectId, opts.state],
    );
    return res.rows[0].id;
  }

  // =====================================================================
  // Deferred returns next review (§4.5).
  // =====================================================================

  it('DEFERRED RETURNS NEXT REVIEW: a graduation finding deferred in an earlier review re-appears as a fresh pending candidate once a new review is materialised, still subject to eligibility', async () => {
    if (!env) return;
    _clearAnalyticConfigCacheForTests();
    // A graduation candidate, not detection: today every real v1 detection
    // analytic's `resolveDetectionRuleProposal` resolves `null` (§4.3's
    // "a detection prompt exists to propose a rule" gate, `detection-
    // candidates.ts`'s `canProposeRule` — PROGRESS.md 2026-09-15), so no
    // fixture-only `analyticId` can pass the real pipeline's detection
    // filter today (confirmed against this same file's own pre-existing
    // `review-prompts.live.test.ts` ADVERSARIAL test, which fails on `main`
    // for the identical, unrelated reason — not this diff). Graduation has
    // no such gap and exercises the exact same "re-offered from live
    // eligibility, not from the old row" mechanism this test is proving.
    const user = await createTestAuthUser(envBundle, 'defer-reoffer');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const strategyId = await seedStrategy(user.id);
    const fieldId = `defer_reoffer_field_${Date.now()}`;
    await seedBoolField(user.id, strategyId, fieldId);
    await insertFinding(user.id, strategyId, fieldId);
    const subjectId = findingSubjectId(strategyId, fieldId);

    // Week 1: materialise for real, then defer it (mirrors `deferGraduation
    // Decision` — this test writes the transition directly to isolate the
    // pipeline behaviour from the Server Action's own entitlement/ownership
    // plumbing, already covered elsewhere).
    const reviewOneId = await insertReview(user.id, '2026-08-03', '2026-08-09');
    const writtenOne = await computeAndWriteReviewPrompts(user.id, reviewOneId, new Date('2026-08-10T00:00:00Z'));
    const firstRow = writtenOne.find((p) => p.subjectId === subjectId);
    expect(firstRow).toBeDefined();
    expect(firstRow!.kind).toBe('graduation');
    await db.query(`update retrospeq.review_prompts set state = 'deferred' where id = $1`, [firstRow!.id]);

    // Week 2: a NEW review, same still-eligible finding (no decline/mute
    // ever written) -- must be offered again as a fresh `pending` row.
    const reviewTwoId = await insertReview(user.id, '2026-08-10', '2026-08-16');
    const writtenTwo = await computeAndWriteReviewPrompts(user.id, reviewTwoId, new Date('2026-08-17T00:00:00Z'));
    const secondRow = writtenTwo.find((p) => p.subjectId === subjectId);
    expect(secondRow).toBeDefined();
    expect(secondRow!.reviewId).toBe(reviewTwoId);

    const dbRow = await db.query<{ state: string; review_id: string }>(
      `select state, review_id from retrospeq.review_prompts where id = $1`,
      [secondRow!.id],
    );
    expect(dbRow.rows[0]).toEqual({ state: 'pending', review_id: reviewTwoId });

    // The week-1 row itself stays `deferred`, untouched (not yet 4 weeks
    // old) -- re-offering never mutates or deletes the original record.
    const oldRow = await db.query<{ state: string }>(`select state from retrospeq.review_prompts where id = $1`, [firstRow!.id]);
    expect(oldRow.rows[0].state).toBe('deferred');
  });

  // =====================================================================
  // Expiry sweep (§4.8).
  // =====================================================================

  it('EXPIRY: a pending/deferred prompt whose own review ended more than 4 weeks before asOfDate is flipped to expired on the next materialisation and is not re-offered', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'expiry-sweep');
    cleanupUserIds.push(user.id);

    const staleReviewId = await insertReview(user.id, '2026-06-01', '2026-06-07'); // period_end well past 4 weeks before asOfDate below
    const stalePendingSubjectId = detectionSubjectId(`seq.expiry_stale_pending_${Date.now()}`);
    const staleDeferredSubjectId = detectionSubjectId(`seq.expiry_stale_deferred_${Date.now()}`);
    const stalePendingId = await insertPromptRow(user.id, staleReviewId, { subjectId: stalePendingSubjectId, state: 'pending' });
    const staleDeferredId = await insertPromptRow(user.id, staleReviewId, { subjectId: staleDeferredSubjectId, state: 'deferred' });

    // Nothing new to materialise this trigger review -- an empty candidate
    // set is the normal case (§4.3) and still runs the expiry sweep.
    const currentReviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const asOfDate = new Date('2026-09-14T00:00:00Z'); // > 4 weeks after 2026-06-07
    await computeAndWriteReviewPrompts(user.id, currentReviewId, asOfDate);

    const rows = await db.query<{ id: string; state: string }>(
      `select id, state from retrospeq.review_prompts where id = any($1::uuid[])`,
      [[stalePendingId, staleDeferredId]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.state]));
    expect(byId.get(stalePendingId)).toBe('expired');
    expect(byId.get(staleDeferredId)).toBe('expired');
  });

  it('EXPIRY NEVER TOUCHES ACCEPTED/DECLINED: terminal-state rows keep their state regardless of age', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'expiry-never-touches-decided');
    cleanupUserIds.push(user.id);

    const staleReviewId = await insertReview(user.id, '2026-06-01', '2026-06-07');
    const acceptedId = await insertPromptRow(user.id, staleReviewId, { subjectId: detectionSubjectId(`seq.expiry_accepted_${Date.now()}`), state: 'accepted' });
    const declinedId = await insertPromptRow(user.id, staleReviewId, { subjectId: detectionSubjectId(`seq.expiry_declined_${Date.now()}`), state: 'declined' });

    const currentReviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    await computeAndWriteReviewPrompts(user.id, currentReviewId, new Date('2026-09-14T00:00:00Z'));

    const rows = await db.query<{ id: string; state: string }>(`select id, state from retrospeq.review_prompts where id = any($1::uuid[])`, [[acceptedId, declinedId]]);
    const byId = new Map(rows.rows.map((r) => [r.id, r.state]));
    expect(byId.get(acceptedId)).toBe('accepted');
    expect(byId.get(declinedId)).toBe('declined');
  });

  it('BACKLOG READ excludes an already-expired row and the current review\'s own deferred row, and reports the correct age', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'backlog-read-live');
    cleanupUserIds.push(user.id);

    const twoWeeksAgoReviewId = await insertReview(user.id, '2026-08-24', '2026-08-30');
    const validDeferredId = await insertPromptRow(user.id, twoWeeksAgoReviewId, { subjectId: detectionSubjectId(`seq.backlog_valid_${Date.now()}`), state: 'deferred' });

    const staleReviewId = await insertReview(user.id, '2026-06-01', '2026-06-07');
    const alreadyExpiredId = await insertPromptRow(user.id, staleReviewId, { subjectId: detectionSubjectId(`seq.backlog_expired_${Date.now()}`), state: 'expired' });

    const currentReviewId = await insertReview(user.id, '2026-09-07', '2026-09-13');
    const currentWeekDeferredId = await insertPromptRow(user.id, currentReviewId, { subjectId: detectionSubjectId(`seq.backlog_thisweek_${Date.now()}`), state: 'deferred' });

    const asOfDate = new Date('2026-09-14T00:00:00Z');
    const backlog = await fetchDeferredBacklogForUser(user.id, currentReviewId, asOfDate);
    const ids = backlog.map((r) => r.id);

    expect(ids).toContain(validDeferredId);
    expect(ids).not.toContain(alreadyExpiredId);
    expect(ids).not.toContain(currentWeekDeferredId);

    const validRow = backlog.find((r) => r.id === validDeferredId)!;
    expect(validRow.reviewPeriodEnd.slice(0, 10)).toBe('2026-08-30');
  });

  it('CROSS-USER ISOLATION: expiring user A\'s stale backlog never touches user B\'s pending/deferred rows, and the backlog read is user-scoped', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'expiry-isoA');
    const userB = await createTestAuthUser(envBundle, 'expiry-isoB');
    cleanupUserIds.push(userA.id, userB.id);

    const staleReviewA = await insertReview(userA.id, '2026-06-01', '2026-06-07');
    const staleReviewB = await insertReview(userB.id, '2026-06-01', '2026-06-07');
    const rowA = await insertPromptRow(userA.id, staleReviewA, { subjectId: detectionSubjectId(`seq.iso_expiry_a_${Date.now()}`), state: 'pending' });
    const rowB = await insertPromptRow(userB.id, staleReviewB, { subjectId: detectionSubjectId(`seq.iso_expiry_b_${Date.now()}`), state: 'pending' });

    const currentReviewA = await insertReview(userA.id, '2026-09-07', '2026-09-13');
    await computeAndWriteReviewPrompts(userA.id, currentReviewA, new Date('2026-09-14T00:00:00Z'));

    const rowAAfter = await db.query<{ state: string }>(`select state from retrospeq.review_prompts where id = $1`, [rowA]);
    const rowBAfter = await db.query<{ state: string }>(`select state from retrospeq.review_prompts where id = $1`, [rowB]);
    expect(rowAAfter.rows[0].state).toBe('expired');
    expect(rowBAfter.rows[0].state).toBe('pending'); // untouched -- user A's materialisation never expires user B's backlog

    const backlogForB = await fetchDeferredBacklogForUser(userB.id, null, new Date('2026-09-14T00:00:00Z'));
    expect(backlogForB.map((r) => r.id)).not.toContain(rowA);
  });
});
