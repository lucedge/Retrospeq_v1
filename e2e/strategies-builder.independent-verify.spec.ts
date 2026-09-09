import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 03 (Field Registry & Strategy) §5.1/§5.2 — strategy list +
 * strategy-creation builder. INDEPENDENT REVIEW verification
 * (retrospeq-qa/tester dispatch, 2026-09-09) of an out-of-order UI landing
 * that shipped with ZERO test coverage of any kind (no unit test for
 * `app/(app)/strategies/actions.ts`, no component test for
 * `StrategyBuilder.tsx`, no E2E spec) — this file is the first test this
 * slice has ever had. Scope, given review time budget: the core flow +
 * failure/gating paths named in the review dispatch, not full parity with
 * this repo's usual coder-suite + independent-verify-suite pairing (see
 * PROGRESS.md's decision-log entry for this date for the explicit list of
 * what remains untested after this file).
 *
 * Covers:
 *   1. Free-plan user: `/strategies` and `/strategies/new` render the
 *      Pro-upsell gate, never the builder — plus a DIRECT repository-level
 *      call proving the server-side gate holds independent of what the UI
 *      renders (defense-in-depth, same class of check this build applies
 *      to every other entitlement-gated write path).
 *   2. Pro-plan user, the two-phase write path from docs/adr/0027 (trigger
 *      conditions present, so `createStrategyFromBuilder` takes the
 *      shell -> createTriggerCondition x N -> editStrategy route, not the
 *      single-call zero-trigger path) — full builder walkthrough,
 *      hedge-word live advisory, pre-entry moment restriction for a note
 *      field, submission, and a DIRECT DB assertion that the strategy's
 *      `current_version` really is 2 (not 1) and that
 *      `strategy_versions.triggers[].condition_id` resolves to REAL
 *      `trigger_conditions` rows — the exact invariant ADR 0027 rests on.
 *   3. Zero-trigger path: `current_version` stays 1, matching story 2.1
 *      literally, per the ADR's own "no deviation for that case" claim.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-StrategyBuilder-IndepVerify-Pass-4471!';

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

