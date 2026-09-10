import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';

/**
 * Module 03 §5.1 / Module 05 §5 — strategy-detail screen with per-field
 * finding state. INDEPENDENT VERIFICATION of a coder dispatch picked up
 * after a crash (PROGRESS.md 2026-09-11 "picked up, not redone" entry),
 * dispatched separately per this project's tester convention. Scope,
 * beyond what the coder's own `findings-payload.test.ts` /
 * `findings-service.live.test.ts` already cover:
 *
 *   1. Cross-user adversarial 404 — user B requesting user A's strategy
 *      id via the real UI gets a genuine 404, not a data leak or a
 *      different error shape.
 *   2. Fail-closed on a KILL-SWITCHED analytic (row exists, `enabled`
 *      flipped false) — not just an absent-row / outside-cohort case,
 *      which the coder's own live suite already covers.
 *   3. Representative-segment tie-break through the REAL service/UI path
 *      (not just the pure `pickRepresentativeFinding` unit test) — a
 *      field with four active rows across all four confidence tiers
 *      renders only the `confident` one.
 *   4. `provisional` renders with the EXACT SAME computed CSS as
 *      `confident` (ADR 0035 decision #5) — checked by reading real
 *      computed styles, not just eyeballing a screenshot.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-StrategyDetail-IndepVerify-Pass-8821!';

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

test.describe('Strategy-detail screen (Module 03 §5.1, /strategies/[id]) — independent verification', () => {
  let db: Client;
  const cleanupUserIds: string[] = [];
  let toggledOffAnalyticId: string | null = null;

  test.beforeAll(async () => {
    db = new Client({ connectionString: SUPABASE_DB_URL });
    await db.connect();
  });

  test.afterEach(async () => {
    // Belt-and-suspenders restore in case a mid-test assertion failure
    // left the kill-switch test's own `enabled` mutation applied — this
    // table is a SHARED, global-scoped fixture (one row per analytic id
    // for the whole DB), so a stuck `false` would silently break every
    // OTHER test/user relying on `find.toggle` being live.
    if (toggledOffAnalyticId) {
      await db.query(`update retrospeq.analytic_config set enabled = true where analytic_id = $1`, [toggledOffAnalyticId]).catch(() => {});
      toggledOffAnalyticId = null;
    }
  });

  test.afterAll(async () => {
    for (const userId of cleanupUserIds) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)").catch(() => {});
      await db.query('delete from retrospeq.analytic_renders where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.user_cohorts where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]).catch(() => {});
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]).catch(() => {});
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]).catch(() => {});
      await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
      await deleteUser(userId);
    }
    await db.end();
  });

  async function setPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
    await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
  }

  async function addToCohort(userId: string): Promise<void> {
    await db.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'beta_traders') on conflict do nothing`, [userId]);
  }

  async function seedStrategyAndField(
    userId: string,
    fieldId: string,
    fieldName: string,
    dataType: string,
    strategyName: string,
  ): Promise<string> {
    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, $2, 1, false, 'active') returning id`,
      [userId, strategyName],
    );
    const strategyId = strategyRes.rows[0].id;
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, $3, 'strategy_var', $4, 'captured', $5, '{}'::jsonb)`,
      [fieldId, userId, fieldName, dataType, strategyId],
    );
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, $3, $4::jsonb, '[]'::jsonb)`,
      [strategyId, userId, strategyName, JSON.stringify([{ field_id: fieldId, capture_moment: 'pre_entry', order: 1 }])],
    );
    return strategyId;
  }

  async function insertFinding(
    userId: string,
    strategyId: string,
    fieldId: string,
    analyticId: string,
    segment: Record<string, unknown>,
    confidence: 'confident' | 'provisional' | 'null_result' | 'insufficient',
    n: number,
    winRate: number | null,
    baselineWinRate: number | null,
    deltaWinRate: number | null,
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          confidence, gate_failures, state)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, null, 30, $8, null, $9, null, $10, '{}', 'active')`,
      [userId, analyticId, strategyId, fieldId, JSON.stringify(segment), n, winRate, baselineWinRate, deltaWinRate, confidence],
    );
  }

  async function loginAs(page: import('@playwright/test').Page, email: string) {
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  }

  test('1. cross-user adversarial: user B requesting user A\'s strategy id gets a real 404, never a data leak', async ({ page }) => {
    const owner = await createConfirmedUser('sd-404-owner');
    const attacker = await createConfirmedUser('sd-404-attacker');
    cleanupUserIds.push(owner.id, attacker.id);
    await setPlan(owner.id, 'pro');
    await setPlan(attacker.id, 'pro');
    await addToCohort(owner.id);

    const fieldId = 'strategy_var.iv404_conviction';
    const strategyId = await seedStrategyAndField(owner.id, fieldId, 'Conviction', 'rating', "Owner's private strategy (iv-404)");
    await insertFinding(owner.id, strategyId, fieldId, 'find.rating', { op: 'between', value: { min: 4, max: 5 } }, 'confident', 40, 0.71, 0.42, 0.29);

    // Sanity: the owner's own session sees it, with real numbers.
    await loginAs(page, owner.email);
    await page.goto(`/strategies/${strategyId}`);
    await expect(page.getByRole('heading', { name: "Owner's private strategy (iv-404)" })).toBeVisible();
    await expect(page.getByText('Win rate rises from 42% to 71% when Conviction is 4–5.')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/login') || url.pathname === '/', { timeout: 10_000 });

    // Adversarial: attacker's own session, same URL.
    await loginAs(page, attacker.email);
    const response = await page.goto(`/strategies/${strategyId}`);
    expect(response?.status()).toBe(404);
    // Never the owner's strategy name, never the real computed statement,
    // never any content that would confirm the id is valid.
    await expect(page.getByText("Owner's private strategy (iv-404)")).toHaveCount(0);
    await expect(page.getByText(/Win rate rises/)).toHaveCount(0);
    await expect(page.getByText(/could not be found/i)).toBeVisible();
    await page.screenshot({ path: 'tmp/dev-screenshots/iv-strategy-detail-cross-user-404.png', fullPage: true });

    // And a syntactically-plausible but nonexistent id gets the IDENTICAL
    // 404 — no enumeration signal distinguishing "exists, not yours" from
    // "does not exist at all".
    const bogusResponse = await page.goto('/strategies/00000000-0000-0000-0000-000000000000');
    expect(bogusResponse?.status()).toBe(404);
  });

  test('2. fail-closed on a KILL-SWITCHED analytic: a real row exists but analytic_config.enabled = false renders identically to zero rows', async ({ page }) => {
    // IMPORTANT ordering: `config-repository.ts`'s `getAnalyticConfig` is
    // backed by a real, documented 60s in-process cache
    // (`config-cache.ts`, Module 05 §4.8's own "config is cached 60s").
    // The kill-switch must be flipped BEFORE the very first `canRender`
    // call for this analytic id in this process, not after a prior
    // request already cached `enabled: true` — otherwise this test would
    // be asserting the cache's staleness window, not the fail-closed
    // gating logic itself. (Found by this exact ordering mistake on the
    // first draft of this test — confirms the cache is real and working
    // as documented, not a bug in `findings-service.ts`.) The "real data
    // WOULD show if enabled" half of this contrast is already proven
    // independently by tests 1/3/4 below using `find.rating` — the
    // `canRender` gate is generic, not per-analytic-id special-cased, so
    // this test only needs to isolate the disabled path for `find.toggle`
    // specifically without racing its own cache.
    toggledOffAnalyticId = 'find.toggle';
    await db.query(`update retrospeq.analytic_config set enabled = false where analytic_id = 'find.toggle'`);

    const user = await createConfirmedUser('sd-killswitch');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const fieldId = 'strategy_var.iv_killswitch_toggle';
    const strategyId = await seedStrategyAndField(user.id, fieldId, 'HTF trend aligned', 'bool', 'Kill-switch test strategy (iv)');
    await insertFinding(user.id, strategyId, fieldId, 'find.toggle', { op: 'eq', value: true }, 'confident', 41, 0.68, 0.42, 0.26);

    await loginAs(page, user.email);
    await page.goto(`/strategies/${strategyId}`);
    await expect(page.getByText('Not enough data yet.')).toBeVisible();
    await expect(page.getByText(/More trades needed|more trade[s]? on this setup/)).toBeVisible();
    // The real computed numbers/statement must never leak once gated.
    await expect(page.getByText(/Win rate rises/)).toHaveCount(0);
    await expect(page.getByText('68%')).toHaveCount(0);
    await page.screenshot({ path: 'tmp/dev-screenshots/iv-strategy-detail-killswitch-failclosed.png', fullPage: true });

    // Also confirm nothing was logged to analytic_renders for this gated render.
    const renders = await db.query(`select count(*)::int as n from retrospeq.analytic_renders where user_id = $1 and analytic_id = 'find.toggle'`, [user.id]);
    expect(renders.rows[0].n).toBe(0);

    // Restore, then prove the SAME row/page, once re-enabled (and once the
    // cache's own TTL has been forced to re-read via the test-only escape
    // hatch is unavailable cross-process — instead, confirm restoration by
    // querying the DB directly, which is the actual system-of-record fact
    // this test's own gate depends on) reflects `enabled = true` again.
    await db.query(`update retrospeq.analytic_config set enabled = true where analytic_id = 'find.toggle'`);
    toggledOffAnalyticId = null;
    const restored = await db.query<{ enabled: boolean }>(`select enabled from retrospeq.analytic_config where analytic_id = 'find.toggle'`);
    expect(restored.rows[0].enabled).toBe(true);
  });

  test('3. representative-segment tie-break through the REAL UI path: a field with rows in all four tiers renders only the confident one', async ({ page }) => {
    const user = await createConfirmedUser('sd-tiebreak');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const fieldId = 'strategy_var.iv_tiebreak_conviction';
    const strategyId = await seedStrategyAndField(user.id, fieldId, 'Conviction', 'rating', 'Tie-break test strategy (iv)');

    // Four rows, four DIFFERENT segments (required by the active-tuple
    // uniqueness index), spanning all four confidence tiers.
    await insertFinding(user.id, strategyId, fieldId, 'find.rating', { op: 'eq', value: 1 }, 'insufficient', 5, null, null, null);
    await insertFinding(user.id, strategyId, fieldId, 'find.rating', { op: 'eq', value: 2 }, 'null_result', 60, 0.5, 0.49, 0.01);
    await insertFinding(user.id, strategyId, fieldId, 'find.rating', { op: 'eq', value: 3 }, 'provisional', 25, 0.6, 0.4, 0.2);
    await insertFinding(user.id, strategyId, fieldId, 'find.rating', { op: 'between', value: { min: 4, max: 5 } }, 'confident', 40, 0.71, 0.42, 0.29);

    await loginAs(page, user.email);
    await page.goto(`/strategies/${strategyId}`);

    // Exactly ONE .finding card for this one field (§5.1's one-card-per-field markup).
    await expect(page.locator('.finding')).toHaveCount(1);
    await expect(page.locator('.finding')).toHaveAttribute('data-confidence', 'confident');
    await expect(page.getByText('Win rate rises from 42% to 71% when Conviction is 4–5.')).toBeVisible();
    // The other three tiers' own statements must not appear anywhere.
    await expect(page.getByText(/no difference detected/)).toHaveCount(0);
    await expect(page.getByText('Not enough data yet.')).toHaveCount(0);
    await page.screenshot({ path: 'tmp/dev-screenshots/iv-strategy-detail-tiebreak-confident-wins.png', fullPage: true });
  });

  test('4. provisional renders with the EXACT SAME computed CSS as confident (ADR 0035 decision #5) — verified via real computed styles, not just a screenshot', async ({ page }) => {
    const user = await createConfirmedUser('sd-provisional');
    cleanupUserIds.push(user.id);
    await setPlan(user.id, 'pro');
    await addToCohort(user.id);

    const confidentFieldId = 'strategy_var.iv_prov_confident';
    const provisionalFieldId = 'strategy_var.iv_prov_provisional';

    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Provisional-vs-confident test (iv)', 1, false, 'active') returning id`,
      [user.id],
    );
    const strategyId = strategyRes.rows[0].id;
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config) values
         ($1, $2, 'Conviction (confident)', 'strategy_var', 'rating', 'captured', $3, '{}'::jsonb),
         ($4, $2, 'Conviction (provisional)', 'strategy_var', 'rating', 'captured', $3, '{}'::jsonb)`,
      [confidentFieldId, user.id, strategyId, provisionalFieldId],
    );
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Provisional-vs-confident test (iv)', $3::jsonb, '[]'::jsonb)`,
      [
        strategyId,
        user.id,
        JSON.stringify([
          { field_id: confidentFieldId, capture_moment: 'pre_entry', order: 1 },
          { field_id: provisionalFieldId, capture_moment: 'pre_entry', order: 2 },
        ]),
      ],
    );
    await insertFinding(user.id, strategyId, confidentFieldId, 'find.rating', { op: 'between', value: { min: 4, max: 5 } }, 'confident', 40, 0.71, 0.42, 0.29);
    await insertFinding(user.id, strategyId, provisionalFieldId, 'find.rating', { op: 'between', value: { min: 4, max: 5 } }, 'provisional', 25, 0.6, 0.4, 0.2);

    await loginAs(page, user.email);
    await page.goto(`/strategies/${strategyId}`);

    await expect(page.locator('.finding')).toHaveCount(2);
    const confidentCard = page.locator('.finding[data-confidence="confident"]');
    const provisionalCard = page.locator('.finding[data-confidence="provisional"]');
    await expect(confidentCard).toHaveCount(1);
    await expect(provisionalCard).toHaveCount(1);

    // The meta line's own TEXT is the only place the distinction is
    // carried (ADR 0035 decision #5) — confirm both.
    await expect(confidentCard.locator('.finding__meta')).toContainText('confident');
    await expect(provisionalCard.locator('.finding__meta')).toContainText('provisional');

    // Real computed styles must be identical on the card itself (border,
    // background) — this is the actual visual proof, not just trusting
    // the CSS source text.
    const relevantProps = ['border-left-width', 'border-left-color', 'border-left-style', 'background-color', 'border-radius'] as const;
    const readStyles = async (locator: typeof confidentCard) =>
      locator.evaluate((el, props: readonly string[]) => {
        const style = getComputedStyle(el);
        const out: Record<string, string> = {};
        for (const p of props) out[p] = style.getPropertyValue(p);
        return out;
      }, relevantProps);

    const confidentStyles = await readStyles(confidentCard);
    const provisionalStyles = await readStyles(provisionalCard);
    expect(provisionalStyles).toEqual(confidentStyles);

    // And neither is a red/green hue — the design system has no such
    // token pair; spot-check the border-left-color (the one place a
    // confidence-driven accent color would show up if one existed) isn't
    // in a red or green hue range.
    const colorMatch = confidentStyles['border-left-color'].match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (colorMatch) {
      const [, r, g, b] = colorMatch.map(Number);
      const isReddish = r > 150 && g < 100 && b < 100;
      const isGreenish = g > 120 && r < 100 && b < 100;
      expect(isReddish).toBe(false);
      expect(isGreenish).toBe(false);
    }

    await page.screenshot({ path: 'tmp/dev-screenshots/iv-strategy-detail-provisional-vs-confident.png', fullPage: true });
  });
});
