import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 08 (Onboarding & Home) §5.1/§5.6/§9 -- Slice 08b E2E. Follows
 * `rules-guided-front-door.spec.ts`'s/`rules-list.spec.ts`'s own
 * conventions: real dev server, real Supabase Auth project, a real `pg`
 * connection for setup/verification, screenshots to `tmp/dev-screenshots/`.
 *
 * TWO KNOWN, ALREADY-TRACKED, UNRELATED-TO-THIS-SLICE INFRA GAPS shape
 * what this file drives through the real UI versus seeds directly via SQL
 * — documented here rather than silently worked around:
 *
 * 1. **No real KMS exists** (`lib/broker/envelope-encryption.ts`'s
 *    `createKmsMasterKeyProvider` throws `KmsNotConfiguredError`
 *    unconditionally against this real, unmocked dev server — PROGRESS.md
 *    "Infra gaps"). Every CREDENTIALED `connectAccount` attempt therefore
 *    genuinely fails end-to-end today; only `manual` (Module 01 story 2.7,
 *    no credential at all) can complete for real through the browser. The
 *    broker-path scenario below therefore seeds the post-connect DB state
 *    directly for that one step ONLY — `connectAccount`'s own real
 *    stage-advancement call is already separately, thoroughly proven
 *    (mocked, but exercising the real code path) in
 *    `app/(app)/accounts/__tests__/actions.test.ts`. The manual-path
 *    scenario needs no such shortcut and drives the real UI throughout.
 * 2. **No real sync-trigger surface exists** (`lib/ingestion/sync.ts`'s own
 *    header: "The `trigger` surface itself ... NOT this slice's job" —
 *    still true, nothing in this repo calls `runSync` from a real
 *    cron/API route/UI button). "Import completing" is therefore also
 *    simulated by seeding real `trades` rows directly and advancing
 *    `onboarding_state.stage` the same way a real completed sync would
 *    (`advanceOnboardingStageBestEffort`, separately proven for real
 *    against a live Postgres connection in `sync.live.test.ts`).
 *
 * Everything AFTER that seeded starting point — the router's own
 * redirects, the Hook screen's real trade count and honest copy, the
 * guided-calibration completion signal actually firing and being
 * persisted — is driven through the real, running app with zero
 * shortcuts.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-Onboarding-Pass-1234!';

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

