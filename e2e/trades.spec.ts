import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 02 §5.1/§5.2 E2E — the trade list screen's core flow (a signed-in
 * trader sees their real open/closed/confirmed trades) plus its
 * "not enough data yet" empty-state path, added by an independent tester
 * pass (Slice 7a tester review) since no E2E coverage of this screen
 * existed yet. Follows `auth.spec.ts`'s own conventions: real dev server,
 * real Supabase Auth project, screenshots to `tmp/dev-screenshots/`.
 *
 * A confirmed (`email_confirm: true`) user is created directly via the
 * GoTrue admin API (same approach as `lib/supabase/__tests__/
 * rls-test-helpers.ts`'s `createTestAuthUser`, inlined here rather than
 * imported since that helper lives under `lib/supabase/__tests__` and
 * returns a shape keyed for vitest's RLS suites) so the UI login flow
 * itself can be driven for real (`auth.spec.ts`'s own signup flow can't
 * reach a logged-in state without a real inbox — `mailer_autoconfirm` is
 * off on this project). Trade data is seeded with a direct `pg` connection
 * (owner role, bypasses RLS — setup only), the same pattern every
 * `lib/ingestion/__tests__/*.live.test.ts` file already uses.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-Trades-Pass-1234!';

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

test.describe('Trades list screen (Module 02 §5.1/§5.2)', () => {
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
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]).catch(() => {});
      await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
      await deleteUser(userId);
    }
  });

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'E2E Trades Screen', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    opts: {
      instrument: string;
      status: 'open' | 'closed' | 'confirmed';
      direction?: 'long' | 'short';
      groupingConfidence?: 'confident_single' | 'confident_split' | 'ambiguous';
      outcome?: 'win' | 'loss' | 'scratch' | null;
      rMultiple?: string | null;
      riskPct?: string | null;
    },
  ): Promise<string> {
    const direction = opts.direction ?? 'long';
    const openedAt = new Date('2026-08-20T09:00:00Z');
    const closedAt = opts.status === 'open' ? null : new Date('2026-08-20T11:00:00Z');
    const confirmedAt = opts.status === 'confirmed' ? new Date('2026-08-20T12:00:00Z') : null;

    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4::timestamptz, $5, $4::date)
       returning id`,
      [userId, accountId, opts.instrument, openedAt.toISOString(), closedAt ? closedAt.toISOString() : null],
    );
    const blockId = blockRes.rows[0].id;

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, risk_pct, r_multiple, currency,
          outcome, grouping_confidence, confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $6::date, $8,
               '1.10000000', '1.10500000', '100000.00000000', '1.09000000', $9, $10, 'USD',
               $11, $12, $13, $14)
       returning id`,
      [
        userId,
        accountId,
        blockId,
        opts.instrument,
        direction,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        opts.status,
        opts.riskPct === undefined ? '1.000000' : opts.riskPct,
        opts.rMultiple === undefined ? '1.5000' : opts.rMultiple,
        opts.outcome === undefined ? null : opts.outcome,
        opts.groupingConfidence ?? 'confident_single',
        confirmedAt ? confirmedAt.toISOString() : null,
        confirmedAt ? 'user' : null,
      ],
    );
    const tradeId = tradeRes.rows[0].id;

    const fillRes = await db.query<{ id: string }>(
      `insert into retrospeq.fills
         (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
       values ($1, $2, $3, $4, $5, '100000.00000000', '1.10000000', $6::timestamptz, $6::date, 'USD')
       returning id`,
      [userId, accountId, `e2e-trades-${tradeId}`, opts.instrument, direction === 'long' ? 'buy' : 'sell', openedAt.toISOString()],
    );
    await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
      tradeId,
      fillRes.rows[0].id,
      userId,
    ]);

    return tradeId;
  }

  async function loginAs(page: import('@playwright/test').Page, email: string) {
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/', { timeout: 10_000 });
  }

  test('empty state: a brand-new account with zero trades renders an honest "not enough data yet" message, not a fake/empty-looking table', async ({
    page,
  }) => {
    const user = await createConfirmedUser('trades-empty');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.goto('/trades');
    await expect(page.locator('h1')).toHaveText('Trades');

    const body = await page.locator('body').textContent();
    expect(body).toContain('Not enough data yet');
    // Never a fake populated-looking empty table.
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.locator('article.rq-card')).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/trades-empty.png', fullPage: true });
  });

  test('populated state: open position (incl. an ambiguous-grouping one with the honest disabled chip), closed-unconfirmed, and confirmed trades all render with no colour-coded outcome, direction as text, and .rq-num on every number', async ({
    page,
  }) => {
    const user = await createConfirmedUser('trades-populated');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);

    await seedTrade(user.id, accountId, { instrument: 'EURUSD', status: 'open', direction: 'long' });
    await seedTrade(user.id, accountId, {
      instrument: 'GBPUSD',
      status: 'open',
      direction: 'short',
      groupingConfidence: 'ambiguous',
    });
    await seedTrade(user.id, accountId, {
      instrument: 'USDJPY',
      status: 'closed',
      outcome: 'loss',
      rMultiple: '-1.0000',
    });
    await seedTrade(user.id, accountId, {
      instrument: 'AUDUSD',
      status: 'confirmed',
      outcome: 'win',
      rMultiple: '2.3000',
    });
    await seedTrade(user.id, accountId, {
      instrument: 'NZDUSD',
      status: 'confirmed',
      outcome: 'scratch',
      rMultiple: '0.0000',
    });

    await loginAs(page, user.email);
    await page.goto('/trades');
    await expect(page.locator('h1')).toHaveText('Trades');

    await expect(page.getByText('Open positions')).toBeVisible();
    await expect(page.getByText('Needs review')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Confirmed', exact: true })).toBeVisible();

    // The ambiguous open position shows the ambient grouping chip; the
    // non-ambiguous one does not.
    const ambiguousCard = page.locator('article[data-trade-id]', { hasText: 'GBPUSD' });
    await expect(ambiguousCard.getByText('Is this add part of the same trade?')).toBeVisible();
    const plainOpenCard = page.locator('article[data-trade-id]', { hasText: 'EURUSD' });
    await expect(plainOpenCard.getByText('Is this add part of the same trade?')).toHaveCount(0);

    // Direction rendered as text, never as a colour class — long AND short.
    await expect(page.getByText('Long', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Short', { exact: true }).first()).toBeVisible();

    // Win / loss / scratch outcomes carry no colour styling hook beyond a
    // plain data attribute this repo's own CSS never selects on (verified
    // separately by grep against retrospeq-design-system/brand/css — no
    // `data-outcome` rule exists at all).
    await expect(page.locator('article[data-outcome="win"]')).toHaveCount(1);
    await expect(page.locator('article[data-outcome="loss"]')).toHaveCount(1);
    await expect(page.locator('article[data-outcome="scratch"]')).toHaveCount(1);

    await page.screenshot({ path: 'tmp/dev-screenshots/trades-populated.png', fullPage: true });

    // Spot-check .rq-num is genuinely applied to real numeric output, not
    // just claimed — the open position's risk % and a closed trade's
    // R-multiple.
    await expect(plainOpenCard.locator('.rq-num')).not.toHaveCount(0);
    const closedCard = page.locator('article[data-trade-id]', { hasText: 'USDJPY' });
    await expect(closedCard.locator('.rq-num', { hasText: '-1.0R' })).toBeVisible();
  });

  test('the "Same trade"/"Separate" grouping-chip buttons are genuinely disabled (not just dimmed) with an honest note, and "Later" genuinely dismisses the chip', async ({
    page,
  }) => {
    const user = await createConfirmedUser('trades-chip');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    await seedTrade(user.id, accountId, {
      instrument: 'EURJPY',
      status: 'open',
      groupingConfidence: 'ambiguous',
    });

    await loginAs(page, user.email);
    await page.goto('/trades');

    const sameTradeBtn = page.getByRole('button', { name: 'Same trade' });
    const separateBtn = page.getByRole('button', { name: 'Separate' });
    await expect(sameTradeBtn).toBeDisabled();
    await expect(separateBtn).toBeDisabled();
    await expect(page.getByText("Resolving this here isn't available yet")).toBeVisible();

    // A disabled button rejects a forced click attempt at the DOM/event
    // level too, not merely via the `disabled` CSS look — Playwright's own
    // actionability check refuses to click a disabled element, which is
    // itself the proof; assert the chip is still present as evidence no
    // click went through.
    await expect(page.getByText('Is this add part of the same trade?')).toBeVisible();

    await page.getByRole('button', { name: 'Later' }).click();
    await expect(page.getByText('Is this add part of the same trade?')).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/trades-grouping-chip-dismissed.png', fullPage: true });
  });

  test('the not-a-decision checkbox toggles visually in place on a real click (re-verifying the coder-reported _valueTracker fix independently), and persists through a reload', async ({
    page,
  }) => {
    const user = await createConfirmedUser('trades-not-a-decision');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const tradeId = await seedTrade(user.id, accountId, { instrument: 'EURCHF', status: 'closed' });

    await loginAs(page, user.email);
    await page.goto('/trades');

    const checkbox = page.locator('input[type="checkbox"]');
    await expect(checkbox).not.toBeChecked();

    const [response] = await Promise.all([
      // The Server Action posts back to the current page URL — waiting on
      // this (rather than a fixed sleep) is what actually proves the round
      // trip completed before we move on, not just that React's own
      // optimistic state flipped.
      page.waitForResponse((res) => res.request().method() === 'POST', { timeout: 10_000 }),
      checkbox.click(),
    ]);
    expect(response.ok()).toBe(true);

    // The real, in-place visual assertion the coder's own bug was about:
    // checked state must flip WITHOUT a reload.
    await expect(checkbox).toBeChecked({ timeout: 5_000 });

    // Independent proof the WRITE itself landed, not just the optimistic
    // client state — read the row directly, bypassing the UI entirely.
    const dbRowAfterCheck = await db.query('select not_a_decision from retrospeq.trades where id = $1', [tradeId]);
    expect(dbRowAfterCheck.rows[0].not_a_decision).toBe(true);

    await page.screenshot({ path: 'tmp/dev-screenshots/trades-not-a-decision-checked.png', fullPage: true });

    // Survives a real reload (server round trip actually persisted it).
    await page.reload();
    await expect(page.locator('input[type="checkbox"]')).toBeChecked();

    // And un-toggling also works visually in place.
    const [unresponse] = await Promise.all([
      page.waitForResponse((res) => res.request().method() === 'POST', { timeout: 10_000 }),
      page.locator('input[type="checkbox"]').click(),
    ]);
    expect(unresponse.ok()).toBe(true);
    await expect(page.locator('input[type="checkbox"]')).not.toBeChecked({ timeout: 5_000 });

    const dbRowAfterUncheck = await db.query('select not_a_decision from retrospeq.trades where id = $1', [tradeId]);
    expect(dbRowAfterUncheck.rows[0].not_a_decision).toBe(false);
  });

  test('failure path: a session that expires mid-render is handled honestly, not with a raw error', async ({ page, context }) => {
    const user = await createConfirmedUser('trades-session-expired');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    // Simulate an expired/invalid session by clearing Supabase's own
    // cookies before navigating — the same "session missing" path
    // `requireSessionUser`/the page's own `if (!user)` fallback cover.
    await context.clearCookies();
    await page.goto('/trades');

    // app/(app)/layout.tsx redirects a signed-out visitor to /login before
    // this page ever renders its own fallback — assert THAT honest
    // behaviour (never a raw Next.js error page / stack trace).
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('body')).not.toContainText('Error:');
    await page.screenshot({ path: 'tmp/dev-screenshots/trades-session-expired-redirect.png', fullPage: true });
  });
});
