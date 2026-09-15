import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 06 (Review & Graduation), frames 4.8/4.9 — real-browser E2E
 * coverage of `/review/decisions` for PROMOTION and RETIREMENT, closing the
 * phase-end gap named in `PROGRESS.md` ("Next up" / "phase-end follow-ups").
 * Seeding helpers mirror `app/(app)/review/decisions/__tests__/decisions-
 * promotion-retirement-integration.live.test.ts` (the live unit-level
 * coverage of the SAME actions) almost verbatim — this file adds the real
 * browser + rendered-copy + DOM-class layer that file cannot.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-PromoRetire-Pass-7712!';

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

test.describe('/review/decisions — promotion + retirement (Module 06 §4.8/§4.9)', () => {
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
      await db.query('delete from retrospeq.prompt_history where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.finding_rule_links where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trigger_evaluations where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]).catch(() => {});
      await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
      await deleteUser(userId);
    }
    await db.end();
  });

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

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
       values ($1, 'Promo/Retire E2E Test', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedStrategy(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Promo/Retire E2E Strategy', 1, false, 'active') returning id`,
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

  async function insertRule(userId: string, opts: { createdAt: Date; rendered: string }): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, severity, origin, evaluation, state, scope, created_at)
       values ($1, 'soft', 'authored', 'pre_entry', 'active', 'global', $2::timestamptz) returning id`,
      [userId, opts.createdAt.toISOString()],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, 'risk_pct', 'lte', '1.0'::jsonb, $3)`,
      [ruleId, userId, opts.rendered],
    );
    return ruleId;
  }

  /** A rule genuinely eligible for §5.7 promotion — 50 days old, 20
   *  followed (never broken) evaluations spread over the last 20 days. */
  async function seedPromotionEligibleRule(userId: string, accountId: string, rendered: string): Promise<string> {
    const ruleId = await insertRule(userId, { createdAt: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000), rendered });
    for (let i = 1; i <= 20; i++) {
      const serverDay = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const tradeId = await seedTrade(userId, accountId, serverDay);
      await db.query(
        `insert into retrospeq.rule_evaluations (user_id, trade_id, rule_id, rule_version, severity, result, server_day)
         values ($1, $2, $3, 1, 'soft', 'followed', $4::date)`,
        [userId, tradeId, ruleId, serverDay],
      );
    }
    return ruleId;
  }

  let periodCounter = 0;

  async function insertReview(userId: string): Promise<string> {
    // Distinct period_start per call within a test file run.
    const periodStart = new Date(Date.UTC(2026, 8, 7) - periodCounter * 7 * 24 * 60 * 60 * 1000);
    const periodEnd = new Date(periodStart.getTime() + 6 * 24 * 60 * 60 * 1000);
    periodCounter += 1;
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload)
       values ($1, 'weekly', $2::date, $3::date, 1, '{}'::jsonb) returning id`,
      [userId, periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10)],
    );
    return res.rows[0].id;
  }

  async function insertPromotionPrompt(userId: string, reviewId: string, ruleId: string, evidence: Record<string, unknown>): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'promotion', 1, 'rule', $3, $4::jsonb, 'pending') returning id`,
      [userId, reviewId, ruleId, JSON.stringify(evidence)],
    );
    return res.rows[0].id;
  }

  async function seedDecayedRuleAndFinding(userId: string, strategyId: string): Promise<{ ruleId: string; decayedFindingId: string }> {
    const ruleId = await insertRule(userId, { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), rendered: 'Never risk more than 1% per trade.' });
    const fieldId = 'drv.risk_pct';
    const segment = JSON.stringify({ op: 'gte', value: 4 });

    const origRes = await db.query<{ id: string }>(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, baseline_n, baseline_win_rate,
          delta_win_rate, confidence, state)
       values ($1, 'find.promo-retire-e2e', $2, $3, $4::jsonb, 25, 0.71, 20, 0.42, 0.29, 'confident', 'superseded')
       returning id`,
      [userId, strategyId, fieldId, segment],
    );
    const origId = origRes.rows[0].id;

    const currentRes = await db.query<{ id: string }>(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, baseline_n, baseline_win_rate,
          delta_win_rate, confidence, state)
       values ($1, 'find.promo-retire-e2e', $2, $3, $4::jsonb, 40, 0.48, 20, 0.46, 0.02, 'confident', 'decayed')
       returning id`,
      [userId, strategyId, fieldId, segment],
    );
    const currentId = currentRes.rows[0].id;

    await db.query(
      `insert into retrospeq.finding_rule_links (finding_id, rule_id, user_id, delta_at_graduation, trades_at_graduation, consecutive_decay_checks)
       values ($1, $2, $3, 0.29, 25, 2)`,
      [origId, ruleId, userId],
    );

    return { ruleId, decayedFindingId: currentId };
  }

  async function insertRetirementDecayPrompt(userId: string, reviewId: string, ruleId: string, decayedFindingId: string, strategyId: string): Promise<string> {
    const evidence = {
      ruleId,
      decayedFindingId,
      strategyId,
      fieldId: 'drv.risk_pct',
      n: 40,
      currentDeltaWinRate: 0.02,
      deltaAtGraduation: 0.29,
      tradesAtGraduation: 25,
      consecutiveDecayChecks: 2,
    };
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'retirement', 1, 'rule', $3, $4::jsonb, 'pending')
       returning id`,
      [userId, reviewId, ruleId, JSON.stringify(evidence)],
    );
    return res.rows[0].id;
  }

  // -----------------------------------------------------------------
  // Promotion (frame 4.8)
  // -----------------------------------------------------------------

  test('PROMOTION core flow: "Make it hard" writes the real severity change and lands on the empty state', async ({ page }) => {
    const user = await createConfirmedUser('promo-accept');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro'); // `rules.hard` is Pro-only — viewing a promotion prompt at all requires Pro.

    const accountId = await seedAccount(user.id);
    const ruleId = await seedPromotionEligibleRule(user.id, accountId, 'Only take conviction 4 or higher.');
    const reviewId = await insertReview(user.id);
    await insertPromotionPrompt(user.id, reviewId, ruleId, {
      ruleId,
      rendered: 'Only take conviction 4 or higher.',
      ageDays: 50,
      applicableEvaluations: 20,
      followedEvaluations: 20,
      complianceRatio: 1,
    });

    await loginAs(page, user.email);
    await page.goto('/review/decisions');
    await page.waitForSelector('#promo-h');

    await expect(page.locator('#promo-h')).toHaveText('Make this rule hard?');
    await expect(page.getByText('Only take conviction 4 or higher.')).toBeVisible();
    await expect(page.locator('.rq-dots i:not(.off)')).toHaveCount(20);
    await expect(page.locator('.rq-cost')).toBeVisible();

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-promotion-ready.png', fullPage: true });

    await page.getByRole('button', { name: 'Make it hard' }).click();
    await page.waitForSelector('text=Nothing to decide right now.', { timeout: 30_000 });

    const ruleRow = await db.query('select severity from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].severity).toBe('hard');
    const promptRow = await db.query(`select state, payload from retrospeq.review_prompts where user_id = $1 and kind = 'promotion'`, [user.id]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].payload.resolution).toBe('made_hard');
  });

  test('PROMOTION failure path: "Keep it soft" declines without changing severity', async ({ page }) => {
    const user = await createConfirmedUser('promo-decline');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');

    const accountId = await seedAccount(user.id);
    const ruleId = await seedPromotionEligibleRule(user.id, accountId, 'Only take conviction 4 or higher.');
    const reviewId = await insertReview(user.id);
    await insertPromotionPrompt(user.id, reviewId, ruleId, {
      ruleId,
      rendered: 'Only take conviction 4 or higher.',
      ageDays: 50,
      applicableEvaluations: 20,
      followedEvaluations: 20,
      complianceRatio: 1,
    });

    await loginAs(page, user.email);
    await page.goto('/review/decisions');
    await page.waitForSelector('#promo-h');

    await page.getByRole('button', { name: 'Keep it soft' }).click();
    await page.waitForSelector('text=Nothing to decide right now.', { timeout: 30_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-promotion-declined.png', fullPage: true });

    const ruleRow = await db.query('select severity from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].severity).toBe('soft');
    const promptRow = await db.query(`select state, payload from retrospeq.review_prompts where user_id = $1 and kind = 'promotion'`, [user.id]);
    expect(promptRow.rows[0].state).toBe('declined');
    expect(promptRow.rows[0].payload.resolution).toBe('kept_soft');
    const historyRow = await db.query(
      `select decline_count, muted from retrospeq.prompt_history where user_id = $1 and subject_id = $2 and kind = 'promotion'`,
      [user.id, ruleId],
    );
    expect(historyRow.rows[0]).toEqual({ decline_count: 1, muted: false });
  });

  // -----------------------------------------------------------------
  // Retirement (frame 4.9)
  // -----------------------------------------------------------------

  test('RETIREMENT core flow: the .rq-btn--equal pair renders with no primary/secondary distinction; "Retire it" writes the real state change', async ({ page }) => {
    const user = await createConfirmedUser('retire-accept');
    cleanupUserIds.push(user.id);

    const strategyId = await seedStrategy(user.id);
    const { ruleId, decayedFindingId } = await seedDecayedRuleAndFinding(user.id, strategyId);
    const reviewId = await insertReview(user.id);
    await insertRetirementDecayPrompt(user.id, reviewId, ruleId, decayedFindingId, strategyId);

    await loginAs(page, user.email);
    await page.goto('/review/decisions');
    await page.waitForSelector('#retire-h');

    await expect(page.locator('#retire-h')).toHaveText('Has this edge stopped working?');
    // Real before/after comparison, not invented.
    await expect(page.locator('.rq-cmp__val').first()).toContainText('%');

    const keepBtn = page.getByRole('button', { name: 'Keep the rule' });
    const retireBtn = page.getByRole('button', { name: 'Retire it' });
    await expect(keepBtn).toHaveClass(/rq-btn--equal/);
    await expect(retireBtn).toHaveClass(/rq-btn--equal/);
    await expect(keepBtn).not.toHaveClass(/ghost/);
    await expect(retireBtn).not.toHaveClass(/ghost/);
    // No lone primary `.rq-btn` (without --equal) anywhere in this section.
    await expect(page.locator('section[aria-labelledby="retire-h"] .rq-btn:not(.rq-btn--equal)')).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-retirement-ready.png', fullPage: true });

    await retireBtn.click();
    await page.waitForSelector('text=Nothing to decide right now.', { timeout: 30_000 });

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-retirement-retired.png', fullPage: true });

    const ruleRow = await db.query('select state from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].state).toBe('retired');
    const promptRow = await db.query(`select state, payload from retrospeq.review_prompts where user_id = $1 and kind = 'retirement'`, [user.id]);
    expect(promptRow.rows[0].state).toBe('accepted');
    expect(promptRow.rows[0].payload.resolution).toBe('retire');
  });

  /**
   * "The blocked state": `RetirementDecisionCard`'s own `canDecide: false`
   * branch is, BY DESIGN, never reached through the real `/review/
   * decisions` route — `fetchNextDecision` (`actions.ts:378`,
   * `if (!detail.canDecide) continue;`) re-verifies the prompt's premise
   * live and silently skips it before it is ever handed to the page,
   * exactly the same way it treats an already-recovered edge (see the
   * live suite's own "fetchNextDecision: an edge that has since RECOVERED
   * ... is skipped" test). Forcing the client component into that branch
   * would require either mocking the server action (not a real E2E) or
   * bypassing the real filter in product code (out of scope, and this
   * agent does not touch `lib/rules/**`/`app/(app)/rules/**` or this
   * route's own decision logic per its dispatch). This test instead proves
   * the REAL, reachable behaviour a trader hits when the premise no longer
   * holds: a retirement candidate whose rule was retired by another
   * action (e.g. from `/rules`) between materialisation and this view is
   * never shown as a stale or broken decision — the trader lands on the
   * honest empty state instead.
   */
  test('RETIREMENT blocked-premise path: a rule already retired since the prompt was written is silently skipped, never offered as a stale decision', async ({ page }) => {
    const user = await createConfirmedUser('retire-blocked');
    cleanupUserIds.push(user.id);

    const strategyId = await seedStrategy(user.id);
    const { ruleId, decayedFindingId } = await seedDecayedRuleAndFinding(user.id, strategyId);
    const reviewId = await insertReview(user.id);
    await insertRetirementDecayPrompt(user.id, reviewId, ruleId, decayedFindingId, strategyId);

    // The premise changes between materialisation and this view: the rule
    // is retired through some other path (e.g. the rulebook UI) before the
    // trader ever opens this decision.
    await db.query(`update retrospeq.rules set state = 'retired' where id = $1`, [ruleId]);

    await loginAs(page, user.email);
    await page.goto('/review/decisions');

    await expect(page.getByText('Nothing to decide right now.')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#retire-h')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retire it' })).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/e2e-retirement-blocked-skipped.png', fullPage: true });

    // Still genuinely retired (by the setup step, not by this page) and no
    // second prompt/history row was fabricated.
    const ruleRow = await db.query('select state from retrospeq.rules where id = $1', [ruleId]);
    expect(ruleRow.rows[0].state).toBe('retired');
    const promptRow = await db.query(`select state from retrospeq.review_prompts where user_id = $1 and kind = 'retirement'`, [user.id]);
    expect(promptRow.rows[0].state).toBe('pending'); // never auto-decided, just skipped for THIS view
  });
});
