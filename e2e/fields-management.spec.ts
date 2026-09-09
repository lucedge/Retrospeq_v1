import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 03 (Field Registry & Strategy) §4.5/§6.1 — the fields MANAGEMENT
 * screen (`app/(app)/fields/**`). INDEPENDENT VERIFICATION (retrospeq-tester
 * dispatch, 2026-09-09) of a UI slice that shipped with ZERO real test
 * coverage — the coder's own self-check was a throwaway, deleted Playwright
 * script. This is the first PERMANENT E2E spec this slice has ever had,
 * matching `e2e/strategies-builder.independent-verify.spec.ts`'s own
 * established conventions (real GoTrue admin-created users, real Postgres
 * cleanup, screenshots read back for design-system compliance rather than
 * merely asserted on).
 *
 * Covers:
 *   1. Free-plan user: `/fields` shows the Pro upsell for custom fields
 *      (never "Add a field"), but the 9 seeded derived fields still render
 *      (§3.2: every user gets them regardless of plan) — screenshot.
 *   2. Pro-plan user, empty custom-field state: "Add a field" is the one
 *      primary `.rq-btn` — screenshot.
 *   3. Pro-plan user, full create -> list -> rename -> archive flow through
 *      the real UI, with a real-DB assertion after each step (not just a
 *      UI-visible claim) — screenshots at each key state.
 *   4. Archive blocked by a real dependent (`FIELD_IN_USE`), naming it
 *      inline — the failure path this module's own §7.4 test plan and
 *      00-foundation §9.4's E2E bar both call for.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-FieldsManagement-Pass-9931!';

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

