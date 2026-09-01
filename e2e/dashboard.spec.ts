import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';
import { weekStartForServerDay } from '../lib/rules/week-boundary';

/**
 * Module 08 (Onboarding & Home) §7/§8 — the dashboard E2E, THIS DISPATCH'S
 * SCOPE ONLY (`open`/`closeout`/`clear` — never the Module-06-blocked
 * `Review ready`). Follows `e2e/onboarding.spec.ts`'s/`e2e/rules-adherence
 * .spec.ts`'s own conventions exactly (real dev server, real Supabase Auth
 * project, a real `pg` connection for setup/verification, screenshots to
 * `tmp/dev-screenshots/`).
 *
 * `/dashboard` does NOT gate on `onboarding_state.stage` — any
 * authenticated trader can view it regardless of onboarding progress (see
 * `app/(app)/dashboard/page.tsx`'s own header) — so every scenario here
 * logs in and navigates straight to `/dashboard`, no onboarding-stage
 * seeding needed.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-Dashboard-Pass-1234!';

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

const CURRENT_WEEK_START = weekStartForServerDay(new Date().toISOString().slice(0, 10));

test.describe('Dashboard (Module 08 §7/§8)', () => {
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
      await db.query('delete from retrospeq.adherence_weekly where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]).catch(() => {});
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
    // A fresh trader's onboarding stage is 'created', so post-sign-in `/`
    // redirects onward — every scenario below navigates to `/dashboard`
    // explicitly next, so this just waits clear of `/login` itself.
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  }

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier, status, connected_at)
       values ($1, 'Dashboard E2E MT5', 'mt5', 'USD', '00:00:00 UTC', 't0', 'connected', now())
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  /**
   * Seeds a real `blocks`/`trades` row, PLUS a real `fills`/`trade_fills`
   * pair — the "Trades to close" scenario below drives a REAL `confirmDay`
   * submission through the UI (`trades-slice7b.spec.ts`'s own
   * `seedTradeWithFills` established that a trade with no backing fill
   * cannot be confirmed cleanly), so this dashboard suite's own seeding
   * matches that precedent exactly rather than the fills-less shortcut
   * `e2e/onboarding.spec.ts`'s `seedTrade` uses (that suite never drives a
   * real confirm).
   */
  async function seedTrade(
    userId: string,
    accountId: string,
    serverDay: string,
    status: 'open' | 'closed',
    riskPct: string,
  ): Promise<void> {
    const openedAt = new Date(`${serverDay}T09:00:00Z`);
    const closedAt = status === 'closed' ? new Date(`${serverDay}T09:30:00Z`) : null;
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
       returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt ? closedAt.toISOString() : null, serverDay],
    );
    const blockId = blockRes.rows[0].id;

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
          grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, $7,
               '1.10000000', $8, '100000.00000000', '1.09000000', $9, $9, 'USD',
               'confident_single')
       returning id`,
      [
        userId,
        accountId,
        blockId,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        serverDay,
        status,
        closedAt ? '1.10500000' : null,
        riskPct,
      ],
    );
    const tradeId = tradeRes.rows[0].id;

    const fillRes = await db.query<{ id: string }>(
      `insert into retrospeq.fills
         (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
       values ($1, $2, $3, 'EURUSD', 'buy', '100000.00000000', '1.10000000', $4::timestamptz, $4::date, 'USD')
       returning id`,
      [userId, accountId, `e2e-dashboard-${tradeId}`, openedAt.toISOString()],
    );
    await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
      tradeId,
      fillRes.rows[0].id,
      userId,
    ]);
  }

  test('Trades to close: a real unconfirmed trade closed today is listed plainly, and "Close out the day" deep-links straight into the real close-out screen for that account/day', async ({
    page,
  }) => {
    const user = await createConfirmedUser('dash-closeout');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const today = new Date().toISOString().slice(0, 10);
    await seedTrade(user.id, accountId, today, 'closed', '1.500000');

    await loginAs(page, user.email);
    await page.goto('/dashboard');

    await expect(page.locator('.dash[data-state="closeout"]')).toBeVisible();
    await expect(page.locator('.dash__headline')).toContainText('trade');
    await expect(page.locator('.dash__headline')).toContainText('to close out');
    await expect(page.locator('.dash__trades li')).toHaveCount(1);
    await expect(page.locator('.dash__trades .instrument')).toHaveText('EURUSD');

    // One primary .rq-btn on this state, per §7.1's own table.
    await expect(page.locator('main.dash a.rq-btn, main.dash button.rq-btn')).toHaveCount(1);

    await page.screenshot({ path: 'tmp/dev-screenshots/dashboard-closeout.png', fullPage: true });

    await page.getByRole('link', { name: 'Close out the day' }).click();
    await page.waitForURL(new RegExp(`/trades/close-out\\?account=${accountId}&day=${today}`), { timeout: 10_000 });
    await expect(page.locator('h1')).toContainText(`Close out ${today}`);

    // The real close-out flow this dispatch reused, not rebuilt — proves
    // the deep link actually lands on real, actionable data (not an empty
    // picker), confirming the trade is genuinely there.
    await expect(page.getByRole('button', { name: 'Day done' })).toBeVisible();
    await page.getByRole('button', { name: 'Day done' }).click();
    await expect(page.getByRole('heading', { name: 'Day closed out' })).toBeVisible({ timeout: 10_000 });

    // Confirming clears the day -- a later dashboard visit is now Clear.
    await page.goto('/dashboard');
    await expect(page.locator('.dash[data-state="clear"]')).toBeVisible({ timeout: 10_000 });
  });

  test('Clear: no trades outstanding renders "Nothing to close out." with real adherence numbers, honestly omits streak and the findings projection line, and shows no currency/R anywhere', async ({
    page,
  }) => {
    const user = await createConfirmedUser('dash-clear');
    cleanupUserIds.push(user.id);

    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, 'global', null, 'hard', 'authored', 'pre_entry', 'active') returning id`,
      [user.id],
    );
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, 'total_open_risk', 'lte', '1'::jsonb, 'Never let your total open risk exceed 1%.')`,
      [ruleRes.rows[0].id, user.id],
    );
    await db.query(
      `insert into retrospeq.adherence_weekly
         (user_id, week_start, hard_followed, hard_total, soft_followed, soft_total, top_break_rule_id, top_break_count)
       values ($1, $2::date, 9, 10, 4, 4, $3, 1)`,
      [user.id, CURRENT_WEEK_START, ruleRes.rows[0].id],
    );

    await loginAs(page, user.email);
    await page.goto('/dashboard');

    await expect(page.locator('.dash[data-state="clear"]')).toBeVisible();
    await expect(page.locator('.dash__headline')).toHaveText('Nothing to close out.');

    // Real adherence numbers, reused verbatim from Module 04's own already-
    // built display, not re-derived.
    const adherence = page.locator('.adherence');
    await expect(adherence).toBeVisible();
    await expect(adherence.locator('.adherence__hard')).toContainText('9 of 10');
    await expect(adherence.locator('.adherence__attribution')).toContainText(
      'Never let your total open risk exceed 1%.',
    );

    // Honestly omitted, not faked (§7's own spec shows both; both are
    // blocked on modules that don't exist yet — see this dispatch's own
    // scope notes in app/(app)/dashboard/page.tsx).
    await expect(page.getByText(/streak/i)).toHaveCount(0);
    await expect(page.getByText(/next finding/i)).toHaveCount(0);

    // AGENTS.md's non-negotiable, re-asserted for this specific screen: no
    // currency P&L, no bare "R" figure anywhere on this page.
    await expect(page.getByText('$')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/\d+\.\d+R\b/);

    await page.screenshot({ path: 'tmp/dev-screenshots/dashboard-clear.png', fullPage: true });
  });

  test('Open position: a genuine open trade is never silently shown as Clear — a minimal, honest indicator renders instead, with no fabricated current-R or conviction field', async ({
    page,
  }) => {
    const user = await createConfirmedUser('dash-open');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const today = new Date().toISOString().slice(0, 10);
    await seedTrade(user.id, accountId, today, 'open', '2.000000');

    await loginAs(page, user.email);
    await page.goto('/dashboard');

    await expect(page.locator('.dash[data-state="open"]')).toBeVisible();
    await expect(page.locator('.dash__headline')).toContainText('position');
    await expect(page.locator('.dash__headline')).toContainText('open');
    // Never the Clear headline for a trader with a genuine open position --
    // this is the specific product-correctness bug this dispatch's own
    // scope note calls out.
    await expect(page.locator('.dash__headline')).not.toContainText('Nothing to close out');

    const position = page.locator('.open-position');
    await expect(position).toBeVisible();
    await expect(position.locator('.instrument')).toContainText('EURUSD');
    await expect(position.locator('.instrument')).toContainText('Long');
    // Real risk_pct (Module 02 data), but never a fabricated current-R or
    // conviction value -- see dashboard-repository.ts's own header.
    await expect(position.locator('dt')).toHaveText('Risk');
    await expect(position.locator('dd')).toHaveText('2.0%');
    await expect(page.getByText(/conviction/i)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/\+\d+\.\d+R\b/);

    await page.screenshot({ path: 'tmp/dev-screenshots/dashboard-open.png', fullPage: true });
  });

  test('the app shell nav has a real "Home" entry pointing at /dashboard', async ({ page }) => {
    const user = await createConfirmedUser('dash-nav');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.goto('/rules');
    await page.getByRole('link', { name: 'Home' }).click();
    await page.waitForURL('**/dashboard', { timeout: 10_000 });
  });
});
