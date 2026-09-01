import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Independent tester verification (Module 04 Slice 10f, story 2.5) — a
 * FRESH E2E spec, not the coder's own `rules-edit-threshold.spec.ts`,
 * exercising fresh fixtures per the dispatch's own explicit instructions:
 *
 *  - item 3: a DIFFERENT bool operand than the coder's own
 *    (`target_set_at_entry`, not `stop_set_at_entry`) never shows Edit.
 *  - item 3: a retired rule on a DIFFERENT operand than the coder's own
 *    (`weekly_loss_pct`, not `risk_pct`) never shows Edit.
 *  - item 4: a successful edit on a DIFFERENT operand than the coder's own
 *    (`total_open_risk`, not `risk_pct`) updates the row's displayed text
 *    immediately (no reload), independently re-verified against Postgres
 *    directly for the CORRECT new value/rendered text, not just "some text
 *    changed."
 *
 * Throwaway verification only, matching this repo's own established
 * "independent tester writes fresh fixtures, doesn't just re-run the
 * coder's own suite" convention (see Slice 10b/10d/10e's own independent
 * verification write-ups in PROGRESS.md).
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-IndepVerify-Pass-1234!';

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

test.describe('Independent verification: edit-threshold UI, fresh fixtures (Module 04 §2.5)', () => {
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
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]).catch(() => {});
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
    // Module 08 (Onboarding & Home) Slice 08b: post-sign-in `/` now
    // redirects onward per a fresh trader's onboarding stage (see
    // `lib/onboarding/router.ts`) rather than rendering bare `/` — waits
    // for navigation away from `/login` instead of a specific destination.
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  }

  async function seedGlobalRule(
    userId: string,
    operandId: string,
    op: string,
    value: unknown,
    rendered: string,
    overrides: { severity?: 'soft' | 'hard'; state?: 'active' | 'retired' } = {},
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, 'global', null, $2, 'authored', 'pre_entry', $3)
       returning id`,
      [userId, overrides.severity ?? 'soft', overrides.state ?? 'active'],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, $4, $5::jsonb, $6)`,
      [ruleId, userId, operandId, op, JSON.stringify(value), rendered],
    );
    return ruleId;
  }

  test('a DIFFERENT bool operand (target_set_at_entry) never shows Edit', async ({ page }) => {
    const user = await createConfirmedUser('indep-bool-excl');
    cleanupUserIds.push(user.id);
    await seedGlobalRule(user.id, 'target_set_at_entry', 'is_true', true, 'Always set a target before entering.', {
      severity: 'soft',
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.locator('li', { hasText: 'Always set a target before entering.' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    // Other controls still present -- exclusion is scoped to Edit only.
    await expect(row.getByRole('button', { name: 'Promote to hard' })).toBeVisible();
  });

  test('a retired rule on a DIFFERENT operand (weekly_loss_pct) never shows Edit', async ({ page }) => {
    const user = await createConfirmedUser('indep-retired-excl');
    cleanupUserIds.push(user.id);
    await seedGlobalRule(user.id, 'weekly_loss_pct', 'lte', 4, "Never let this week's loss exceed 4% of your account.", {
      severity: 'soft',
      state: 'retired',
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    await page.getByText('Retired rules (1)').click();
    const row = page.locator('li', { hasText: "Never let this week's loss exceed 4% of your account." });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  });

  test('a successful edit on a DIFFERENT operand (total_open_risk) updates the row live, and Postgres carries exactly the new value/text', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const user = await createConfirmedUser('indep-edit-success');
    cleanupUserIds.push(user.id);
    const ruleId = await seedGlobalRule(
      user.id,
      'total_open_risk',
      'lte',
      4,
      'Never let your total open risk exceed 4% of your account.',
      { severity: 'soft' },
    );

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.getByTestId(`rule-row-${ruleId}`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Edit' }).click();

    const stepperValue = row.locator('.rq-step__val');
    await expect(stepperValue).toHaveText('4.0%', { timeout: 10_000 });

    await page.screenshot({
      path: 'tmp/dev-screenshots/indep-verify-edit-open-prefilled.png',
      fullPage: true,
    });

    const decreaseBtn = row.getByRole('button', { name: 'Decrease' });
    await decreaseBtn.click();
    await decreaseBtn.click();
    await decreaseBtn.click();
    // total_open_risk step is 0.5 per the catalogue -- three decreases from
    // 4 = 2.5.
    await expect(stepperValue).toHaveText('2.5%');

    await expect(row.locator('.preview')).not.toContainText('Checking against your history', { timeout: 5_000 });
    await row.getByRole('button', { name: 'Save' }).click();

    const headerSentence = row.locator('section.rq-card > div > p.rule-sentence');
    // The row must update WITHOUT a page reload -- poll for the header
    // text directly rather than reloading, so a reload would NOT
    // accidentally paper over a staleness bug.
    await expect(headerSentence).toHaveText('Never let your total open risk exceed 2.5% of your account.', {
      timeout: 15_000,
    });

    await page.screenshot({
      path: 'tmp/dev-screenshots/indep-verify-edit-success.png',
      fullPage: true,
    });

    // Independent re-verification directly against Postgres -- not just
    // "some text changed," the EXACT correct new value/rendered text and
    // version bookkeeping.
    const rulesRes = await db.query<{ current_version: number }>(
      'select current_version from retrospeq.rules where id = $1',
      [ruleId],
    );
    expect(rulesRes.rows[0].current_version).toBe(2);
    const versionRes = await db.query<{ value: unknown; rendered: string; superseded_at: string | null }>(
      'select value, rendered, superseded_at from retrospeq.rule_versions where rule_id = $1 and version = 2',
      [ruleId],
    );
    expect(versionRes.rows[0].value).toBe(2.5);
    expect(versionRes.rows[0].rendered).toBe('Never let your total open risk exceed 2.5% of your account.');
    expect(versionRes.rows[0].superseded_at).toBeNull();
    const oldVersionRes = await db.query<{ superseded_at: string | null }>(
      'select superseded_at from retrospeq.rule_versions where rule_id = $1 and version = 1',
      [ruleId],
    );
    expect(oldVersionRes.rows[0].superseded_at).not.toBeNull();
  });

  test('a fresh tier-downgrade fixture (an account that HAD t1 when the rule was created, then disconnects) rejects the edit honestly through the real UI', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const user = await createConfirmedUser('indep-tier-downgrade');
    cleanupUserIds.push(user.id);

    const accountRes = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier, status)
       values ($1, 'Downgrade-scenario account', 'mt5', 'USD', '00:00:00 UTC', 't1', 'connected')
       returning id`,
      [user.id],
    );
    const accountId = accountRes.rows[0].id;
    const ruleId = await seedGlobalRule(
      user.id,
      'stop_move_count',
      'lte',
      2,
      'Never move your stop more than 2 time(s).',
      { severity: 'soft' },
    );

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.getByTestId(`rule-row-${ruleId}`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(row.locator('.rq-step__val')).toHaveText('2', { timeout: 10_000 });

    // The account genuinely disconnects WHILE the edit control is open --
    // a fresh scenario from the coder's own "always zero accounts" fixture.
    await db.query(`update retrospeq.trading_accounts set status = 'disconnected' where id = $1`, [accountId]);

    await row.getByRole('button', { name: 'Increase' }).click();
    await row.getByRole('button', { name: 'Save' }).click();

    const alert = row.locator('[role="alert"]');
    await expect(alert).toBeVisible({ timeout: 18_000 });
    await expect(alert).toContainText('connected accounts');

    await page.screenshot({
      path: 'tmp/dev-screenshots/indep-verify-tier-rejected.png',
      fullPage: true,
    });

    // No corruption -- still version 1, value 2.
    const current = await db.query<{ current_version: number; value: unknown }>(
      `select r.current_version, rv.value from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.id = $1`,
      [ruleId],
    );
    expect(current.rows[0].current_version).toBe(1);
    expect(current.rows[0].value).toBe(2);
  });
});