test.describe('Fields management screen (Module 03 §4.5/§6.1, /fields) — independent verification', () => {
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
      await db.query('delete from retrospeq.field_usages where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]).catch(() => {});
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]).catch(() => {});
      await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
      await deleteUser(userId);
    }
    await db.end();
  });

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

  async function loginAs(page: import('@playwright/test').Page, email: string) {
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  }

  test('free-plan user: derived fields still render, custom-field creation is gated to the Pro upsell, never "Add a field"', async ({ page }) => {
    const user = await createConfirmedUser('fields-free-gate');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'free');

    await loginAs(page, user.email);
    await page.goto('/fields');

    // The 9 seeded derived fields render as static, non-actionable chips —
    // §3.2: every real user has these regardless of plan.
    await expect(page.getByRole('heading', { name: 'Recorded automatically' })).toBeVisible();
    await expect(page.getByText("You don't have any custom fields")).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add a field' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Upgrade to Pro' })).toBeVisible();

    // Design-system check: exactly one primary .rq-btn on this view (the
    // upgrade link) — excludes the persistent nav-chrome "Sign out" ghost
    // button, same exclusion `strategies-builder.independent-verify.spec.ts`
    // already establishes for shared shell chrome.
    const primaryButtons = await page.locator('.rq-btn:not(.rq-btn--ghost)').count();
    expect(primaryButtons).toBe(1);

    await page.screenshot({ path: 'tmp/dev-screenshots/fields-free-gate.png', fullPage: true });

    // The entire /fields/new route is gated too — no create form should
    // exist in the DOM at all for a free user landing here directly.
    await page.goto('/fields/new');
    await expect(page.getByRole('heading', { name: 'Custom fields are a Pro feature' })).toBeVisible();
    await expect(page.locator('#field-name')).toHaveCount(0);
    await page.screenshot({ path: 'tmp/dev-screenshots/fields-new-free-gate.png', fullPage: true });
  });

  test('Pro-plan user: empty custom-field state shows exactly one primary .rq-btn ("Add a field")', async ({ page }) => {
    const user = await createConfirmedUser('fields-pro-empty');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');

    await loginAs(page, user.email);
    await page.goto('/fields');

    await expect(page.getByText("You haven't added any fields of your own yet.")).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add a field' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Upgrade to Pro' })).toHaveCount(0);

    const primaryButtons = await page.locator('.rq-btn:not(.rq-btn--ghost)').count();
    expect(primaryButtons).toBe(1); // "Add a field" only — never both it and an upsell

    await page.screenshot({ path: 'tmp/dev-screenshots/fields-pro-empty.png', fullPage: true });
  });

  test('Pro-plan user: create -> list -> rename -> archive, each step backed by a real DB read, plus the FIELD_IN_USE failure path', async ({ page }) => {
    const user = await createConfirmedUser('fields-pro-full-flow');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');

    await loginAs(page, user.email);

    // ---- Create ----
    await page.goto('/fields');
    await page.getByRole('link', { name: 'Add a field' }).click();
    await expect(page).toHaveURL(/\/fields\/new/);

    await page.fill('#field-name', 'Setup quality (e2e)');
    await page.getByRole('radio', { name: 'Rating' }).click();
    await page.getByRole('radio', { name: 'All strategies' }).check();

    // Exactly one primary .rq-btn on the create form ("Create field";
    // "Cancel" is .rq-btn--ghost).
    const createFormPrimaryButtons = await page.locator('.rq-btn:not(.rq-btn--ghost)').count();
    expect(createFormPrimaryButtons).toBe(1);
    await page.screenshot({ path: 'tmp/dev-screenshots/fields-new-form-filled.png', fullPage: true });

    await page.getByRole('button', { name: 'Create field' }).click();
    await expect(page.getByRole('heading', { name: 'Field created' })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'tmp/dev-screenshots/fields-new-success.png', fullPage: true });

    const createdRes = await db.query<{ id: string }>(
      `select id from retrospeq.fields where user_id = $1 and name = $2 and kind = 'account'`,
      [user.id, 'Setup quality (e2e)'],
    );
    expect(createdRes.rows).toHaveLength(1);
    const fieldId = createdRes.rows[0].id;

    // ---- List, populated state ----
    await page.getByRole('link', { name: 'Back to your fields' }).click();
    await expect(page).toHaveURL(/\/fields$/);
    const row = page.locator(`[data-testid="field-row-${fieldId}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByText('Setup quality (e2e)')).toBeVisible();
    await expect(row.getByText('Shared')).toBeVisible(); // account kind
    await page.screenshot({ path: 'tmp/dev-screenshots/fields-list-populated.png', fullPage: true });

    // ---- Rename ----
    await row.getByRole('button', { name: 'Rename' }).click();
    const renameInput = row.getByLabel('Rename Setup quality (e2e)');
    await renameInput.fill('Setup quality, renamed (e2e)');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByText('Setup quality, renamed (e2e)')).toBeVisible();

    const renamedRes = await db.query('select name from retrospeq.fields where id = $1', [fieldId]);
    expect(renamedRes.rows[0].name).toBe('Setup quality, renamed (e2e)');

    // ---- Attach to a strategy directly (real field_usages dependent),
    // then verify archive is genuinely blocked, naming the dependent ----
    const stratRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'E2E dependent strategy', 1, false, 'active') returning id`,
      [user.id],
    );
    const strategyId = stratRes.rows[0].id;
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'E2E dependent strategy', $3::jsonb, '[]'::jsonb)`,
      [strategyId, user.id, JSON.stringify([{ field_id: fieldId, capture_moment: 'post_close', order: 0 }])],
    );
    await db.query(`insert into retrospeq.field_usages (user_id, field_id, used_by, used_by_id) values ($1, $2, 'strategy', $3)`, [
      user.id,
      fieldId,
      strategyId,
    ]);

    await page.reload();
    const rowAfterAttach = page.locator(`[data-testid="field-row-${fieldId}"]`);
    await rowAfterAttach.getByRole('button', { name: 'Archive' }).click();
    await rowAfterAttach.getByRole('button', { name: 'Yes, archive' }).click();
    await expect(rowAfterAttach.getByText(/can.t be archived/)).toBeVisible();
    await expect(rowAfterAttach.getByText('E2E dependent strategy')).toBeVisible(); // §9 "naming the rules" — named here as the strategy
    await page.screenshot({ path: 'tmp/dev-screenshots/fields-archive-blocked.png', fullPage: true });

    const stillActiveRes = await db.query('select state from retrospeq.fields where id = $1', [fieldId]);
    expect(stillActiveRes.rows[0].state).toBe('active');

    // ---- Remove the dependency directly, then archive succeeds ----
    await db.query('delete from retrospeq.field_usages where user_id = $1 and field_id = $2', [user.id, fieldId]);
    await page.reload();
    const rowAfterCleanup = page.locator(`[data-testid="field-row-${fieldId}"]`);
    await rowAfterCleanup.getByRole('button', { name: 'Archive' }).click();
    await rowAfterCleanup.getByRole('button', { name: 'Yes, archive' }).click();
    await expect(page.locator(`[data-testid="field-row-${fieldId}"]`)).toHaveCount(0); // moved out of the active list

    const archivedRes = await db.query('select state, archived_at from retrospeq.fields where id = $1', [fieldId]);
    expect(archivedRes.rows[0].state).toBe('archived');
    expect(archivedRes.rows[0].archived_at).not.toBeNull();

    await page.getByText('Archived fields').click(); // <details> summary
    await expect(page.getByText('Setup quality, renamed (e2e)')).toBeVisible();
    await page.screenshot({ path: 'tmp/dev-screenshots/fields-list-archived-expanded.png', fullPage: true });

    await db.query('delete from retrospeq.strategy_versions where strategy_id = $1', [strategyId]);
    await db.query('delete from retrospeq.strategies where id = $1', [strategyId]);
  });

  test('Pro-plan user: promoting a strategy_var field flips it to shared, visible in the list without a page reload', async ({ page }) => {
    const user = await createConfirmedUser('fields-pro-promote');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');

    const stratRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'E2E promote strategy', 1, false, 'active') returning id`,
      [user.id],
    );
    const strategyId = stratRes.rows[0].id;
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'E2E promote strategy', '[]'::jsonb, '[]'::jsonb)`,
      [strategyId, user.id],
    );
    const fieldRes = await db.query<{ id: string }>(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ('str.e2e-promote-conviction', $1, 'Conviction (e2e-promote)', 'strategy_var', 'rating', 'captured', $2, '{"min":1,"max":5}'::jsonb)
       returning id`,
      [user.id, strategyId],
    );
    const fieldId = fieldRes.rows[0].id;

    await loginAs(page, user.email);
    await page.goto('/fields');

    const row = page.locator(`[data-testid="field-row-${fieldId}"]`);
    await expect(row.getByText('This strategy only')).toBeVisible();
    await expect(row.getByText('Only in E2E promote strategy.')).toBeVisible();

    await row.getByRole('button', { name: 'Share across strategies' }).click();
    await expect(row.getByText('Shared')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Share across strategies' })).toHaveCount(0); // promotion is terminal, no re-promote control

    const promotedRes = await db.query('select kind, owner_strategy_id from retrospeq.fields where id = $1', [fieldId]);
    expect(promotedRes.rows[0]).toEqual({ kind: 'account', owner_strategy_id: null });

    await db.query('delete from retrospeq.strategy_versions where strategy_id = $1', [strategyId]);
    await db.query('delete from retrospeq.strategies where id = $1', [strategyId]);
  });
});
