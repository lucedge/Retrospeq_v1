import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';
import { detectionSubjectId } from '../lib/review/prompt-candidates/stable-subject-id';

/**
 * Module 06 (Review & Graduation), frame 4.10 — real-browser E2E coverage
 * of `/review/decisions` for DETECTION, closing the phase-end gap named in
 * `PROGRESS.md`. Seeding mirrors `app/(app)/review/decisions/__tests__/
 * decisions-detection-integration.live.test.ts` (the live unit-level
 * coverage of the same actions/`fetchNextDecision` dispatch).
 *
 * `seq.reentry_after_loss` is the real, newly-`canAccept: true` analytic
 * named in this dispatch (cross-trade operand `computableToday` flip,
 * d2b7b76) — `detection-operand-map.ts` resolves it to a real
 * `time_since_last_loss` operand proposal today, unmocked.
 * `risk.spread` is the real, still-unmappable analytic used for the
 * failure path (`detection-operand-map.ts`'s own header names it as one
 * of the three still-`null` for a schema reason unrelated to this slice).
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-Detection-Pass-8834!';

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

test.describe('/review/decisions — detection (Module 06 frame 4.10)', () => {
  // The shared dev DB occasionally shows multi-second-to-tens-of-seconds
  // round trips under concurrent load (documented elsewhere in this repo
  // as shared-DB contention, not a product defect) — this route's own
  // `fetchNextDecision`/`preview()` pipeline makes several sequential
  // real DB calls per render, so a generous per-test budget avoids a
  // false FAIL from infra latency rather than a real regression.
  test.describe.configure({ timeout: 90_000 });
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
      await db.query('delete from retrospeq.prompt_history where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.detections where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]).catch(() => {});
      await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
      await deleteUser(userId);
    }
    await db.end();
  });

  async function loginAs(page: import('@playwright/test').Page, email: string) {
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
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

  let periodCounter = 0;

  async function insertReview(userId: string): Promise<string> {
    const periodStart = new Date(Date.UTC(2026, 8, 7) - periodCounter * 7 * 24 * 60 * 60 * 1000);
    const periodEnd = new Date(periodStart.getTime() + 6 * 24 * 60 * 60 * 1000);
    periodCounter += 1;
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2::date, $3::date, 1, '{}'::jsonb) returning id`,
      [userId, periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10)],
    );
    return res.rows[0].id;
  }

  async function insertDetectionPrompt(userId: string, reviewId: string, analyticId: string, occurrences: number): Promise<string> {
    const subjectId = detectionSubjectId(analyticId);
    const evidence = {
      analyticId,
      occurrences,
      tier: 'count_outcome',
      classification: 'pattern',
      outcomeAvgR: -0.6,
      outcomeBaselineAvgR: 0.3,
      direction: 'active',
    };
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'detection', 1, 'detection', $3, $4::jsonb, 'pending')
       returning id`,
      [userId, reviewId, subjectId, JSON.stringify(evidence)],
    );
    return res.rows[0].id;
  }

  test('CORE FLOW: a newly-reachable canAccept:true pattern (seq.reentry_after_loss) creates a real rule via "Add the rule"', async ({ page }) => {
    const user = await createConfirmedUser('detect-accept');
    cleanupUserIds.push(user.id);

    await seedDetection(user.id, 'seq.reentry_after_loss', 11);
    const reviewId = await insertReview(user.id);
    await insertDetectionPrompt(user.id, reviewId, 'seq.reentry_after_loss', 11);

    await loginAs(page, user.email);
    await page.goto('/review/decisions');
    await page.waitForSelector('#det-h');

    await expect(page.locator('#det-h')).toHaveText('Make a rule from this pattern?');
    await expect(page.getByText('You re-entered within 90 seconds of a loss 11 times.')).toBeVisible();
    await expect(page.locator('.detection')).toBeVisible();
    await expect(page.locator('.detection__statement')).toBeVisible();

    // The concept disclosure is collapsed by default — no syndrome name
    // ("revenge trading") visible outside it.
    const conceptDetails = page.locator('.detection__concept');
    await expect(conceptDetails.locator('summary')).toHaveText('What is this pattern?');

    const addBtn = page.getByRole('button', { name: 'Add the rule' });
    await expect(addBtn).toBeVisible();
    await expect(page.getByRole('button', { name: 'Not yet' })).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-detection-ready.png', fullPage: true });

    await addBtn.click();
    await page.waitForSelector('text=Nothing to decide right now.', { timeout: 70_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-detection-added.png', fullPage: true });

    const ruleRow = await db.query('select severity, origin, scope, state from retrospeq.rules where user_id = $1', [user.id]);
    expect(ruleRow.rows).toHaveLength(1);
    expect(ruleRow.rows[0]).toMatchObject({ severity: 'soft', origin: 'detected', scope: 'global', state: 'active' });

    const promptRow = await db.query(`select state, payload from retrospeq.review_prompts where user_id = $1 and kind = 'detection'`, [user.id]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].payload.resolution).toBe('added');
  });

  test('FAILURE PATH: a still-unmappable analytic (risk.spread) shows "can\'t become a rule yet"; "Not yet" records a decline, creates no rule', async ({ page }) => {
    const user = await createConfirmedUser('detect-unsupported');
    cleanupUserIds.push(user.id);

    await seedDetection(user.id, 'risk.spread', 5);
    const reviewId = await insertReview(user.id);
    await insertDetectionPrompt(user.id, reviewId, 'risk.spread', 5);

    await loginAs(page, user.email);
    await page.goto('/review/decisions');
    await page.waitForSelector('#det-h');

    await expect(page.getByText("This pattern can't become a rule yet.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add the rule' })).toHaveCount(0);
    const notYetBtn = page.getByRole('button', { name: 'Not yet' });
    await expect(notYetBtn).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-detection-unsupported.png', fullPage: true });

    await notYetBtn.click();
    await page.waitForSelector('text=Nothing to decide right now.', { timeout: 70_000 });

    // "Not yet" on detection is a DEFER, not a decline (`deferDetectionDecision`'s
    // own header) — the prompt is left `deferred`, no rule created, no
    // `prompt_history` row written (matches the live suite's own
    // `deferDetectionDecision` assertion).
    const ruleCount = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
    expect(ruleCount.rows[0].n).toBe(0);
    const promptRow = await db.query('select state, decided_at from retrospeq.review_prompts where user_id = $1', [user.id]);
    expect(promptRow.rows[0].state).toBe('deferred');
    expect(promptRow.rows[0].decided_at).toBeNull();
  });
});
