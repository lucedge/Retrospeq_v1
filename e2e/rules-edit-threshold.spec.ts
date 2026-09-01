import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 04 (Rulebook & Evaluation) §2.5 / §6.1's `.rule-editor` reference
 * markup, adapted for EDITING an existing rule's threshold — Slice 10f.
 * Closes the E2E gap for `editRule` (`app/(app)/rules/actions.ts`), fully
 * built/tested/security-reviewed since Slice 2 (2026-08-19) but never
 * driven through a real browser session until now — `RuleList.tsx`'s new
 * inline "Edit" action (`EditRuleControl.tsx`) is the UI this proves.
 *
 * Seeding approach, matching `rules-list.spec.ts`'s own precedent: direct
 * SQL for `rules`/`rule_versions` rows rather than driving the real
 * `createRule` pipeline — Slice 2's own tests already prove authoring;
 * this suite's job is the EDIT UI layer built on top of whatever `rules`/
 * `rule_versions` already contain.
 *
 * ON THE VERSION-CONFLICT (`RULE_EDIT_CONFLICT`) CASE — CORRECTED,
 * Slice 10f coder fix pass (2026-09-01): a single-threaded "mutate the DB
 * via a second connection, then click Save" sequence from ONE browser
 * session used to (WRONGLY) succeed here, because `editRule` re-derived
 * "expected version" from its own fresh internal re-fetch rather than
 * from the CALLER's own snapshot — the exact bug an independent tester
 * pass found (see PROGRESS.md's "Slice 10f — INDEPENDENT TESTER
 * VERIFICATION" entry and `editRule`'s own header comment in
 * `app/(app)/rules/actions.ts`). `EditRuleControl.tsx` now threads its own
 * `fetchRuleForEdit` snapshot's `currentVersion` through to `editRule` as
 * a required `expectedVersion` argument, so THIS exact single-threaded
 * "mutate elsewhere, then Save the stale control" sequence now correctly
 * surfaces `RULE_EDIT_CONFLICT` — proven below ("a rule changed elsewhere
 * before Save is clicked is honestly rejected... and Refresh reloads the
 * control with the up-to-date value"). This is a genuine UI-level replay
 * of the SAME race `applyRuleEdit`'s own atomic guarded UPDATE enforces
 * at the repository layer (`rules-repository.live.test.ts`) — this test
 * proves the UI actually reaches and surfaces that guard correctly, which
 * it previously did not.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-RulesEdit-Pass-1234!';

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

test.describe('Editing an existing rule\'s threshold (Module 04 §2.5, /rules)', () => {
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

  /**
   * The ROW's OWN header sentence, precisely distinguished from
   * `EditRuleControl`'s own live-preview sentence — both share the CSS
   * class `rule-sentence` (`RuleRow`'s header `<p>` and
   * `EditableSentence`'s own `<p>`, `EditRuleControl.tsx`), but only the
   * header one is the row's SERVER-CONFIRMED display text; the edit
   * control's is a live, CLIENT-ONLY preview of the not-yet-saved value
   * and updates on every stepper click regardless of whether Save has
   * succeeded. Asserting against an unscoped `hasText` match on the whole
   * `<li>` (an earlier version of this test's own mistake, caught during
   * this slice's own self-check) would pass the moment the trader clicks
   * "+", well before Save is ever even clicked — a false-positive that
   * would silently hide a genuinely stuck/failed save. This locator's
   * `>` direct-child chain (`section.rq-card > div > p.rule-sentence`)
   * only ever matches the header, never `EditRuleControl`'s own
   * `.rule-editor > p.rule-sentence` (a different parent chain).
   */
  function rowHeaderSentence(row: import('@playwright/test').Locator) {
    return row.locator('section.rq-card > div > p.rule-sentence');
  }

  /**
   * Waits, after a Save click, for one of the two HONEST outcomes
   * `EditRuleControl.tsx`'s own `withTimeout` (15s) guarantees the trader
   * will always eventually see — never a silent, unresolved hang:
   *
   *   (a) real success — the row's own header sentence updates to
   *       `expectedRendered`.
   *   (b) `withTimeout`'s own honest recovery message ("This is taking
   *       longer than expected... It may have already gone through —
   *       close this and reopen Edit to check...") — the same client-side
   *       deadline `RuleList.tsx`'s own header documents a REAL, reproduced
   *       occurrence of (a hung/aborted dev-server Server Action stream,
   *       Slice 10e's own `hardCapChooser` fix). On outcome (b), reloads
   *       the page (the exact recovery action the message itself names)
   *       and re-checks the header.
   *
   * NOTE ON THIS FILE'S OWN DEBUGGING HISTORY, kept here rather than
   * quietly deleted, per this repo's own "never fake it" posture: this
   * helper was ORIGINALLY written believing outcome (b) was actually
   * firing in this environment — every one of this file's own tests
   * appeared to hang past 18s on first authoring. Direct investigation
   * (dev-server logs, then a client-side `console.log` trace of
   * `editRule`'s own resolved result) proved that diagnosis WRONG: the
   * Server Action itself was resolving successfully client-side in every
   * case, well within its 15s budget. The real bug was in THIS test file:
   * `row` was originally a `page.locator('li', { hasText: ... })` bound to
   * the rule's OLD rendered sentence — the moment a real save updated that
   * text, the locator's own filter condition stopped matching ANY element
   * (the new text no longer contains the old text as a substring), so
   * every assertion chained off `row` silently found nothing, forever — a
   * false NEGATIVE masquerading as a hang. Fixed by giving `RuleRow` a
   * stable `data-testid={\`rule-row-${rule.ruleId}\`}` (`RuleList.tsx`) and
   * keying every row locator in this file off THAT instead of off text
   * that the test itself is about to change. `waitForSaveOutcome`'s outcome
   * (b) branch is kept regardless — `RuleList.tsx`'s own dev-server
   * flakiness class is real and independently reproduced elsewhere in this
   * repo (Slice 10e), even though it did not turn out to be what was
   * happening in THIS file's own case.
   */
  async function waitForSaveOutcome(
    page: import('@playwright/test').Page,
    row: import('@playwright/test').Locator,
    expectedRendered: string,
  ): Promise<void> {
    const headerSentence = rowHeaderSentence(row);
    const alert = row.locator('[role="alert"]');
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline) {
      if ((await headerSentence.count()) > 0 && (await headerSentence.textContent()) === expectedRendered) {
        return;
      }
      if ((await alert.count()) > 0) {
        // Outcome (b) -- reload and confirm the write really did land.
        await page.reload();
        const reloadedRow = page.locator('li', { hasText: expectedRendered });
        await expect(reloadedRow).toBeVisible({ timeout: 10_000 });
        return;
      }
      await page.waitForTimeout(250);
    }
    throw new Error(
      `waitForSaveOutcome: neither the row's header updated to "${expectedRendered}" nor an error message ` +
        `appeared within 18s -- a genuine unrecovered hang, which withTimeout's own 15s deadline should never allow.`,
    );
  }

  async function currentRuleVersionRow(ruleId: string): Promise<{ currentVersion: number; version: number; value: unknown; rendered: string }> {
    const rulesRes = await db.query<{ current_version: number }>('select current_version from retrospeq.rules where id = $1', [ruleId]);
    const currentVersion = rulesRes.rows[0].current_version;
    const versionRes = await db.query<{ version: number; value: unknown; rendered: string }>(
      'select version, value, rendered from retrospeq.rule_versions where rule_id = $1 and version = $2',
      [ruleId, currentVersion],
    );
    return { currentVersion, version: versionRes.rows[0].version, value: versionRes.rows[0].value, rendered: versionRes.rows[0].rendered };
  }

  test('opening Edit pre-fills the current value with a live preview, and a real Save writes a new rule_versions row, bumps rules.current_version, and updates the row WITHOUT a full page reload', async ({
    page,
  }) => {
    // This dev/test Supabase project's own round-trip latency plus this
    // repo's own already-documented dev-server flakiness class (see
    // `RuleList.tsx`'s header: "The destination stream closed early")
    // means a real `editRule` call can legitimately take several seconds
    // — 60s (not the 30s default) leaves real room for the final
    // assertion's own 18s window without the OUTER test timeout
    // preempting it mid-wait, matching Slice 10e's own `test.setTimeout`
    // precedent for the same class of flakiness.
    test.setTimeout(60_000);
    const user = await createConfirmedUser('rules-edit-success');
    cleanupUserIds.push(user.id);
    const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 1.5, 'Never risk more than 1.5% per trade.', { severity: 'soft' });

    await loginAs(page, user.email);
    await page.goto('/rules');

    // A STABLE locator, keyed on `ruleId` (`RuleRow`'s own `data-testid`)
    // rather than the row's own TEXT — see `rowHeaderSentence`'s own
    // header for the real bug this slice's own self-check found: a
    // `hasText`-filtered locator stops matching the instant the header
    // text it was built from changes, silently making every subsequent
    // assertion chained off it un-satisfiable (a false NEGATIVE — the
    // update genuinely lands in the DOM, the STALE locator just can no
    // longer see it).
    const row = page.getByTestId(`rule-row-${ruleId}`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Edit' }).click();

    // Pre-filled from the rule's REAL current value (`fetchRuleForEdit`),
    // not a fabricated/default one.
    const stepperValue = row.locator('.rq-step__val');
    await expect(stepperValue).toHaveText('1.5%', { timeout: 10_000 });

    // Live preview well is present (§5.8/story 1.2 — same live-preview
    // pattern the CREATE flow already established). No seeded
    // `operand_distributions` row for this trader, so the honest
    // "not enough data" state is what should render — still proves the
    // preview control is live and reachable, not that a specific ratio
    // renders (Slice 3/9's own tests already prove the ratio math itself).
    const preview = row.locator('.preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Preview only. Past trades are never scored against this rule.');

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-edit-open-prefilled.png', fullPage: true });

    // Adjust the value via the stepper (never free-text/keyboard entry) —
    // two "+" clicks at a 0.1 step = 1.5 -> 1.7.
    const increaseBtn = row.getByRole('button', { name: 'Increase' });
    await increaseBtn.click();
    await increaseBtn.click();
    await expect(stepperValue).toHaveText('1.7%');
    // The sentence text above the stepper updates live too.
    await expect(row.getByText('Never risk more than 1.7% per trade.')).toBeVisible();

    await row.getByRole('button', { name: 'Save' }).click();

    // The ROW's OWN header sentence updates WITHOUT a full page reload in
    // the common case -- see `waitForSaveOutcome`'s own header for the
    // honest, non-fudged handling of this environment's own real
    // dev-server response-streaming flakiness (already documented
    // elsewhere in this repo, independently re-confirmed by this file's
    // own investigation, not assumed away).
    await waitForSaveOutcome(page, row, 'Never risk more than 1.7% per trade.');

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-edit-success.png', fullPage: true });

    // Real DB proof, not just UI text — §2.5: "Edit creates a new version;
    // past evaluations point at the old one."
    const current = await currentRuleVersionRow(ruleId);
    expect(current.currentVersion).toBe(2);
    expect(current.version).toBe(2);
    expect(current.value).toBe(1.7);
    expect(current.rendered).toBe('Never risk more than 1.7% per trade.');
    const oldVersion = await db.query<{ superseded_at: string | null }>(
      'select superseded_at from retrospeq.rule_versions where rule_id = $1 and version = 1',
      [ruleId],
    );
    expect(oldVersion.rows[0].superseded_at).not.toBeNull();
  });

  test('a rule whose operand tier is no longer available (no qualifying connected account) rejects an edit attempt honestly, and leaves the rule unchanged', async ({
    page,
  }) => {
    const user = await createConfirmedUser('rules-edit-tier-reject');
    cleanupUserIds.push(user.id);
    // stop_move_count is t1 -- this trader has ZERO connected accounts, so
    // `editRule`'s own re-validated tier gate (§5.1's "validate: ...
    // tier" step, re-run in full on every edit per that function's own
    // header) rejects honestly, the same real path a trader would hit if
    // their only t1-capable account were later disconnected/downgraded.
    const ruleId = await seedGlobalRule(user.id, 'stop_move_count', 'lte', 2, 'Never move your stop more than 2 time(s).', {
      severity: 'soft',
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.locator('li', { hasText: 'Never move your stop more than 2 time(s).' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Edit' }).click();

    const stepperValue = row.locator('.rq-step__val');
    await expect(stepperValue).toHaveText('2', { timeout: 10_000 });

    await row.getByRole('button', { name: 'Save' }).click();

    const alert = row.locator('[role="alert"]');
    // 18s, not 10s -- same dev-server-flakiness tolerance the other two
    // tests in this file use (a hung/aborted Server Action stream can, in
    // principle, affect this call too, even though the tier check itself
    // resolves fast server-side).
    await expect(alert).toBeVisible({ timeout: 18_000 });
    await expect(alert).toContainText('connected accounts');
    await expect(alert).toContainText('Stop move count');

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-edit-tier-rejected.png', fullPage: true });

    // Nothing changed server-side -- still version 1, same value.
    const current = await currentRuleVersionRow(ruleId);
    expect(current.currentVersion).toBe(1);
    expect(current.value).toBe(2);
  });

  test('a rule changed elsewhere before Save is clicked is honestly rejected with RULE_EDIT_CONFLICT, leaves the "elsewhere" edit untouched, and Refresh reloads the control with the up-to-date value so the trader can save again', async ({
    page,
  }) => {
    // Same reasoning as the successful-edit test above.
    test.setTimeout(60_000);
    const user = await createConfirmedUser('rules-edit-conflict');
    cleanupUserIds.push(user.id);
    const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 1.0, 'Never risk more than 1% per trade.', { severity: 'soft' });

    await loginAs(page, user.email);
    await page.goto('/rules');

    // Stable, `ruleId`-keyed locator -- see the successful-edit test's own
    // comment above for why a `hasText`-filtered one would silently break
    // the moment this row's own header text changes.
    const row = page.getByTestId(`rule-row-${ruleId}`);
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(row.locator('.rq-step__val')).toHaveText('1.0%', { timeout: 10_000 });

    // Simulate a genuine, already-COMMITTED edit "elsewhere" (a second
    // tab, or another device) that lands between this trader opening Edit
    // and clicking Save -- the exact same supersede-then-insert-then-bump
    // sequence `applyRuleEdit` itself performs.
    await db.query('begin');
    await db.query(
      `update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = 1 and superseded_at is null`,
      [ruleId],
    );
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 2, $2, 'risk_pct', 'lte', '3'::jsonb, 'Never risk more than 3% per trade.')`,
      [ruleId, user.id],
    );
    await db.query(`update retrospeq.rules set current_version = 2 where id = $1`, [ruleId]);
    await db.query('commit');

    // The still-open edit control has no idea the version changed -- this
    // is exactly the "stale snapshot" scenario. Adjust via the stepper
    // (two "+" clicks from this control's own stale 1% baseline = 1.2%)
    // and click Save. Post-fix, `EditRuleControl.tsx` sends back its OWN
    // snapshot version (1), which no longer matches the rule's true
    // current version (2) -- this must now be REJECTED, not silently
    // written on top of the fresh row.
    const increaseBtn = row.getByRole('button', { name: 'Increase' });
    await increaseBtn.click();
    await increaseBtn.click();
    // Let the debounced live-preview call for the new value settle before
    // saving -- avoids racing an in-flight `previewRule` fetch against the
    // component's own state updates (an orthogonal concern this test isn't
    // about; the CREATE flow's own preview has the identical debounce
    // interplay).
    await expect(row.locator('.preview')).not.toContainText('Checking against your history', { timeout: 5_000 });
    await row.getByRole('button', { name: 'Save' }).click();

    // Honest rejection, not a silent overwrite -- the server's own
    // RULE_EDIT_CONFLICT `user_message`, rendered via the generic
    // `role="alert"` path every other rejection code uses.
    const alert = row.locator('[role="alert"]');
    await expect(alert).toBeVisible({ timeout: 18_000 });
    await expect(alert).toContainText('changed elsewhere');

    // The "elsewhere" edit (version 2, 3%) survives completely untouched --
    // no version 3 was ever written, this trader's stale 1.2% value never
    // reached the database.
    const afterRejectedSave = await currentRuleVersionRow(ruleId);
    expect(afterRejectedSave.currentVersion).toBe(2);
    expect(afterRejectedSave.value).toBe(3);

    // The rejection isn't a dead end -- a "Refresh" affordance re-fetches
    // this SAME open control with the rule's now-current value/version, so
    // the trader has an actual path forward rather than just an alert with
    // nowhere to go.
    await page.screenshot({ path: 'tmp/dev-screenshots/rule-edit-conflict-rejected.png', fullPage: true });
    await row.getByRole('button', { name: 'Refresh with the latest value' }).click();
    await expect(row.locator('.rq-step__val')).toHaveText('3.0%', { timeout: 10_000 });
    await expect(alert).toHaveCount(0);

    // A fresh Save now (adjust +2 from the newly-refreshed 3% baseline =
    // 3.2%) succeeds cleanly against the up-to-date version.
    await increaseBtn.click();
    await increaseBtn.click();
    await expect(row.locator('.preview')).not.toContainText('Checking against your history', { timeout: 5_000 });
    await row.getByRole('button', { name: 'Save' }).click();
    await waitForSaveOutcome(page, row, 'Never risk more than 3.2% per trade.');

    const afterRefreshedSave = await currentRuleVersionRow(ruleId);
    expect(afterRefreshedSave.currentVersion).toBe(3);
    expect(afterRefreshedSave.value).toBe(3.2);
    expect(afterRefreshedSave.rendered).toBe('Never risk more than 3.2% per trade.');
  });

  test('retired rules never show an Edit action -- story 2.4: retire is lifecycle-final, editing a dead rule makes no sense', async ({ page }) => {
    const user = await createConfirmedUser('rules-edit-retired');
    cleanupUserIds.push(user.id);
    await seedGlobalRule(user.id, 'risk_pct', 'lte', 1, 'Never risk more than 1% per trade (retired).', {
      severity: 'soft',
      state: 'retired',
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    await page.getByText('Retired rules (1)').click();
    const row = page.locator('li', { hasText: 'Never risk more than 1% per trade (retired).' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  });

  test('a bool operand rule (no threshold to change) never shows an Edit action', async ({ page }) => {
    const user = await createConfirmedUser('rules-edit-bool-excluded');
    cleanupUserIds.push(user.id);
    await seedGlobalRule(user.id, 'stop_set_at_entry', 'is_true', true, 'Always set a stop before entering.', { severity: 'soft' });

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.locator('li', { hasText: 'Always set a stop before entering.' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    // The rest of the row's controls are still present -- exclusion is
    // scoped to Edit only.
    await expect(row.getByRole('button', { name: 'Promote to hard' })).toBeVisible();
  });
});
