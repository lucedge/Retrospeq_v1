import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 04 (Rulebook & Evaluation) §6.1's `.rule-editor` reference markup
 * / story 1.1, Slice 10b E2E — the general rule editor's core flow (pick
 * ANY offerable operand, adjust the stepper, see a live preview, submit,
 * land on a real "rule added" state backed by a genuine `rules` row) plus
 * one failure path (already at the free-tier `rules.create` cap of 3,
 * same honest-message convention Slice 10a's own E2E already establishes
 * for the guided front door). Follows `rules-guided-front-door.spec.ts`'s
 * own conventions: real dev server, real Supabase Auth project, a real
 * `pg` connection for setup/verification, screenshots to
 * `tmp/dev-screenshots/`.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-RuleEditor-Pass-1234!';

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

test.describe('General rule editor (Module 04 §6.1, /rules/new)', () => {
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

  test('core flow: a numeric operand can be chosen, its stepper genuinely changes the sentence and re-runs a live preview, and submitting writes a real global soft rule', async ({
    page,
  }) => {
    const user = await createConfirmedUser('editor-numeric');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.goto('/rules/new');
    await expect(page.locator('h1')).toHaveText('Write a rule');

    // No operand chosen yet -- no `.rule-editor` section rendered, no
    // second `.rq-btn` visible anywhere on this screen (only chrome).
    await expect(page.locator('.rule-editor')).toHaveCount(0);

    await page.selectOption('#operand-picker', 'risk_pct');
    await expect(page.locator('.rule-editor')).toBeVisible();

    // A brand-new account has zero history -- bounds midpoint (0.1 + 5.0)
    // / 2 rounded to the 0.1 step is 2.6%, the SAME honest fallback
    // guided-front-door.ts documents (independently re-derived here, not
    // assumed).
    await expect(page.locator('.rq-step__val')).toHaveText('2.6%');
    await expect(page.getByText('Never risk more than 2.6% per trade.')).toBeVisible();

    // Zero primary `.rq-btn` UNTIL an operand is chosen would be wrong --
    // once one is, exactly one primary `.rq-btn` exists (the submit),
    // matching "exactly one primary per view."
    await expect(page.locator('button.rq-btn:not(.rq-btn--ghost)')).toHaveCount(1);

    await page.getByRole('button', { name: 'Increase' }).click();
    await page.getByRole('button', { name: 'Increase' }).click();
    await expect(page.locator('.rq-step__val')).toHaveText('2.8%');
    await expect(page.getByText('Never risk more than 2.8% per trade.')).toBeVisible();

    // Live preview genuinely re-runs off the new value -- a real round
    // trip (loading skeleton, then a real resolved state), not a static
    // string. Still insufficient_history for a brand-new account.
    await expect(page.getByText('Checking against your history…')).toBeVisible({ timeout: 2_000 });
    await expect(page.getByText('No history yet', { exact: false })).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-e2e-numeric.png', fullPage: true });

    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByText('Rule added')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Never risk more than 2.8% per trade.')).toBeVisible();
    await expect(page.locator('.rq-tag--muted', { hasText: 'Starts soft' })).toBeVisible();

    // Exactly one primary `.rq-btn` on the done state too, plus one
    // `.rq-btn--ghost` secondary -- never a second primary.
    await expect(page.locator('button.rq-btn:not(.rq-btn--ghost), a.rq-btn:not(.rq-btn--ghost)')).toHaveCount(1);

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-e2e-done.png', fullPage: true });

    const rows = await db.query<{ operand_id: string; op: string; value: string; severity: string; scope: string; state: string }>(
      `select rv.operand_id, rv.op, rv.value, r.severity, r.scope, r.state
         from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.user_id = $1`,
      [user.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].operand_id).toBe('risk_pct');
    expect(rows.rows[0].op).toBe('lte');
    expect(Number(rows.rows[0].value)).toBe(2.8);
    expect(rows.rows[0].severity).toBe('soft');
    expect(rows.rows[0].scope).toBe('global');
    expect(rows.rows[0].state).toBe('active');
  });

  test('a bool operand has no stepper at all -- the sentence is already complete the moment it is chosen, and submitting still writes a real row', async ({
    page,
  }) => {
    const user = await createConfirmedUser('editor-bool');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.goto('/rules/new');
    await page.selectOption('#operand-picker', 'stop_set_at_entry');

    await expect(page.getByText('Always set a stop before entering.')).toBeVisible();
    // No stepper for a bool operand -- there is no `{value}` in its
    // sentence template to adjust.
    await expect(page.locator('.rq-step')).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-e2e-bool.png', fullPage: true });

    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByText('Rule added')).toBeVisible({ timeout: 15_000 });

    const rows = await db.query<{ operand_id: string; op: string }>(
      `select rv.operand_id, rv.op
         from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.user_id = $1`,
      [user.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].operand_id).toBe('stop_set_at_entry');
    expect(rows.rows[0].op).toBe('is_true');
  });

  test('failure path: a trader already at the free-tier rule cap sees an honest message and the submit control is genuinely disabled', async ({
    page,
  }) => {
    const user = await createConfirmedUser('editor-at-cap');
    cleanupUserIds.push(user.id);

    await insertActiveGlobalRule(user.id, 'hold_seconds', 'Never hold a position longer than 60 seconds.');
    await insertActiveGlobalRule(user.id, 'held_past_stop', 'Never hold a position past its stop.');
    await insertActiveGlobalRule(user.id, 'weekly_review_completed', 'Complete your weekly review every week.');

    await loginAs(page, user.email);
    await page.goto('/rules/new');
    await expect(page.getByText("You're already at your rule limit", { exact: false })).toBeVisible();

    await page.selectOption('#operand-picker', 'risk_pct');
    await expect(page.getByRole('button', { name: 'Add rule' })).toBeDisabled();

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-e2e-at-cap.png', fullPage: true });

    // No fourth rule silently created despite the visible, disabled control.
    const rows = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
    expect(rows.rows[0].n).toBe(3);
  });

  test('failure path: two global rules on the same operand that can never both be satisfied are rejected with the conflicting rule named', async ({
    page,
  }) => {
    const user = await createConfirmedUser('editor-unsat');
    cleanupUserIds.push(user.id);

    // Not authorable through THIS editor (a single-operator picker can
    // never itself produce two conflicting operators on one operand) --
    // seeded directly so the pre-existing global rule is a `gte` this
    // editor's own `risk_pct` (`lte`-only) submission can genuinely
    // contradict, proving `RULE_UNSATISFIABLE` really is wired end-to-end
    // for a `scope: 'global'`-only screen, not just theoretically reachable.
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, 'global', null, 'soft', 'authored', 'pre_entry', 'active') returning id`,
      [user.id],
    );
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, 'risk_pct', 'gte', '3'::jsonb, 'Never risk more than 3% per trade (gte, seeded for this test).')`,
      [ruleRes.rows[0].id, user.id],
    );

    await loginAs(page, user.email);
    await page.goto('/rules/new');
    await page.selectOption('#operand-picker', 'risk_pct');
    // Default seed (bounds midpoint 2.6%) is `lte 2.6`, which IS
    // contradictory with the seeded `gte 3` rule (no value could ever be
    // both <= 2.6 and >= 3).
    await page.getByRole('button', { name: 'Add rule' }).click();

    await expect(page.getByText('can never be satisfied', { exact: false })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-e2e-unsatisfiable.png', fullPage: true });

    // Rejected, not written -- still exactly the one seeded rule.
    const rows = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
    expect(rows.rows[0].n).toBe(1);
  });
});
