import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 04 (Rulebook & Evaluation) story 1.1 / §6.1's rule list, plus
 * §5.7's severity lifecycle (promote/demote/retire) and the hard-cap swap
 * chooser — Slice 10e. This is the E2E proof for the UI gap PROGRESS.md's
 * own "Module 04 scope gap" entry named: Slice 7 (2026-08-25) built
 * `promoteRule`/`demoteRule`/`retireRule` as backend-only Server Actions
 * with no UI ever wired to them, and no test file ever drove them through
 * a real browser session either.
 *
 * Seeding approach, matching `rules-adherence.spec.ts`'s own precedent:
 * direct SQL for anything already proven elsewhere (`rules`/`rule_versions`
 * rows, `rule_evaluations` rows for the eligibility gates) rather than
 * driving the real confirm pipeline — Slice 5/6/7's own live tests already
 * prove the freeze/eligibility PIPELINE; this suite's job is the LIST/
 * CONTROLS layer built on top of whatever `rules`/`rule_evaluations`
 * already contain.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-RulesList-Pass-1234!';

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

test.describe('Rule list, severity lifecycle, and the hard-cap swap (Module 04 story 1.1 / §5.7, /rules)', () => {
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
    await page.waitForURL('**/', { timeout: 10_000 });
  }

  async function seedGlobalRule(
    userId: string,
    operandId: string,
    op: string,
    value: unknown,
    rendered: string,
    overrides: { severity?: 'soft' | 'hard'; state?: 'active' | 'retired'; createdAt?: Date } = {},
  ): Promise<string> {
    const createdAt = overrides.createdAt ?? new Date();
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state, created_at, promoted_at)
       values ($1, 1, 'global', null, $2, 'authored', 'pre_entry', $3, $4::timestamptz, case when $2 = 'hard' then $4::timestamptz else null end)
       returning id`,
      [userId, overrides.severity ?? 'soft', overrides.state ?? 'active', createdAt.toISOString()],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered, created_at)
       values ($1, 1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)`,
      [ruleId, userId, operandId, op, JSON.stringify(value), rendered, createdAt.toISOString()],
    );
    return ruleId;
  }

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier)
       values ($1, 'Rule List E2E', 'mt5', 'USD', '00:00:00 UTC', 't0')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(userId: string, accountId: string, serverDay: string): Promise<string> {
    const openedAt = new Date(`${serverDay}T09:00:00Z`);
    const closedAt = new Date(`${serverDay}T09:30:00Z`);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
       returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
          grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, 'closed',
               '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '1.000000', '1.000000', 'USD',
               'confident_single')
       returning id`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    return tradeRes.rows[0].id;
  }

  /**
   * An eligible soft rule: created 60 days ago (clears the 42-day/6-week
   * gate), 20 distinct real trades each with a `followed` evaluation dated
   * well outside the last-3-weeks window (100% compliance, zero recent
   * breaks) — clears every one of §5.7's four gates at once.
   */
  async function seedEligibleSoftRule(userId: string, accountId: string, operandId: string, rendered: string): Promise<string> {
    const ruleCreatedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const ruleId = await seedGlobalRule(userId, operandId, 'lte', 2, rendered, { severity: 'soft', createdAt: ruleCreatedAt });

    for (let i = 0; i < 20; i++) {
      const day = new Date(Date.now() - (55 - i) * 24 * 60 * 60 * 1000);
      const serverDay = day.toISOString().slice(0, 10);
      const tradeId = await seedTrade(userId, accountId, serverDay);
      await db.query(
        `insert into retrospeq.rule_evaluations (user_id, trade_id, rule_id, rule_version, severity, result, observed, server_day)
         values ($1, $2, $3, 1, 'soft', 'followed', '1'::jsonb, $4::date)`,
        [userId, tradeId, ruleId, serverDay],
      );
    }
    return ruleId;
  }

  test('the list renders a mix of active soft/hard rules and a collapsed retired section, with severity badges and no promote/demote controls on retired rows', async ({
    page,
  }) => {
    const user = await createConfirmedUser('rules-list-mixed');
    cleanupUserIds.push(user.id);

    await seedGlobalRule(user.id, 'risk_pct', 'lte', 1, 'Never risk more than 1% per trade.', { severity: 'soft' });
    await seedGlobalRule(user.id, 'total_open_risk', 'lte', 2, 'Never let your total open risk exceed 2%.', {
      severity: 'hard',
    });
    await seedGlobalRule(user.id, 'daily_loss_pct', 'lte', 3, "Never let today's loss exceed 3%.", {
      severity: 'soft',
      state: 'retired',
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    await expect(page.getByRole('heading', { name: 'Your rules' })).toBeVisible();

    const softRow = page.locator('li', { hasText: 'Never risk more than 1% per trade.' });
    await expect(softRow).toBeVisible();
    await expect(softRow.getByText('Soft', { exact: true })).toBeVisible();

    const hardRow = page.locator('li', { hasText: 'Never let your total open risk exceed 2%.' });
    await expect(hardRow).toBeVisible();
    await expect(hardRow.getByText('Hard', { exact: true })).toBeVisible();

    // Retired rule starts collapsed inside <details>, not shown as a plain row.
    await expect(page.getByText("Never let today's loss exceed 3%.")).not.toBeVisible();
    await expect(page.getByText('Retired rules (1)')).toBeVisible();
    await page.getByText('Retired rules (1)').click();
    await expect(page.getByText("Never let today's loss exceed 3%.")).toBeVisible();
    // No promote/demote controls anywhere in the retired section.
    const retiredRow = page.locator('li', { hasText: "Never let today's loss exceed 3%." });
    await expect(retiredRow.getByRole('button', { name: /Promote|Demote/ })).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-list-mixed.png', fullPage: true });
  });

  test('an eligible soft rule shows a working "Promote to hard" control, and a real promote flips its badge', async ({ page }) => {
    const user = await createConfirmedUser('rules-list-promote');
    cleanupUserIds.push(user.id);
    await db.query(
      `insert into retrospeq.subscriptions (user_id, plan, status) values ($1, 'pro', 'active')
       on conflict (user_id) do update set plan = 'pro', status = 'active'`,
      [user.id],
    ).catch(() => {}); // best-effort — some environments may seed this differently; the promote itself will surface a clear error if plan resolution fails.
    const accountId = await seedAccount(user.id);
    await seedEligibleSoftRule(user.id, accountId, 'risk_pct', 'Never risk more than 2% per trade.');

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.locator('li', { hasText: 'Never risk more than 2% per trade.' });
    await expect(row.getByText('Soft', { exact: true })).toBeVisible();
    const promoteBtn = row.getByRole('button', { name: 'Promote to hard' });
    await expect(promoteBtn).toBeEnabled();
    await promoteBtn.click();

    await expect(row.getByText('Hard', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(row.getByRole('button', { name: 'Demote to soft' })).toBeVisible();
    await expect(row.locator('[role="status"]', { hasText: 'Not yet eligible' })).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-list-promote-success.png', fullPage: true });
  });

  test('an ineligible soft rule (freshly created, no evaluations) shows an honest, specific "not yet eligible" breakdown, never a bare rejection', async ({
    page,
  }) => {
    const user = await createConfirmedUser('rules-list-ineligible');
    cleanupUserIds.push(user.id);
    await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, 'Never risk more than 2% per trade (brand new).', {
      severity: 'soft',
      createdAt: new Date(),
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.locator('li', { hasText: 'Never risk more than 2% per trade (brand new).' });
    await row.getByRole('button', { name: 'Promote to hard' }).click();

    const status = row.locator('[role="status"]');
    await expect(status).toBeVisible();
    await expect(status).toContainText('Not yet eligible to promote');
    // The two gates a brand-new, zero-evaluation rule genuinely fails.
    await expect(status).toContainText('42');
    await expect(status).toContainText('20 applicable evaluations needed');
    // Still soft — no promotion happened.
    await expect(row.getByText('Soft', { exact: true })).toBeVisible();
    await expect(row.getByText('Hard', { exact: true })).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-list-ineligible.png', fullPage: true });
  });

  test('a real demote flips a hard rule back to soft', async ({ page }) => {
    const user = await createConfirmedUser('rules-list-demote');
    cleanupUserIds.push(user.id);
    await seedGlobalRule(user.id, 'total_open_risk', 'lte', 2, 'Never let your total open risk exceed 2% (demote test).', {
      severity: 'hard',
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.locator('li', { hasText: 'Never let your total open risk exceed 2% (demote test).' });
    await expect(row.getByText('Hard', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Demote to soft' }).click();

    await expect(row.getByText('Soft', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(row.getByRole('button', { name: 'Promote to hard' })).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-list-demote.png', fullPage: true });
  });

  test('retire requires an explicit confirm step, and a real retire moves the rule into the collapsed retired section', async ({
    page,
  }) => {
    const user = await createConfirmedUser('rules-list-retire');
    cleanupUserIds.push(user.id);
    await seedGlobalRule(user.id, 'risk_pct', 'lte', 1.5, 'Never risk more than 1.5% per trade (retire test).', {
      severity: 'soft',
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.locator('li', { hasText: 'Never risk more than 1.5% per trade (retire test).' });
    await row.getByRole('button', { name: 'Retire' }).click();

    // Confirm step — the rule must NOT be retired by the first click alone.
    await expect(row.getByText("can't be undone")).toBeVisible();
    await expect(page.getByText('Retired rules (1)')).toHaveCount(0);
    await page.screenshot({ path: 'tmp/dev-screenshots/rule-list-retire-confirm.png', fullPage: true });

    // Backing out leaves the rule active, still promotable/demotable.
    await row.getByRole('button', { name: 'Keep it active' }).click();
    await expect(row.getByText('Never risk more than 1.5% per trade (retire test).')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Retire' })).toBeVisible();

    // Now actually confirm.
    await row.getByRole('button', { name: 'Retire' }).click();
    await row.getByRole('button', { name: 'Yes, retire' }).click();

    await expect(page.getByText('Retired rules (1)')).toBeVisible({ timeout: 10_000 });
    await page.getByText('Retired rules (1)').click();
    await expect(page.getByText('Never risk more than 1.5% per trade (retire test).')).toBeVisible();
    await expect(page.getByText('Retired', { exact: true })).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-list-retired-final.png', fullPage: true });
  });

  test('the hard-cap swap: promoting a 7th rule at the 6-hard-rule cap offers a real trade-off, and completing the swap demotes the chosen rule and promotes the original', async ({
    page,
  }) => {
    // Module 04 Slice 10e bug-fix pass (2026-08-31): `RuleList.tsx` now
    // wraps every awaited Server Action call (including both calls this
    // test's own swap makes) in a 15s client-side deadline
    // (`ACTION_TIMEOUT_MS`, `./with-timeout.ts`) — a legitimate, deliberate
    // ceiling this test needs enough budget to actually observe either
    // outcome of (success, or the fix's own honest timeout state), rather
    // than being cut off by a tighter window that predates that deadline
    // existing at all. Worst case, both sequential calls in a swap hit the
    // full 15s ceiling before settling, so the overall test timeout is
    // bumped well past 2 x 15s plus normal seeding/login/navigation
    // overhead.
    test.setTimeout(75_000);
    const user = await createConfirmedUser('rules-list-hardcap');
    cleanupUserIds.push(user.id);
    await db
      .query(
        `insert into retrospeq.subscriptions (user_id, plan, status) values ($1, 'pro', 'active')
         on conflict (user_id) do update set plan = 'pro', status = 'active'`,
        [user.id],
      )
      .catch(() => {});
    const accountId = await seedAccount(user.id);

    // 6 existing active hard rules — none need to be individually eligible
    // (promoteRuleSeverity never re-checks eligibility for an ALREADY-hard
    // rule), so these are cheap to seed.
    const hardRuleIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await seedGlobalRule(user.id, 'risk_pct', 'lte', 1 + i * 0.1, `Hard cap filler rule #${i + 1}.`, {
        severity: 'hard',
      });
      hardRuleIds.push(id);
    }
    // The 7th, genuinely eligible soft rule attempting promotion.
    await seedEligibleSoftRule(user.id, accountId, 'total_open_risk', 'Never let your total open risk exceed 2% (swap test).');

    await loginAs(page, user.email);
    await page.goto('/rules');

    const row = page.locator('li', { hasText: 'Never let your total open risk exceed 2% (swap test).' });
    await row.getByRole('button', { name: 'Promote to hard' }).click();

    const alert = row.locator('[role="alertdialog"]');
    // 18s, not 10s (see this test's own `test.setTimeout` comment above):
    // this promote click is itself wrapped in the same 15s client-side
    // deadline, so a local assertion window shorter than that ceiling could
    // fail spuriously before the click's own promise has had a legitimate
    // chance to settle either way.
    await expect(alert).toBeVisible({ timeout: 18_000 });
    await expect(alert).toContainText('You already have');
    await expect(alert).toContainText('6');
    await expect(alert.locator('.demote-list li')).toHaveCount(6);

    // Choose the first filler rule to move back to soft, then Swap.
    await alert.locator('.demote-list li').first().getByRole('radio').check();
    await alert.getByRole('button', { name: 'Swap' }).click();

    // The chosen rule is now soft, and the original rule is now hard —
    // alert dismissed, both facts real and independently verifiable. Same
    // 18s reasoning as above — `handleSwap` awaits up to two sequential
    // 15s-ceilinged calls.
    await expect(row.getByText('Hard', { exact: true })).toBeVisible({ timeout: 18_000 });
    await expect(alert).toHaveCount(0);

    const demotedRuleId = hardRuleIds[0];
    const demoted = await db.query<{ severity: string }>('select severity from retrospeq.rules where id = $1', [demotedRuleId]);
    expect(demoted.rows[0].severity).toBe('soft');
    const promoted = await db.query<{ severity: string }>(
      `select rv.rendered, r.severity
         from retrospeq.rules r join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where rv.rendered = 'Never let your total open risk exceed 2% (swap test).'`,
    );
    expect(promoted.rows[0].severity).toBe('hard');

    await page.screenshot({ path: 'tmp/dev-screenshots/rule-list-hardcap-swap.png', fullPage: true });
  });
});
