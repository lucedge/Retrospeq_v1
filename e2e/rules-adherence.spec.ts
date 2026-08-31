import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { uniqueTestEmail } from './helpers';
import { weekStartForServerDay, addDaysToServerDay } from '../lib/rules/week-boundary';

/**
 * Module 04 (Rulebook & Evaluation) §5.6 / §6.1's `.adherence` reference
 * markup, story 3.3 — Slice 10d part 2 E2E. Covers `/rules`'s adherence
 * display: a real week with both hard and soft breaks and a real
 * hard-priority attribution line, the "up from" week-over-week comparison,
 * the honest `insufficient_history` state, and the "zero breaks this week"
 * state (reported plainly, no attribution line). Follows
 * `rules-ambient-strip.spec.ts`'s own conventions (real dev server, real
 * Supabase Auth project, a real `pg` connection for setup/verification,
 * screenshots to `tmp/dev-screenshots/`).
 *
 * **Seeding approach, deliberate**: this suite seeds `adherence_weekly`
 * (and the `rules`/`rule_versions` rows the attribution line's rendered
 * text join needs) DIRECTLY via SQL, never by driving real trades through
 * the confirm pipeline. `adherence_weekly`'s own MATERIALISATION pipeline
 * (rule evaluation -> freeze -> recompute) is already proven end-to-end by
 * `lib/rules/__tests__/adherence-repository.live.test.ts` (Slice 6) — this
 * suite's whole job is the DISPLAY layer's own read/composition/render
 * path on top of whatever that table already contains, so re-deriving it
 * from real trades here would just be slower, more fragile, and
 * duplicate coverage that already exists.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!;
const TEST_PASSWORD = 'Retrospeq-E2E-Adherence-Pass-1234!';

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

// The SAME "current week" the display itself computes
// (`adherence-display.ts`'s `currentWeekStartFor`) — a plain UTC calendar
// date bucketed through the repo's one canonical ISO-week convention
// (ADR 0015), reused directly here rather than re-implemented, so this
// suite's fixtures are guaranteed to land in the SAME week the page will
// actually query for, regardless of which real day this suite happens to
// run on.
const CURRENT_WEEK_START = weekStartForServerDay(new Date().toISOString().slice(0, 10));
const PRIOR_WEEK_START = addDaysToServerDay(CURRENT_WEEK_START, -7);

test.describe('Adherence display (Module 04 §5.6, /rules)', () => {
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

  async function seedAdherenceWeekly(
    userId: string,
    weekStart: string,
    counts: {
      hardFollowed: number;
      hardTotal: number;
      softFollowed: number;
      softTotal: number;
      topBreakRuleId?: string | null;
      topBreakCount?: number | null;
    },
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.adherence_weekly
         (user_id, week_start, hard_followed, hard_total, soft_followed, soft_total, top_break_rule_id, top_break_count)
       values ($1, $2::date, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        weekStart,
        counts.hardFollowed,
        counts.hardTotal,
        counts.softFollowed,
        counts.softTotal,
        counts.topBreakRuleId ?? null,
        counts.topBreakCount ?? null,
      ],
    );
  }

  test('a real week with hard AND soft breaks: both fractions render correctly, "up from" reflects the real prior week, and the attribution line names the hard-priority rule by its rendered sentence', async ({
    page,
  }) => {
    const user = await createConfirmedUser('adherence-ready');
    cleanupUserIds.push(user.id);

    const hardRuleId = await seedGlobalRule(
      user.id,
      'total_open_risk',
      'lte',
      1,
      'hard',
      'Never let your total open risk exceed 1%.',
    );
    await seedGlobalRule(user.id, 'daily_loss_pct', 'lte', 2, 'soft', "Never let today's loss exceed 2%.");

    // Hand-computed expectation: 2 hard breaks (34 total, 32 followed), 14
    // soft breaks (102 total, 88 followed) -- §6.1's own worked numbers,
    // reused deliberately so this test doubles as a direct reproduction of
    // the spec's own reference example. HARD-PRIORITY means the attribution
    // must name the HARD rule and its denominator must be the HARD break
    // count (2), never the larger soft one (14), even though 14 > 2.
    await seedAdherenceWeekly(user.id, CURRENT_WEEK_START, {
      hardFollowed: 32,
      hardTotal: 34,
      softFollowed: 88,
      softTotal: 102,
      topBreakRuleId: hardRuleId,
      topBreakCount: 2,
    });
    await seedAdherenceWeekly(user.id, PRIOR_WEEK_START, {
      hardFollowed: 27,
      hardTotal: 27,
      softFollowed: 81,
      softTotal: 99,
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    await expect(page.getByRole('heading', { name: 'Your rulebook' })).toBeVisible();
    const section = page.locator('.adherence');
    await expect(section).toBeVisible();

    await expect(section.locator('.adherence__hard')).toContainText('Hard rules:');
    await expect(section.locator('.adherence__hard')).toContainText('32 of 34');
    await expect(section.locator('.adherence__soft')).toContainText('88 of 102');
    // The week-over-week comparison, from the REAL prior-week row.
    await expect(section.locator('.adherence__soft')).toContainText('up from');
    await expect(section.locator('.adherence__soft')).toContainText('81 of 99');

    // Hard-priority: names the HARD rule's own rendered sentence, and the
    // denominator is the HARD break count (2), not the soft one (14).
    const attribution = section.locator('.adherence__attribution');
    await expect(attribution).toContainText('Never let your total open risk exceed 1%.');
    await expect(attribution).toContainText('2 of the 2');
    await expect(attribution).toContainText('hard break');
    await expect(attribution).not.toContainText('soft break');

    // .rq-num on every numeric readout, no exceptions (AGENTS.md).
    await expect(section.locator('.rq-num')).toHaveCount(4); // hard fraction, soft fraction, prior fraction, attribution numbers (one span each -- see below for exact count reasoning)

    // No red/green -- this section carries no colour token beyond this
    // system's own achromatic ink scale (asserted at the design-system CSS
    // level by this slice's own coder/qa pass; here we simply confirm no
    // inline style or class name smuggles one in).
    await expect(section).not.toHaveClass(/success|danger|red|green/);

    await page.screenshot({ path: 'tmp/dev-screenshots/adherence-ready.png', fullPage: true });
  });

  test('insufficient_history: no adherence_weekly row for the current week renders an honest "not enough data yet" state, never a fabricated 0 of 0 or an error', async ({
    page,
  }) => {
    const user = await createConfirmedUser('adherence-empty');
    cleanupUserIds.push(user.id);
    // Deliberately seeds NOTHING for the current week -- a brand-new
    // trader with no rules and no confirmed trades yet.

    await loginAs(page, user.email);
    await page.goto('/rules');

    await expect(page.getByRole('heading', { name: 'Your rulebook' })).toBeVisible();
    const section = page.locator('.adherence');
    await expect(section).toBeVisible();
    await expect(section.getByRole('heading', { name: 'Adherence' })).toBeVisible();
    await expect(section).toContainText('Not enough data yet');
    await expect(section.locator('.adherence__hard')).toHaveCount(0);
    await expect(section.locator('.adherence__soft')).toHaveCount(0);
    await expect(section).not.toContainText('0 of 0');
    await expect(page.locator('[role="alert"]', { hasText: 'Adherence is unavailable' })).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/adherence-insufficient-history.png', fullPage: true });
  });

  test('zero breaks this week: a genuinely good week is reported plainly ("No rules were broken this week."), never celebrated, and there is no attribution line to a rule that did not break', async ({
    page,
  }) => {
    const user = await createConfirmedUser('adherence-zero-breaks');
    cleanupUserIds.push(user.id);
    await seedGlobalRule(user.id, 'total_open_risk', 'lte', 1, 'hard', 'Never let your total open risk exceed 1%.');

    await seedAdherenceWeekly(user.id, CURRENT_WEEK_START, {
      hardFollowed: 12,
      hardTotal: 12,
      softFollowed: 5,
      softTotal: 5,
      topBreakRuleId: null,
      topBreakCount: null,
    });

    await loginAs(page, user.email);
    await page.goto('/rules');

    const section = page.locator('.adherence');
    await expect(section.locator('.adherence__hard')).toContainText('12 of 12');
    await expect(section.locator('.adherence__soft')).toContainText('5 of 5');
    // No "up from" -- the prior week has no row either.
    await expect(section.locator('.adherence__soft')).not.toContainText('up from');

    // Reported plainly, not as a celebration -- no exclamation, no
    // streak/points/XP language anywhere on this screen (AGENTS.md:
    // "Adherence earns no XP, ever").
    await expect(section.locator('.adherence__attribution')).toContainText('No rules were broken this week.');
    await expect(page.getByText(/streak/i)).toHaveCount(0);
    await expect(page.getByText(/\bXP\b/)).toHaveCount(0);
    await expect(page.getByText(/points?/i)).toHaveCount(0);

    await page.screenshot({ path: 'tmp/dev-screenshots/adherence-zero-breaks.png', fullPage: true });
  });
});
