import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';
import { weekStartForServerDay } from '../lib/rules/week-boundary';
import { lastNCompletedMonths } from '../lib/review/monthly-period';

/**
 * Module 06 (Review & Graduation) §4.9/frame 4.13 — real-browser E2E
 * coverage of `/review/month`, closing the phase-end gap named in
 * `PROGRESS.md`. This route is a pure compute-on-view READ (no prompts,
 * no writes) — see `app/(app)/review/month/page.tsx`'s own header — so
 * both scenarios here only assert rendered output against real seeded
 * rows, never a DB-effect check.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-MonthlyReview-Pass-6621!';

interface TestUser {
  id: string;
  email: string;
}

async function createConfirmedUser(label: string): Promise<TestUser> {
  const email = uniqueTestEmail(label);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
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

test.describe('/review/month — monthly trend (Module 06 §4.9/frame 4.13)', () => {
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
      await db.query('delete from retrospeq.finding_rule_links where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.adherence_weekly where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]).catch(() => {});
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
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  }

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Monthly E2E Test', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  /** `fetchStrategiesForUser` (`lib/fields/strategy-repository.ts`) INNER
   *  JOINs `strategy_versions` (`on sv.strategy_id = s.id and sv.version =
   *  s.current_version`) — a `strategies` row with no matching version row
   *  is silently excluded from every read, including the monthly
   *  strategy-weight panel's own name lookup. A real strategy always has
   *  at least one version row (`strategy-repository.ts`'s own creation
   *  path), so this seeds one to match. */
  async function seedStrategy(userId: string, name: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, $2, 1, false, 'active') returning id`,
      [userId, name],
    );
    const strategyId = res.rows[0].id;
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, $3, '[]'::jsonb, '[]'::jsonb)`,
      [strategyId, userId, name],
    );
    return strategyId;
  }

  async function seedConfirmedTrade(userId: string, accountId: string, strategyId: string, serverDay: string, rMultiple: string): Promise<void> {
    const openedAt = new Date(`${serverDay}T09:00:00.000Z`);
    const closedAt = new Date(`${serverDay}T11:00:00.000Z`);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5) returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, strategy_id, instrument, direction, opened_at, closed_at, server_day, status,
          currency, grouping_confidence, r_multiple, confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, 'EURUSD', 'long', $5::timestamptz, $6::timestamptz, $7, 'confirmed',
               'USD', 'confident_single', $8, now(), 'user')`,
      [userId, accountId, blockRes.rows[0].id, strategyId, openedAt.toISOString(), closedAt.toISOString(), serverDay, rMultiple],
    );
  }

  async function seedAdherenceWeekly(userId: string, weekStart: string, hardFollowed: number, hardTotal: number, softFollowed: number, softTotal: number): Promise<void> {
    await db.query(
      `insert into retrospeq.adherence_weekly (user_id, week_start, hard_followed, hard_total, soft_followed, soft_total)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, week_start) do update set hard_followed = excluded.hard_followed, hard_total = excluded.hard_total, soft_followed = excluded.soft_followed, soft_total = excluded.soft_total`,
      [userId, weekStart, hardFollowed, hardTotal, softFollowed, softTotal],
    );
  }

  /** A finding_rule_links row that resolves to `fetchEdgeStabilityForUser`'s
   *  own "stable, checked at least once, no decay" sub-case: the CURRENT
   *  finding for the tuple stays `active` (never `decayed`), so
   *  `findRetirementDecayCandidates` never flags it, and `last_checked_at`
   *  / `last_delta` are both set (the panel's own "checked at least once"
   *  gate). */
  async function seedStableEdge(userId: string, strategyId: string): Promise<void> {
    const fieldId = 'drv.risk_pct';
    const segment = JSON.stringify({ op: 'gte', value: 4 });
    const findingRes = await db.query<{ id: string }>(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, baseline_n, baseline_win_rate,
          delta_win_rate, confidence, state)
       values ($1, 'find.monthly-e2e-stable', $2, $3, $4::jsonb, 40, 0.65, 20, 0.42, 0.23, 'confident', 'active')
       returning id`,
      [userId, strategyId, fieldId, segment],
    );
    await db.query(
      `insert into retrospeq.finding_rule_links
         (finding_id, rule_id, user_id, delta_at_graduation, trades_at_graduation, last_checked_at, last_delta, consecutive_decay_checks)
       values ($1, gen_random_uuid(), $2, 0.29, 25, now(), 0.23, 0)`,
      [findingRes.rows[0].id, userId],
    );
  }

  test('POPULATED: renders a real adherence sequence, real edge stability, and real strategy weight for 3 completed months', async ({ page }) => {
    const user = await createConfirmedUser('month-populated');
    cleanupUserIds.push(user.id);

    const accountId = await seedAccount(user.id);
    const strategyName = 'Monthly E2E Strategy';
    const strategyId = await seedStrategy(user.id, strategyName);

    // One real week per completed month (day 15 of each month is always
    // deep enough into the month that its own Monday week_start cannot
    // shift into the previous month — see `lastNCompletedMonths`'s own
    // "3 fully-ended calendar months" contract).
    const months = lastNCompletedMonths(3);
    const fractions: [number, number, number, number][] = [
      [10, 10, 12, 14],
      [11, 12, 15, 18],
      [12, 12, 19, 20],
    ];
    for (let i = 0; i < months.length; i++) {
      const day15 = `${months[i]!.key}-15`;
      const weekStart = weekStartForServerDay(day15);
      const [hf, ht, sf, st] = fractions[i]!;
      await seedAdherenceWeekly(user.id, weekStart, hf, ht, sf, st);
      // One confirmed trade per month, real R, attributed to the strategy.
      await seedConfirmedTrade(user.id, accountId, strategyId, day15, i === 0 ? '1.0000' : i === 1 ? '-0.5000' : '2.0000');
    }

    await seedStableEdge(user.id, strategyId);

    await loginAs(page, user.email);
    await page.goto('/review/month');
    await page.waitForSelector('#month-h');

    await expect(page.locator('#month-h')).toHaveText('Three months in view');

    // Adherence direction — real sparkline (>= 2 real points) plus the
    // real hard/soft sequences, month labels matching lastNCompletedMonths.
    await expect(page.locator('.rq-spark polyline')).toBeVisible();
    for (const m of months) {
      await expect(page.locator('.axis')).toContainText(m.label);
    }
    const softSeq = page.locator('p.panel__meta', { hasText: 'Soft rules held' });
    await expect(softSeq).toContainText('12 of 14');
    await expect(softSeq).toContainText('15 of 18');
    await expect(softSeq).toContainText('19 of 20');
    const hardSeq = page.locator('p.panel__meta', { hasText: 'Hard' });
    await expect(hardSeq).toContainText('10 of 10');

    // Edge stability — real "stable" sub-case, not a decay before/after.
    await expect(page.getByText('Stable. No decay flagged.')).toBeVisible();
    await expect(page.locator('section:has(#p-edge-stability) .rq-cmp__val').first()).toContainText('%');

    // Which strategies pull weight — real R total from the 3 seeded
    // trades (1.0 - 0.5 + 2.0 = 2.5R), the seeded strategy's own name,
    // never a currency figure on this screen.
    await expect(page.getByText(strategyName)).toBeVisible();
    await expect(page.getByText('+2.5R')).toBeVisible();
    await expect(page.getByText('In R over 3 months. Currency lives in Performance.')).toBeVisible();

    await expect(page.getByText('Not enough data yet.')).toHaveCount(0);
    await expect(page.getByText('A read with zero prompts, ever. Nothing to tap.')).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-month-populated.png', fullPage: true });
  });

  test('HONEST EMPTY STATE: a brand-new account with no history renders "Not enough data yet." for every panel, never a fabricated number', async ({ page }) => {
    const user = await createConfirmedUser('month-empty');
    cleanupUserIds.push(user.id);
    // Deliberately zero seeding of any kind — a genuinely short/absent
    // trading history.

    await loginAs(page, user.email);
    await page.goto('/review/month');
    await page.waitForSelector('#month-h');

    await expect(page.locator('.rq-spark')).toHaveCount(0);
    await expect(page.locator('.panel')).toHaveCount(3);
    // All three panels honestly degrade — same copy, once per panel.
    await expect(page.getByText('Not enough data yet.')).toHaveCount(3);

    const softSeq = page.locator('p.panel__meta', { hasText: 'Soft rules held' });
    await expect(softSeq).toContainText('no data');

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-month-empty.png', fullPage: true });
  });
});
