import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

import { canRender } from '../registry-runtime-service';
import { recordAnalyticRender } from '../render-repository';
import { _clearAnalyticConfigCacheForTests } from '../config-cache';

/**
 * Module 05 §4.8 — live-DB proof that the REAL, wired `canRender`
 * (registry-runtime-service.ts, real `withUserConnection` reads against
 * the actual migration) behaves correctly end to end, and that a
 * successful render genuinely writes an `analytic_renders` row with the
 * right shape (§4.8's own closing line). `registry-runtime.test.ts` /
 * `registry-runtime-service.test.ts` already prove the formula and the
 * fail-closed-on-throw contract with mocked dependencies — this file is
 * the "does the real SQL actually do what those mocks assumed" check.
 *
 * Runs against the real, live shared dev/test Supabase Postgres project —
 * skipped (never faked) if the required env vars aren't present.
 */
const env = readRlsTestEnv();
const ANALYTIC_ID = 'rls.live.test.analytic';

describe.skipIf(!env)('canRender + recordAnalyticRender — live DB (Module 05 §4.8)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'canrender-live');
  }, 30_000);

  // `getAnalyticConfig` now caches a successful `analytic_config` read for
  // 60 seconds (`config-cache.ts`, §4.8's own "config is cached 60s",
  // wired 2026-09-08). Several tests below directly `update
  // retrospeq.analytic_config` mid-test and expect the VERY NEXT
  // `canRender` call to see the change immediately -- that is testing
  // "does the underlying DB-driven logic respond correctly to a config
  // change," a different, still-valid concern from "does the cache
  // genuinely hold a value for up to 60 seconds" (covered separately,
  // `config-cache.test.ts`). Clearing the cache before every test in this
  // file keeps those two concerns decoupled without this file needing to
  // sleep 60 real seconds between assertions -- a real caller in
  // production DOES experience up to 60s of staleness after a config
  // change, by design (§4.8's own spec text), this test file's own
  // per-test cache clear is a test-only accommodation, not a claim that
  // production behaves this way.
  beforeEach(() => {
    if (env) _clearAnalyticConfigCacheForTests();
  });

  afterAll(async () => {
    if (!env) return;
    await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [ANALYTIC_ID]);
    await db.query('delete from retrospeq.analytic_renders where user_id = $1', [user.id]);
    await db.query('delete from retrospeq.analytic_user_suppression where user_id = $1', [user.id]);
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.profiles where id = $1', [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  }, 30_000);

  it('a brand-new user (free plan, no cohort, no accounts) is allowed by a free/no-cohort/t0 analytic', async () => {
    await db.query(
      `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
       values ($1, true, 'free', false, 't0')`,
      [ANALYTIC_ID],
    );

    const result = await canRender(ANALYTIC_ID, user.id, 'weekly');
    expect(result).toEqual({ canRender: true, reason: 'ok' });
  });

  it('a successful canRender, followed by recordAnalyticRender, writes a real analytic_renders row with the exact payload', async () => {
    const decision = await canRender(ANALYTIC_ID, user.id, 'weekly');
    expect(decision.canRender).toBe(true);

    const payload = { statement: 'Timeframe — no difference detected.', n: 31, confidence: 'null_result' };
    const written = await recordAnalyticRender({
      userId: user.id,
      analyticId: ANALYTIC_ID,
      surface: 'weekly',
      payload,
    });

    expect(written.id).toBeTruthy();
    expect(written.renderedAt).toBeTruthy();

    const res = await db.query(
      `select user_id, analytic_id, surface, payload from retrospeq.analytic_renders where id = $1`,
      [written.id],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].user_id).toBe(user.id);
    expect(res.rows[0].analytic_id).toBe(ANALYTIC_ID);
    expect(res.rows[0].surface).toBe('weekly');
    expect(res.rows[0].payload).toEqual(payload);
  });

  it('enabled=false -> canRender false, reason disabled (the kill switch, live)', async () => {
    await db.query(`update retrospeq.analytic_config set enabled = false where analytic_id = $1`, [ANALYTIC_ID]);
    const result = await canRender(ANALYTIC_ID, user.id, 'weekly');
    expect(result).toEqual({ canRender: false, reason: 'disabled' });
    await db.query(`update retrospeq.analytic_config set enabled = true where analytic_id = $1`, [ANALYTIC_ID]);
  });

  it('min_plan = pro -> a free-plan user (the seeded signup default) is denied, reason plan', async () => {
    await db.query(`update retrospeq.analytic_config set min_plan = 'pro' where analytic_id = $1`, [ANALYTIC_ID]);
    const result = await canRender(ANALYTIC_ID, user.id, 'weekly');
    expect(result).toEqual({ canRender: false, reason: 'plan' });
    await db.query(`update retrospeq.analytic_config set min_plan = 'free' where analytic_id = $1`, [ANALYTIC_ID]);
  });

  it('cohort_only = true -> a user not in user_cohorts is denied, reason cohort', async () => {
    await db.query(`update retrospeq.analytic_config set cohort_only = true where analytic_id = $1`, [ANALYTIC_ID]);
    const result = await canRender(ANALYTIC_ID, user.id, 'weekly');
    expect(result).toEqual({ canRender: false, reason: 'cohort' });
    await db.query(`update retrospeq.analytic_config set cohort_only = false where analytic_id = $1`, [ANALYTIC_ID]);
  });

  it('a real analytic_user_suppression row -> denied, reason suppressed', async () => {
    await db.query(
      `insert into retrospeq.analytic_user_suppression (user_id, analytic_id, reason) values ($1, $2, 'user_hidden')`,
      [user.id, ANALYTIC_ID],
    );
    const result = await canRender(ANALYTIC_ID, user.id, 'weekly');
    expect(result).toEqual({ canRender: false, reason: 'suppressed' });
    await db.query(`delete from retrospeq.analytic_user_suppression where user_id = $1 and analytic_id = $2`, [user.id, ANALYTIC_ID]);
  });

  it('min_account_tier = t1 -> a user with zero connected accounts is denied, reason tier', async () => {
    await db.query(`update retrospeq.analytic_config set min_account_tier = 't1' where analytic_id = $1`, [ANALYTIC_ID]);
    const result = await canRender(ANALYTIC_ID, user.id, 'weekly');
    expect(result).toEqual({ canRender: false, reason: 'tier' });
    await db.query(`update retrospeq.analytic_config set min_account_tier = 't0' where analytic_id = $1`, [ANALYTIC_ID]);
  });

  it('THE ADVERSARIAL FAIL-CLOSED CASE, live: no analytic_config row at all -> false, reason not_configured, never a default-on', async () => {
    const result = await canRender('rls.live.test.does_not_exist', user.id, 'weekly');
    expect(result).toEqual({ canRender: false, reason: 'not_configured' });
  });

  it('THE CACHE IS ACTUALLY LIVE-WIRED, not just proven against mocks: a real DB update made WITHOUT clearing the cache is not seen by the very next canRender call', async () => {
    // Every other test in this file explicitly clears the cache
    // (`beforeEach` above) to isolate "does the DB-driven logic work"
    // from "does the cache genuinely hold a value" -- this is the one
    // test that does the OPPOSITE on purpose: proves the real,
    // end-to-end wired path (`registry-runtime-service.ts` ->
    // `config-repository.ts` -> `config-cache.ts`) actually serves a
    // cached value against the real Postgres connection, not only
    // against `config-repository.test.ts`'s mocked query function.
    const CACHE_LIVE_ANALYTIC_ID = 'rls.live.test.cache-liveness';
    await db.query(
      `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
       values ($1, true, 'free', false, 't0')`,
      [CACHE_LIVE_ANALYTIC_ID],
    );

    try {
      const first = await canRender(CACHE_LIVE_ANALYTIC_ID, user.id, 'weekly');
      expect(first).toEqual({ canRender: true, reason: 'ok' });

      // Mutate the DB directly, deliberately WITHOUT clearing the cache.
      await db.query(`update retrospeq.analytic_config set enabled = false where analytic_id = $1`, [CACHE_LIVE_ANALYTIC_ID]);

      const second = await canRender(CACHE_LIVE_ANALYTIC_ID, user.id, 'weekly');
      // Still true -- the real wired path served the cached (pre-update)
      // config, not a fresh Postgres read. This is the INTENDED §4.8
      // behaviour (a config change may take up to 60s to take effect),
      // not a bug -- proven here against the real DB, not a mock.
      expect(second).toEqual({ canRender: true, reason: 'ok' });

      // Now prove the cache genuinely releases the update once cleared --
      // otherwise this test would only prove "the cache never expires,"
      // not "the cache correctly reflects reality once its window ends."
      _clearAnalyticConfigCacheForTests();
      const third = await canRender(CACHE_LIVE_ANALYTIC_ID, user.id, 'weekly');
      expect(third).toEqual({ canRender: false, reason: 'disabled' });
    } finally {
      await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [CACHE_LIVE_ANALYTIC_ID]);
    }
  }, 20_000);
});

describe.skipIf(!!env)('canRender + recordAnalyticRender — live DB — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
