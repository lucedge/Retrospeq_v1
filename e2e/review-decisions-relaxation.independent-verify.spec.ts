import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 06 (Review & Graduation) Slice 7 — `retrospeq-tester` gate,
 * 2026-09-13. INDEPENDENT VERIFICATION, real browser, real dev server, real
 * shared dev Supabase project. §4.7's own framing: "Both options presented
 * with equal visual weight... The product does not have an opinion about
 * which the trader should choose." This is the single most important thing
 * to verify in this slice — checked via real computed CSS, not a screenshot
 * alone, mirroring `strategy-detail.independent-verify.spec.ts` test 4's own
 * `getComputedStyle`-comparison precedent for the identical class of claim
 * (ADR 0035 decision #5's provisional-vs-confident equality).
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-RelaxDecisions-IndepVerify-Pass-9931!';

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

test.describe('Relaxation decision screen (§4.7, /review/decisions) — independent verification', () => {
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
      await db.query('delete from retrospeq.review_prompts where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]).catch(() => {});
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
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  }

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Relaxation IV Test', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(userId: string, accountId: string, serverDay: string): Promise<string> {
    const openedAt = new Date(`${serverDay}T10:00:00Z`);
    const closedAt = new Date(`${serverDay}T11:00:00Z`);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date) returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    const blockId = blockRes.rows[0].id;
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6::date, 'closed',
               '1.10000000', '1.10500000', '100000.00000000', 'USD', 'confident_single')
       returning id`,
      [userId, accountId, blockId, openedAt.toISOString(), closedAt.toISOString(), serverDay],
    );
    return tradeRes.rows[0].id;
  }

  async function seedRelaxationFixture(userId: string): Promise<{ ruleId: string; promptId: string }> {
    const accountId = await seedAccount(userId);
    const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, severity, origin, evaluation, state, scope, created_at)
       values ($1, 'soft', 'authored', 'pre_entry', 'active', 'global', $2::timestamptz) returning id`,
      [userId, createdAt.toISOString()],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, 'risk_pct', 'lte', '1.0'::jsonb, 'Never risk more than 1% per trade.')`,
      [ruleId, userId],
    );

    const observedValues = [...Array(10).fill(0.8), ...Array(11).fill(2.1)];
    for (let i = 0; i < observedValues.length; i++) {
      const serverDay = new Date(Date.now() - (41 - i) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const tradeId = await seedTrade(userId, accountId, serverDay);
      const result = i < 11 ? 'broken' : 'followed';
      await db.query(
        `insert into retrospeq.rule_evaluations (user_id, trade_id, rule_id, rule_version, severity, result, observed, server_day)
         values ($1, $2, $3, 1, 'soft', $4, $5::jsonb, $6::date)`,
        [userId, tradeId, ruleId, result, JSON.stringify(observedValues[i]), serverDay],
      );
    }

    // Reimplements `determineCurrentWeeklyReviewPeriod`'s own "first ever
    // review" branch (`lib/review/current-period.ts`) directly here rather
    // than importing that module — it carries a `server-only` import guard
    // this plain Playwright/Node process cannot load. For a brand-new test
    // user with zero completed reviews, that function's own logic reduces
    // to exactly this: the most recently fully-ended ISO week (Monday
    // start, `lib/rules/week-boundary.ts`'s own convention, matched here).
    const now = new Date();
    const dow = now.getUTCDay(); // 0=Sun..6=Sat
    const daysSinceMonday = (dow + 6) % 7;
    const currentWeekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
    const lastEndedWeekStart = new Date(currentWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastEndedWeekEnd = new Date(currentWeekStart.getTime() - 1 * 24 * 60 * 60 * 1000);
    const periodStart = lastEndedWeekStart.toISOString().slice(0, 10);
    const periodEnd = lastEndedWeekEnd.toISOString().slice(0, 10);

    const reviewRes = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2::date, $3::date, 1, '{}'::jsonb) returning id`,
      [userId, periodStart, periodEnd],
    );
    const reviewId = reviewRes.rows[0].id;

    const payload = { ruleId, rendered: 'Never risk more than 1% per trade.', ageDays: 50, applicableEvaluations: 21, brokenEvaluations: 11, breakRate: 11 / 21 };
    const promptRes = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'relaxation', 1, 'rule', $3, $4::jsonb, 'pending') returning id`,
      [userId, reviewId, ruleId, JSON.stringify(payload)],
    );
    return { ruleId, promptId: promptRes.rows[0].id };
  }

  test('the two choice buttons are STRUCTURALLY identical — same element, same class list, same computed styles, zero primary/secondary distinction', async ({ page }) => {
    const user = await createConfirmedUser('relax-equal-weight');
    cleanupUserIds.push(user.id);
    await seedRelaxationFixture(user.id);

    await loginAs(page, user.email);
    await page.goto('/review/decisions');

    await expect(page.getByRole('heading', { name: 'Which one is true?' })).toBeVisible();
    await expect(page.getByText('You have set risk per trade to 1.0% and traded a median of 2.1% over the last six weeks.')).toBeVisible();
    await expect(page.getByText('15 of 30 applicable trades exceeded it.')).toHaveCount(0); // sanity: not the spec's own worked example text, the real seeded one
    await expect(page.getByText('11 of 21 applicable trades exceeded it.')).toBeVisible();
    await expect(page.getByText('A rule you break most weeks stops meaning anything. Recommit to it, or move it to where you actually trade.')).toBeVisible();

    const keepBtn = page.getByRole('button', { name: 'Keep 1.0%' });
    const changeBtn = page.getByRole('button', { name: 'Change to 2.1%' });
    await expect(keepBtn).toBeVisible();
    await expect(changeBtn).toBeVisible();

    // 1. Identical tag name and identical class list, IN ORDER — not just
    //    "both look similar", the literal DOM attribute this ADR's own
    //    ethics claim depends on.
    const [keepTag, keepClass] = await keepBtn.evaluate((el) => [el.tagName, el.className]);
    const [changeTag, changeClass] = await changeBtn.evaluate((el) => [el.tagName, el.className]);
    expect(keepTag).toBe(changeTag);
    expect(keepClass).toBe(changeClass);
    expect(keepClass.split(/\s+/)).toEqual(expect.arrayContaining(['rq-btn', 'rq-btn--equal']));
    // Neither the plain (implicitly-primary) `.rq-btn` alone, nor
    // `.rq-btn--ghost` (a real secondary distinction) — this screen must
    // use ONLY the symmetric-choice class pair.
    expect(keepClass).not.toContain('ghost');
    expect(changeClass).not.toContain('ghost');

    // 2. Real computed styles, not just source CSS text — background,
    //    border, font-weight, width must be IDENTICAL between the two.
    const relevantProps = ['background-color', 'box-shadow', 'font-weight', 'color', 'border-radius', 'width', 'height', 'padding'] as const;
    const readStyles = async (locator: typeof keepBtn) =>
      locator.evaluate((el, props: readonly string[]) => {
        const style = getComputedStyle(el);
        const out: Record<string, string> = {};
        for (const p of props) out[p] = style.getPropertyValue(p);
        return out;
      }, relevantProps);

    const keepStyles = await readStyles(keepBtn);
    const changeStyles = await readStyles(changeBtn);
    expect(changeStyles).toEqual(keepStyles);

    // 3. Equal WIDTH specifically (the `.rq-btn-row > * { flex: 1 }` "same
    //    element, side by side" layout claim) — a real geometric check, not
    //    inferred from the class name alone.
    const keepBox = await keepBtn.boundingBox();
    const changeBox = await changeBtn.boundingBox();
    expect(keepBox).not.toBeNull();
    expect(changeBox).not.toBeNull();
    expect(Math.abs((keepBox!.width ?? 0) - (changeBox!.width ?? 0))).toBeLessThanOrEqual(1);

    // 4. No red/green hue on either button — this design system has no
    //    such token pair; spot-check both buttons' color/background.
    for (const styles of [keepStyles, changeStyles]) {
      for (const key of ['background-color', 'color']) {
        const match = styles[key].match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) continue;
        const [, r, g, b] = match.map(Number);
        const isReddish = r > 150 && g < 100 && b < 100;
        const isGreenish = g > 120 && r < 100 && b < 100;
        expect(isReddish).toBe(false);
        expect(isGreenish).toBe(false);
      }
    }

    // 5. No THIRD button on this screen at all (§4.7/§5.1: exactly two
    //    choices, no defer/"Not yet" escape hatch — `docs/adr/0041`
    //    decision 4).
    await expect(page.locator('button, a').filter({ hasText: /Not yet|Defer/i })).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/iv-relaxation-decision-equal-weight-ready.png', fullPage: true });

    // Act on it (Keep), then confirm the terminal state, per §5.1's own
    // "no dead end" framing.
    await keepBtn.click();
    await expect(page.getByText('Nothing to decide right now.')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'tmp/dev-screenshots/iv-relaxation-decision-equal-weight-after.png', fullPage: true });

    const promptRow = await db.query(`select state, payload from retrospeq.review_prompts where user_id = $1 and kind = 'relaxation'`, [user.id]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].payload.resolution).toBe('recommit');
  });
});
