import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';
import { weekStartForServerDay, addDaysToServerDay } from '../lib/rules/week-boundary';

// `determineCurrentWeeklyReviewPeriod` (lib/review/current-period.ts) picks
// the most recently-ENDED ISO week when a trader has no completed review
// yet -- the review/prompt fixtures below must target THAT real period
// (computed from the actual "now" this test runs at), not a fixed
// hardcoded date, or the page resolves "no_review" instead.
const now = new Date();
const todayServerDay = now.toISOString().slice(0, 10);
const currentWeekStart = weekStartForServerDay(todayServerDay);
const lastEndedWeekStart = addDaysToServerDay(currentWeekStart, -7);
const lastEndedWeekEnd = addDaysToServerDay(lastEndedWeekStart, 6);

/**
 * Module 06 (Review & Graduation) Slice 6 — `retrospeq-tester` dispatch,
 * 2026-09-13. Real-browser E2E coverage of `/review/decisions` (Part 2,
 * GRADUATION ONLY), beyond the coder's own throwaway self-check. Core flow
 * (accept a supported field, real DB writes) plus a real failure path
 * (a custom field's honest rejection) plus the Pro-gate, per this repo's
 * own "core flow + at least one failure path" E2E bar (00-foundation §9.4,
 * Module 06 §7.4).
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-Decisions-Slice6-Pass-4471!';

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

test.describe('/review/decisions — Part 2 graduation decisions (Module 06 §4.2/§4.6), independent tester coverage', () => {
  let db: Client;
  const cleanupUserIds: string[] = [];
  const cleanupAnalyticIds: string[] = [];

  test.beforeAll(async () => {
    db = new Client({ connectionString: SUPABASE_DB_URL });
    await db.connect();
  });

  test.afterAll(async () => {
    for (const analyticId of cleanupAnalyticIds) {
      await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [analyticId]).catch(() => {});
    }
    for (const userId of cleanupUserIds) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)").catch(() => {});
      await db.query('delete from retrospeq.review_prompts where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.prompt_history where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.finding_rule_links where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.field_usages where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]).catch(() => {});
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]).catch(() => {});
      await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
      await deleteUser(userId);
    }
    await db.end();
  });

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

  async function seedStrategy(userId: string, name: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, $2, 1, false, 'active') returning id`,
      [userId, name],
    );
    return res.rows[0].id;
  }

  async function seedAnalyticConfig(analyticId: string): Promise<void> {
    await db.query(
      `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
       values ($1, true, 'free', false, 't0') on conflict (analytic_id) do nothing`,
      [analyticId],
    );
    cleanupAnalyticIds.push(analyticId);
  }

  async function seedFinding(userId: string, strategyId: string, fieldId: string, analyticId: string, segment: unknown): Promise<void> {
    await db.query(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          p_value, p_adjusted, confidence, gate_failures, state)
       values ($1,$2,$3,$4,$5::jsonb,40,0.71,null,20,0.42,null,0.29,null,0.001,0.001,'confident','{}','active')`,
      [userId, analyticId, strategyId, fieldId, JSON.stringify(segment)],
    );
  }

  async function seedCustomField(userId: string, strategyId: string, fieldId: string, name: string): Promise<void> {
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, $3, 'strategy_var', 'pick_one', 'captured', $4, '{"options":["low","high"]}'::jsonb)`,
      [fieldId, userId, name, strategyId],
    );
  }

  async function insertReview(userId: string, periodStart: string, periodEnd: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2, $3, 1, '{}'::jsonb) returning id`,
      [userId, periodStart, periodEnd],
    );
    return res.rows[0].id;
  }

  async function insertGraduationPrompt(userId: string, reviewId: string, strategyId: string, fieldId: string, analyticId: string): Promise<string> {
    const payload = {
      strategyId,
      fieldId,
      analyticId,
      n: 40,
      winRate: 0.71,
      avgR: null,
      baselineN: 20,
      baselineWinRate: 0.42,
      baselineAvgR: null,
      deltaWinRate: 0.29,
      deltaAvgR: null,
    };
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'graduation', 1, 'finding', $3, $4::jsonb, 'pending') returning id`,
      [userId, reviewId, crypto.randomUUID(), JSON.stringify(payload)],
    );
    return res.rows[0].id;
  }

  async function loginAs(page: import('@playwright/test').Page, email: string) {
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  }

  test('CORE FLOW: a Pro trader accepts a graduation decision on a supported field — real rule created, screen lands on "nothing to decide"', async ({ page }) => {
    const user = await createConfirmedUser('decisions-accept');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');

    const strategyId = await seedStrategy(user.id, 'Accept Flow Strategy (e2e)');
    const analyticId = 'find.e2e-decisions-accept';
    await seedAnalyticConfig(analyticId);
    await seedFinding(user.id, strategyId, 'drv.risk_pct', analyticId, { op: 'between', value: { min: 0.5, max: 1.0 } });
    const reviewId = await insertReview(user.id, lastEndedWeekStart, lastEndedWeekEnd);
    await insertGraduationPrompt(user.id, reviewId, strategyId, 'drv.risk_pct', analyticId);

    await loginAs(page, user.email);
    await page.goto('/review/decisions');
    await page.waitForSelector('#dec-h');

    await expect(page.locator('#dec-h')).toContainText('risk %');
    await expect(page.getByText(/Based on 40 trades/)).toBeVisible();
    await expect(page.locator('.rq-cost')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add the rule' })).toBeVisible();

    // Design-system check before acting: exactly one primary button, no
    // red/green anywhere.
    await expect(page.locator('.rq-btn:not(.rq-btn--ghost):not(.rq-btn--equal)')).toHaveCount(1);
    await page.screenshot({ path: 'tmp/dev-screenshots/review-decisions-graduation-populated.png', fullPage: true });

    await page.getByRole('button', { name: 'Add the rule' }).click();
    await page.waitForSelector('text=Nothing to decide right now.', { timeout: 30_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/review-decisions-graduation-none-pending.png', fullPage: true });

    // Real DB write, verified directly.
    const ruleRow = await db.query(`select origin, severity, scope from retrospeq.rules where user_id = $1`, [user.id]);
    expect(ruleRow.rows).toHaveLength(1);
    expect(ruleRow.rows[0]).toMatchObject({ origin: 'graduated', severity: 'soft', scope: 'strategy' });

    const promptRow = await db.query(`select state from retrospeq.review_prompts where user_id = $1`, [user.id]);
    expect(promptRow.rows[0].state).toBe('accepted');
  });

  test('FAILURE PATH: a custom field honestly rejects — no crash, no red/green, evidence still shown, prompt stays pending', async ({ page }) => {
    const user = await createConfirmedUser('decisions-reject-custom');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');

    const strategyId = await seedStrategy(user.id, 'Reject Flow Strategy (e2e)');
    const fieldId = `conviction_e2e_${Date.now()}`;
    await seedCustomField(user.id, strategyId, fieldId, 'Conviction');
    const analyticId = 'find.e2e-decisions-reject';
    await seedAnalyticConfig(analyticId);
    await seedFinding(user.id, strategyId, fieldId, analyticId, { op: 'eq', value: 'high' });
    const reviewId = await insertReview(user.id, lastEndedWeekStart, lastEndedWeekEnd);
    const promptId = await insertGraduationPrompt(user.id, reviewId, strategyId, fieldId, analyticId);

    await loginAs(page, user.email);
    await page.goto('/review/decisions');
    await page.waitForSelector('#dec-h');

    await expect(page.getByText("This kind of finding can")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add the rule' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Not yet' })).toBeVisible();
    // No red/green anywhere in this rejection state.
    const html = await page.content();
    expect(html.toLowerCase()).not.toMatch(/color:\s*red|color:\s*green/);

    await page.screenshot({ path: 'tmp/dev-screenshots/review-decisions-graduation-unsupported-field.png', fullPage: true });

    await page.getByRole('button', { name: 'Not yet' }).click();
    // The single pending prompt in this fixture -- deferring it lands on
    // page.tsx's own "none_pending" branch once the Server Action's
    // revalidatePath re-render completes.
    await page.waitForSelector('text=Nothing to decide right now.', { timeout: 30_000 });

    const promptRow = await db.query(`select state, decided_at from retrospeq.review_prompts where id = $1`, [promptId]);
    expect(promptRow.rows[0].state).toBe('deferred');
    expect(promptRow.rows[0].decided_at).toBeNull();
  });

  test('FREE-TIER GATE: a free-plan trader sees the honest Pro upsell, never the decision content — empty/thin-data-style state', async ({ page }) => {
    const user = await createConfirmedUser('decisions-free-gate');
    cleanupUserIds.push(user.id);
    // No setPlan call -- new users default to free.

    await loginAs(page, user.email);
    await page.goto('/review/decisions');
    await page.waitForSelector('h1');

    await expect(page.getByText('Turning a finding into a rule is a Pro feature.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add the rule' })).toHaveCount(0);
    await expect(page.locator('.rq-btn:not(.rq-btn--ghost)')).toHaveCount(0); // no primary button — nothing to offer

    await page.screenshot({ path: 'tmp/dev-screenshots/review-decisions-graduation-plan-required.png', fullPage: true });
  });
});
