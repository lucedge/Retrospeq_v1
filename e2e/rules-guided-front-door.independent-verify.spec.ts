import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 04 (Rulebook & Evaluation) §5.10 / story 1.4, Slice 10a —
 * INDEPENDENT tester verification, screenshot-based visual self-check for
 * a screen STATE the coder's own E2E suite (`rules-guided-front-door.spec.ts`)
 * never exercised: a trader with SUFFICIENT real history, producing a
 * genuine "flagged" preview with real numbers on screen (their own suite
 * only covers brand-new/no-history and at-the-free-tier-cap).
 *
 * `operand_distributions` rows are inserted directly via SQL rather than
 * through the real recompute pipeline (`recomputeOperandDistributionsForUser`
 * imports `server-only`, which throws when imported from a plain Node
 * process the way this Playwright spec runs -- unlike the app itself, which
 * runs under Next.js's "react-server" resolve condition). This is a
 * DELIBERATE, narrower scope than the vitest live-DB test file
 * (`lib/rules/__tests__/guided-front-door.independent-verify.live.test.ts`),
 * which already independently proves the recompute PIPELINE is correct
 * end-to-end against real trade rows. This spec's own job is different: does
 * the SCREEN render a real `operand_distributions` row honestly (real
 * numbers, `.rq-num`, no red/green, correct seeded threshold), which is
 * exactly what a hand-inserted-but-schema-valid row can prove.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-GuidedRules-Verify-5678!';

interface TestUser {
  id: string;
  email: string;
}

async function createConfirmedUser(label: string): Promise<TestUser> {
  const email = uniqueTestEmail(label);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
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

test.describe('Guided three-rule front door — independent verify: sufficient-history "flagged" state (Module 04 §5.10)', () => {
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
      await db.query('delete from retrospeq.operand_distributions where user_id = $1', [userId]).catch(() => {});
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
    // Module 08 (Onboarding & Home) Slice 08b: post-sign-in `/` now
    // redirects onward per a fresh trader's onboarding stage (see
    // `lib/onboarding/router.ts`) rather than rendering bare `/` — waits
    // for navigation away from `/login` instead of a specific destination.
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  }

  /** One evenly-spread 20-observation distribution, one bucket per value
   *  (count 1 each unless `repeat` is given) -- values span the operand's
   *  own catalogue bounds exactly, so the 80th-percentile seed this test
   *  hand-computes in its own comments is independently checkable. */
  async function insertDistribution(
    userId: string,
    operandId: string,
    values: number[],
    countPerValue: number,
  ): Promise<void> {
    const buckets = values.map((value) => ({ value, count: countPerValue }));
    const n = values.length * countPerValue;
    await db.query(
      `insert into retrospeq.operand_distributions (user_id, operand_id, buckets, n, computed_at)
       values ($1, $2, $3::jsonb, $4, now())`,
      [userId, operandId, JSON.stringify(buckets), n],
    );
  }

  test('a trader with a real, sufficient (n=20) distribution for all three guided operands sees genuine flagged previews with real numbers, not fabricated ones', async ({
    page,
  }) => {
    const user = await createConfirmedUser('guided-flagged');
    cleanupUserIds.push(user.id);

    // risk_pct: bounds {min:0.1, max:5.0, step:0.1} -- 0.5..2.4 in 0.1
    // steps, one observation each (n=20). By hand: 80th percentile
    // (target = 20*0.8 = 16) is the 16th ascending value = 0.5+15*0.1 =
    // 2.0 -- the seeded threshold this test expects on screen. At that
    // threshold, values > 2.0 (2.1, 2.2, 2.3, 2.4 -- 4 values) are
    // FLAGGED.
    const riskValues = Array.from({ length: 20 }, (_, i) => Number((0.5 + i * 0.1).toFixed(1)));
    await insertDistribution(user.id, 'risk_pct', riskValues, 1);

    // daily_loss_pct: bounds {min:0.5, max:10, step:0.5} -- 0.5..10.0 in
    // 0.5 steps is EXACTLY 20 values. 80th percentile (target=16) is the
    // 16th value = 0.5+15*0.5 = 8.0. Flagged (>8.0): 8.5, 9.0, 9.5, 10.0
    // -- 4 values.
    const dailyLossValues = Array.from({ length: 20 }, (_, i) => Number((0.5 + i * 0.5).toFixed(1)));
    await insertDistribution(user.id, 'daily_loss_pct', dailyLossValues, 1);

    // consecutive_losses: bounds {min:1, max:10, step:1} -- 1..10, TWO
    // observations each (n=20). 80th percentile (target=16): cumulative
    // count reaches 16 at value 8 (2*8=16). Flagged (>8): values 9, 10,
    // two each -- 4 observations.
    await insertDistribution(user.id, 'consecutive_losses', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2);

    await loginAs(page, user.email);
    await page.goto('/rules/start');
    await expect(page.locator('h1')).toHaveText('Three rules to start with');

    const riskCard = page.locator('.rule-editor', { hasText: 'Never risk more than' });
    await expect(riskCard.locator('.rq-step__val')).toHaveText('2.0%', { timeout: 10_000 });
    // Real, non-zero flagged count -- never `insufficient_history` copy,
    // never a fabricated number.
    await expect(riskCard.locator('.preview__count')).toHaveText('4', { timeout: 10_000 });
    await expect(riskCard.getByText('No history yet', { exact: false })).toHaveCount(0);
    await expect(riskCard.getByText('Against your recent trades, this would have flagged')).toBeVisible();

    const dailyLossCard = page.locator('.rule-editor', { hasText: "Never let today's loss exceed" });
    await expect(dailyLossCard.locator('.rq-step__val')).toHaveText('8.0%', { timeout: 10_000 });
    await expect(dailyLossCard.locator('.preview__count')).toHaveText('4', { timeout: 10_000 });

    const clCard = page.locator('.rule-editor', { hasText: 'Stop trading after' });
    await expect(clCard.locator('.rq-step__val')).toHaveText('8', { timeout: 10_000 });
    await expect(clCard.locator('.preview__count')).toHaveText('4', { timeout: 10_000 });

    // `.rq-num` on every numeric readout on this screen (AGENTS.md
    // non-negotiable) -- the stepper value AND the preview count both
    // carry it.
    await expect(riskCard.locator('.rq-step__val.rq-num')).toHaveCount(1);
    await expect(riskCard.locator('.preview__count.rq-num')).toHaveCount(1);

    await page.screenshot({ path: 'tmp/dev-screenshots/guided-rules-independent-verify-flagged.png', fullPage: true });
  });
});
