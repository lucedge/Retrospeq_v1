import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 02 Slice 7b E2E — independent tester pass (not the coder's own
 * self-check), covering the close-out screen (§5.1/§5.2's three refusal
 * codes + the trim-reason chip + a successful confirm), the manual-entry
 * form (§4.8, zero-accounts state + a real submission), and a real split
 * and a real join performed through the UI (not just unit-tested against
 * the backend functions directly). Same conventions as `trades.spec.ts`:
 * real dev server, real Supabase Auth project, screenshots to
 * `tmp/dev-screenshots/`, direct `pg` seeding (owner role, bypasses RLS,
 * setup only).
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-Slice7b-Pass-1234!';

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

test.describe('Close-out / manual entry / split / join (Module 02 Slice 7b)', () => {
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
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]).catch(() => {});
      await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
      await deleteUser(userId);
    }
    await db.end();
  });

  async function seedAccount(userId: string, platform: 'mt5' | 'manual' = 'mt5'): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'E2E Slice7b', $2, 'USD', '00:00:00 UTC')
       returning id`,
      [userId, platform],
    );
    return res.rows[0].id;
  }

  async function seedTradeWithFills(
    userId: string,
    accountId: string,
    opts: {
      instrument: string;
      day: string; // 'YYYY-MM-DD'
      groupingConfidence?: 'confident_single' | 'ambiguous';
      extraFill?: boolean; // second fill, non-first, non-synthetic -- a valid split boundary
      status?: 'open' | 'closed';
    },
  ): Promise<{ tradeId: string; blockId: string; fillIds: string[] }> {
    const openedAt = new Date(`${opts.day}T09:00:00Z`);
    const closedAt = opts.status === 'open' ? null : new Date(`${opts.day}T11:00:00Z`);
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
          grouping_confidence, confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, 'long', $5::timestamptz, $6, $5::date, $7,
               '1.10000000', '1.10500000', '200000.00000000', '1.09000000', '1.000000', '1.5000', 'USD',
               $8, null, null)
       returning id`,
      [
        userId,
        accountId,
        blockId,
        opts.instrument,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        opts.status ?? 'closed',
        opts.groupingConfidence ?? 'confident_single',
      ],
    );
    const tradeId = tradeRes.rows[0].id;

    const fillIds: string[] = [];
    async function insertFill(volume: string, filledAt: Date): Promise<string> {
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
         values ($1, $2, $3, $4, 'buy', $5, '1.10000000', $6::timestamptz, $6::date, 'USD')
         returning id`,
        [userId, accountId, `e2e-slice7b-${tradeId}-${filledAt.getTime()}`, opts.instrument, volume, filledAt.toISOString()],
      );
      return res.rows[0].id;
    }

    const firstFillId = await insertFill('100000.00000000', openedAt);
    await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
      tradeId,
      firstFillId,
      userId,
    ]);
    fillIds.push(firstFillId);

    if (opts.extraFill) {
      const secondAt = new Date(openedAt.getTime() + 5 * 60_000);
      const secondFillId = await insertFill('100000.00000000', secondAt);
      await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'add')`, [
        tradeId,
        secondFillId,
        userId,
      ]);
      fillIds.push(secondFillId);
    }

    return { tradeId, blockId, fillIds };
  }

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

  test('close-out: COVERAGE_GAP refusal renders the specific gap detail honestly, with no working retry-sync button', async ({
    page,
  }) => {
    const user = await createConfirmedUser('closeout-gap');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const day = '2026-07-10';
    await seedTradeWithFills(user.id, accountId, { instrument: 'EURUSD', day });
    // A coverage gap overlapping this day.
    await db.query(
      `insert into retrospeq.coverage_gaps (account_id, user_id, gap_from, gap_to)
       values ($1, $2, $3::timestamptz, $4::timestamptz)`,
      [accountId, user.id, `${day}T08:00:00Z`, `${day}T09:30:00Z`],
    );

    await loginAs(page, user.email);
    await page.goto(`/trades/close-out?account=${accountId}&day=${day}`);
    await page.getByRole('button', { name: 'Day done' }).click();

    await expect(page.getByText(/unresolved coverage gap/)).toBeVisible({ timeout: 10_000 });
    // Specific detail, not a generic "something's wrong" -- the count is real.
    await expect(page.getByText(/1 unresolved coverage gap/)).toBeVisible();
    await expect(page.getByText("Sync isn't automated yet")).toBeVisible();
    // No working retry-sync control anywhere on the page.
    await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /retry/i })).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/closeout-coverage-gap.png', fullPage: true });
  });

  test('close-out: AMBIGUOUS_GROUPING refusal deep-links to the blocking trade, which auto-expands its fills', async ({
    page,
  }) => {
    const user = await createConfirmedUser('closeout-ambig');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const day = '2026-07-11';
    const { tradeId } = await seedTradeWithFills(user.id, accountId, {
      instrument: 'GBPUSD',
      day,
      groupingConfidence: 'ambiguous',
      extraFill: true,
      status: 'open',
    });

    await loginAs(page, user.email);
    await page.goto(`/trades/close-out?account=${accountId}&day=${day}`);
    await page.getByRole('button', { name: 'Day done' }).click();

    await expect(page.getByText(/ambiguous grouping/)).toBeVisible({ timeout: 10_000 });
    const link = page.getByRole('link', { name: 'Review this trade' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `/trades#trade-${tradeId}`);

    await page.screenshot({ path: 'tmp/dev-screenshots/closeout-ambiguous-grouping.png', fullPage: true });

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/trades#trade-${tradeId}$`));
    // AutoExpandFillsOnHash opened the matching <details> -- its fills table is visible.
    await expect(page.locator(`#trade-${tradeId} table`)).toBeVisible({ timeout: 5_000 });
  });

  test('close-out: a real successful confirm, with a trim-reason chip tapped first -- no red/green, exactly one primary .rq-btn', async ({
    page,
  }) => {
    const user = await createConfirmedUser('closeout-success');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const day = '2026-07-12';
    await seedTradeWithFills(user.id, accountId, { instrument: 'USDJPY', day, extraFill: true });

    await loginAs(page, user.email);
    await page.goto(`/trades/close-out?account=${accountId}&day=${day}`);

    // Exactly one primary .rq-btn on this screen ("Day done") -- every
    // other button is either a pill (trim-reason chips) or ghost.
    const primaryButtons = page.locator('button.rq-btn:not(.rq-btn--ghost):not(.rq-btn--equal):not(.rq-pill)');
    await expect(primaryButtons).toHaveCount(1);
    await expect(primaryButtons.first()).toHaveText('Day done');

    // No red/green class anywhere on the page.
    const html = await page.content();
    expect(html).not.toMatch(/class="[^"]*\b(?:red|green|success|danger)\b/i);

    await page.getByRole('radio', { name: 'Target' }).click();
    await expect(page.getByRole('radio', { name: 'Target', exact: true })).toHaveAttribute('aria-checked', 'true', {
      timeout: 5_000,
    });

    await page.screenshot({ path: 'tmp/dev-screenshots/closeout-trim-reason-picked.png', fullPage: true });

    await page.getByRole('button', { name: 'Day done' }).click();
    await expect(page.getByText('Day closed out')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('1 trade confirmed.')).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/closeout-success.png', fullPage: true });

    const dbTrade = await db.query(
      `select confirmed_at from retrospeq.trades where account_id = $1 and server_day = $2`,
      [accountId, day],
    );
    expect(dbTrade.rows[0].confirmed_at).not.toBeNull();
    const dbCapture = await db.query(
      `select value from retrospeq.trade_captures where user_id = $1 and field_id = 'trim_reason'`,
      [user.id],
    );
    expect(dbCapture.rows[0].value).toBe('target');
  });

  test('manual entry: zero-accounts state is honest, points at connecting an account, never renders a doomed form', async ({
    page,
  }) => {
    const user = await createConfirmedUser('manual-empty');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.goto('/trades/manual-entry');

    await expect(page.getByText("you don't have one yet")).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add a manual account' })).toBeVisible();
    // Scoped to <main> -- the app shell's own "Sign out" form in the nav
    // is expected and irrelevant here; this screen's own content must
    // never render a doomed manual-entry <form>.
    await expect(page.locator('main form')).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/manual-entry-empty.png', fullPage: true });
  });

  test('manual entry: a real submission through the form creates a trade, with exactly one primary .rq-btn', async ({
    page,
  }) => {
    const user = await createConfirmedUser('manual-submit');
    cleanupUserIds.push(user.id);
    await seedAccount(user.id, 'manual');

    await loginAs(page, user.email);
    await page.goto('/trades/manual-entry');

    const primaryButtons = page.locator('button.rq-btn:not(.rq-btn--ghost):not(.rq-btn--equal):not(.rq-pill)');
    await expect(primaryButtons).toHaveCount(1);
    await expect(primaryButtons.first()).toHaveText('Log trade');

    await page.fill('#instrument', 'XAUUSD');
    await page.getByRole('radio', { name: 'Long' }).click();
    await page.fill('#size', '1');
    await page.fill('#entryPrice', '2400');
    await page.fill('#exitPrice', '2410');
    await page.fill('#stop', '2395');

    await page.screenshot({ path: 'tmp/dev-screenshots/manual-entry-filled.png', fullPage: true });

    await page.getByRole('button', { name: 'Log trade' }).click();
    await expect(page.getByText('Trade logged')).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/manual-entry-success.png', fullPage: true });

    const dbTrade = await db.query(`select instrument, direction from retrospeq.trades where user_id = $1`, [user.id]);
    expect(dbTrade.rows).toHaveLength(1);
    expect(dbTrade.rows[0].instrument).toBe('XAUUSD');
    expect(dbTrade.rows[0].direction).toBe('long');
  });

  test('split: a real split performed through the UI creates a second trade from the chosen fill onward', async ({
    page,
  }) => {
    const user = await createConfirmedUser('split-ui');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    // Closed (not open): OpenPositionCard only renders the fills section
    // when grouping_confidence is 'ambiguous' (§4.3's confidence bands),
    // but TradeRowCard (closed/confirmed) always does -- see page.tsx's
    // own header comments on both. A plain closed trade is the simplest
    // real path to a rendered "Split here" control.
    const { tradeId } = await seedTradeWithFills(user.id, accountId, {
      instrument: 'EURGBP',
      day: '2026-07-13',
      extraFill: true,
      status: 'closed',
    });

    await loginAs(page, user.email);
    await page.goto(`/trades#trade-${tradeId}`);
    await expect(page.locator(`#trade-${tradeId} table`)).toBeVisible({ timeout: 5_000 });

    // Only one eligible split boundary (the second, non-first fill).
    const splitBtn = page.locator(`#trade-${tradeId}`).getByRole('button', { name: 'Split here' });
    await expect(splitBtn).toHaveCount(1);

    await page.screenshot({ path: 'tmp/dev-screenshots/split-before.png', fullPage: true });

    await splitBtn.click();
    // Wait for the pending "Splitting…" state to clear (the Server Action
    // + router.refresh() round trip), not a fixed sleep. `router.refresh()`
    // re-collapses the `<details>` (fresh server render), so this waits on
    // the button's own pending-state text, not on the (now-collapsed)
    // fills table's visibility.
    await expect(page.getByRole('button', { name: 'Splitting…' })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(`article[data-trade-id="${tradeId}"]`)).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/split-after.png', fullPage: true });

    const dbTrades = await db.query(
      `select id from retrospeq.trades where account_id = $1 and instrument = 'EURGBP'`,
      [accountId],
    );
    expect(dbTrades.rows).toHaveLength(2);
  });

  test('join: a real join performed through the UI merges two same-block unconfirmed trades into one', async ({
    page,
  }) => {
    const user = await createConfirmedUser('join-ui');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const instrument = 'AUDJPY';
    const day = '2026-07-14';
    // Two trades sharing one block, both unconfirmed.
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4::timestamptz, null, $4::date)
       returning id`,
      [user.id, accountId, instrument, `${day}T09:00:00Z`],
    );
    const blockId = blockRes.rows[0].id;

    async function insertTradeWithFill(openedAt: string): Promise<string> {
      const tradeRes = await db.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            currency, grouping_confidence, confirmed_at, confirmed_by)
         values ($1, $2, $3, $4, 'long', $5::timestamptz, null, $5::date, 'open', 'USD', 'ambiguous', null, null)
         returning id`,
        [user.id, accountId, blockId, instrument, openedAt],
      );
      const tradeId = tradeRes.rows[0].id;
      const fillRes = await db.query<{ id: string }>(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
         values ($1, $2, $3, $4, 'buy', '100000.00000000', '1.10000000', $5::timestamptz, $5::date, 'USD')
         returning id`,
        [user.id, accountId, `e2e-slice7b-join-${tradeId}`, instrument, openedAt],
      );
      await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
        tradeId,
        fillRes.rows[0].id,
        user.id,
      ]);
      return tradeId;
    }

    const tradeIdA = await insertTradeWithFill(`${day}T09:00:00Z`);
    const tradeIdB = await insertTradeWithFill(`${day}T09:05:00Z`);

    await loginAs(page, user.email);
    await page.goto('/trades');

    await expect(page.getByText('Same position, separate trades')).toBeVisible();
    const joinBtn = page.getByRole('button', { name: /Join with/ });
    await expect(joinBtn).toHaveCount(1);

    await page.screenshot({ path: 'tmp/dev-screenshots/join-before.png', fullPage: true });

    await joinBtn.click();
    // Wait for the pending "Joining…" state to clear (the Server Action +
    // router.refresh() round trip), not a fixed sleep.
    await expect(page.getByRole('button', { name: 'Joining…' })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('Same position, separate trades')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({ path: 'tmp/dev-screenshots/join-after.png', fullPage: true });

    const dbTradeA = await db.query('select id from retrospeq.trades where id = $1', [tradeIdA]);
    const dbTradeB = await db.query('select id from retrospeq.trades where id = $1', [tradeIdB]);
    // Exactly one of the two survives; the other was deleted (absorbed).
    expect(dbTradeA.rows.length + dbTradeB.rows.length).toBe(1);
  });
});