test.describe('Onboarding sequence + router (Module 08 §5.1/§5.6/§9, Slice 08b)', () => {
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
  }

  async function seedBrokerAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier, status, connected_at)
       values ($1, 'Onboarding E2E MT5', 'mt5', 'USD', '00:00:00 UTC', 't0', 'connected', now())
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(userId: string, accountId: string, serverDay: string): Promise<void> {
    const openedAt = new Date(`${serverDay}T09:00:00Z`);
    const closedAt = new Date(`${serverDay}T09:30:00Z`);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
       returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
          grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, 'closed',
               '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '1.000000', '1.000000', 'USD',
               'confident_single')`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
  }

  test('created stage: a brand-new trader signing in lands on /accounts/connect, never bare /', async ({ page }) => {
    const user = await createConfirmedUser('onboarding-created');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.waitForURL('**/accounts/connect', { timeout: 10_000 });
    await expect(page.locator('h1')).toHaveText('Connect your trading account');
  });

  test('broker path: account_connected -> history_imported reveals the honest Hook fallback with the real trade count -> calibration (declined) advances to rules_calibrated -> a later visit lands on /dashboard', async ({
    page,
  }) => {
    const user = await createConfirmedUser('onboarding-broker-flow');
    cleanupUserIds.push(user.id);

    // Step 1 (real): a fresh sign-in lands on the real connect screen.
    await loginAs(page, user.email);
    await page.waitForURL('**/accounts/connect', { timeout: 10_000 });

    // Step 2 (seeded -- see file header, infra gap #1): the post-connect
    // state a real credentialed connect would have produced.
    const accountId = await seedBrokerAccount(user.id);
    await db.query(
      `update retrospeq.onboarding_state set stage = 'account_connected', path = 'broker' where user_id = $1`,
      [user.id],
    );
    const afterConnect = await db.query<{ stage: string; path: string }>(
      'select stage, path from retrospeq.onboarding_state where user_id = $1',
      [user.id],
    );
    expect(afterConnect.rows[0]).toEqual({ stage: 'account_connected', path: 'broker' });

    // Step 3 (seeded -- see file header, infra gap #2): a completed
    // import — three real, non-manual trades, then the exact stage a
    // successful `runSync` would advance to.
    await seedTrade(user.id, accountId, '2026-01-05');
    await seedTrade(user.id, accountId, '2026-01-06');
    await seedTrade(user.id, accountId, '2026-01-07');
    await db.query(`update retrospeq.onboarding_state set stage = 'history_imported' where user_id = $1`, [user.id]);

    // Step 4 (real): the router sends a history_imported/broker trader to
    // the Hook screen, which renders the ONLY variant this slice can ever
    // show — the honest fallback, with the REAL trade count (3), never a
    // fabricated finding.
    await page.goto('/');
    await page.waitForURL('**/onboarding/hook', { timeout: 10_000 });
    await expect(page.locator('h1')).toContainText("We've imported");
    await expect(page.locator('h1 .rq-num')).toHaveText('3');
    await expect(page.getByText('Nothing conclusive yet', { exact: false })).toBeVisible();
    // One primary button on this screen, full stop.
    await expect(page.locator('.hook a.rq-btn, .hook button.rq-btn')).toHaveCount(1);
    await page.screenshot({ path: 'tmp/dev-screenshots/onboarding-hook-honest-fallback.png', fullPage: true });

    // Step 5 (real): "Set up three rules" leads to the already-shipped
    // guided front door (Module 04 Slice 10a) — this dispatch does not
    // rebuild it.
    await page.getByRole('link', { name: 'Set up three rules' }).click();
    await page.waitForURL('**/rules/start', { timeout: 10_000 });
    await expect(page.locator('h1')).toHaveText('Three rules to start with');

    // Step 6 (real): declining entirely is a legitimate completion (§5.10)
    // — the minimal, additive completion hook in GuidedFrontDoor.tsx fires
    // regardless, a real client -> Server Action -> DB round trip.
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByText('No rules added')).toBeVisible();

    await expect
      .poll(
        async () => {
          const r = await db.query<{ stage: string }>('select stage from retrospeq.onboarding_state where user_id = $1', [
            user.id,
          ]);
          return r.rows[0]!.stage;
        },
        { timeout: 10_000 },
      )
      .toBe('rules_calibrated');

    // Step 7 (real): a later visit lands a rules_calibrated-stage trader
    // on /dashboard — Module 08's own dashboard dispatch, see
    // lib/onboarding/router.ts's own header.
    await page.goto('/');
    await page.waitForURL('**/dashboard', { timeout: 10_000 });
  });

  test('manual path: connects for real with no credential, skips account_connected and the Hook screen entirely, and lands straight on /rules/start', async ({
    page,
  }) => {
    const user = await createConfirmedUser('onboarding-manual-flow');
    cleanupUserIds.push(user.id);

    await loginAs(page, user.email);
    await page.waitForURL('**/accounts/connect', { timeout: 10_000 });

    // Fully real, no seeding shortcut needed — manual has no
    // credential/KMS step at all (Module 01 story 2.7).
    await page.getByRole('radio', { name: 'Manual (no API)' }).click();
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('h1')).toHaveText('Connected', { timeout: 10_000 });

    const state = await db.query<{ stage: string; path: string }>(
      'select stage, path from retrospeq.onboarding_state where user_id = $1',
      [user.id],
    );
    expect(state.rows[0]).toEqual({ stage: 'history_imported', path: 'manual' });

    // The router sends this trader STRAIGHT to /rules/start — never
    // /onboarding/hook, since a manual trader has no history to hook from.
    await page.goto('/');
    await page.waitForURL('**/rules/start', { timeout: 10_000 });
    await expect(page.locator('h1')).toHaveText('Three rules to start with');

    await page.screenshot({ path: 'tmp/dev-screenshots/onboarding-manual-path-rules-start.png', fullPage: true });
  });
});