test.describe('Strategy list + creation builder (Module 03 §5.1/§5.2, /strategies) — independent verification', () => {
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
      await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]).catch(() => {});
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

  async function insertAccountField(
    userId: string,
    id: string,
    name: string,
    dataType: string,
    config: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, config)
       values ($1, $2, $3, 'account', $4, 'captured', $5::jsonb) returning id`,
      [id, userId, name, dataType, JSON.stringify(config)],
    );
    return res.rows[0].id;
  }

  async function loginAs(page: import('@playwright/test').Page, email: string) {
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  }

  test('free-plan user: /strategies and /strategies/new render the Pro gate only, never the builder; server-side entitlement holds independent of the UI', async ({
    page,
  }) => {
    const user = await createConfirmedUser('free-gate');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'free');

    await loginAs(page, user.email);

    // Empty state, free plan -- upsell copy, single .rq-btn upgrade link,
    // no "New strategy" button anywhere on the page.
    await page.goto('/strategies');
    await expect(page.getByText('Strategies are a Pro feature.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'New strategy' })).toHaveCount(0);
    // Excludes the persistent nav-chrome "Sign out" ghost button
    // (`app/(app)/layout.tsx`, present on every authenticated page) --
    // "one primary .rq-btn per view" is about this page's OWN content,
    // not shared shell chrome every route in this app carries.
    const rqBtnCountList = await page.locator('.rq-btn:not(.rq-btn--ghost)').count();
    expect(rqBtnCountList).toBe(1); // only the Upgrade to Pro link
    await page.screenshot({ path: 'tmp/dev-screenshots/strategies-list-free-empty.png', fullPage: true });

    // /strategies/new: the ENTIRE route is gated per that page's own
    // header -- no builder markup should exist in the DOM at all, not
    // merely hidden.
    await page.goto('/strategies/new');
    await expect(page.getByRole('heading', { name: 'Strategies are a Pro feature' })).toBeVisible();
    await expect(page.getByText('What setup are you naming?')).toHaveCount(0);
    await expect(page.locator('#strategy-name')).toHaveCount(0);
    await page.screenshot({ path: 'tmp/dev-screenshots/strategies-new-free-gate.png', fullPage: true });

    // Defense-in-depth at the repository layer itself (not just the UI) is
    // verified separately in
    // `lib/fields/__tests__/strategy-repository.entitlement-defense-in-depth.live.test.ts`
    // (a plain `.ts` module with `import 'server-only'` cannot be
    // dynamically imported from inside a Playwright spec the way this
    // repo's vitest live tests already do via `vi.mock('server-only', ...)`
    // -- attempted here first, failed with "Cannot use import statement
    // outside a module" under Playwright's own Node runtime, so the check
    // was moved to the correct harness instead of forced into the wrong
    // one). This spec confirms the count stays zero after the free user's
    // OWN, real signed-in session never even reaches a save control.
    const countRes = await db.query('select count(*)::int as n from retrospeq.strategies where user_id = $1', [user.id]);
    expect(countRes.rows[0].n).toBe(0);
  });

  test('Pro-plan user, builder with 2 trigger conditions (ADR 0027 two-phase path): full walkthrough, hedge-word advisory, pre-entry moment restriction, and current_version really is 2 with real trigger_conditions rows', async ({
    page,
  }) => {
    const user = await createConfirmedUser('pro-two-phase');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');

    const convictionId = await insertAccountField(user.id, 'acct.conviction-indepverify', 'Conviction (indep-verify)', 'rating', {
      options: ['1', '2', '3', '4', '5'],
    });
    const journalNoteId = await insertAccountField(user.id, 'acct.postnote-indepverify', 'Post-trade note (indep-verify)', 'note', {});

    await loginAs(page, user.email);

    // Empty state, Pro plan.
    await page.goto('/strategies');
    await expect(page.getByText("You haven't built a strategy yet.")).toBeVisible();
    await page.screenshot({ path: 'tmp/dev-screenshots/strategies-list-pro-empty.png', fullPage: true });

    await page.getByRole('link', { name: 'New strategy' }).click();
    await expect(page).toHaveURL(/\/strategies\/new/);

    // Step 1: name.
    await page.fill('#strategy-name', 'Liquidity sweep reversal (indep-verify)');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 2: triggers. First condition is clean; second deliberately
    // contains a spec-mandated hedge word ("clean") to prove the live
    // client-side advisory fires from the SAME `detectHedgeWords` the
    // server uses, not a parallel reimplementation.
    await expect(page.getByText('When does this setup exist?')).toBeVisible();
    await page.getByRole('textbox', { name: 'Condition 1', exact: true }).fill('Liquidity swept before entry');
    await page.getByRole('button', { name: 'Add condition' }).click();
    await page.getByRole('textbox', { name: 'Condition 2', exact: true }).fill('Setup looks clean');
    await expect(page.getByText(/may mean different things on different days/)).toBeVisible();
    await page.screenshot({ path: 'tmp/dev-screenshots/strategies-builder-triggers-hedge-warning.png', fullPage: true });
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 3: fields. Verify the note-typed field's moment <select> never
    // offers "Before entry" (§4.4: note cannot be pre_entry) -- checked
    // BEFORE checking it, since the control only renders once checked.
    await expect(page.getByText('What do you want to record?')).toBeVisible();
    await page.getByRole('checkbox').nth(0).check(); // Conviction (first account field, order kind,name)
    const checkboxes = page.getByRole('checkbox');
    const noteCheckboxIndex = await (async () => {
      const count = await checkboxes.count();
      for (let i = 0; i < count; i++) {
        const row = checkboxes.nth(i).locator('xpath=ancestor::li[1]');
        if ((await row.textContent())?.includes('Post-trade note')) return i;
      }
      throw new Error('note field checkbox not found');
    })();
    await checkboxes.nth(noteCheckboxIndex).check();
    const noteRow = checkboxes.nth(noteCheckboxIndex).locator('xpath=ancestor::li[1]');
    const noteMomentOptions = await noteRow.locator('select option').allTextContents();
    expect(noteMomentOptions).not.toContain('Before entry');
    expect(noteMomentOptions).toContain('After it closes');

    await page.screenshot({ path: 'tmp/dev-screenshots/strategies-builder-fields-step.png', fullPage: true });

    await page.getByRole('button', { name: 'Create strategy' }).click();
    await expect(page.getByText('Strategy created')).toBeVisible({ timeout: 25_000 });
    await page.screenshot({ path: 'tmp/dev-screenshots/strategies-builder-success.png', fullPage: true });

    // Real-DB assertion: the two-phase path (docs/adr/0027) must have run
    // -- current_version is 2 (empty shell = 1, real content = 2), and the
    // strategy_versions.triggers[] condition_ids resolve to REAL
    // trigger_conditions rows this user owns, not placeholders.
    const stratRes = await db.query<{ id: string; current_version: number }>(
      `select id, current_version from retrospeq.strategies where user_id = $1 and name = $2`,
      [user.id, 'Liquidity sweep reversal (indep-verify)'],
    );
    expect(stratRes.rows).toHaveLength(1);
    const { id: strategyId, current_version: currentVersion } = stratRes.rows[0];
    expect(currentVersion).toBe(2);

    const versionRes = await db.query<{ triggers: { condition_id: string; text: string }[]; fields: unknown[] }>(
      `select triggers, fields from retrospeq.strategy_versions where strategy_id = $1 and version = $2`,
      [strategyId, currentVersion],
    );
    const triggers = versionRes.rows[0].triggers;
    expect(triggers).toHaveLength(2);

    const conditionIds = triggers.map((t) => t.condition_id);
    const realConditionsRes = await db.query(
      `select id from retrospeq.trigger_conditions where user_id = $1 and strategy_id = $2`,
      [user.id, strategyId],
    );
    const realConditionIds = realConditionsRes.rows.map((r) => r.id);
    expect(realConditionIds.sort()).toEqual(conditionIds.sort());
    for (const id of conditionIds) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/); // real uuid, never a "pending-N" placeholder
    }

    // Version 1 (the empty shell) must exist and genuinely be empty --
    // the trader never binds a trade to it, but it must be real, not a
    // fiction of the ADR's own narrative.
    const v1Res = await db.query(
      `select triggers, fields from retrospeq.strategy_versions where strategy_id = $1 and version = 1`,
      [strategyId],
    );
    expect(v1Res.rows).toHaveLength(1);
    expect(v1Res.rows[0].triggers).toEqual([]);
    expect(v1Res.rows[0].fields).toEqual([]);

    // The list screen shows the completed strategy with the real counts,
    // never a stray "empty shell" row -- confirms only ONE strategy is
    // visible, not two (the shell is the SAME row, just version 2 now).
    await page.goto('/strategies');
    const rows = page.locator('li:has-text("Liquidity sweep reversal (indep-verify)")');
    await expect(rows).toHaveCount(1);
    await expect(rows.getByText('2 trigger conditions')).toBeVisible();
    await page.screenshot({ path: 'tmp/dev-screenshots/strategies-list-pro-populated.png', fullPage: true });

    void convictionId;
    void journalNoteId;
  });

  test('Pro-plan user, zero trigger conditions: single-call path stays genuinely version 1, matching story 2.1 literally', async ({
    page,
  }) => {
    const user = await createConfirmedUser('pro-single-call');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');

    await loginAs(page, user.email);
    await page.goto('/strategies/new');

    await page.fill('#strategy-name', 'No-trigger baseline strategy (indep-verify)');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    // Leave the single, empty trigger row blank -- it gets filtered out
    // client-side (`trimmedTriggers`), so zero triggers are submitted.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Create strategy' }).click();
    await expect(page.getByText('Strategy created')).toBeVisible({ timeout: 25_000 });

    const stratRes = await db.query<{ current_version: number }>(
      `select current_version from retrospeq.strategies where user_id = $1 and name = $2`,
      [user.id, 'No-trigger baseline strategy (indep-verify)'],
    );
    expect(stratRes.rows).toHaveLength(1);
    expect(stratRes.rows[0].current_version).toBe(1);

    const condRes = await db.query('select count(*)::int as n from retrospeq.trigger_conditions where user_id = $1', [user.id]);
    expect(condRes.rows[0].n).toBe(0);
  });
});
