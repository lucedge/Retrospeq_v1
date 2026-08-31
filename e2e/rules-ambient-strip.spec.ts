import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 04 (Rulebook & Evaluation) §5.9 / §6.1's `.ambient` reference
 * markup, story 3.5 — Slice 10d E2E. Covers the ambient strip on
 * `/trades/manual-entry`: the genuine `neutral` state for a brand-new
 * account, a `watch` tint from a broken SOFT rule, a `breach` tint from a
 * broken HARD rule, a real account switch re-fetching live state, and the
 * one thing §5.9 asks a pre-entry screen to actually DO with a breach
 * (write a `rule_overrides` row the instant the trader proceeds, silently,
 * never blocking). Follows `rules-guided-front-door.spec.ts`'s own
 * conventions: real dev server, real Supabase Auth project, a real `pg`
 * connection for setup/verification, screenshots to `tmp/dev-screenshots/`.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-AmbientStrip-Pass-1234!';

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

test.describe('Ambient strip (Module 04 §5.9, /trades/manual-entry)', () => {
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
      await db.query('delete from retrospeq.rule_overrides where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]).catch(() => {});
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
    await page.waitForURL('**/', { timeout: 10_000 });
  }

  async function seedManualAccount(userId: string, label: string, startingEquity: string | null = null): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity)
       values ($1, $2, 'manual', 'USD', '00:00:00 UTC', $3)
       returning id`,
      [userId, label, startingEquity],
    );
    return res.rows[0].id;
  }

  async function seedGlobalRule(
    userId: string,
    operandId: string,
    op: string,
    value: unknown,
    severity: 'soft' | 'hard',
    rendered: string,
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, 'global', null, $2, 'authored', 'pre_entry', 'active') returning id`,
      [userId, severity],
    );
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, $4, $5::jsonb, $6)`,
      [ruleRes.rows[0].id, userId, operandId, op, JSON.stringify(value), rendered],
    );
    return ruleRes.rows[0].id;
  }

  /** An OPEN trade -- feeds `total_open_risk` (sum of `risk_pct` across
   *  every open trade on the account), no equity needed. */
  async function seedOpenTrade(userId: string, accountId: string, riskPct: string): Promise<string> {
    const now = new Date();
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, now.toISOString()],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, server_day, status,
          entry_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency, grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $4::date, 'open',
               '1.10000000', '100000.00000000', '1.09000000', $5, $5, 'USD', 'confident_single')
       returning id`,
      [userId, accountId, blockRes.rows[0].id, now.toISOString(), riskPct],
    );
    return tradeRes.rows[0].id;
  }

  /** A CLOSED + CONFIRMED trade, closed "now" -- feeds `daily_pnl_pct`/
   *  `daily_loss_pct` via `trades.realized_pnl`, percent of the account's
   *  own `starting_equity`. */
  async function seedClosedConfirmedTrade(userId: string, accountId: string, realizedPnl: string): Promise<string> {
    const now = new Date();
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'GBPUSD', $3::timestamptz, $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, now.toISOString()],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, risk_pct, r_multiple, realized_pnl, currency,
          outcome, grouping_confidence, confirmed_at, confirmed_by)
       values ($1, $2, $3, 'GBPUSD', 'long', $4::timestamptz, $4::timestamptz, $4::date, 'confirmed',
               '1.30000000', '1.29000000', '100000.00000000', '1.31000000', '1.000000', '-1.0000', $5, 'USD',
               'loss', 'confident_single', $4::timestamptz, 'user')
       returning id`,
      [userId, accountId, blockRes.rows[0].id, now.toISOString(), realizedPnl],
    );
    return tradeRes.rows[0].id;
  }

  test('neutral state: a brand-new manual account with zero trades and no rules shows all three cells genuinely neutral, never omitted', async ({
    page,
  }) => {
    const user = await createConfirmedUser('ambient-neutral');
    cleanupUserIds.push(user.id);
    await seedManualAccount(user.id, 'Neutral Account');

    await loginAs(page, user.email);
    await page.goto('/trades/manual-entry');

    const strip = page.getByRole('group', { name: 'Account state' });
    await expect(strip).toBeVisible();
    const cells = strip.locator('.ambient__cell');
    await expect(cells).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(cells.nth(i)).toHaveAttribute('data-state', 'neutral');
    }

    await expect(strip.getByText('No trades yet')).toBeVisible();
    // No starting_equity configured -- an honest "Unknown," never a
    // fabricated 0%, per `ambient-state.ts`'s own "can't compute" state.
    await expect(strip.getByText('Unknown')).toBeVisible();
    // No open trades, no cap configured -- "0.0 / —".
    await expect(strip.getByText('0.0 / —')).toBeVisible();

    // .rq-num on every numeric readout, no exceptions (AGENTS.md).
    await expect(cells.locator('.rq-num')).toHaveCount(3);

    await page.screenshot({ path: 'tmp/dev-screenshots/ambient-strip-neutral.png', fullPage: true });
  });

  test('watch state: a broken SOFT daily-loss-cap rule tints Day P&L "watch," never "breach"', async ({ page }) => {
    const user = await createConfirmedUser('ambient-watch');
    cleanupUserIds.push(user.id);
    const accountId = await seedManualAccount(user.id, 'Watch Account', '10000.00000000');
    await seedClosedConfirmedTrade(user.id, accountId, '-300.00000000'); // -3.0% of 10,000
    await seedGlobalRule(user.id, 'daily_loss_pct', 'lte', 2, 'soft', "Never let today's loss exceed 2%.");

    await loginAs(page, user.email);
    await page.goto('/trades/manual-entry');

    const strip = page.getByRole('group', { name: 'Account state' });
    const pnlCell = strip.locator('.ambient__cell', { hasText: 'Day P&L' });
    await expect(pnlCell).toHaveAttribute('data-state', 'watch', { timeout: 10_000 });
    await expect(pnlCell.getByText('-3.0%')).toBeVisible();

    // The OTHER two cells are unaffected by this rule -- still neutral.
    await expect(strip.locator('.ambient__cell', { hasText: 'Today' })).toHaveAttribute('data-state', 'neutral');
    await expect(strip.locator('.ambient__cell', { hasText: 'Risk' })).toHaveAttribute('data-state', 'neutral');

    await page.screenshot({ path: 'tmp/dev-screenshots/ambient-strip-watch.png', fullPage: true });
  });

  test('breach state: a broken HARD risk-cap rule tints Risk "breach," submitting still proceeds with no modal/confirm, and a real rule_overrides row is written', async ({
    page,
  }) => {
    const user = await createConfirmedUser('ambient-breach');
    cleanupUserIds.push(user.id);
    // Inserted FIRST -- `listTradingAccounts` orders `created_at desc`, so
    // this becomes the SECOND (non-default) account once `accountB` below
    // is inserted after it.
    const accountNeutral = await seedManualAccount(user.id, 'Neutral Sibling Account');
    // Inserted SECOND -- becomes accounts[0], the page's default selection.
    const accountBreach = await seedManualAccount(user.id, 'Breach Account');
    await seedOpenTrade(user.id, accountBreach, '1.400000'); // 1.4% open risk
    const ruleId = await seedGlobalRule(
      user.id,
      'total_open_risk',
      'lte',
      1,
      'hard',
      'Never let your total open risk exceed 1%.',
    );

    await loginAs(page, user.email);
    await page.goto('/trades/manual-entry');

    const strip = page.getByRole('group', { name: 'Account state' });
    const riskCell = strip.locator('.ambient__cell', { hasText: 'Risk' });
    await expect(riskCell).toHaveAttribute('data-state', 'breach', { timeout: 10_000 });
    await expect(riskCell.getByText('1.4 / 1.0')).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/ambient-strip-breach.png', fullPage: true });

    // --- Account switch genuinely re-fetches, never shows stale data ---
    // The rule is GLOBAL (applies to every account this trader owns, not
    // just `accountBreach`), so the cap (1.0) still shows here -- only the
    // CURRENT value is per-account and genuinely changes to 0 (this
    // sibling account has no open trades of its own). This is the
    // correct, real behaviour (re-derived from first principles, not
    // assumed): "0.0 / 1.0," never "0.0 / —" (which would incorrectly
    // imply no cap is configured at all).
    await page.selectOption('#accountId', accountNeutral);
    await expect(riskCell).toHaveAttribute('data-state', 'neutral', { timeout: 10_000 });
    await expect(strip.getByText('0.0 / 1.0')).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/ambient-strip-switched-to-neutral.png', fullPage: true });

    // Switch back -- breach state is re-derived live, not cached wrong.
    await page.selectOption('#accountId', accountBreach);
    await expect(riskCell).toHaveAttribute('data-state', 'breach', { timeout: 10_000 });
    await expect(riskCell.getByText('1.4 / 1.0')).toBeVisible();

    // --- Proceeding past the visible breach: no modal, no confirm, and a
    // real rule_overrides row lands, silently, alongside the real trade ---
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // A DIFFERENT instrument from `seedOpenTrade`'s own EURUSD -- avoids
    // this manual entry accidentally grouping against the already-open
    // seeded position (Module 02's grouping engine, out of this slice's
    // scope to exercise here; this test only needs a genuinely NEW,
    // independent trade to prove the override write happens alongside a
    // real submission).
    await page.fill('#instrument', 'XAUUSD');
    await page.getByRole('radio', { name: 'Long' }).click();
    await page.fill('#size', '1');
    await page.fill('#entryPrice', '2400');
    await page.fill('#exitPrice', '2410');

    await page.getByRole('button', { name: 'Log trade' }).click();
    // A slightly wider-than-default timeout, not a masked bug: two Server
    // Actions (the real `createManualTradeAction` submission AND
    // `recordOverride`, fired together off this one click per
    // `ManualEntryScreen.tsx`'s `handleProceedPastBreach`) both hit this
    // repo's shared direct-pg pool (`lib/supabase/direct.ts`, `max: 3`) on
    // a local dev server already warmed by this same test file's own
    // earlier requests. This margin also covers a REAL bug this slice's
    // own testing pass found and fixed before landing (not shipped): the
    // account-switch effect's original "skip the first run" guard used an
    // invocation-COUNT ref, which React's Strict Mode (`next dev`'s
    // default) silently inverted — Strict Mode's deliberate double-invoke
    // of every effect consumed the "skip" on a throwaway first pass,
    // letting the real mount fall through into the real-fetch branch and
    // fire an extra, unwanted `fetchAmbientState` round trip (and a
    // spurious `ambient -> null` flash) on every ordinary page load, which
    // measurably doubled this exact flow's latency (~10.5s vs ~7.5s,
    // confirmed via direct instrumentation before the fix). Fixed by
    // comparing the account id VALUE against what `ambient` actually
    // reflects (`lastFetchedAccountId` ref) instead of counting
    // invocations — idempotent regardless of how many times an effect
    // fires for the same value. 20s leaves real margin for ordinary local
    // dev-server contention without papering over a genuine hang the way
    // a much longer/no timeout would.
    await expect(page.getByText('Trade logged')).toBeVisible({ timeout: 20_000 });
    // Still no modal/confirm appeared at any point during submission.
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // The real proof: a genuine `rule_overrides` row, `trade_id` null (a
    // pre-entry override -- see `ManualEntryScreen.tsx`'s own header for
    // why), citing the breached rule and the observed fact the strip
    // showed at the moment of proceeding.
    await expect
      .poll(
        async () => {
          const rows = await db.query(
            `select rule_id, trade_id, rule_version, observed from retrospeq.rule_overrides where user_id = $1`,
            [user.id],
          );
          return rows.rows;
        },
        { timeout: 10_000 },
      )
      .toEqual([
        expect.objectContaining({
          rule_id: ruleId,
          trade_id: null,
          rule_version: 1,
          observed: 1.4,
        }),
      ]);
  });

  test('SSR degradation: a malformed rule reaching page.tsx\'s initial getAmbientAccountState read degrades ONLY the ambient section -- the rest of the manual-entry form stays fully usable', async ({
    page,
  }) => {
    const user = await createConfirmedUser('ambient-ssr-malformed');
    cleanupUserIds.push(user.id);
    await seedManualAccount(user.id, 'Malformed Rule Account');
    // A genuinely corrupted rule -- bypasses the application-layer catalogue
    // check entirely via direct SQL, the SAME technique
    // `freeze-evaluations.live.test.ts`'s "a genuinely malformed
    // rule_versions row (operand_id not in the catalogue)" test and this
    // module's own `ambient-state.live.test.ts` convention use (a real
    // catalogue-edit-drops-an-operand-still-referenced-by-old-data scenario,
    // not a fabricated shortcut). `getAmbientAccountState` feeds this same
    // triple into the real `evaluate()`, which throws `RuleEvaluationError`
    // (`UNKNOWN_OPERAND`) -- deliberately NOT caught inside
    // `getAmbientAccountState` itself (see that file's own header), so this
    // is a genuine end-to-end trigger of the exact SSR path `page.tsx`'s own
    // try/catch now guards.
    await seedGlobalRule(user.id, 'this_operand_does_not_exist', 'lte', 1, 'hard', 'Corrupted rule.');

    await loginAs(page, user.email);
    await page.goto('/trades/manual-entry');

    // The page itself rendered -- NOT Next's default RSC error page. If the
    // fix regressed (the throw propagating unwrapped again), this heading
    // would never appear.
    await expect(page.getByRole('heading', { name: 'Log a trade by hand' })).toBeVisible();

    // The ambient section degrades honestly -- the SAME rendered fallback
    // `fetchAmbientState`'s own live re-fetch failure already uses (no
    // second error UI invented for this call site).
    await expect(page.getByText('Account state is unavailable right now. Please try again.')).toBeVisible();
    // The three ambient cells are still structurally present (never
    // omitted), just unable to show real values -- "…" placeholders, not a
    // fabricated neutral-looking fact set.
    const strip = page.getByRole('group', { name: 'Account state' });
    await expect(strip).toBeVisible();
    await expect(strip.locator('.ambient__cell')).toHaveCount(3);

    // The REST of the form remains genuinely usable -- a trader can still
    // log a trade even though this one rule's own state can't render.
    await page.fill('#instrument', 'XAUUSD');
    await page.getByRole('radio', { name: 'Long' }).click();
    await page.fill('#size', '1');
    await page.fill('#entryPrice', '2400');
    await page.fill('#exitPrice', '2410');
    await page.getByRole('button', { name: 'Log trade' }).click();
    await expect(page.getByText('Trade logged')).toBeVisible({ timeout: 20_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/ambient-strip-ssr-degraded.png', fullPage: true });
  });
});
