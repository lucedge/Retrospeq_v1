import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 04 (Rulebook & Evaluation) §5.10 / story 1.4, Slice 10a E2E — the
 * guided three-rule front door's core flow (accept a rule, live preview
 * updates as the stepper moves, decline) plus one failure path
 * (already-at-the-free-tier-rule-cap, surfaced honestly rather than
 * showing a control that would just fail). Follows `trades.spec.ts`'s own
 * conventions: real dev server, real Supabase Auth project, a real `pg`
 * connection for setup/verification, screenshots to `tmp/dev-screenshots/`.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-GuidedRules-Pass-1234!';

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

test.describe('Guided three-rule front door (Module 04 §5.10, /rules/start)', () => {
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
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]).catch(() => {});
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
    await page.waitForURL('**/', { timeout: 10_000 });
  }

  async function insertActiveGlobalRule(userId: string, operandId: string, rendered: string): Promise<void> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, 'global', null, 'soft', 'authored', 'pre_entry', 'active') returning id`,
      [userId],
    );
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, 'lte', '1'::jsonb, $4)`,
      [ruleRes.rows[0].id, userId, operandId, rendered],
    );
  }

  test('core flow: a brand-new trader sees all three cards with a live preview, deselects one, adds the other two for real, and the done state reflects exactly what was added', async ({
    page,
  }) => {
    const user = await createConfirmedUser('guided-core');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.goto('/rules/start');
    await expect(page.locator('h1')).toHaveText('Three rules to start with');

    // No history at all -- every card genuinely says "not enough data
    // yet" (AGENTS.md: a correct, intended state, not a bug), never a
    // fabricated ratio.
    await expect(page.getByText('No history yet', { exact: false })).toHaveCount(3, { timeout: 10_000 });

    // Zero primary `.rq-btn` within THIS screen's own content (the
    // persistent app-shell header's own "Sign out" `.rq-btn` is chrome
    // shared across every page, not this view's content, and coexists
    // with a page's own `.rq-btn` elsewhere in this app already --
    // e.g. /plan's "Upgrade to Pro" -- so the "one primary per view"
    // check is scoped to the guided front door's own <section>). Only
    // the two `.rq-btn--equal` outline actions live in that section, per
    // the design system's no-implied-recommendation rule applied to
    // "add" vs "skip".
    const screenContent = page.locator('section', { has: page.locator('#guided-rules-h') });
    await expect(screenContent.locator('button.rq-btn:not(.rq-btn--equal)')).toHaveCount(0);
    await expect(screenContent.locator('button.rq-btn.rq-btn--equal')).toHaveCount(2);

    // The stepper genuinely moves the value AND the sentence updates --
    // not just the numeric readout. A brand-new account has zero history,
    // so risk_pct's seed is the CATALOGUE BOUNDS MIDPOINT (0.1 + 5.0) / 2
    // rounded to the 0.1 step -- 2.6% (`guided-front-door.ts`'s own
    // documented fallback, independently re-derived here rather than
    // assumed).
    const riskCard = page.locator('.rule-editor', { hasText: 'Never risk more than' });
    await expect(riskCard.locator('.rq-step__val')).toHaveText('2.6%');
    await riskCard.getByRole('button', { name: 'Increase' }).click();
    await riskCard.getByRole('button', { name: 'Increase' }).click();
    await expect(riskCard.locator('.rq-step__val')).toHaveText('2.8%');
    await expect(riskCard.getByText('Never risk more than 2.8% per trade.')).toBeVisible();

    // Preview re-runs live off the new value (still insufficient_history
    // for a brand-new account, but a REAL round trip, not a static string
    // -- proven by the loading skeleton appearing then resolving again).
    await expect(riskCard.getByText('Checking against your history…')).toBeVisible({ timeout: 2_000 });
    await expect(riskCard.getByText('No history yet', { exact: false })).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/guided-rules-e2e-choosing.png', fullPage: true });

    // Deselect the daily loss cap card -- "some, not all."
    const dailyLossCard = page.locator('.rule-editor', { hasText: "Never let today's loss exceed" });
    await dailyLossCard.getByRole('switch').click();
    await expect(dailyLossCard.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('button', { name: 'Add 2 selected' })).toBeVisible();

    // Add the two remaining selected rules -- a REAL write via the
    // existing createRule Server Action, not a UI-only state flip.
    await page.getByRole('button', { name: 'Add 2 selected' }).click();
    await expect(page.getByText('Your rulebook is started')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Never risk more than 2.8% per trade.')).toBeVisible();
    await expect(page.getByText('Stop trading after 6 losses in a row.')).toBeVisible();
    // The deselected one never appears in the "added" summary. Scoped to
    // the `.rq-tag` chip elements specifically (not a page-wide text
    // search) -- the screen's own intro paragraph ("...every one starts
    // soft...") legitimately contains this substring too
    // (case-insensitively), so an unscoped `getByText('Starts soft')`
    // would false-positive against that unrelated sentence, not a real
    // third rule (confirmed by inspecting the actual matched elements).
    await expect(page.getByText('Never let today', { exact: false })).toHaveCount(0);
    await expect(page.locator('.rq-tag--muted', { hasText: 'Starts soft' })).toHaveCount(2);

    await page.screenshot({ path: 'tmp/dev-screenshots/guided-rules-e2e-done.png', fullPage: true });

    // Independent proof against Postgres directly -- exactly two REAL
    // active global soft rules exist, for the exact two operands chosen.
    const rows = await db.query<{ operand_id: string; severity: string; scope: string; state: string }>(
      `select rv.operand_id, r.severity, r.scope, r.state
         from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.user_id = $1
        order by rv.operand_id`,
      [user.id],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.operand_id)).toEqual(['consecutive_losses', 'risk_pct']);
    for (const row of rows.rows) {
      expect(row.severity).toBe('soft');
      expect(row.scope).toBe('global');
      expect(row.state).toBe('active');
    }
  });

  test('decline entirely: "Skip for now" persists nothing and reads as an equally legitimate choice, not a punished one', async ({ page }) => {
    const user = await createConfirmedUser('guided-skip');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.goto('/rules/start');
    await expect(page.locator('h1')).toHaveText('Three rules to start with');

    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByText('No rules added')).toBeVisible();
    await expect(page.getByText("That's fine", { exact: false })).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/guided-rules-e2e-skipped.png', fullPage: true });

    const rows = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
    expect(rows.rows[0].n).toBe(0);
  });

  test('failure path: a trader already at the free-tier rule cap sees an honest message and no interaction that would just fail, while "Skip for now" still works', async ({
    page,
  }) => {
    const user = await createConfirmedUser('guided-at-cap');
    cleanupUserIds.push(user.id);

    // Three active global rules on OTHER operands -- rules.create's free
    // cap (3, lib/entitlements/capability-table.ts) is genuinely exhausted
    // before this trader ever reaches the guided screen.
    await insertActiveGlobalRule(user.id, 'hold_seconds', 'Never hold a position longer than 60 seconds.');
    await insertActiveGlobalRule(user.id, 'stop_set_at_entry', 'Always set a stop before entering.');
    await insertActiveGlobalRule(user.id, 'held_past_stop', 'Never hold a position past its stop.');

    await loginAs(page, user.email);
    await page.goto('/rules/start');
    await expect(page.locator('h1')).toHaveText('Three rules to start with');

    await expect(page.getByText("You're already at your rule limit", { exact: false })).toBeVisible();
    const addButton = page.getByRole('button', { name: /Add all three|Add \d+ selected/ });
    await expect(addButton).toBeDisabled();

    await page.screenshot({ path: 'tmp/dev-screenshots/guided-rules-e2e-at-cap.png', fullPage: true });

    // "Skip for now" is never blocked by the same cap -- declining always
    // works.
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByText('No rules added')).toBeVisible();

    // No guided rule was silently created despite the disabled button --
    // the three pre-existing rules are still the only three rows.
    const rows = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
    expect(rows.rows[0].n).toBe(3);
  });
});
