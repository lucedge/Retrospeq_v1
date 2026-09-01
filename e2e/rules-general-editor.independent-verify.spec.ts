import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 04 Slice 10b (general rule editor, CREATE flow, /rules/new) —
 * INDEPENDENT tester verification, dispatched separately from the coder's
 * own pass and from `e2e/rules-general-editor.spec.ts` (the coder's own
 * E2E suite). Fresh fixtures throughout — different operands and values
 * than every one of the coder's own tests (`risk_pct`/`gte 3`/`lte 2.6`,
 * `stop_set_at_entry`, `hold_seconds`/`held_past_stop`/
 * `weekly_review_completed`) — per this repo's own established
 * independent-verification convention (see Slice 10a's own
 * `.independent-verify.spec.ts`).
 *
 * Covers the specific gaps flagged in this slice's own dispatch:
 *   - RULE_UNSATISFIABLE, re-derived with a genuinely different
 *     operand/value pair (`correlated_exposure`, not `risk_pct`).
 *   - `operand_not_computable`, exercised for the first time through THIS
 *     screen (the coder's own E2E suite never selected a non-distribution-
 *     backed operand) via `total_open_risk`.
 *   - Tier-gating defense-in-depth: a tier-excluded operand
 *     (`stop_moved_against`, t1) is injected directly into the DOM
 *     `<select>` (bypassing the real picker's own filtering entirely) and
 *     submitted through the REAL `createRule` action, proving the server
 *     itself independently rejects it — the client-side filter is not the
 *     only defense.
 *   - The double-submit race the coder's own write-up did not examine: a
 *     genuine two-click (dispatched synchronously, zero delay) on the
 *     single "Add rule" button, checked against the real free-tier
 *     `rules.create` cap of 3 for an over-cap write.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-RuleEditor-IndepVerify-Pass-9876!';

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

test.describe('General rule editor (Module 04 §6.1, /rules/new) — independent verification', () => {
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

  async function insertActiveGlobalRule(userId: string, operandId: string, op: string, value: unknown, rendered: string): Promise<void> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, 'global', null, 'soft', 'authored', 'pre_entry', 'active') returning id`,
      [userId],
    );
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, $4, $5::jsonb, $6)`,
      [ruleRes.rows[0].id, userId, operandId, op, JSON.stringify(value), rendered],
    );
  }

  test('RULE_UNSATISFIABLE — a genuinely different operand/value pair than the coder\'s own E2E (correlated_exposure, not risk_pct) is rejected end-to-end with zero row written', async ({ page }) => {
    const user = await createConfirmedUser('indep-unsat');
    cleanupUserIds.push(user.id);

    // Seeded directly (not authorable through this single-operator picker,
    // same reasoning as the coder's own equivalent test) -- a `gte 6` rule
    // this editor's own `correlated_exposure` (`lte`-only) default submission
    // genuinely contradicts.
    await insertActiveGlobalRule(
      user.id,
      'correlated_exposure',
      'gte',
      6,
      'Never let correlated exposure fall below 6% of your account (gte, seeded for this independent-verify test).',
    );

    await loginAs(page, user.email);
    await page.goto('/rules/new');
    await page.selectOption('#operand-picker', 'correlated_exposure');

    // bounds {min:0.5, max:10, step:0.5} -> midpoint default is 5.5%,
    // independently hand-computed here (not copy-pasted from the coder's
    // own fixture): (0.5+10)/2 = 5.25, rounded to the nearest 0.5 step (via
    // HALF_UP on steps-from-min) = 5.5. `lte 5.5` is contradictory with the
    // seeded `gte 6` rule (no value can be both <= 5.5 and >= 6).
    await expect(page.locator('.rq-step__val')).toHaveText('5.5%');

    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByText('can never be satisfied', { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('correlated exposure fall below 6%', { exact: false })).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-independent-verify-unsatisfiable.png', fullPage: true });

    const rows = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
    expect(rows.rows[0].n).toBe(1); // only the seeded rule -- the rejected candidate wrote nothing
  });

  test('operand_not_computable — a real non-distribution-backed offerable operand (total_open_risk) genuinely shows the honest "not available" preview state through THIS screen, and the rule can still be saved despite it', async ({ page }) => {
    const user = await createConfirmedUser('indep-notcomputable');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.goto('/rules/new');
    await page.selectOption('#operand-picker', 'total_open_risk');
    await expect(page.getByText('Never let your total open risk exceed', { exact: false })).toBeVisible();

    // Distinct, honest copy -- NOT the "No history yet" insufficient_history
    // message (a data-volume gap), because this is a builder-scope gap:
    // `total_open_risk` is not in DISTRIBUTION_OPERAND_IDS at all, regardless
    // of trade count.
    await expect(page.getByText("Preview isn't available for \"Total open risk\" yet", { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('can still be saved and evaluated once that support ships', { exact: false })).toBeVisible();
    await expect(page.getByText('No history yet', { exact: false })).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-independent-verify-not-computable.png', fullPage: true });

    // Saving still works -- an unpreviewable rule is never blocked from
    // being authored (Module 04 §10: "A rule that cannot be evaluated is
    // never an error to the user").
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
    expect(rows.rows[0].operand_id).toBe('total_open_risk');
    expect(rows.rows[0].op).toBe('lte');
  });

  test('tier-gating defense-in-depth: a t1 operand injected directly into the DOM select (bypassing the real picker entirely) is still genuinely rejected by the real server-side createRule action for a trader with zero connected accounts', async ({ page }) => {
    const user = await createConfirmedUser('indep-tierbypass');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.goto('/rules/new');

    // Confirm the real picker genuinely never offers it (belt) --
    // independently re-confirming the unit-level `getEditableOperands`
    // claim against the REAL rendered DOM, not just the pure function.
    await expect(page.locator('option[value="stop_moved_against"]')).toHaveCount(0);
    await expect(page.locator('option[value="stop_move_count"]')).toHaveCount(0);

    // Now bypass the picker outright -- inject an option the server never
    // sent, select it, and submit through the REAL createRule Server
    // Action. If the picker were the ONLY defense, this would silently
    // succeed.
    await page.evaluate(() => {
      const select = document.querySelector('#operand-picker') as HTMLSelectElement;
      const opt = document.createElement('option');
      opt.value = 'stop_moved_against';
      opt.textContent = 'Moving your stop (injected -- bypass test, not a real offered option)';
      select.appendChild(opt);
    });
    await page.selectOption('#operand-picker', 'stop_moved_against');
    await expect(page.getByText('Never move your stop against the position.')).toBeVisible();

    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(
      page.getByText('None of your connected accounts report enough data for "Moving your stop" yet', { exact: false }),
    ).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-independent-verify-tier-bypass-rejected.png', fullPage: true });

    const rows = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
    expect(rows.rows[0].n).toBe(0); // rejected server-side -- zero rows, despite bypassing the client picker
  });

  test('double-submit race: two genuinely concurrent clicks on the single "Add rule" button never push the trader past the free-tier rules.create cap of 3', async ({ page }) => {
    const user = await createConfirmedUser('indep-doubleclick');
    cleanupUserIds.push(user.id);

    // Seed exactly 2 pre-existing active global rules (distinct operands
    // from the one under test, `giveback_from_peak`, which is fresh to
    // this whole verification pass) -- one successful submission through
    // this screen legitimately reaches the cap of 3; a race that lets a
    // SECOND concurrent call also succeed would push the trader to 4,
    // silently exceeding "You're at 3 of 3 rules."
    await insertActiveGlobalRule(user.id, 'weekly_review_completed', 'is_true', true, 'Complete your weekly review every week.');
    await insertActiveGlobalRule(user.id, 'first_time_instrument', 'is_false', true, 'Never trade an instrument for the first time (seeded).');

    await loginAs(page, user.email);
    await page.goto('/rules/new');
    await page.selectOption('#operand-picker', 'giveback_from_peak');
    await expect(page.getByText("Stop trading once you've given back", { exact: false })).toBeVisible();

    const addButton = page.getByRole('button', { name: 'Add rule' });
    await expect(addButton).toBeEnabled();

    // Two `.click()` calls dispatched back-to-back in the SAME synchronous
    // browser task -- the worst-case race window, tighter than any real
    // double-click, and specifically chosen to test whether React's
    // `disabled={phase === 'submitting'}` re-render genuinely lands between
    // the two clicks or not. If `createRule` has no server-side atomic
    // guard on `rules.create`'s count (an unguarded read-then-insert, per
    // `lib/entitlements/rules-usage.ts`'s `countActiveRules` +
    // `lib/rules/rules-repository.ts`'s `insertRuleAndVersion` -- confirmed
    // by direct source inspection, no `pg_advisory_xact_lock` the way
    // Slice 7's `promoteRuleSeverity` fix added for the analogous
        // `rules.hard` cap), both clicks can independently pass the
    // entitlement check before either write commits.
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim().startsWith('Add rule')) as HTMLButtonElement;
      btn.click();
      btn.click();
    });

    // Give both requests time to fully resolve either way (success or
    // error) before reading the DB.
    await page.waitForTimeout(6_000);
    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-independent-verify-double-submit-race.png', fullPage: true });

    const rows = await db.query<{ id: string; op: string; value: string }>(
      `select r.id, rv.op, rv.value
         from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.user_id = $1 and rv.operand_id = 'giveback_from_peak'`,
      [user.id],
    );
    const totalRows = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);

    console.log(
      `[double-submit race] giveback_from_peak rows written: ${rows.rows.length}; total active rules for this user: ${totalRows.rows[0].n} (cap is 3)`,
    );

    // The invariant this test is actually checking: the free-tier cap of 3
    // is NEVER exceeded, regardless of how many of the two racing clicks
    // "succeeded" client-side.
    expect(totalRows.rows[0].n).toBeLessThanOrEqual(3);
    expect(rows.rows.length).toBeLessThanOrEqual(1);
  });

  test('cross-tab double-submit: two SEPARATE browser contexts (no shared React state, so the single-tab disabled-button guard cannot apply) racing the exact same createRule submission must still never exceed the free-tier cap of 3', async ({ browser }) => {
    const user = await createConfirmedUser('indep-crosstab-race');
    cleanupUserIds.push(user.id);

    await insertActiveGlobalRule(user.id, 'weekly_review_completed', 'is_true', true, 'Complete your weekly review every week.');
    await insertActiveGlobalRule(user.id, 'first_time_instrument', 'is_false', true, 'Never trade an instrument for the first time (seeded).');

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await loginAs(pageA, user.email);
      await loginAs(pageB, user.email);

      await pageA.goto('/rules/new');
      await pageB.goto('/rules/new');
      await pageA.selectOption('#operand-picker', 'giveback_from_peak');
      await pageB.selectOption('#operand-picker', 'giveback_from_peak');
      await expect(pageA.getByRole('button', { name: 'Add rule' })).toBeEnabled();
      await expect(pageB.getByRole('button', { name: 'Add rule' })).toBeEnabled();

      // Two genuinely independent browser contexts -- no shared React
      // `phase` state, so the single-tab `disabled={phase==='submitting'}`
      // guard the previous test empirically found to be effective cannot
      // help here at all. This is the realistic "two tabs" / "double
      // network client" scenario `createRule`'s own unguarded
      // read-count-then-insert (`countActiveRules` +
      // `insertRuleAndVersion`, no advisory lock, confirmed by direct
      // source inspection) would actually be exposed to.
      await Promise.all([
        pageA.getByRole('button', { name: 'Add rule' }).click(),
        pageB.getByRole('button', { name: 'Add rule' }).click(),
      ]);

      await pageA.waitForTimeout(6_000);
      console.log('[cross-tab race] pageA body snippet:', (await pageA.locator('body').innerText()).slice(0, 400));
      console.log('[cross-tab race] pageB body snippet:', (await pageB.locator('body').innerText()).slice(0, 400));

      const totalRows = await db.query('select count(*)::int as n from retrospeq.rules where user_id = $1', [user.id]);
      const gfpRows = await db.query(
        `select count(*)::int as n from retrospeq.rules r
           join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
          where r.user_id = $1 and rv.operand_id = 'giveback_from_peak'`,
        [user.id],
      );
      console.log(
        `[cross-tab race] giveback_from_peak rows written: ${gfpRows.rows[0].n}; total active rules: ${totalRows.rows[0].n} (cap is 3)`,
      );

      if (totalRows.rows[0].n > 3) {
        await pageA.screenshot({ path: 'tmp/dev-screenshots/rule-editor-independent-verify-crosstab-race-BUG.png', fullPage: true });
      }

      expect(totalRows.rows[0].n).toBeLessThanOrEqual(3);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('screenshot: a real "flagged" preview state (healthy band) rendered through this screen, distinct from insufficient_history and the loading skeleton', async ({ page }) => {
    const user = await createConfirmedUser('indep-flagged-shot');
    cleanupUserIds.push(user.id);

    // A real, schema-valid operand_distributions row inserted directly
    // (same rationale as Slice 10a's own independent-verify screenshot
    // test: the recompute pipeline's correctness is proven elsewhere by
    // live-DB tests, not this screenshot; `server-only`-guarded modules
    // cannot be imported from a plain-Node Playwright process). Hand-
    // computed flagged count: risk_pct <= 2.6 (this operand's own bounds-
    // midpoint default) -- value 1.0 (16 trades, followed, <= 2.6) + value
    // 4.0 (4 trades, broken, > 2.6) => flagged = 4, n = 20, ratio = 0.2,
    // inside the 0.06-0.35 "healthy" band.
    await db.query(
      `insert into retrospeq.operand_distributions (user_id, operand_id, buckets, n)
       values ($1, 'risk_pct', $2::jsonb, 20)`,
      [user.id, JSON.stringify([{ value: 1.0, count: 16 }, { value: 4.0, count: 4 }])],
    );

    await loginAs(page, user.email);
    await page.goto('/rules/new');
    await page.selectOption('#operand-picker', 'risk_pct');
    await expect(page.locator('.rq-step__val')).toHaveText('2.6%');

    await expect(page.locator('.preview__count')).toHaveText('4', { timeout: 10_000 });
    await expect(page.getByText('Tight enough to matter, loose enough to keep.')).toBeVisible();

    // .rq-num on the stepper value AND the preview count -- no exceptions.
    await expect(page.locator('.rq-step__val.rq-num')).toHaveCount(1);
    await expect(page.locator('.preview__count.rq-num')).toHaveCount(1);

    // Exactly one primary .rq-btn while editing; no red/green class names
    // anywhere in the rendered markup (grep the actual class list, not
    // just eyeball the screenshot).
    await expect(page.locator('button.rq-btn:not(.rq-btn--ghost)')).toHaveCount(1);
    const classNames = await page
      .locator('[class]')
      .evaluateAll((els) => els.flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/)));
    expect(classNames.some((c) => /success|danger|red|green/i.test(c))).toBe(false);

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-editor-independent-verify-flagged.png', fullPage: true });
  });

  // NOTE: an attempt was made here to also prove free-tier cap
  // defense-in-depth by removing the submit button's `disabled` attribute
  // via raw DOM manipulation and forcing a `.click()`, mirroring the
  // tier-gating bypass test above. That attempt is DELIBERATELY NOT
  // included: it produced inconclusive, environment-specific results (the
  // native click event demonstrably fired -- confirmed via a capture-phase
  // listener -- but no corresponding `createRule` network call was ever
  // observed, and dev-mode HMR reconnected mid-test, a plausible
  // confound). Rather than ship a misleading/flaky test, this gap is left
  // HONESTLY OPEN: the free-tier cap's defense-in-depth (server rejects
  // even if the client's disabled state were bypassed) is established here
  // by the CROSS-TAB race test above using ORDINARY clicks (no DOM
  // hacking) -- which is a strictly stronger, more realistic proof that
  // reached a real, reproducible finding (see that test's own comment).
  // The coder's own `rules-general-editor.spec.ts` at-cap test (disabled
  // button + honest message + zero rows) was independently re-run as part
  // of this pass's full-suite re-run and confirmed still passing.
});
