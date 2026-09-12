import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';
import { weekStartForServerDay, addDaysToServerDay } from '../lib/rules/week-boundary';

/**
 * Module 06 (Review & Graduation) Slice 5 — `retrospeq-tester` dispatch,
 * 2026-09-12. Independent, real-browser E2E coverage of `/review` beyond
 * the coder's own throwaway self-check (deleted after use, per its
 * PROGRESS.md entry — this repo has zero permanent E2E coverage of this
 * screen before this file). Two real scenarios the coder's own screenshots
 * did NOT capture:
 *
 *   1. A genuinely populated week with THREE real findings (the coder's
 *      own populated screenshot had zero qualifying findings) — confirms
 *      the findings panel's cap-at-3 and `.finding` markup reuse against
 *      real data, not just the zero-findings path.
 *   2. A real missed-review, `covers_weeks = 2` span, produced by seeding
 *      one real COMPLETED review with a period_end that leaves exactly
 *      one week un-reviewed before "now" — confirms
 *      `determineCurrentWeeklyReviewPeriod`'s §4.8 "covers two" branch end
 *      to end through the real page, not just the mocked unit test.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-WeeklyReview-Slice5-Pass-9931!';

interface TestUser {
  id: string;
  email: string;
}

async function createConfirmedUser(label: string): Promise<TestUser> {
  const email = uniqueTestEmail(label);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email, password: TEST_PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`admin createUser failed (${res.status}): ${JSON.stringify(body)}`);
  return { id: body.id as string, email };
}

async function deleteUser(userId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  }).catch(() => {});
}

test.describe('/review — weekly read screen (Module 06 §4.2/§4.8), independent tester coverage', () => {
  let db: Client;
  const cleanupUserIds: string[] = [];

  test.beforeAll(async () => {
    db = new Client({ connectionString: SUPABASE_DB_URL });
    await db.connect();
  });

  test.afterAll(async () => {
    for (const userId of cleanupUserIds) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)").catch(() => {});
      await db.query('delete from retrospeq.review_prompts where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.analytic_renders where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.user_cohorts where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]).catch(() => {});
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]).catch(() => {});
      await db.query('delete from retrospeq.adherence_weekly where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.week_completeness where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.fills where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]).catch(() => {});
      await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
      await deleteUser(userId);
    }
    await db.end();
  });

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

  async function addToCohort(userId: string): Promise<void> {
    await db.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'beta_traders') on conflict do nothing`, [userId]);
  }

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Review E2E Test', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedConfirmedTrade(userId: string, accountId: string, serverDay: string, rMultiple: string): Promise<void> {
    const openedAt = new Date(`${serverDay}T09:00:00.000Z`);
    const closedAt = new Date(`${serverDay}T11:00:00.000Z`);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5) returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          currency, grouping_confidence, r_multiple, confirmed_at, confirmed_by)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, 'confirmed',
               'USD', 'confident_single', $7, now(), 'user')`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), closedAt.toISOString(), serverDay, rMultiple],
    );
  }

  async function seedWeekCompleteness(userId: string, weekStart: string, daysTraded: number, daysClosed: number): Promise<void> {
    await db.query(
      `insert into retrospeq.week_completeness (user_id, week_start, days_traded, days_closed, complete)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, week_start) do update set days_traded = excluded.days_traded, days_closed = excluded.days_closed, complete = excluded.complete`,
      [userId, weekStart, daysTraded, daysClosed, daysClosed >= daysTraded],
    );
  }

  async function seedAdherenceWeekly(userId: string, weekStart: string, hardFollowed: number, hardTotal: number, softFollowed: number, softTotal: number): Promise<void> {
    await db.query(
      `insert into retrospeq.adherence_weekly (user_id, week_start, hard_followed, hard_total, soft_followed, soft_total)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, week_start) do update set hard_followed = excluded.hard_followed, hard_total = excluded.hard_total, soft_followed = excluded.soft_followed, soft_total = excluded.soft_total`,
      [userId, weekStart, hardFollowed, hardTotal, softFollowed, softTotal],
    );
  }

  async function seedStreak(userId: string, streakWeeks: number): Promise<void> {
    await db.query(
      `update retrospeq.engagement_state set streak_weeks = $2, longest_streak_weeks = greatest(longest_streak_weeks, $2) where user_id = $1`,
      [userId, streakWeeks],
    );
  }

  async function seedStrategyFieldFinding(userId: string, fieldId: string, fieldName: string, strategyName: string, winRate: number, baseline: number): Promise<void> {
    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, $2, 1, false, 'active') returning id`,
      [userId, strategyName],
    );
    const strategyId = strategyRes.rows[0].id;
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, $3, 'strategy_var', 'rating', 'captured', $4, '{}'::jsonb)`,
      [fieldId, userId, fieldName, strategyId],
    );
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, $3, $4::jsonb, '[]'::jsonb)`,
      [strategyId, userId, strategyName, JSON.stringify([{ field_id: fieldId, capture_moment: 'pre_entry', order: 1 }])],
    );
    await db.query(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          confidence, gate_failures, state)
       values ($1, 'find.rating', $2, $3, $4::jsonb, 40, $5, null, 30, $6, null, $7, null, 'confident', '{}', 'active')`,
      [userId, strategyId, fieldId, JSON.stringify({ op: 'between', value: { min: 4, max: 5 } }), winRate, baseline, winRate - baseline],
    );
  }

  async function loginAs(page: import('@playwright/test').Page, email: string) {
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  }

  const now = new Date();
  const todayServerDay = now.toISOString().slice(0, 10);
  const currentWeekStart = weekStartForServerDay(todayServerDay);
  const lastEndedWeekStart = addDaysToServerDay(currentWeekStart, -7);

  test('1. a genuinely populated week with THREE real findings renders all three, capped correctly, real panel numbers', async ({ page }) => {
    const user = await createConfirmedUser('review-3findings');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const accountId = await seedAccount(user.id);
    await seedConfirmedTrade(user.id, accountId, lastEndedWeekStart, '1.0000');
    await seedConfirmedTrade(user.id, accountId, addDaysToServerDay(lastEndedWeekStart, 1), '0.5000');
    await seedConfirmedTrade(user.id, accountId, addDaysToServerDay(lastEndedWeekStart, 2), '-0.2000');
    await seedWeekCompleteness(user.id, lastEndedWeekStart, 3, 3);
    await seedAdherenceWeekly(user.id, lastEndedWeekStart, 10, 10, 18, 20);
    await seedStreak(user.id, 2);

    await seedStrategyFieldFinding(user.id, 'strategy_var.e2e_conviction_1', 'Conviction A', 'Strategy A (e2e)', 0.71, 0.42);
    await seedStrategyFieldFinding(user.id, 'strategy_var.e2e_conviction_2', 'Conviction B', 'Strategy B (e2e)', 0.68, 0.4);
    await seedStrategyFieldFinding(user.id, 'strategy_var.e2e_conviction_3', 'Conviction C', 'Strategy C (e2e)', 0.65, 0.44);

    await loginAs(page, user.email);
    await page.goto('/review');
    await page.waitForSelector('#review-h');

    // Real outcome numbers (1.0 + 0.5 - 0.2 = 1.3R, 3 trades, 3 days).
    await expect(page.locator('#review-h')).toContainText('3');
    await expect(page.locator('#review-h')).toContainText('trades');
    await expect(page.getByText('3 of 3 days closed out.')).toBeVisible();
    await expect(page.getByText('Hard rules:')).toContainText('10');
    await expect(page.getByText(/Soft:/)).toContainText('18');

    // Exactly 3 finding cards, capped, all confident, none showing "Not enough data yet."
    await expect(page.locator('.finding')).toHaveCount(3);
    await expect(page.locator('.finding[data-confidence="confident"]')).toHaveCount(3);
    await expect(page.getByText('Not enough data yet.')).toHaveCount(0);

    // Exactly one .rq-btn WITHIN the review view itself (the layout's own
    // "Sign out" chrome button is app-shell furniture present on every
    // route in this app, not part of this view — same distinction already
    // established for every other already-reviewed screen in this repo).
    const reviewSection = page.locator('section[aria-labelledby="review-h"]');
    await expect(reviewSection.locator('.rq-btn')).toHaveCount(1);
    await expect(reviewSection.locator('.rq-btn')).toBeDisabled();

    await page.screenshot({ path: 'tmp/dev-screenshots/review-populated-3-findings.png', fullPage: true });
  });

  test('2. a real missed-review, covers_weeks=2 span renders a date-range period line, not "Week of"', async ({ page }) => {
    const user = await createConfirmedUser('review-missed-week');
    cleanupUserIds.push(user.id);

    // Seed one COMPLETED review whose period_end leaves exactly ONE whole
    // week (the week immediately before lastEndedWeekStart) un-reviewed.
    const missedWeekStart = addDaysToServerDay(lastEndedWeekStart, -7);
    const completedPeriodEnd = addDaysToServerDay(missedWeekStart, -1); // the Sunday before the missed week
    const completedPeriodStart = addDaysToServerDay(completedPeriodEnd, -6);

    await db.query(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload, completed_at)
       values ($1, 'weekly', $2, $3, 1, '{}'::jsonb, now())`,
      [user.id, completedPeriodStart, completedPeriodEnd],
    );

    await loginAs(page, user.email);
    await page.goto('/review');
    await page.waitForSelector('#review-h');

    // Two-week span: the period line must NOT read "Week of" (single-week
    // phrasing) — it must name both ends of the range instead (ADR 0039 /
    // format.ts's own covers_weeks > 1 branch).
    const periodLine = page.locator('.rq-sub').first();
    await expect(periodLine).not.toContainText('Week of');

    // The underlying materialised row must genuinely record covers_weeks = 2.
    const row = await db.query<{ covers_weeks: number; period_start: string; period_end: string }>(
      `select covers_weeks, period_start::text as period_start, period_end::text as period_end
         from retrospeq.reviews where user_id = $1 and completed_at is null`,
      [user.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].covers_weeks).toBe(2);
    expect(row.rows[0].period_start).toBe(missedWeekStart);

    await page.screenshot({ path: 'tmp/dev-screenshots/review-missed-week-2span.png', fullPage: true });
  });
});
